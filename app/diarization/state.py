"""Recoverable, meeting-scoped identities and interval-to-transcript assignment."""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
from uuid import uuid4

import numpy as np

from ..transcripts import atomic_json


class SpeakerState:
    def __init__(self, directory: Path, voiceprints=()):
        self.directory = directory
        self.path = directory / "speaker-state.json"
        self.log = directory / "speaker-features.jsonl"
        empty = {
            "model_tag": None, "processed": 0, "speakers": {}, "turns": [], "offset": 0,
        }
        try:
            self.value = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.value = empty
        if self.log.exists() and self.value["offset"] > self.log.stat().st_size:
            self.value = empty
        if self.log.exists():
            with self.log.open("r+b") as source:
                source.seek(self.value["offset"])
                while line := source.readline():
                    if not line.endswith(b"\n"):
                        source.truncate(self.value["offset"])
                        break
                    entry = json.loads(line)
                    self.value = entry["state"]
                    self.value["offset"] = source.tell()
        for row in voiceprints:
            if row.get("embedding"):
                self.value["speakers"].setdefault(
                    row["id"], {"name": row["name"], "embedding": json.loads(row["embedding"]),
                                  "weight": 60000, "registered": True},
                )
        if voiceprints:
            atomic_json(self.path, self.value)

    @property
    def names(self):
        active = {speaker for turn in self.value["turns"] for speaker in turn["speaker_ids"]}
        return {key: {"name": s["name"]} for key, s in self.value["speakers"].items()
                if key in active or not s.get("registered")}

    def accept(self, result):
        if self.value["model_tag"] not in (None, result["model_tag"]):
            raise ValueError("会议声纹模型版本已变更，请使用原模型继续处理")
        if result["end"] <= self.value["processed"]:
            return False
        state = deepcopy(self.value)
        state["model_tag"] = result["model_tag"]
        mapping, used, evidence = {}, set(), []
        # Assign strongest local evidence first; local speakers must remain distinct.
        for local in sorted(result["speakers"], key=lambda s: -s["clean_ms"]):
            speaker_id = None
            if local.get("embedding"):
                vector = np.asarray(local["embedding"], dtype=np.float32)
                vector /= max(float(np.linalg.norm(vector)), 1e-8)
                scored = sorted(((float(np.asarray(s["embedding"]) @ vector), key)
                                 for key, s in state["speakers"].items() if key not in used), reverse=True)
                # An ambiguous near-match stays unknown; don't create a new
                # identity for every uncertain window of the same speaker.
                confident = scored and scored[0][0] >= .5 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= .08)
                if scored and not confident and scored[0][0] >= .6:
                    continuity = {}
                    for current in result["turns"]:
                        if current["local_ids"] != [local["local_id"]]:
                            continue
                        for prior in state["turns"]:
                            if prior.get("unknown") or prior.get("overlap") or len(prior["speaker_ids"]) != 1:
                                continue
                            overlap = max(0, min(current["end_ms"], prior["end_ms"]) - max(current["start_ms"], prior["start_ms"]))
                            identity = prior["speaker_ids"][0]
                            continuity[identity] = continuity.get(identity, 0) + overlap
                    evidence_ms = continuity.get(scored[0][1], 0)
                    # Hysteresis needs both acoustic support and at least 1 s of
                    # the same clean speech already attributed in an earlier window.
                    confident = evidence_ms >= 1000 and evidence_ms >= .8 * sum(continuity.values())
                if confident:
                    speaker_id = scored[0][1]
                elif (not scored or scored[0][0] < .5) and local["clean_ms"] >= 1500 and local["fresh_ms"] >= 300 and len(state["speakers"]) < 16:
                    speaker_id = uuid4().hex
                    state["speakers"][speaker_id] = {"name": f"说话人 {len(state['speakers']) + 1}",
                        "embedding": vector.tolist(), "weight": 0}
                if speaker_id is not None:
                    speaker = state["speakers"][speaker_id]
                    if local["clean_ms"] >= 1500 and local["fresh_ms"] > 0:
                        weight = min(speaker["weight"], 60000)
                        updated = np.asarray(speaker["embedding"]) * weight + vector * local["fresh_ms"]
                        updated /= max(float(np.linalg.norm(updated)), 1e-8)
                        speaker.update(embedding=updated.tolist(), weight=weight + local["fresh_ms"])
                    used.add(speaker_id)
            mapping[local["local_id"]] = speaker_id
            evidence.append({**local, "speaker_id": speaker_id})
        turns = []
        for turn in result["turns"]:
            ids = [mapping.get(i) for i in turn["local_ids"]]
            turns.append({"start_ms": round(turn["start_ms"]), "end_ms": round(turn["end_ms"]),
                          "speaker_ids": list(dict.fromkeys(i for i in ids if i)),
                          "unknown": any(i is None for i in ids), "overlap": len(ids) > 1,
                          "local_ids": turn["local_ids"]})
        # Keep enough history for the longest ASR segment plus the rolling context.
        # A final can arrive well after its first diarization window.
        cutoff = max(0, result["end"] / 16 - 60000)
        prior = [{**t, "end_ms": min(t["end_ms"], result["start"] / 16)}
                 for t in state["turns"] if t["start_ms"] < result["start"] / 16 and t["end_ms"] > cutoff]
        state.update(processed=result["end"], turns=prior + turns)
        entry = {"start": result["start"], "end": result["end"], "evidence": evidence,
                 "turns": turns, "state": state}
        with self.log.open("ab") as output:
            output.write((json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
            state["offset"] = output.tell()
        atomic_json(self.path, state)
        self.value = state
        return True


def label_segment(segment, turns, processed_ms):
    if segment["end_ms"] <= segment["start_ms"] or segment["end_ms"] > processed_ms:
        return segment
    relevant = []
    for turn in turns:
        low, high = max(segment["start_ms"], turn["start_ms"]), min(segment["end_ms"], turn["end_ms"])
        if high - low >= 40:
            relevant.append({**turn, "start_ms": low, "end_ms": high})
    ids = list(dict.fromkeys(s for t in relevant for s in t["speaker_ids"]))
    status = "assigned" if len(ids) == 1 else "multiple" if ids else "unknown"
    if any(t.get("overlap") for t in relevant):
        status = "overlap"
    elif any(t.get("unknown") for t in relevant):
        status = "unknown"
    return {**segment, "speaker_ids": ids, "speaker_status": status,
            "speaker_turns": relevant}
