"""Global relabeling and conservative re-transcription of mixed-speaker segments."""
from __future__ import annotations

from dataclasses import replace
import asyncio
import hashlib
import json
import os
from uuid import uuid4

import numpy as np

from .state import VOICEPRINT_MATCH_MARGIN, VOICEPRINT_MATCH_THRESHOLD, label_segment
from ..asr import LANGUAGES
from ..qwen_streaming import RemoteDecoder
from ..recordings import read_audio
from ..transcripts import atomic_json

# shortcut: 1000 ms adjacency, calibrate against labeled pause and speaker-switch data.
ADJACENT_SPEAKER_GAP_MS = 1000


def _unit_vector(value):
    vector = np.asarray(value, dtype=np.float32)
    return vector / max(float(np.linalg.norm(vector)), 1e-8)


def _global_center_identities(vectors, speakers):
    """Assign registered identities to global centers with one-to-one rejection."""
    registered = [
        (key, _unit_vector(speaker["embedding"]))
        for key, speaker in speakers.items()
        if speaker.get("registered") and speaker.get("embedding")
    ]
    proposals = []
    for index, vector in enumerate(vectors):
        scored = sorted(
            ((float(vector @ embedding), key) for key, embedding in registered),
            reverse=True,
        )
        if not scored or scored[0][0] < VOICEPRINT_MATCH_THRESHOLD:
            continue
        if len(scored) > 1 and scored[0][0] - scored[1][0] < VOICEPRINT_MATCH_MARGIN:
            continue
        proposals.append((scored[0][0], index, scored[0][1]))
    identities = [None] * len(vectors)
    used_speakers = set()
    for _, index, speaker_id in sorted(proposals, reverse=True):
        if speaker_id in used_speakers:
            continue
        identities[index] = speaker_id
        used_speakers.add(speaker_id)
    return identities


def global_timeline(directory, centers, state):
    """Stream the feature journal; only keep the revisable rolling tail in memory."""
    vectors = [_unit_vector(center) for center in centers]
    identities = _global_center_identities(vectors, state.value["speakers"])
    names = dict(state.names)
    anonymous_count = sum(
        not speaker.get("registered") for speaker in state.value["speakers"].values()
    )
    stable_ids = {
        track["speaker_id"] for track in state.value.get("tracks", {}).values()
        if track.get("status") == "stable" and track.get("speaker_id")
        and not state.value["speakers"].get(track["speaker_id"], {}).get("registered")
    }
    identities = [identity or uuid4().hex for identity in identities]
    path = directory / "speaker-timeline.jsonl"
    temporary = path.with_suffix(".tmp")
    pending, aliases = [], {}
    with temporary.open("w") as output:
        def write(turn):
            output.write(json.dumps(turn, ensure_ascii=False, separators=(",", ":")) + "\n")

        with state.log.open() as source:
            for line in source:
                entry = json.loads(line)
                boundary = entry["start"] / 16
                for turn in pending:
                    if turn["start_ms"] < boundary:
                        write({**turn, "end_ms": min(turn["end_ms"], boundary)})
                pending = []
                mapping, assigned = {}, set()
                for local in sorted(entry["evidence"], key=lambda e: -e["clean_ms"]):
                    identity = None
                    online_identity = local.get("speaker_id")
                    online_speaker = state.value["speakers"].get(online_identity) if online_identity else None
                    if local.get("embedding") and local["clean_ms"] >= 350:
                        vector = _unit_vector(local["embedding"])
                        scored = sorted(
                            ((float(center @ vector), index) for index, center in enumerate(vectors)
                             if identities[index] not in assigned),
                            reverse=True,
                        )
                        if scored and scored[0][0] >= VOICEPRINT_MATCH_THRESHOLD and (
                                len(scored) == 1 or scored[0][0] - scored[1][0] >= VOICEPRINT_MATCH_MARGIN):
                            identity = identities[scored[0][1]]
                    if identity is None and online_identity in stable_ids and online_identity not in assigned:
                        identity = online_identity
                    # Registered online matches never bypass global center validation.
                    if identity is None and online_speaker and not online_speaker.get("registered") \
                            and online_identity not in assigned and local.get("clean_ms", 0) >= 350:
                        identity = online_identity
                    if identity:
                        if identity not in names:
                            speaker = state.value["speakers"].get(identity)
                            if speaker and speaker.get("registered"):
                                names[identity] = {"name": speaker["name"]}
                            else:
                                anonymous_count += 1
                                names[identity] = {"name": f"说话人 {anonymous_count}"}
                        assigned.add(identity)
                        if online_identity:
                            aliases.setdefault(online_identity, set()).add(identity)
                    mapping[local["local_id"]] = identity
                for turn in entry["turns"]:
                    ids = [mapping.get(i) for i in turn["local_ids"]]
                    speaker_ids = list(dict.fromkeys(i for i in ids if i))
                    pending.append({"start_ms": turn["start_ms"], "end_ms": turn["end_ms"],
                        "speaker_ids": speaker_ids,
                        "overlap": len(speaker_ids) > 1, "unknown": any(i is None for i in ids)})
        for turn in pending:
            write(turn)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    for old, replacements in aliases.items():
        if len(replacements) == 1 and old not in replacements:
            names[old] = {**names[old], "merged_into": next(iter(replacements))}
    return names


def _stable_segment_identity(segment):
    if segment.get("speaker_status") != "assigned":
        return None
    speaker_ids = list(dict.fromkeys(segment.get("speaker_ids", ())))
    return speaker_ids[0] if len(speaker_ids) == 1 else None


