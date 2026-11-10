"""Recoverable, meeting-scoped identities and interval-to-transcript assignment."""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
from uuid import uuid4

import numpy as np

from ..transcripts import atomic_json

# shortcut: .60 open-set threshold; calibrate with labeled voiceprint pairs before production rollout.
VOICEPRINT_MATCH_THRESHOLD = .6
VOICEPRINT_MATCH_MARGIN = .08
TRACK_SIMILARITY_THRESHOLD = .55


class SpeakerState:
    def __init__(self, directory: Path, voiceprints=()):
        self.directory = directory
        self.path = directory / "speaker-state.json"
        self.log = directory / "speaker-features.jsonl"
        empty = {
            "model_tag": None, "processed": 0, "speakers": {}, "tracks": {}, "turns": [], "offset": 0,
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
        self.value.setdefault("tracks", {})
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

    @staticmethod
    def _local_intervals(turns):
        intervals = {}
        for turn in turns:
            for local_id in turn["local_ids"]:
                intervals.setdefault(local_id, []).append((turn["start_ms"], turn["end_ms"]))
        return intervals

    @staticmethod
    def _overlap_ms(left, right):
        return sum(max(0, min(a_end, b_end) - max(a_start, b_start))
                   for a_start, a_end in left for b_start, b_end in right)

    @staticmethod
    def _track_embedding_similarity(local, track):
        if not local.get("embedding") or not track.get("embedding"):
            return None
        vector = np.asarray(local["embedding"], dtype=np.float32)
        vector /= max(float(np.linalg.norm(vector)), 1e-8)
        previous = np.asarray(track["embedding"], dtype=np.float32)
        previous /= max(float(np.linalg.norm(previous)), 1e-8)
        return float(previous @ vector)

    def _associate_tracks(self, result, state):
        """Associate stateless model channels with tracks from the previous window."""
        intervals = self._local_intervals(result["turns"])
        assigned = set()
        associations = {}
        diagnostics = {}
        for local in sorted(result["speakers"], key=lambda item: -item["clean_ms"]):
            candidates = []
            for track_id, track in state["tracks"].items():
                if track_id in assigned:
                    continue
                overlap = self._overlap_ms(intervals.get(local["local_id"], []), track.get("intervals", []))
                # shortcut: 40 ms overlap and .55 similarity; replace with labeled-track calibration when available.
                if overlap < 40:
                    continue
                similarity = self._track_embedding_similarity(local, track)
                if similarity is not None and similarity < TRACK_SIMILARITY_THRESHOLD:
                    continue
                candidates.append((
                    1 if similarity is not None else 0,
                    similarity if similarity is not None else 0,
                    overlap,
                    track.get("seen_windows", 0),
                    track_id,
                    similarity,
                ))
            if not candidates:
                diagnostics[local["local_id"]] = {
                    "track_id": None, "track_overlap_ms": 0, "track_similarity": None,
                    "track_reason": "new_track",
                }
                continue
            _, _, overlap, _, track_id, similarity = max(candidates)
            assigned.add(track_id)
            associations[local["local_id"]] = track_id
            diagnostics[local["local_id"]] = {
                "track_id": track_id,
                "track_overlap_ms": round(float(overlap), 3),
                "track_similarity": round(float(similarity), 6) if similarity is not None else None,
                "track_reason": "embedding_and_time" if similarity is not None else "time_continuity",
            }
        return associations, diagnostics, intervals

    def accept(self, result):
        if self.value["model_tag"] not in (None, result["model_tag"]):
            raise ValueError("会议声纹模型版本已变更，请使用原模型继续处理")
        if result["end"] <= self.value["processed"]:
            return False
        state = deepcopy(self.value)
        state["model_tag"] = result["model_tag"]
        track_associations, track_diagnostics, intervals = self._associate_tracks(result, state)
        track_ids = dict(track_associations)
        for local in result["speakers"]:
            track_ids.setdefault(local["local_id"], uuid4().hex)
        mapping, used, evidence, matching_diagnostics = {}, set(), [], []
        # Tracks carry continuity only; the current window must still provide
        # evidence for a registered identity.
        for local in sorted(result["speakers"], key=lambda s: -s["clean_ms"]):
            speaker_id = None
            reason = "no_embedding"
            top_candidate_id = None
            top_score = second_score = margin = continuity_ms = None
            candidate_count = blocked_candidate_count = 0
            blocked_candidate_id = blocked_candidate_score = None
            track_id = track_ids[local["local_id"]]
            track = state["tracks"].get(track_id)
            track_info = track_diagnostics[local["local_id"]]
            track_similarity = track_info["track_similarity"]
            inherited_id = track.get("speaker_id") if track else None
            inherited = state["speakers"].get(inherited_id) if inherited_id else None
            inherited_anonymous = bool(inherited_id and inherited and not inherited.get("registered"))
            if local.get("embedding"):
                vector = np.asarray(local["embedding"], dtype=np.float32)
                vector /= max(float(np.linalg.norm(vector)), 1e-8)
                all_scored = sorted(((float(np.asarray(s["embedding"]) @ vector), key)
                                     for key, s in state["speakers"].items() if s.get("registered")), reverse=True)
                scored = sorted(((float(np.asarray(s["embedding"]) @ vector), key)
                                 for key, s in state["speakers"].items()
                                 if s.get("registered") and key not in used), reverse=True)
                candidate_count = len(scored)
                blocked_candidate_count = len(all_scored) - len(scored)
                if all_scored and all_scored[0][1] in used:
                    blocked_candidate_score, blocked_candidate_id = all_scored[0]
                if scored:
                    top_score, top_candidate_id = scored[0]
                    second_score = scored[1][0] if len(scored) > 1 else None
                    margin = top_score - second_score if second_score is not None else None
                # A near-match stays unresolved; track continuity cannot promote it.
                confident = scored and scored[0][0] >= VOICEPRINT_MATCH_THRESHOLD and (
                    len(scored) == 1 or scored[0][0] - scored[1][0] >= VOICEPRINT_MATCH_MARGIN
                )
                if confident:
                    speaker_id = scored[0][1]
                    reason = "confident_match"
                elif inherited_anonymous and track and track.get("seen_windows", 0) >= 1:
                    speaker_id = inherited_id
                    reason = "anonymous_track_inherited"
                elif (track and track.get("seen_windows", 0) >= 1
                      and local["clean_ms"] >= 1500 and local["fresh_ms"] >= 300
                      and len(state["speakers"]) < 16):
                    speaker_id = uuid4().hex
                    anonymous_count = sum(
                        not speaker.get("registered") for speaker in state["speakers"].values()
                    )
                    state["speakers"][speaker_id] = {"name": f"说话人 {anonymous_count + 1}",
                        "embedding": vector.tolist(), "weight": 0}
                    reason = "anonymous_created"
                elif not scored:
                    reason = "awaiting_track_confirmation" if track is None else "no_available_candidate"
                elif scored[0][0] < VOICEPRINT_MATCH_THRESHOLD:
                    reason = "awaiting_track_confirmation" if track is None else "below_threshold"
                else:
                    reason = "ambiguous_match"
            elif inherited_anonymous and track and track.get("seen_windows", 0) >= 1:
                speaker_id = inherited_id
                reason = "anonymous_track_inherited_without_embedding"
            if speaker_id is not None:
                speaker = state["speakers"][speaker_id]
                if (not speaker.get("registered") and local.get("embedding")
                        and local["clean_ms"] >= 1500 and local["fresh_ms"] > 0):
                    vector = np.asarray(local["embedding"], dtype=np.float32)
                    weight = min(speaker["weight"], 60000)
                    updated = np.asarray(speaker["embedding"]) * weight + vector * local["fresh_ms"]
                    updated /= max(float(np.linalg.norm(updated)), 1e-8)
                    speaker.update(embedding=updated.tolist(), weight=weight + local["fresh_ms"])
                used.add(speaker_id)
            mapping[local["local_id"]] = speaker_id
            evidence.append({**local, "speaker_id": speaker_id})
            matching_diagnostics.append({
                "local_id": local["local_id"],
                "track_id": track_id,
                "track_overlap_ms": track_info["track_overlap_ms"],
                "track_similarity": track_similarity,
                "track_reason": track_info["track_reason"],
                "track_seen_windows": track.get("seen_windows", 0) if track else 0,
                "track_status": track.get("status", "new") if track else "new",
                "active_ms": round(float(local.get("active_ms", 0)), 3),
                "clean_ms": round(float(local["clean_ms"]), 3),
                "fresh_ms": round(float(local["fresh_ms"]), 3),
                "has_embedding": bool(local.get("embedding")),
                "candidate_count": candidate_count,
                "blocked_candidate_count": blocked_candidate_count,
                "blocked_candidate_id": blocked_candidate_id,
                "blocked_candidate_score": round(float(blocked_candidate_score), 6)
                if blocked_candidate_score is not None else None,
                "top_candidate_id": top_candidate_id,
                "top_score": round(float(top_score), 6) if top_score is not None else None,
                "second_score": round(float(second_score), 6) if second_score is not None else None,
                "margin": round(float(margin), 6) if margin is not None else None,
                "continuity_ms": round(float(continuity_ms), 3) if continuity_ms is not None else None,
                "speaker_id": speaker_id,
                "reason": reason,
            })
        turns = []
        turn_diagnostics = []
        for turn in result["turns"]:
            ids = [mapping.get(i) for i in turn["local_ids"]]
            speaker_ids = list(dict.fromkeys(i for i in ids if i))
            unresolved_local_ids = [local_id for local_id, speaker in zip(turn["local_ids"], ids) if speaker is None]
            if len(turn["local_ids"]) > 1 and unresolved_local_ids:
                reason = "raw_overlap_with_unresolved_track"
            elif len(speaker_ids) > 1:
                reason = "confirmed_overlap"
            elif len(turn["local_ids"]) > 1:
                reason = "raw_overlap_single_identity"
            elif unresolved_local_ids:
                reason = "unresolved_identity"
            else:
                reason = "single_resolved_identity"
            turns.append({"start_ms": round(turn["start_ms"]), "end_ms": round(turn["end_ms"]),
                          "speaker_ids": speaker_ids,
                          "unknown": any(i is None for i in ids), "overlap": len(speaker_ids) > 1,
                          "local_ids": turn["local_ids"]})
            turn_diagnostics.append({
                "start_ms": round(turn["start_ms"]), "end_ms": round(turn["end_ms"]),
                "local_ids": turn["local_ids"], "speaker_ids": speaker_ids,
                "unresolved_local_ids": unresolved_local_ids,
                "raw_overlap": len(turn["local_ids"]) > 1,
                "resolved_identity_count": len(speaker_ids),
                "reason": reason,
            })
        current_tracks = {}
        for local in result["speakers"]:
            local_id = local["local_id"]
            track_id = track_ids[local_id]
            previous = state["tracks"].get(track_id, {})
            speaker_id = mapping.get(local_id)
            previous_id = previous.get("speaker_id")
            previous_speaker = state["speakers"].get(previous_id) if previous_id else None
            continuity_id = speaker_id or (
                previous_id if previous_speaker and not previous_speaker.get("registered") else None
            )
            current_tracks[track_id] = {
                "speaker_id": continuity_id,
                "embedding": local.get("embedding") or previous.get("embedding"),
                "intervals": intervals.get(local_id, []),
                "last_local_id": local_id,
                "last_start_ms": round(result["start"] / 16),
                "last_end_ms": round(result["end"] / 16),
                "seen_windows": previous.get("seen_windows", 0) + 1,
                "status": "stable" if continuity_id
                and previous.get("seen_windows", 0) >= 1 else "candidate",
            }
        state["tracks"] = current_tracks
        # Keep enough history for the longest ASR segment plus the rolling context.
        # A final can arrive well after its first diarization window.
        cutoff = max(0, result["end"] / 16 - 60000)
        prior = [{**t, "end_ms": min(t["end_ms"], result["start"] / 16)}
                 for t in state["turns"] if t["start_ms"] < result["start"] / 16 and t["end_ms"] > cutoff]
        state.update(processed=result["end"], turns=prior + turns)
        entry = {"start": result["start"], "end": result["end"], "fresh_from": result.get("fresh_from"),
                 "evidence": evidence, "turns": turns,
                 "diagnostics": {
                     "window": {"start": result["start"], "end": result["end"],
                                "fresh_from": result.get("fresh_from")},
                     "matching": matching_diagnostics,
                     "turns": turn_diagnostics,
                     "summary": {
                         "local_speaker_count": len(result["speakers"]),
                         "resolved_identity_count": len({speaker for speaker in mapping.values() if speaker}),
                         "unresolved_local_ids": [local_id for local_id, speaker in mapping.items() if speaker is None],
                         "raw_overlap_turn_count": sum(item["raw_overlap"] for item in turn_diagnostics),
                         "confirmed_overlap_turn_count": sum(
                             item["reason"] == "confirmed_overlap" for item in turn_diagnostics
                         ),
                         "overlap_with_unresolved_track_count": sum(
                             item["reason"] == "raw_overlap_with_unresolved_track" for item in turn_diagnostics
                         ),
                         "anonymous_created_count": sum(
                             item["reason"] == "anonymous_created" for item in matching_diagnostics
                         ),
                         "track_count": len(current_tracks),
                         "inherited_match_count": sum(
                             item["reason"] == "track_inherited_match" for item in matching_diagnostics
                         ),
                         "recovered_blocked_match_count": sum(
                             item["reason"] == "track_recovered_blocked_match" for item in matching_diagnostics
                         ),
                     },
                 },
                 "state": state}
        with self.log.open("ab") as output:
            output.write((json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
            state["offset"] = output.tell()
        atomic_json(self.path, state)
        self.value = state
        return True

def _confirmed_overlap(turn):
    return bool(turn.get("overlap")) and len(set(turn.get("speaker_ids", ()))) > 1


def label_segment(segment, turns, processed_ms):
    if segment["end_ms"] <= segment["start_ms"] or segment["end_ms"] > processed_ms:
        return segment
    relevant = []
    for turn in turns:
        low, high = max(segment["start_ms"], turn["start_ms"]), min(segment["end_ms"], turn["end_ms"])
        if high - low >= 40:
            relevant.append({**turn, "start_ms": low, "end_ms": high})
    ids = list(dict.fromkeys(s for t in relevant for s in t["speaker_ids"]))
    unresolved = any(t.get("unknown") for t in relevant)
    status = "assigned" if len(ids) == 1 and not unresolved else "multiple" if ids else "unknown"
    if any(_confirmed_overlap(t) for t in relevant):
        status = "overlap"
    elif len(ids) > 1:
        status = "multiple"
    return {**segment, "speaker_ids": ids, "speaker_status": status,
            "speaker_turns": relevant}
