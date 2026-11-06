"""Durable, sample-windowed summaries generated outside the ASR hot path."""
from __future__ import annotations

import asyncio
from contextlib import closing
from datetime import datetime, timezone
import logging
import sqlite3
from typing import Any, Protocol
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from .config import Settings
from .meetings import MeetingError, MeetingStore
from .minutes import MinutesGenerationError, OpenAIMinutesGenerator
from .model_configs import ModelConfig, ModelConfigStore
from .recordings import SAMPLE_RATE, read_audio_summary
from .transcripts import plain_text

logger = logging.getLogger(__name__)

STAGE_PROMPT = """请对下面时间段内的聊天内容进行简洁、忠实的总结概括。
输入中的[讲话人]标记表示对应的发言人。必须保留每条观点、建议、结论与讲话人的对应关系，
例如“张三认为……”或“李四提出……”，不要把不同人的发言合并成没有主语的结论。
必须准确保留原文明确出现的数字、日期、人员、责任人、截止时间、决策和未解决问题，
不要遗漏、改写或臆测这些事实。
只总结本阶段实际讨论的内容，不要按照预设目标、固定栏目或任务类型整理，
也不要推断原文没有明确表达的信息。请使用自然连贯的中文段落，
不要重复会议名称或时间范围，不要添加开场说明。"""


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class StageSummaryGenerator(Protocol):
    async def generate(
        self,
        title: str,
        transcript: str,
        start_seconds: float,
        end_seconds: float,
    ) -> str:
        ...


class OpenAIStageSummaryGenerator:
    def __init__(self, config: ModelConfig, settings: Settings) -> None:
        self.delegate = OpenAIMinutesGenerator(config, settings)
        self.max_tokens = min(settings.llm_max_tokens, settings.stage_summary_max_tokens)

    async def generate(
        self,
        title: str,
        transcript: str,
        start_seconds: float,
        end_seconds: float,
    ) -> str:
        prompt = (
            f"{STAGE_PROMPT}\n\n"
            f"本阶段范围：{start_seconds:g}–{end_seconds:g} 秒。"
        )
        return await self.delegate.generate_from_prompt(
            title,
            transcript,
            prompt,
            self.max_tokens,
            truncation_setting="STAGE_SUMMARY_MAX_TOKENS",
        )

    async def close(self) -> None:
        await self.delegate.close()


