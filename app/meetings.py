from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import shutil
import time
from typing import Any
from uuid import uuid4

from .recordings import read_audio_summary
from .transcripts import TranscriptStore, plain_text

logger = logging.getLogger(__name__)
MEETING_ID = re.compile(r"^[0-9a-f]{32}$")
MEETING_SELECT = """SELECT meetings.*, departments.name AS department_name
    FROM meetings LEFT JOIN departments ON departments.id = meetings.department_id"""


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
        (path.parent / "minutes").mkdir(exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS departments (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )
            """)
            db.execute("""
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT,
                    status TEXT NOT NULL CHECK(status IN ('created', 'recording', 'paused', 'ended')),
                    text_path TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, ended_at TEXT,
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    recording_since REAL, owner TEXT,
                    department_id TEXT REFERENCES departments(id)
                )
            """)
            if "department_id" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
                db.execute("ALTER TABLE meetings ADD COLUMN department_id TEXT REFERENCES departments(id)")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_created ON meetings(created_at DESC, id DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_department ON meetings(department_id, created_at DESC)")
            db.execute("""
                CREATE TABLE IF NOT EXISTS meeting_minutes (
                    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
                    status TEXT NOT NULL CHECK(status IN ('generating', 'ready', 'failed')),
                    file_path TEXT, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
                )
            """)
            if "source_revision" not in {row["name"] for row in db.execute("PRAGMA table_info(meeting_minutes)")}:
                db.execute("ALTER TABLE meeting_minutes ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0")
            if "file_revision" not in {row["name"] for row in db.execute("PRAGMA table_info(meeting_minutes)")}:
                db.execute("ALTER TABLE meeting_minutes ADD COLUMN file_revision INTEGER NOT NULL DEFAULT 0")
            db.execute("""CREATE TABLE IF NOT EXISTS diarization_jobs (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id), status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
            )""")
        if legacy_directory is not None:
            self._import_archives(legacy_directory)

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
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
        archived_duration = None
        try:
            directory = self.path.parent / "meetings" / row["id"]
            audio = read_audio_summary(directory)
            result["audio_available"] = bool(audio and audio.samples)
            if audio is not None:
                archived_duration = audio.duration_seconds
            if (directory / "transcript.json").exists() or (directory / "events.jsonl").exists():
                document = self.transcript(row["id"]).read()
                result.update(text=plain_text(document), segments=document["segments"],
                              speakers=document["speakers"], transcript_revision=document["revision"],
                              next_segment_id=document["next_segment_id"], processing=document["processing"])
                result["content_revision"] = document.get("content_revision", document["revision"])
            else:
                result["text"] = (self.path.parent / row["text_path"]).read_text(encoding="utf-8")
                result.update(segments=[], speakers={}, transcript_revision=0, next_segment_id=0,
                              processing={"status": "idle", "error": ""})
        except OSError as exc:
            raise MeetingError("无法读取会议文本文件，请检查数据目录", 500) from exc
        result["duration_seconds"] = round(
            archived_duration if archived_duration is not None else self._duration(row, time.time()), 2
        )
        result.pop("owner")
        result.pop("recording_since")
        return result

    def directory(self, meeting_id: str) -> Path:
        if not MEETING_ID.fullmatch(meeting_id):
            raise MeetingError("会议不存在", 404)
        return self.path.parent / "meetings" / meeting_id

    def transcript(self, meeting_id: str) -> TranscriptStore:
        return TranscriptStore(self.directory(meeting_id))

    def save_segment(self, meeting_id, owner, segment_id, text, start_ms, end_ms, capture_id):
        with self._connection() as db:
            row = self._require(db, meeting_id, owner)
            if row["status"] == "ended":
                raise MeetingError("会议已结束，只能查看记录")
            event = self.transcript(meeting_id).final(segment_id, text, start_ms, end_ms, capture_id)
            now = time.time()
            db.execute("""UPDATE meetings SET updated_at = ?, duration_seconds = ?, recording_since = ?
                WHERE id = ?""", (_timestamp(), self._duration(row, now),
                                   now if row["status"] == "recording" else None, meeting_id))
            return event

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
        row = db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone()
        if row is None:
            raise MeetingError("会议不存在", 404)
        if row["owner"] != owner:
            raise MeetingError("会议已在其他页面打开，请先关闭该页面的录音")
        return row

    def create(self, title: str, language: str | None = None, department_id: str | None = None) -> dict[str, Any]:
        meeting_id, now = uuid4().hex, _timestamp()
        text_path = f"meetings/{meeting_id}/transcript.txt"
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if department_id and not db.execute("SELECT 1 FROM departments WHERE id = ?", (department_id,)).fetchone():
                raise MeetingError("部门不存在，请重新选择", 422)
            self.transcript(meeting_id).read()
            db.execute(
                """INSERT INTO meetings (id, title, language, status, text_path, created_at, updated_at, department_id)
                   VALUES (?, ?, ?, 'created', ?, ?, ?, ?)""",
                (meeting_id, title.strip(), language or None, text_path, now, now, department_id),
            )
            return self._record(db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone())

    def list(self, *, title: str = "", department_id: str | None = None, status: str | None = None,
             created_from: datetime | None = None, created_before: datetime | None = None) -> list[dict[str, Any]]:
        conditions, values = [], []
        if title.strip():
            # Treat %, _ and backslashes as literal characters in meeting names.
            escaped = title.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            conditions.append("meetings.title LIKE ? ESCAPE '\\'")
            values.append(f"%{escaped}%")
        if department_id == "unassigned":
            conditions.append("meetings.department_id IS NULL")
        elif department_id:
            conditions.append("meetings.department_id = ?")
            values.append(department_id)
        if status:
            conditions.append("meetings.status = ?")
            values.append(status)
        for boundary, operator in ((created_from, ">="), (created_before, "<")):
            if boundary:
                conditions.append(f"meetings.created_at {operator} ?")
                values.append(boundary.astimezone(timezone.utc).isoformat())
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with self._connection() as db:
            return [self._record(row) for row in db.execute(
                MEETING_SELECT + where + " ORDER BY meetings.created_at DESC, meetings.id DESC", values,
            )]

    def get(self, meeting_id: str) -> dict[str, Any] | None:
        if not MEETING_ID.fullmatch(meeting_id):
            return None
        with self._connection() as db:
            row = db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone()
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
            return self._record(db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone())

    def list_departments(self) -> list[dict[str, Any]]:
        with self._connection() as db:
            return [dict(row) for row in db.execute("""
                SELECT departments.*, COUNT(meetings.id) AS meeting_count FROM departments
                LEFT JOIN meetings ON meetings.department_id = departments.id
                GROUP BY departments.id ORDER BY departments.created_at DESC, departments.id DESC
            """)]

    def save_department(self, name: str, department_id: str | None = None) -> dict[str, Any]:
        name = name.strip()
        if not name or len(name) > 60:
            raise MeetingError("部门名称须为 1–60 个字符", 422)
        now = _timestamp()
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if department_id:
                    if not db.execute("UPDATE departments SET name = ?, updated_at = ? WHERE id = ?",
                                      (name, now, department_id)).rowcount:
                        raise MeetingError("部门不存在", 404)
                else:
                    department_id = uuid4().hex
                    db.execute("INSERT INTO departments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                               (department_id, name, now, now))
            except sqlite3.IntegrityError as exc:
                raise MeetingError("部门名称已存在") from exc
            row = dict(db.execute("SELECT * FROM departments WHERE id = ?", (department_id,)).fetchone())
            row["meeting_count"] = db.execute("SELECT COUNT(*) FROM meetings WHERE department_id = ?", (department_id,)).fetchone()[0]
            return row

    def delete_department(self, department_id: str) -> None:
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM meetings WHERE department_id = ? LIMIT 1", (department_id,)).fetchone():
                raise MeetingError("该部门已有会议记录，不能删除")
            if not db.execute("DELETE FROM departments WHERE id = ?", (department_id,)).rowcount:
                raise MeetingError("部门不存在", 404)

    def save_text(self, meeting_id: str, text: str, owner: str) -> None:
        with self._connection() as db:
            row = self._require(db, meeting_id, owner)
            if row["status"] == "ended":
                raise MeetingError("会议已结束，只能查看记录")
            try:
                if row["text_path"].startswith("meetings/"):
                    self.transcript(meeting_id).replace_text(text)
                else:
                    self._write_text(row["text_path"], text)
            except OSError as exc:
                raise MeetingError("无法保存会议文本文件，请检查数据目录", 500) from exc
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
            db.execute("""UPDATE meeting_minutes SET status = 'failed', error = ?, updated_at = ?
                WHERE status = 'generating'""", ("服务重启导致生成中断，请重新生成纪要。", _timestamp()))
        trash = self.path.parent / ".deleted-meetings"
        if trash.exists():
            for directory in trash.iterdir():
                if not MEETING_ID.fullmatch(directory.name):
                    continue
                with self._connection() as db:
                    exists = db.execute("SELECT 1 FROM meetings WHERE id = ?", (directory.name,)).fetchone()
                if exists:
                    directory.replace(self.directory(directory.name))
                else:
                    shutil.rmtree(directory)

    def delete(self, meeting_id: str) -> None:
        directory = self.directory(meeting_id)
        trash = self.path.parent / ".deleted-meetings" / meeting_id
        moved = False
        try:
            with self._connection() as db:
                row = self._require(db, meeting_id, None)
                if row["status"] == "recording":
                    raise MeetingError("请先停止录音，再删除会议")
                if db.execute("SELECT 1 FROM meeting_minutes WHERE meeting_id = ? AND status = 'generating'", (meeting_id,)).fetchone():
                    raise MeetingError("纪要正在生成，请完成后再删除")
                if db.execute("SELECT 1 FROM diarization_jobs WHERE meeting_id = ? AND status IN ('queued', 'running')", (meeting_id,)).fetchone():
                    raise MeetingError("正在校正说话人，请完成后再删除")
                has_stage_summaries = db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stage_summaries'"
                ).fetchone()
                if has_stage_summaries and db.execute(
                    """SELECT 1 FROM stage_summaries WHERE meeting_id = ?
                    AND status IN ('pending', 'generating')""",
                    (meeting_id,),
                ).fetchone():
                    raise MeetingError("阶段总结正在生成，请完成后再删除")
                if directory.exists():
                    trash.parent.mkdir(exist_ok=True)
                    directory.replace(trash)
                    moved = True
                db.execute("DELETE FROM diarization_jobs WHERE meeting_id = ?", (meeting_id,))
                db.execute("DELETE FROM meeting_minutes WHERE meeting_id = ?", (meeting_id,))
                db.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
        except BaseException:
            if moved:
                trash.replace(directory)
            raise
        if moved:
            try:
                shutil.rmtree(trash)
            except OSError:
                logger.exception("Meeting deleted; deferred file cleanup until restart: %s", meeting_id)

    def get_minutes(self, meeting_id: str) -> dict[str, Any]:
        with self._connection() as db:
            if not db.execute("SELECT 1 FROM meetings WHERE id = ?", (meeting_id,)).fetchone():
                raise MeetingError("会议不存在", 404)
            row = db.execute("SELECT * FROM meeting_minutes WHERE meeting_id = ?", (meeting_id,)).fetchone()
        result = dict(row) if row else {
            "meeting_id": meeting_id, "status": "not_started", "file_path": None,
            "updated_at": None, "error": "",
        }
        result["text"] = ""
        directory = self.directory(meeting_id)
        document = self.transcript(meeting_id).read() if (directory / "transcript.json").exists() else {}
        result["stale"] = bool(result["file_path"] and result.get("file_revision", 0) != document.get("content_revision", 0))
        if result["file_path"]:
            try:
                result["text"] = (self.path.parent / result["file_path"]).read_text(encoding="utf-8")
            except OSError as exc:
                raise MeetingError("无法读取会议纪要文件，请检查数据目录", 500) from exc
        return result

    def processing_active(self, meeting_id: str) -> bool:
        with self._connection() as db:
            return db.execute("SELECT 1 FROM diarization_jobs WHERE meeting_id = ? AND status IN ('queued', 'running')", (meeting_id,)).fetchone() is not None

    def begin_minutes(self, meeting_id: str, source_revision: int = 0) -> None:
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
            if row is None:
                raise MeetingError("会议不存在", 404)
            if row["status"] != "ended":
                raise MeetingError("请先结束会议，再生成完整会议纪要")
            current = db.execute("SELECT status FROM meeting_minutes WHERE meeting_id = ?", (meeting_id,)).fetchone()
            if current and current["status"] == "generating":
                raise MeetingError("会议纪要正在生成中")
            db.execute("""INSERT INTO meeting_minutes (meeting_id, status, updated_at, source_revision)
                VALUES (?, 'generating', ?, ?) ON CONFLICT(meeting_id) DO UPDATE
                SET status = 'generating', updated_at = excluded.updated_at, error = '',
                    source_revision = excluded.source_revision""",
                (meeting_id, _timestamp(), source_revision))

    def save_minutes(self, meeting_id: str, text: str) -> None:
        # Keep the previous file during regeneration; replace it only after success.
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM meeting_minutes WHERE meeting_id = ?", (meeting_id,)).fetchone()
            if row is None or row["status"] != "generating":
                raise MeetingError("没有正在进行的纪要任务")
            file_path = f"meetings/{meeting_id}/minutes.md"
            self._write_text(file_path, text)
            db.execute("""UPDATE meeting_minutes SET status = 'ready', file_path = ?,
                updated_at = ?, error = '', file_revision = source_revision
                WHERE meeting_id = ?""", (file_path, _timestamp(), meeting_id))

    def fail_minutes(self, meeting_id: str, error: str) -> None:
        with self._connection() as db:
            db.execute("""UPDATE meeting_minutes SET status = 'failed', error = ?, updated_at = ?
                WHERE meeting_id = ? AND status = 'generating'""", (error, _timestamp(), meeting_id))

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
