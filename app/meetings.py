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
from .minutes_formats import DEFAULT_MINUTES_FORMAT_ID, DEFAULT_MINUTES_FORMAT_NAME, DEFAULT_MINUTES_PROMPT

logger = logging.getLogger(__name__)
MEETING_ID = re.compile(r"^[0-9a-f]{32}$")
MEETING_SELECT = """SELECT meetings.*, departments.name AS department_name,
    minutes_formats.name AS minutes_format_name, minutes_formats.prompt AS minutes_format_prompt,
    users.account AS creator_account, users.employee_id AS creator_employee_id,
    meeting_imports.status AS import_status, meeting_imports.stage AS import_stage,
    meeting_imports.filename AS import_filename, meeting_imports.error AS import_error,
    meeting_imports.processed_samples AS import_processed_samples,
    meeting_imports.total_samples AS import_total_samples
    FROM meetings LEFT JOIN departments ON departments.id = meetings.department_id
    LEFT JOIN minutes_formats ON minutes_formats.id = meetings.minutes_format_id
    LEFT JOIN users ON users.id = meetings.user_id
    LEFT JOIN meeting_imports ON meeting_imports.meeting_id = meetings.id"""


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
            db.execute("""CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, account TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL, department_id TEXT NOT NULL REFERENCES departments(id),
                employee_id TEXT NOT NULL, created_at TEXT NOT NULL,
                is_department_admin INTEGER NOT NULL DEFAULT 0
            )""")
            if "is_department_admin" not in {row["name"] for row in db.execute("PRAGMA table_info(users)")}:
                db.execute("ALTER TABLE users ADD COLUMN is_department_admin INTEGER NOT NULL DEFAULT 0")
            db.execute("""CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL, created_at TEXT NOT NULL
            )""")
            db.execute("""
                CREATE TABLE IF NOT EXISTS departments (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )
            """)
            db.execute("""
                CREATE TABLE IF NOT EXISTS minutes_formats (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    prompt TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )
            """)
            now = _timestamp()
            db.execute("""INSERT OR IGNORE INTO minutes_formats
                (id, name, prompt, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)""",
                (DEFAULT_MINUTES_FORMAT_ID, DEFAULT_MINUTES_FORMAT_NAME, DEFAULT_MINUTES_PROMPT, now, now))
            db.execute("""
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT,
                    status TEXT NOT NULL CHECK(status IN ('created', 'recording', 'paused', 'ended')),
                    text_path TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, ended_at TEXT,
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    recording_since REAL, owner TEXT,
                    department_id TEXT REFERENCES departments(id),
                    minutes_format_id TEXT REFERENCES minutes_formats(id),
                    key_speakers TEXT NOT NULL DEFAULT '[]',
                    user_id TEXT REFERENCES users(id)
                )
            """)
            if "department_id" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
                db.execute("ALTER TABLE meetings ADD COLUMN department_id TEXT REFERENCES departments(id)")
            if "user_id" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
                db.execute("ALTER TABLE meetings ADD COLUMN user_id TEXT REFERENCES users(id)")
            if "minutes_format_id" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
                db.execute("ALTER TABLE meetings ADD COLUMN minutes_format_id TEXT REFERENCES minutes_formats(id)")
            if "key_speakers" not in {row["name"] for row in db.execute("PRAGMA table_info(meetings)")}:
                db.execute("ALTER TABLE meetings ADD COLUMN key_speakers TEXT NOT NULL DEFAULT '[]'")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_created ON meetings(created_at DESC, id DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_department ON meetings(department_id, created_at DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_user ON meetings(user_id, created_at DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS meetings_minutes_format ON meetings(minutes_format_id)")
            db.execute("""CREATE TABLE IF NOT EXISTS voiceprints (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL, department_id TEXT REFERENCES departments(id),
                embedding TEXT NOT NULL, duration_seconds REAL NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('recording', 'import')),
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )""")
            if "department_id" not in {row["name"] for row in db.execute("PRAGMA table_info(voiceprints)")}:
                db.execute("ALTER TABLE voiceprints ADD COLUMN department_id TEXT REFERENCES departments(id)")
            db.execute("CREATE INDEX IF NOT EXISTS voiceprints_user ON voiceprints(user_id, created_at DESC)")
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
            db.execute("""CREATE TABLE IF NOT EXISTS meeting_imports (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
                filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT NOT NULL DEFAULT 'transcribing', error TEXT NOT NULL DEFAULT '',
                processed_samples INTEGER NOT NULL DEFAULT 0, total_samples INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
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
        try:
            configured_key_speakers = json.loads(result.get("key_speakers") or "[]")
        except (TypeError, ValueError):
            configured_key_speakers = []
        if not isinstance(configured_key_speakers, list):
            configured_key_speakers = []
        result["key_speakers"] = configured_key_speakers
        imported = {key.removeprefix("import_"): result.pop(key)
                    for key in tuple(result) if key.startswith("import_")}
        result["source"] = "wav" if imported.get("status") else "recording"
        result["import_job"] = imported if imported.get("status") else None
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
                result["key_speakers"] = self._key_speaker_status(configured_key_speakers, document)
            else:
                result["text"] = (self.path.parent / row["text_path"]).read_text(encoding="utf-8")
                result.update(segments=[], speakers={}, transcript_revision=0, next_segment_id=0,
                              processing={"status": "idle", "error": ""})
                result["key_speakers"] = self._key_speaker_status(configured_key_speakers, {})
        except OSError as exc:
            raise MeetingError("无法读取会议文本文件，请检查数据目录", 500) from exc
        result["duration_seconds"] = round(
            archived_duration if archived_duration is not None else self._duration(row, time.time()), 2
        )
        result.pop("owner")
        result.pop("recording_since")
        return result

    @staticmethod
    def _key_speaker_status(configured: list[dict[str, Any]], document: dict[str, Any]) -> list[dict[str, Any]]:
        detected = {
            speaker_id
            for segment in document.get("segments", [])
            for speaker_id in segment.get("speaker_ids", [])
        }
        return [
            {**item, "status": "detected" if item.get("voiceprint_id") in detected else "not_detected"}
            for item in configured
            if isinstance(item, dict) and item.get("voiceprint_id")
        ]

    def directory(self, meeting_id: str) -> Path:
        if not MEETING_ID.fullmatch(meeting_id):
            raise MeetingError("会议不存在", 404)
        return self.path.parent / "meetings" / meeting_id

    def transcript(self, meeting_id: str) -> TranscriptStore:
        return TranscriptStore(self.directory(meeting_id))

    def save_segment(self, meeting_id, owner, segment_id, text, start_ms, end_ms, capture_id, user_id=None):
        with self._connection() as db:
            row = self._require(db, meeting_id, owner, user_id)
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
    def _require(db: sqlite3.Connection, meeting_id: str, owner: str | None, user_id: str | None = None) -> sqlite3.Row:
        db.execute("BEGIN IMMEDIATE")
        values: list[Any] = [meeting_id]
        where = "meetings.id = ?"
        if user_id is not None:
            where += " AND meetings.user_id = ?"
            values.append(user_id)
        row = db.execute(MEETING_SELECT + " WHERE " + where, values).fetchone()
        if row is None:
            raise MeetingError("会议不存在", 404)
        if row["owner"] != owner:
            raise MeetingError("会议已在其他页面打开，请先关闭该页面的录音")
        return row

    def create(self, title: str, language: str | None = None, department_id: str | None = None,
               minutes_format_id: str | None = None, key_speaker_ids: list[str] | None = None,
               *, imported_audio: Path | None = None, filename: str = "", user_id: str | None = None,
               import_pending: bool = False) -> dict[str, Any]:
        meeting_id, now = uuid4().hex, _timestamp()
        text_path = f"meetings/{meeting_id}/transcript.txt"
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if user_id:
                user = db.execute("SELECT department_id FROM users WHERE id = ?", (user_id,)).fetchone()
                if user is None:
                    raise MeetingError("用户不存在", 401)
                department_id = user["department_id"]
            if department_id and not db.execute("SELECT 1 FROM departments WHERE id = ?", (department_id,)).fetchone():
                raise MeetingError("部门不存在，请重新选择", 422)
            minutes_format_id = minutes_format_id or DEFAULT_MINUTES_FORMAT_ID
            if not db.execute("SELECT 1 FROM minutes_formats WHERE id = ?", (minutes_format_id,)).fetchone():
                raise MeetingError("纪要格式不存在，请重新选择", 422)
            key_speakers = self._resolve_key_speakers(db, key_speaker_ids or [], user_id, department_id)
            audio = read_audio_summary(imported_audio) if imported_audio else None
            directory = self.directory(meeting_id)
            if imported_audio:
                if not audio or not audio.samples:
                    raise MeetingError("音频文件没有有效音频", 422)
                directory.parent.mkdir(parents=True, exist_ok=True)
                imported_audio.replace(directory)
            try:
                self.transcript(meeting_id).read()
                db.execute(
                    """INSERT INTO meetings (id, title, language, status, text_path, created_at, updated_at,
                       department_id, minutes_format_id, key_speakers, ended_at, duration_seconds, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (meeting_id, title.strip(), language or None, "ended" if audio or import_pending else "created", text_path,
                     now, now, department_id, minutes_format_id, key_speakers,
                     now if audio or import_pending else None, audio.duration_seconds if audio else 0, user_id),
                )
                if audio:
                    db.execute("""INSERT INTO meeting_imports (meeting_id, filename, total_samples, updated_at)
                        VALUES (?, ?, ?, ?)""", (meeting_id, filename, audio.samples, now))
                elif import_pending:
                    db.execute("""INSERT INTO meeting_imports
                        (meeting_id, filename, status, stage, total_samples, updated_at)
                        VALUES (?, ?, 'queued', 'initializing', 0, ?)""", (meeting_id, filename, now))
            except BaseException:
                if imported_audio:
                    shutil.rmtree(directory)
                raise
            return self._record(db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone())

    def list(self, *, title: str = "", department_id: str | None = None, status: str | None = None,
             created_from: datetime | None = None, created_before: datetime | None = None,
             user_id: str | None = None) -> list[dict[str, Any]]:
        conditions, values = [], []
        if user_id is not None:
            conditions.append("meetings.user_id = ?")
            values.append(user_id)
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

    def get(self, meeting_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        if not MEETING_ID.fullmatch(meeting_id):
            return None
        with self._connection() as db:
            values: list[Any] = [meeting_id]
            where = "meetings.id = ?"
            if user_id is not None:
                where += " AND meetings.user_id = ?"
                values.append(user_id)
            row = db.execute(MEETING_SELECT + " WHERE " + where, values).fetchone()
            return self._record(row) if row else None

    def attach_import(self, meeting_id: str, imported_audio: Path, filename: str,
                      user_id: str | None = None) -> dict[str, Any]:
        audio = read_audio_summary(imported_audio)
        if not audio or not audio.samples:
            raise MeetingError("音频文件没有有效音频", 422)
        destination = self.directory(meeting_id)
        with self._connection() as db:
            row = db.execute(
                MEETING_SELECT + " WHERE meetings.id = ?" + (" AND meetings.user_id = ?" if user_id else ""),
                (meeting_id, user_id) if user_id else (meeting_id,),
            ).fetchone()
            if row is None:
                raise MeetingError("会议不存在", 404)
            destination.mkdir(parents=True, exist_ok=True)
            for item in imported_audio.iterdir():
                item.replace(destination / item.name)
            self.transcript(meeting_id).read()
            now = _timestamp()
            db.execute("""UPDATE meetings SET status = 'ended', duration_seconds = ?,
                ended_at = ?, updated_at = ? WHERE id = ?""",
                       (audio.duration_seconds, now, now, meeting_id))
            db.execute("""UPDATE meeting_imports SET filename = ?, status = 'queued',
                stage = 'transcribing', error = '', processed_samples = 0,
                total_samples = ?, updated_at = ? WHERE meeting_id = ?""",
                       (filename, audio.samples, now, meeting_id))
            return self._record(db.execute(MEETING_SELECT + " WHERE meetings.id = ?", (meeting_id,)).fetchone())

    def claim(self, meeting_id: str, owner: str, user_id: str | None = None) -> dict[str, Any]:
        with self._connection() as db:
            row = self._require(db, meeting_id, None, user_id)
            if row["status"] == "ended":
                raise MeetingError("会议已结束，只能查看记录")
            db.execute("UPDATE meetings SET owner = ? WHERE id = ?", (owner, meeting_id))
            return self._record(row)

    def transition(self, meeting_id: str, action: str, owner: str | None = None, user_id: str | None = None) -> dict[str, Any]:
        transitions = {
            "start": ({"created"}, "recording"),
            "pause": ({"recording"}, "paused"),
            "resume": ({"paused"}, "recording"),
            "end": ({"created", "recording", "paused"}, "ended"),
        }
        allowed, status = transitions[action]
        with self._connection() as db:
            row = self._require(db, meeting_id, owner, user_id)
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

    def list_minutes_formats(self) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = [dict(row) for row in db.execute("""
                SELECT minutes_formats.*, COUNT(meetings.id) AS meeting_count
                FROM minutes_formats LEFT JOIN meetings ON meetings.minutes_format_id = minutes_formats.id
                GROUP BY minutes_formats.id ORDER BY minutes_formats.is_default DESC, minutes_formats.updated_at DESC
            """)]
        for row in rows:
            row["is_default"] = bool(row["is_default"])
        return rows

    def save_minutes_format(self, name: str, prompt: str, format_id: str | None = None) -> dict[str, Any]:
        name, prompt = name.strip(), prompt.strip()
        if not name or len(name) > 60:
            raise MeetingError("纪要格式名称须为 1–60 个字符", 422)
        if not prompt or len(prompt) > 20000:
            raise MeetingError("模板提示词须为 1–20000 个字符", 422)
        now = _timestamp()
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if format_id:
                    if not db.execute("UPDATE minutes_formats SET name = ?, prompt = ?, updated_at = ? WHERE id = ?",
                                      (name, prompt, now, format_id)).rowcount:
                        raise MeetingError("纪要格式不存在", 404)
                else:
                    format_id = uuid4().hex
                    db.execute("INSERT INTO minutes_formats (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                               (format_id, name, prompt, now, now))
            except sqlite3.IntegrityError as exc:
                raise MeetingError("纪要格式名称已存在") from exc
            row = dict(db.execute("SELECT * FROM minutes_formats WHERE id = ?", (format_id,)).fetchone())
            row["meeting_count"] = db.execute("SELECT COUNT(*) FROM meetings WHERE minutes_format_id = ?", (format_id,)).fetchone()[0]
            row["is_default"] = bool(row["is_default"])
            return row

    def delete_minutes_format(self, format_id: str) -> None:
        with self._connection() as db:
            row = db.execute("SELECT is_default FROM minutes_formats WHERE id = ?", (format_id,)).fetchone()
            if row is None:
                raise MeetingError("纪要格式不存在", 404)
            if row["is_default"]:
                raise MeetingError("通用会议格式不能删除")
            if db.execute("SELECT 1 FROM meetings WHERE minutes_format_id = ? LIMIT 1", (format_id,)).fetchone():
                raise MeetingError("该格式已有会议使用，不能删除")
            db.execute("DELETE FROM minutes_formats WHERE id = ?", (format_id,))

    def list_voiceprints(self, user_id: str | None = None, department_id: str | None = None) -> list[dict[str, Any]]:
        with self._connection() as db:
            query = """SELECT voiceprints.id, voiceprints.user_id, voiceprints.name,
                voiceprints.department_id, departments.name AS department_name,
                voiceprints.embedding, voiceprints.duration_seconds, voiceprints.source,
                voiceprints.created_at, voiceprints.updated_at
                FROM voiceprints LEFT JOIN departments ON departments.id = voiceprints.department_id"""
            values: tuple[Any, ...] = ()
            if user_id is not None:
                query += " WHERE voiceprints.user_id = ?"
                values = (user_id,)
            if department_id is not None:
                query += " WHERE " if " WHERE " not in query else " AND "
                query += "voiceprints.department_id = ?"
                values += (department_id,)
            rows = db.execute(query + " ORDER BY voiceprints.created_at DESC, voiceprints.id DESC", values).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _resolve_key_speakers(db: sqlite3.Connection, ids: list[str], user_id: str | None,
                              department_id: str | None) -> str:
        normalized = list(dict.fromkeys(ids))
        if len(normalized) > 20 or any(not isinstance(item, str) or not MEETING_ID.fullmatch(item) for item in normalized):
            raise MeetingError("重点人员选择无效", 422)
        if not normalized:
            return "[]"
        placeholders = ",".join("?" for _ in normalized)
        rows = db.execute(
            f"SELECT id, name, department_id FROM voiceprints WHERE id IN ({placeholders})",
            normalized,
        ).fetchall()
        if len(rows) != len(normalized):
            raise MeetingError("所选重点人员声纹不存在，请刷新后重试", 422)
        account = db.execute("SELECT account, is_department_admin FROM users WHERE id = ?", (user_id,)).fetchone() if user_id else None
        if account is not None and account["account"].casefold() != "admin" and not account["is_department_admin"]:
            if any(row["department_id"] != department_id for row in rows):
                raise MeetingError("只能选择所属部门的重点人员", 422)
        names = {row["id"]: row["name"] for row in rows}
        return json.dumps([{"voiceprint_id": item, "name": names[item]} for item in normalized], ensure_ascii=False)

    def create_voiceprint(self, user_id: str, name: str, department_id: str, embedding: list[float],
                          duration_seconds: float, source: str) -> dict[str, Any]:
        voiceprint_id, now = uuid4().hex, _timestamp()
        with self._connection() as db:
            department = db.execute("SELECT name FROM departments WHERE id = ?", (department_id,)).fetchone()
            if department is None:
                raise MeetingError("部门不存在，请重新选择", 422)
            db.execute(
                "INSERT INTO voiceprints (id, user_id, name, department_id, embedding, duration_seconds, source, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (voiceprint_id, user_id, name, department_id,
                 json.dumps(embedding, separators=(",", ":")), duration_seconds, source, now, now),
            )
        return {"id": voiceprint_id, "user_id": user_id, "name": name,
                "department_id": department_id, "department_name": department["name"],
                "duration_seconds": duration_seconds, "source": source,
                "created_at": now, "updated_at": now}

    def delete_voiceprint(self, voiceprint_id: str) -> None:
        with self._connection() as db:
            if not db.execute("DELETE FROM voiceprints WHERE id = ?", (voiceprint_id,)).rowcount:
                raise MeetingError("声纹记录不存在", 404)

    def rename_voiceprint(self, voiceprint_id: str, name: str) -> dict[str, Any]:
        with self._connection() as db:
            row = db.execute(
                "SELECT voiceprints.*, departments.name AS department_name FROM voiceprints "
                "LEFT JOIN departments ON departments.id = voiceprints.department_id WHERE voiceprints.id = ?",
                (voiceprint_id,),
            ).fetchone()
            if row is None:
                raise MeetingError("声纹记录不存在", 404)
            updated_at = _timestamp()
            db.execute("UPDATE voiceprints SET name = ?, updated_at = ? WHERE id = ?", (name, updated_at, voiceprint_id))
            updated = dict(row)
            updated["name"] = name
            updated["updated_at"] = updated_at
            updated.pop("embedding", None)
            return updated

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

    def release(self, meeting_id: str, owner: str, user_id: str | None = None) -> None:
        with self._connection() as db:
            row = self._require(db, meeting_id, owner, user_id)
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

    def delete(self, meeting_id: str, user_id: str | None = None) -> None:
        directory = self.directory(meeting_id)
        trash = self.path.parent / ".deleted-meetings" / meeting_id
        moved = False
        try:
            with self._connection() as db:
                row = self._require(db, meeting_id, None, user_id)
                if row["status"] not in {"created", "ended"}:
                    raise MeetingError("只能删除未开始或已结束的会议")
                if db.execute("SELECT 1 FROM meeting_imports WHERE meeting_id = ? AND status IN ('queued', 'running')", (meeting_id,)).fetchone():
                    raise MeetingError("正在处理导入音频，请完成后再删除会议")
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
                db.execute("DELETE FROM meeting_imports WHERE meeting_id = ?", (meeting_id,))
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
