from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import time
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)
MEETING_ID = re.compile(r"^[0-9a-f]{32}$")


class MeetingError(Exception):
    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.status_code = status_code


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class MeetingStore:
    """Store metadata in SQLite and transcript text in files beside the database."""

    def __init__(self, path: Path, legacy_directory: Path | None = None) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        (path.parent / "transcripts").mkdir(exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT,
                    status TEXT NOT NULL CHECK(status IN ('created', 'recording', 'paused', 'ended')),
                    text_path TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, ended_at TEXT,
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    recording_since REAL, owner TEXT
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS meetings_created ON meetings(created_at DESC, id DESC)")
        if legacy_directory is not None:
            self._import_archives(legacy_directory)

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _duration(row: sqlite3.Row, now: float) -> float:
        return row["duration_seconds"] + (max(0, now - row["recording_since"]) if row["recording_since"] else 0)

    def _record(self, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            result["text"] = (self.path.parent / row["text_path"]).read_text(encoding="utf-8")
        except OSError as exc:
            raise MeetingError("无法读取会议文本文件，请检查数据目录", 500) from exc
        result["duration_seconds"] = round(self._duration(row, time.time()), 2)
        result.pop("owner")
        result.pop("recording_since")
        return result

    def _write_text(self, text_path: str, text: str) -> None:
        destination = self.path.parent / text_path
        temporary = destination.with_suffix(f".{uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as output:
                output.write(text)
                output.flush()
                os.fsync(output.fileno())
            # Readers always see a complete transcript, including during an update.
            temporary.replace(destination)
        except OSError as exc:
            raise MeetingError("无法保存会议文本文件，请检查数据目录", 500) from exc
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _require(db: sqlite3.Connection, meeting_id: str, owner: str | None) -> sqlite3.Row:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            raise MeetingError("会议不存在", 404)
        if row["owner"] != owner:
            raise MeetingError("会议已在其他页面打开，请先关闭该页面的录音")
        return row

    def create(self, title: str, language: str | None = None) -> dict[str, Any]:
        meeting_id, now = uuid4().hex, _timestamp()
        text_path = f"transcripts/{meeting_id}.txt"
        with self._connection() as db:
            self._write_text(text_path, "")
            db.execute(
                "INSERT INTO meetings (id, title, language, status, text_path, created_at, updated_at) VALUES (?, ?, ?, 'created', ?, ?, ?)",
                (meeting_id, title.strip(), language or None, text_path, now, now),
            )
            return self._record(db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone())

    def list(self) -> list[dict[str, Any]]:
        with self._connection() as db:
            return [self._record(row) for row in db.execute("SELECT * FROM meetings ORDER BY created_at DESC, id DESC")]

    def get(self, meeting_id: str) -> dict[str, Any] | None:
        if not MEETING_ID.fullmatch(meeting_id):
            return None
        with self._connection() as db:
            row = db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
            return self._record(row) if row else None

    def claim(self, meeting_id: str, owner: str) -> dict[str, Any]:
        with self._connection() as db:
            row = self._require(db, meeting_id, None)
            if row["status"] == "ended":
                raise MeetingError("会议已结束，只能查看记录")
            db.execute("UPDATE meetings SET owner = ? WHERE id = ?", (owner, meeting_id))
            return self._record(row)

    def transition(self, meeting_id: str, action: str, owner: str | None = None) -> dict[str, Any]:
        transitions = {
            "start": ({"created"}, "recording"),
            "pause": ({"recording"}, "paused"),
            "resume": ({"paused"}, "recording"),
            "end": ({"created", "recording", "paused"}, "ended"),
        }
        allowed, status = transitions[action]
        with self._connection() as db:
            row = self._require(db, meeting_id, owner)
            if row["status"] not in allowed:
                raise MeetingError("当前会议状态不支持此操作")
            now, timestamp = time.time(), _timestamp()
            db.execute(
                """UPDATE meetings SET status = ?, duration_seconds = ?, recording_since = ?,
                   updated_at = ?, ended_at = ? WHERE id = ?""",
                (status, self._duration(row, now), now if status == "recording" else None,
                 timestamp, timestamp if status == "ended" else None, meeting_id),
            )
            return self._record(db.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone())

    def save_text(self, meeting_id: str, text: str, owner: str) -> None:
        with self._connection() as db:
            row = self._require(db, meeting_id, owner)
            if row["status"] == "ended":
                raise MeetingError("会议已结束，只能查看记录")
            self._write_text(row["text_path"], text)
            now = time.time()
            db.execute(
                "UPDATE meetings SET updated_at = ?, duration_seconds = ?, recording_since = ? WHERE id = ?",
                (_timestamp(), self._duration(row, now), now if row["status"] == "recording" else None, meeting_id),
            )

    def release(self, meeting_id: str, owner: str) -> None:
        with self._connection() as db:
            row = self._require(db, meeting_id, owner)
            db.execute(
                """UPDATE meetings SET owner = NULL, recording_since = NULL, duration_seconds = ?,
                   status = ?, updated_at = ? WHERE id = ?""",
                (self._duration(row, time.time()), "paused" if row["status"] == "recording" else row["status"],
                 _timestamp(), meeting_id),
            )

    def recover(self) -> None:
        # On application restart, retain the last saved text/duration and release stale connections.
        with self._connection() as db:
            db.execute("""UPDATE meetings SET owner = NULL, recording_since = NULL,
                status = CASE WHEN status = 'recording' THEN 'paused' ELSE status END
                WHERE owner IS NOT NULL OR status = 'recording'""")

    def _import_archives(self, directory: Path) -> None:
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for path in directory.glob("*.json"):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                    meeting_id = record["id"]
                    if not MEETING_ID.fullmatch(meeting_id) or not isinstance(record["text"], str):
                        continue
                    if db.execute("SELECT 1 FROM meetings WHERE id = ?", (meeting_id,)).fetchone():
                        continue
                    created = datetime.fromisoformat(record["created_at"])
                    if created.tzinfo is None:
                        created = created.replace(tzinfo=timezone.utc)
                    timestamp = created.astimezone(timezone.utc).isoformat()
                    title = record["title"]
                    language = record.get("language")
                    if not isinstance(title, str) or (language is not None and not isinstance(language, str)):
                        continue
                    text_path = f"transcripts/{meeting_id}.txt"
                    self._write_text(text_path, record["text"])
                    db.execute(
                        """INSERT OR IGNORE INTO meetings
                        (id, title, language, status, text_path, created_at, updated_at, ended_at)
                        VALUES (?, ?, ?, 'ended', ?, ?, ?, ?)""",
                        (meeting_id, title, language, text_path, timestamp, timestamp, timestamp),
                    )
                except (OSError, ValueError, KeyError, TypeError):
                    logger.warning("Skipped invalid legacy archive: %s", path.name)