class StageSummaryStore:
    def __init__(self, path) -> None:
        self.path = path
        with self._connection() as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS stage_summaries (
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                start_sample INTEGER NOT NULL,
                end_sample INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'generating', 'ready', 'failed')),
                text TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
                source_revision INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (meeting_id, start_sample, end_sample)
            )""")
            db.execute("""CREATE INDEX IF NOT EXISTS stage_summaries_pending
                ON stage_summaries(status, updated_at)""")
            db.execute("""CREATE TABLE IF NOT EXISTS stage_summary_sessions (
                meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                reconciled_updated_at TEXT NOT NULL DEFAULT ''
            )""")
            columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(stage_summary_sessions)")
            }
            if "reconciled_updated_at" not in columns:
                db.execute("""ALTER TABLE stage_summary_sessions
                    ADD COLUMN reconciled_updated_at TEXT NOT NULL DEFAULT ''""")
            db.execute("""CREATE TRIGGER IF NOT EXISTS stage_summary_register_meeting
                AFTER INSERT ON meetings BEGIN
                    INSERT OR IGNORE INTO stage_summary_sessions (meeting_id, created_at)
                    VALUES (NEW.id, NEW.created_at);
                END""")
            db.execute("""INSERT OR IGNORE INTO stage_summary_sessions (meeting_id, created_at)
                SELECT meeting_id, MIN(updated_at) FROM stage_summaries GROUP BY meeting_id""")

    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return closing(db)

    @staticmethod
    def _public(row) -> dict[str, Any]:
        result = dict(row)
        result["start_seconds"] = result.pop("start_sample") / SAMPLE_RATE
        result["end_seconds"] = result.pop("end_sample") / SAMPLE_RATE
        return result

    def recover(self) -> None:
        with self._connection() as db, db:
            db.execute("""UPDATE stage_summaries SET status = 'pending',
                error = '', updated_at = ? WHERE status = 'generating'""", (_timestamp(),))

    def recoverable(self) -> list[tuple[str, str]]:
        with self._connection() as db:
            return [
                (row["meeting_id"], row["updated_at"])
                for row in db.execute("""SELECT stage_summary_sessions.meeting_id,
                    meetings.updated_at
                    FROM stage_summary_sessions JOIN meetings
                    ON meetings.id = stage_summary_sessions.meeting_id
                    WHERE meetings.status IN ('paused', 'ended')
                    AND NOT EXISTS (SELECT 1 FROM meeting_imports
                        WHERE meeting_imports.meeting_id = stage_summary_sessions.meeting_id
                        AND meeting_imports.status != 'ready')
                    AND meetings.updated_at != stage_summary_sessions.reconciled_updated_at""")
            ]

    def mark_reconciled(self, meeting_id: str, meeting_updated_at: str) -> None:
        with self._connection() as db, db:
            db.execute("""UPDATE stage_summary_sessions SET reconciled_updated_at = ?
                WHERE meeting_id = ?""", (meeting_updated_at, meeting_id))

    def has_pending(self) -> bool:
        with self._connection() as db:
            return db.execute(
                "SELECT 1 FROM stage_summaries WHERE status = 'pending' LIMIT 1"
            ).fetchone() is not None

    def plan(
        self,
        meeting_id: str,
        watermark: int,
        window: int,
        close_window: bool,
    ) -> None:
        if watermark < 0:
            return
        with self._connection() as db, db:
            if not db.execute(
                "SELECT 1 FROM meetings WHERE id = ?", (meeting_id,)
            ).fetchone():
                return
            db.execute(
                """INSERT OR IGNORE INTO stage_summary_sessions (meeting_id, created_at)
                VALUES (?, ?)""",
                (meeting_id, _timestamp()),
            )
            row = db.execute(
                "SELECT MAX(end_sample) AS value FROM stage_summaries WHERE meeting_id = ?",
                (meeting_id,),
            ).fetchone()
            cursor = row["value"] or 0
            intervals = []
            while cursor + window <= watermark:
                intervals.append((cursor, cursor + window))
                cursor += window
            if close_window and cursor < watermark:
                intervals.append((cursor, watermark))
            now = _timestamp()
            for start, end in intervals:
                db.execute("""INSERT OR IGNORE INTO stage_summaries
                    (meeting_id, start_sample, end_sample, status, updated_at)
                    VALUES (?, ?, ?, 'pending', ?)""", (meeting_id, start, end, now))

    def list(self, meeting_id: str) -> list[dict[str, Any]]:
        with self._connection() as db:
            if not db.execute("SELECT 1 FROM meetings WHERE id = ?", (meeting_id,)).fetchone():
                raise MeetingError("会议不存在", 404)
            rows = db.execute("""SELECT * FROM stage_summaries WHERE meeting_id = ?
                ORDER BY start_sample, end_sample""", (meeting_id,)).fetchall()
        return [self._public(row) for row in rows]

    def get(self, row: dict[str, Any]) -> dict[str, Any] | None:
        with self._connection() as db:
            result = db.execute("""SELECT * FROM stage_summaries
                WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (row["meeting_id"], row["start_sample"], row["end_sample"])).fetchone()
        return self._public(result) if result else None

    def claim(self, excluded_meetings: set[str] | None = None) -> dict[str, Any] | None:
        with self._connection() as db, db:
            db.execute("BEGIN IMMEDIATE")
            excluded_meetings = excluded_meetings or set()
            query = "SELECT * FROM stage_summaries WHERE status = 'pending'"
            values: list[str] = []
            if excluded_meetings:
                placeholders = ", ".join("?" for _ in excluded_meetings)
                query += f" AND meeting_id NOT IN ({placeholders})"
                values.extend(excluded_meetings)
            query += " ORDER BY updated_at, meeting_id, start_sample LIMIT 1"
            row = db.execute(query, values).fetchone()
            if row is None:
                return None
            db.execute("""UPDATE stage_summaries SET status = 'generating', attempts = attempts + 1,
                error = '', updated_at = ? WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (_timestamp(), row["meeting_id"], row["start_sample"], row["end_sample"]))
            updated = dict(row)
            updated["status"] = "generating"
            updated["attempts"] += 1
            return updated

    def defer(self, row: dict[str, Any]) -> None:
        with self._connection() as db, db:
            db.execute(
                """UPDATE stage_summaries SET status = 'pending', attempts = MAX(0, attempts - 1),
                error = '', updated_at = ?
                WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (_timestamp(), row["meeting_id"], row["start_sample"], row["end_sample"]),
            )

    def save(self, row: dict[str, Any], text: str, source_revision: int) -> None:
        with self._connection() as db, db:
            db.execute(
                """UPDATE stage_summaries SET status = 'ready', text = ?, error = '',
                source_revision = ?, updated_at = ?
                WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (
                    text,
                    source_revision,
                    _timestamp(),
                    row["meeting_id"],
                    row["start_sample"],
                    row["end_sample"],
                ),
            )

    def retry(self, row: dict[str, Any]) -> None:
        with self._connection() as db, db:
            db.execute("""UPDATE stage_summaries SET status = 'pending', updated_at = ?
                WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (_timestamp(), row["meeting_id"], row["start_sample"], row["end_sample"]))

    def fail(self, row: dict[str, Any], error: str) -> None:
        with self._connection() as db, db:
            db.execute("""UPDATE stage_summaries SET status = 'failed', error = ?, updated_at = ?
                WHERE meeting_id = ? AND start_sample = ? AND end_sample = ?""",
                (error, _timestamp(), row["meeting_id"], row["start_sample"], row["end_sample"]))

    def retry_failed(self, meeting_id: str) -> list[dict[str, Any]]:
        with self._connection() as db, db:
            if not db.execute(
                "SELECT 1 FROM meetings WHERE id = ?", (meeting_id,)
            ).fetchone():
                raise MeetingError("会议不存在", 404)
            db.execute("""UPDATE stage_summaries SET status = 'pending', attempts = 0,
                error = '', updated_at = ? WHERE meeting_id = ? AND status = 'failed'""",
                (_timestamp(), meeting_id))
            rows = db.execute("""SELECT * FROM stage_summaries
                WHERE meeting_id = ? AND status = 'pending' ORDER BY start_sample""",
                (meeting_id,)).fetchall()
        return [self._public(row) for row in rows]


