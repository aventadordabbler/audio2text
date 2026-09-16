"""Durable meeting events and their rebuildable transcript projections."""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
from uuid import uuid4


def atomic_json(path: Path, value) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def empty_document():
    return {"revision": 0, "content_revision": 0, "next_segment_id": 0, "segments": [], "speakers": {},
            "processing": {"status": "idle", "error": ""}}


def plain_text(document, *, labels=False):
    parts = []
    for segment in sorted(document["segments"], key=lambda s: (s["start_ms"], s["segment_id"])):
        text = segment["text"].strip()
        if not text:
            continue
        if labels:
            names = [document["speakers"].get(s, {}).get("name", "未知说话人")
                     for s in segment.get("speaker_ids", [])]
            status = segment.get("speaker_status")
            name = "说话人待确认" if status in {"unknown", "pending"} else "、".join(names)
            if status == "overlap":
                name = "重叠讲话：" + (name or "说话人待确认")
            text = f"[{name}] {text}"
        parts.append(text)
    return "\n\n".join(parts)


def apply_event(document, event):
    if event["revision"] != document["revision"] + 1:
        raise ValueError("会议事件版本不连续")
    removed = set(event.get("remove_segment_ids", []))
    segments = {s["segment_id"]: s for s in document["segments"] if s["segment_id"] not in removed}
    for segment in event.get("upsert_segments", []):
        segments[segment["segment_id"]] = segment
    document["segments"] = sorted(segments.values(), key=lambda s: (s["start_ms"], s["segment_id"]))
    document["speakers"].update(event.get("speakers", {}))
    document["next_segment_id"] = max(document["next_segment_id"], event.get("next_segment_id", 0))
    if "processing" in event:
        document["processing"] = event["processing"]
    document["revision"] = event["revision"]
    if event.get("upsert_segments") or event.get("remove_segment_ids") or event.get("speakers"):
        document["content_revision"] = event["revision"]


class TranscriptStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.events_path = directory / "events.jsonl"
        self.snapshot_path = directory / "transcript.json"
        self.text_path = directory / "transcript.txt"

    @contextmanager
    def locked(self):
        with (self.directory / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _read(self):
        document = empty_document()
        offset = 0
        if self.snapshot_path.exists():
            try:
                cached = json.loads(self.snapshot_path.read_text())
                offset = cached.pop("event_offset")
                if self.events_path.exists() and offset <= self.events_path.stat().st_size:
                    document = cached
                else:
                    offset = 0
            except (ValueError, KeyError):
                offset = 0
        if self.events_path.exists():
            with self.events_path.open("r+b") as source:
                source.seek(offset)
                while line := source.readline():
                    if not line.endswith(b"\n"):
                        source.truncate(offset)
                        source.flush()
                        os.fsync(source.fileno())
                        break
                    event = json.loads(line)
                    apply_event(document, event)
                    offset = source.tell()
        return document, offset

    def _project(self, document, offset):
        atomic_text(self.text_path, plain_text(document))
        atomic_json(self.snapshot_path, {**document, "event_offset": offset})

    def read(self):
        with self.locked():
            document, offset = self._read()
            # Recover projections after a crash between journal append and snapshot replace.
            try:
                cached = json.loads(self.snapshot_path.read_text())
            except (OSError, ValueError):
                cached = {}
            if cached.get("event_offset") != offset or not self.text_path.exists():
                self._project(document, offset)
            return document

    def _append(self, document, payload):
        event = {**payload, "revision": document["revision"] + 1,
                 "operation_id": uuid4().hex}
        updated = deepcopy(document)
        apply_event(updated, event)
        with self.events_path.open("ab") as output:
            output.write((json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
            offset = output.tell()
        self._project(updated, offset)
        return event

    def final(self, segment_id, text, start_ms, end_ms, capture_id):
        with self.locked():
            document, _ = self._read()
            if segment_id < document["next_segment_id"]:
                return None
            if segment_id != document["next_segment_id"]:
                raise ValueError("转写片段顺序异常")
            segment = {"segment_id": segment_id, "text": text, "start_ms": start_ms,
                       "end_ms": end_ms, "capture_id": capture_id, "speaker_ids": [],
                       "speaker_status": "pending", "speaker_turns": []}
            return self._append(document, {"type": "final", **segment,
                "next_segment_id": segment_id + 1, "upsert_segments": [segment] if text else []})

    def update(self, *, segments=(), remove=(), speakers=None, processing=None, expected_revision=None):
        with self.locked():
            document, _ = self._read()
            if expected_revision is not None and expected_revision != document["revision"]:
                return None
            payload = {"type": "transcript.update", "upsert_segments": list(segments),
                       "remove_segment_ids": list(remove), "speakers": speakers or {}}
            payload["next_segment_id"] = max(
                [document["next_segment_id"], *(s["segment_id"] + 1 for s in segments)])
            if processing is not None:
                payload.update(type="processing", processing=processing)
            return self._append(document, payload)

    def replace_text(self, text):
        document = self.read()
        number = document["next_segment_id"]
        segment = {"segment_id": number, "text": text, "start_ms": 0, "end_ms": 0,
                   "speaker_ids": [], "speaker_status": "unknown", "speaker_turns": []}
        return self.update(segments=[segment] if text else [],
                           remove=[s["segment_id"] for s in document["segments"]])
