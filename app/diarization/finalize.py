"""Global relabeling and conservative re-transcription of mixed-speaker segments."""
from __future__ import annotations

from dataclasses import replace
import asyncio
import hashlib
import json
import os
from uuid import uuid4

import numpy as np

from .state import label_segment
from ..asr import LANGUAGES
from ..qwen_streaming import RemoteDecoder
from ..recordings import read_audio
from ..transcripts import atomic_json


def global_timeline(directory, centers, state):
    """Stream the feature journal; only keep the revisable rolling tail in memory."""
    vectors = [np.asarray(c) for c in centers]
    names, identities, used = dict(state.names), [], set()
    for vector in vectors:
        candidates = sorted(((float(np.asarray(s["embedding"]) @ vector), key)
                             for key, s in state.value["speakers"].items() if key not in used), reverse=True)
        identity = candidates[0][1] if candidates and candidates[0][0] >= .5 else uuid4().hex
        if identity not in names:
            names[identity] = {"name": f"说话人 {len(names) + 1}"}
        identities.append(identity)
        used.add(identity)
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
                    if local.get("embedding") and local["clean_ms"] >= 350:
                        vector = np.asarray(local["embedding"])
                        scored = sorted(((float(center @ vector), index) for index, center in enumerate(vectors)
                                         if identities[index] not in assigned), reverse=True)
                        if scored and scored[0][0] >= .5 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= .08):
                            identity = identities[scored[0][1]]
                    # Keep reliable online distinctions if global evidence is ambiguous.
                    if identity is None and local.get("speaker_id") not in assigned:
                        identity = local.get("speaker_id")
                    if identity:
                        assigned.add(identity)
                        if local.get("speaker_id"):
                            aliases.setdefault(local["speaker_id"], set()).add(identity)
                    mapping[local["local_id"]] = identity
                for turn in entry["turns"]:
                    ids = [mapping.get(i) for i in turn["local_ids"]]
                    pending.append({"start_ms": turn["start_ms"], "end_ms": turn["end_ms"],
                        "speaker_ids": list(dict.fromkeys(i for i in ids if i)),
                        "overlap": len(ids) > 1, "unknown": any(i is None for i in ids)})
        for turn in pending:
            write(turn)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    for old, replacements in aliases.items():
        if len(replacements) == 1 and old not in replacements:
            names[old] = {**names[old], "merged_into": next(iter(replacements))}
    return names


def label_document(directory, document, processed_ms):
    # One chronological pass; no full-meeting pairwise matrix or audio buffer.
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
            yield label_segment(segment, relevant, processed_ms)


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
    def __init__(self, directory, models, settings, language, decoder_factory=None):
        self.directory, self.models, self.settings, self.language = directory, models, settings, language
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
                send_chat_template=self.settings.asr_send_chat_template,
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