class StageSummaryService:
    """Coalesce ASR notifications and generate durable summaries in one background worker."""

    def __init__(
        self,
        meetings: MeetingStore,
        models: ModelConfigStore | None,
        settings: Settings,
        generator: StageSummaryGenerator | None = None,
    ) -> None:
        self.meetings = meetings
        self.models = models
        self.settings = settings
        self.generator = generator
        self.store = StageSummaryStore(meetings.path)
        self.notifications: dict[str, int] = {}
        self.boundaries: dict[str, list[int]] = {}
        self.wake = asyncio.Event()
        self.worker: asyncio.Task | None = None
        self.reconciler: asyncio.Task | None = None
        self.listeners: dict[str, dict[str, asyncio.Queue]] = {}
        self.blocked_meetings: set[str] = set()

    async def start(self) -> None:
        await asyncio.to_thread(self.store.recover)
        self.worker = asyncio.create_task(self._run(), name="stage-summaries")
        if await asyncio.to_thread(self.store.has_pending):
            self.wake.set()
        self.reconciler = asyncio.create_task(
            self._recover_missing_windows(), name="stage-summary-reconciliation"
        )

    def _reconcile(self) -> None:
        window = self.settings.stage_summary_window_seconds * SAMPLE_RATE
        for meeting_id, meeting_updated_at in self.store.recoverable():
            try:
                audio = read_audio_summary(self.meetings.directory(meeting_id))
                if audio is not None:
                    document = self.meetings.transcript(meeting_id).read()
                    confirmed_samples = min(
                        audio.samples,
                        max(
                            (
                                round(
                                    segment.get("end_ms", 0)
                                    * audio.sample_rate
                                    / 1000
                                )
                                for segment in document["segments"]
                            ),
                            default=0,
                        ),
                    )
                    self.store.plan(
                        meeting_id, confirmed_samples, window, close_window=True
                    )
                self.store.mark_reconciled(meeting_id, meeting_updated_at)
            except Exception:
                logger.exception(
                    "Could not reconcile stage summary windows for %s", meeting_id
                )

    async def _recover_missing_windows(self) -> None:
        try:
            await asyncio.to_thread(self._reconcile)
            if await asyncio.to_thread(self.store.has_pending):
                self.wake.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Stage summary startup reconciliation failed")

    def offer(self, meeting_id: str, watermark_samples: int) -> None:
        self.blocked_meetings.discard(meeting_id)
        self._notify(meeting_id, watermark_samples)

    def notify_diarization(self, meeting_id: str) -> None:
        self.blocked_meetings.discard(meeting_id)
        self.wake.set()

    async def finish(self, meeting_id: str, total_samples: int) -> None:
        """Persist an exact pause/end boundary without waiting for generation."""
        self.blocked_meetings.discard(meeting_id)
        try:
            await asyncio.to_thread(
                self.store.plan,
                meeting_id,
                total_samples,
                self.settings.stage_summary_window_seconds * SAMPLE_RATE,
                True,
            )
            meeting = await asyncio.to_thread(self.meetings.get, meeting_id)
            if meeting is not None:
                await asyncio.to_thread(
                    self.store.mark_reconciled, meeting_id, meeting["updated_at"]
                )
        except Exception:
            # Do not turn a successful recording control into a failure. The worker
            # retains the exact boundary and retries the database operation.
            logger.exception("Could not persist stage summary boundary; retrying")
            self._notify(meeting_id, total_samples, close_window=True)
        self.wake.set()

    def _notify(
        self,
        meeting_id: str,
        samples: int,
        close_window: bool = False,
    ) -> None:
        self.notifications[meeting_id] = max(
            self.notifications.get(meeting_id, 0), samples
        )
        if close_window:
            boundaries = self.boundaries.setdefault(meeting_id, [])
            if not boundaries or boundaries[-1] != samples:
                boundaries.append(samples)
        self.wake.set()

    async def list(self, meeting_id: str) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.store.list, meeting_id)

    async def retry_failed(self, meeting_id: str) -> int:
        rows = await asyncio.to_thread(self.store.retry_failed, meeting_id)
        for summary in rows:
            self._publish(meeting_id, {"type": "stage_summary.update", "summary": summary})
        if rows:
            self.wake.set()
        return len(rows)

    def subscribe(self, meeting_id: str, token: str) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=32)
        self.listeners.setdefault(meeting_id, {})[token] = queue
        return queue

    def unsubscribe(self, meeting_id: str, token: str) -> None:
        listeners = self.listeners.get(meeting_id, {})
        listeners.pop(token, None)
        if not listeners:
            self.listeners.pop(meeting_id, None)

    def deleted(self, meeting_id: str) -> None:
        self.notifications.pop(meeting_id, None)
        self.boundaries.pop(meeting_id, None)
        self.blocked_meetings.discard(meeting_id)
        self._publish(meeting_id, {"type": "deleted"})

    def _publish(self, meeting_id: str, event: dict[str, Any]) -> None:
        for queue in tuple(self.listeners.get(meeting_id, {}).values()):
            if event["type"] == "deleted":
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(event)
            elif queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync"})
            else:
                queue.put_nowait(event)

    async def _publish_row(self, row: dict[str, Any]) -> None:
        summary = await asyncio.to_thread(self.store.get, row)
        if summary is not None:
            self._publish(row["meeting_id"], {"type": "stage_summary.update", "summary": summary})

    async def _run(self) -> None:
        while True:
            notifications: dict[str, int] = {}
            boundaries: dict[str, list[int]] = {}
            try:
                await self.wake.wait()
                self.wake.clear()
                notifications, self.notifications = self.notifications, {}
                boundaries, self.boundaries = self.boundaries, {}
                for meeting_id in notifications.keys() | boundaries.keys():
                    for boundary in sorted(set(boundaries.get(meeting_id, []))):
                        await asyncio.to_thread(
                            self.store.plan,
                            meeting_id,
                            boundary,
                            self.settings.stage_summary_window_seconds * SAMPLE_RATE,
                            True,
                        )
                    await asyncio.to_thread(
                        self.store.plan,
                        meeting_id,
                        notifications.get(meeting_id, 0),
                        self.settings.stage_summary_window_seconds * SAMPLE_RATE,
                        False,
                    )
                while row := await asyncio.to_thread(self.store.claim, self.blocked_meetings):
                    await self._publish_row(row)
                    ready = await self._generate(row)
                    if not ready:
                        self.blocked_meetings.add(row["meeting_id"])
                        await self._publish_row(row)
                        break
                if self.notifications:
                    self.wake.set()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Stage summary worker iteration failed; retrying")
                for meeting_id, watermark in notifications.items():
                    self._notify(meeting_id, watermark)
                for meeting_id, pending in boundaries.items():
                    for boundary in pending:
                        self._notify(meeting_id, boundary, close_window=True)
                try:
                    await asyncio.to_thread(self.store.recover)
                except Exception:
                    logger.exception("Could not recover interrupted stage summary jobs")
                await asyncio.sleep(1)
                self.wake.set()

    @staticmethod
    def _speakers_ready(segments: list[dict[str, Any]]) -> bool:
        resolved = {"assigned", "multiple", "overlap"}
        for segment in segments:
            if segment.get("speaker_status") not in resolved or not segment.get("speaker_ids"):
                return False
            if any(
                turn.get("unknown")
                or not turn.get("speaker_ids")
                or any(not speaker_id for speaker_id in turn["speaker_ids"])
                for turn in segment.get("speaker_turns", [])
            ):
                return False
        return True

    async def _generate(self, row: dict[str, Any]) -> bool:
        generator = self.generator
        try:
            meeting = await asyncio.to_thread(self.meetings.get, row["meeting_id"])
            if meeting is None:
                return True
            document = await asyncio.to_thread(self.meetings.transcript(row["meeting_id"]).read)
            start_ms = row["start_sample"] * 1000 / SAMPLE_RATE
            end_ms = row["end_sample"] * 1000 / SAMPLE_RATE
            segments = [
                segment
                for segment in document["segments"]
                if segment["text"].strip() and start_ms <= segment.get("start_ms", 0) < end_ms
            ]
            if not self._speakers_ready(segments):
                await asyncio.to_thread(self.store.defer, row)
                return False
            text = plain_text({**document, "segments": segments}, labels=True)
            if not text:
                await asyncio.to_thread(
                    self.store.save,
                    row,
                    "本阶段未检测到有效发言。",
                    document.get("content_revision", 0),
                )
                await self._publish_row(row)
                return True
            if generator is None:
                if self.models is None:
                    raise MeetingError("尚未配置大语言模型，请在模型配置中添加。", 503)
                config = await asyncio.to_thread(self.models.require, "llm")
                generator = OpenAIStageSummaryGenerator(config, self.settings)
            result = await generator.generate(
                meeting["title"],
                text,
                row["start_sample"] / SAMPLE_RATE,
                row["end_sample"] / SAMPLE_RATE,
            )
            if not result.strip():
                raise MinutesGenerationError("阶段总结服务返回了空结果，请重试。")
            await asyncio.to_thread(
                self.store.save, row, result.strip(), document.get("content_revision", 0)
            )
            await self._publish_row(row)
        except asyncio.CancelledError:
            await asyncio.to_thread(self.store.retry, row)
            raise
        except Exception as exc:
            logger.exception("Stage summary generation failed for %s", row["meeting_id"])
            if row["attempts"] < 3 and not isinstance(exc, MeetingError):
                await asyncio.to_thread(self.store.retry, row)
                await self._publish_row(row)
                await asyncio.sleep(2 ** (row["attempts"] - 1))
                self.wake.set()
            else:
                message = (
                    str(exc)
                    if isinstance(exc, (MeetingError, MinutesGenerationError))
                    else "阶段总结服务暂时不可用。"
                )
                await asyncio.to_thread(self.store.fail, row, message)
                await self._publish_row(row)
        finally:
            if generator is not None and generator is not self.generator:
                await generator.close()
        return True

    async def close(self) -> None:
        if self.reconciler:
            await asyncio.gather(self.reconciler, return_exceptions=True)
            self.reconciler = None
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
        close = getattr(self.generator, "close", None)
        if close is not None:
            await close()