def _has_reliable_second_identity(segment):
    if len(set(segment.get("speaker_ids", ()))) > 1:
        return True
    return any(
        turn.get("overlap") or len(set(turn.get("speaker_ids", ()))) > 1
        for turn in segment.get("speaker_turns", ())
    )


def _inherit_adjacent_identities(segments):
    stable = [_stable_segment_identity(segment) for segment in segments]
    updated = list(segments)
    for index, segment in enumerate(segments):
        if segment.get("speaker_status") != "unknown" or _has_reliable_second_identity(segment):
            continue
        candidates = []
        if index:
            previous = segments[index - 1]
            if stable[index - 1] and 0 <= segment["start_ms"] - previous["end_ms"] <= ADJACENT_SPEAKER_GAP_MS:
                candidates.append(stable[index - 1])
        if index + 1 < len(segments):
            following = segments[index + 1]
            if stable[index + 1] and 0 <= following["start_ms"] - segment["end_ms"] <= ADJACENT_SPEAKER_GAP_MS:
                candidates.append(stable[index + 1])
        if not candidates or len(set(candidates)) != 1:
            continue
        identity = candidates[0]
        existing = set(segment.get("speaker_ids", ()))
        if existing and existing != {identity}:
            continue
        turns = segment.get("speaker_turns") or [{
            "start_ms": segment["start_ms"], "end_ms": segment["end_ms"],
        }]
        updated[index] = {**segment, "speaker_ids": [identity], "speaker_status": "assigned",
                          "speaker_turns": [
                              {**turn, "speaker_ids": [identity], "unknown": False, "overlap": False}
                              for turn in turns
                          ]}
    return updated


def label_document(directory, document, processed_ms):
    # One chronological pass; no full-meeting pairwise matrix or audio buffer.
    labeled = []
    with (directory / "speaker-timeline.jsonl").open() as source:
        cursor, relevant = None, []
        for segment in document["segments"]:
            relevant = [t for t in relevant if t["end_ms"] > segment["start_ms"]]
            while True:
                if cursor is None:
                    line = source.readline()
                    cursor = json.loads(line) if line else None
                if cursor is None or cursor["start_ms"] >= segment["end_ms"]:
                    break
                if cursor["end_ms"] > segment["start_ms"]:
                    relevant.append(cursor)
                cursor = None
            labeled.append(label_segment(segment, relevant, processed_ms))
    yield from _inherit_adjacent_identities(labeled)


def split_ranges(segment):
    if segment["speaker_status"] != "multiple":
        return []
    groups = []
    for turn in segment["speaker_turns"]:
        if turn.get("unknown") or turn.get("overlap") or len(turn["speaker_ids"]) != 1:
            return []
        speaker = turn["speaker_ids"][0]
        if groups and groups[-1]["speaker_id"] == speaker:
            groups[-1]["end_ms"] = turn["end_ms"]
        else:
            groups.append({"speaker_id": speaker, "start_ms": turn["start_ms"], "end_ms": turn["end_ms"]})
    if len(groups) < 2 or any(g["end_ms"] - g["start_ms"] < 350 for g in groups):
        return []
    groups[0]["start_ms"], groups[-1]["end_ms"] = segment["start_ms"], segment["end_ms"]
    for left, right in zip(groups, groups[1:]):
        left["end_ms"] = right["start_ms"] = round((left["end_ms"] + right["start_ms"]) / 2)
    return groups


class SegmentCorrector:
    def __init__(self, directory, models, settings, system_settings, language, decoder_factory=None):
        self.directory, self.models, self.settings = directory, models, settings
        self.system_settings, self.language = system_settings, language
        self.decoder_factory = decoder_factory
        self.decoder = None
        self.cache_path = directory / "speaker-corrections.json"
        self.cache = json.loads(self.cache_path.read_text()) if self.cache_path.exists() else {}

    async def split(self, segment):
        ranges = split_ranges(segment)
        if not ranges:
            return None
        config = replace(self.models.require("asr"), tokenizer=self.settings.asr_tokenizer)
        key = hashlib.sha256(json.dumps([segment["segment_id"], segment["text"], ranges,
                                        config.base_url, config.model, config.asr_mode], sort_keys=True).encode()).hexdigest()
        if key in self.cache:
            return self.cache[key]
        if self.decoder is None:
            self.decoder = self.decoder_factory(config) if self.decoder_factory else RemoteDecoder(
                config,
                use_request_chat_template=self.system_settings.get()["asr_use_request_chat_template"],
                window_seconds=self.settings.asr_window_seconds,
                stride_seconds=self.settings.asr_stride_seconds,
            )
            await self.decoder.prepare()
        output = []
        for group in ranges:
            start, end = round(group["start_ms"] * 16), round(group["end_ms"] * 16)
            if end - start > 320000:
                return None
            # Disk reads are small (at most 20 seconds) and never run on the event loop.
            audio = await asyncio.to_thread(read_audio, self.directory, start, end)
            state = self.decoder.new_state(LANGUAGES.get(self.language, self.language), 21)
            await self.decoder.feed(audio, state)
            text = (await self.decoder.finish(state)).strip()
            if not text:
                return None
            output.append({**group, "text": text})
        self.cache[key] = output
        await asyncio.to_thread(atomic_json, self.cache_path, self.cache)
        return output

    async def close(self):
        if self.decoder:
            await self.decoder.close()