async def stage_summary_socket(
    websocket: WebSocket,
    meeting_id: str,
    meetings: MeetingStore,
    summaries: StageSummaryService,
    user_id: str | None = None,
) -> None:
    """Read-only snapshot/update stream, isolated from the recording socket."""
    await websocket.accept()
    if await asyncio.to_thread(meetings.get, meeting_id, user_id) is None:
        await websocket.send_json(
            {"type": "error", "message": "会议不存在", "meeting_id": meeting_id}
        )
        await websocket.close(code=1008)
        return
    token = uuid4().hex
    subscription = summaries.subscribe(meeting_id, token)
    send_lock = asyncio.Lock()

    async def send(event):
        async with send_lock:
            await websocket.send_json({**event, "meeting_id": meeting_id})

    async def forward():
        while True:
            event = await subscription.get()
            if event["type"] == "resync":
                event = {
                    "type": "stage_summaries.snapshot",
                    "summaries": await summaries.list(meeting_id),
                    "window_seconds": summaries.settings.stage_summary_window_seconds,
                }
            await send(event)
            if event["type"] == "deleted":
                await websocket.close(code=1000)
                return

    async def receive():
        while True:
            payload = await websocket.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "ping":
                await send({"type": "pong"})

    try:
        await send({
            "type": "stage_summaries.snapshot",
            "summaries": await summaries.list(meeting_id),
            "window_seconds": summaries.settings.stage_summary_window_seconds,
        })
        sender = asyncio.create_task(forward())
        receiver = asyncio.create_task(receive())
        done, pending = await asyncio.wait(
            (sender, receiver), return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        summaries.unsubscribe(meeting_id, token)
