"""HTTP file imports with durable jobs, independent of live recording sessions."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from .asr import LANGUAGES
from .audio import SpeechSession
from .meetings import MeetingError
from .qwen_streaming import ASRError, RemoteDecoder
from .recordings import AudioArchive, SAMPLE_RATE, read_audio

logger = logging.getLogger(__name__)


async def _disk(function, *args, **kwargs):
    """Finish disk operations before cancellation can release locks or remove staging files."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class AudioImportService:
    def __init__(self, store, models, settings, diarization, minutes, decoder_factory=None):
        self.store, self.models, self.settings = store, models, settings
        self.diarization, self.minutes = diarization, minutes
        self.decoder_factory = decoder_factory
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(settings.audio_import_workers)
        self.upload_slots = asyncio.Semaphore(settings.audio_import_workers)
        self.closed = False

    def _job(self, meeting_id):
        with self.store._connection() as db:
            row = db.execute("SELECT * FROM meeting_imports WHERE meeting_id = ?", (meeting_id,)).fetchone()
            if row is None:
                raise MeetingError("导入任务不存在", 404)
            return dict(row)

    def _update(self, meeting_id, **values):
        values["updated_at"] = datetime.now(timezone.utc).isoformat()
        with self.store._connection() as db:
            db.execute(f"UPDATE meeting_imports SET {', '.join(key + ' = ?' for key in values)} WHERE meeting_id = ?",
                       (*values.values(), meeting_id))

    async def create(self, upload, title, language, department_id):
        filename = (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
        if not filename.lower().endswith(".wav"):
            raise MeetingError("请选择 WAV 音频文件", 422)
        if self.decoder_factory is None:
            await _disk(self.models.require, "asr")
        if not self.minutes.available:
            raise MeetingError("请先配置大语言模型，再导入音频生成会议总结", 503)
        uploads = self.store.path.parent / ".audio-uploads"
        uploads.mkdir(parents=True, exist_ok=True)
        async with self.upload_slots:
            with TemporaryDirectory(prefix="wav-", dir=uploads) as temporary:
                directory = Path(temporary)
                source = directory / "source.wav"
                size = 0
                with source.open("wb") as output:
                    while chunk := await upload.read(1024 * 1024):
                        size += len(chunk)
                        if size > self.settings.audio_import_max_bytes:
                            raise MeetingError("WAV 文件超过服务端允许的大小", 413)
                        await _disk(output.write, chunk)
                with source.open("rb") as audio:
                    header = audio.read(12)
                if len(header) < 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:] != b"WAVE":
                    raise MeetingError("文件不是有效的 WAV 音频", 422)
                await self._decode(directory)
                # Publish the meeting only after its complete archive and exact duration exist.
                publishing = asyncio.create_task(self._publish(directory, title, language, department_id, filename))
                try:
                    return await asyncio.shield(publishing)
                except asyncio.CancelledError:
                    # A committed meeting must keep processing even if the upload client leaves.
                    await publishing
                    raise

    async def _publish(self, directory, title, language, department_id, filename):
        async with self.lock:
            meeting = await _disk(self.store.create, title, language, department_id,
                                 imported_audio=directory, filename=filename)
            self._schedule(meeting["id"])
            return meeting

    async def _decode(self, directory):
        archive = await _disk(AudioArchive, directory)
        await _disk(archive.begin)
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-f", "wav", "-i", str(directory / "source.wav"),
                "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise MeetingError("音频导入需要服务端安装 FFmpeg", 503) from exc
        try:
            async with asyncio.timeout(self.settings.audio_import_decode_timeout_seconds):
                remainder = b""
                while True:
                    try:
                        block = await process.stdout.readexactly(SAMPLE_RATE * 2 * 10)
                    except asyncio.IncompleteReadError as exc:
                        block = exc.partial
                    if not block:
                        break
                    block = remainder + block
                    length = len(block) // 2 * 2
                    remainder = block[length:]
                    samples = np.frombuffer(block[:length], dtype="<i2").astype(np.float32) / 32768
                    if archive.samples + len(samples) > self.settings.audio_import_max_seconds * SAMPLE_RATE:
                        raise MeetingError("WAV 时长超过服务端允许的范围", 413)
                    await _disk(archive.append, samples)
                if await process.wait() or remainder or not archive.samples:
                    raise MeetingError("WAV 解码失败或没有有效音频，请检查文件是否完整", 422)
                await _disk(archive.end)
        except TimeoutError as exc:
            raise MeetingError("WAV 解析超时，请检查文件或调整服务端导入超时设置", 422) from exc
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            # Drain the pipe after early rejection; wait() alone can hang on a full pipe.
            await process.communicate()

    def _recover(self):
        with self.store._connection() as db:
            db.execute("""UPDATE meeting_imports SET status = 'failed', error = '导入多次中断，请重试处理'
                WHERE status IN ('queued', 'running') AND attempts >= 3""")
            db.execute("UPDATE meeting_imports SET status = 'queued' WHERE status = 'running'")
            return [row[0] for row in db.execute("SELECT meeting_id FROM meeting_imports WHERE status = 'queued'")]

    async def start(self):
        for meeting_id in await _disk(self._recover):
            self._schedule(meeting_id)

    def _schedule(self, meeting_id):
        if self.closed or meeting_id in self.tasks:
            return
        task = asyncio.create_task(self._run(meeting_id), name=f"audio-import-{meeting_id}")
        self.tasks[meeting_id] = task
        def finished(completed):
            self.tasks.pop(meeting_id, None)
            if not completed.cancelled() and completed.exception():
                logger.error("Could not save audio import state for %s", meeting_id, exc_info=completed.exception())
        task.add_done_callback(finished)

    async def retry(self, meeting_id):
        async with self.lock:
            job = await _disk(self._job, meeting_id)
            if job["status"] != "failed" or meeting_id in self.tasks:
                raise MeetingError("只有失败的导入任务可以重试")
            await _disk(self._update, meeting_id, status="queued", error="", attempts=0)
            self._schedule(meeting_id)
            return await _disk(self.store.get, meeting_id)

    async def _transcribe(self, meeting_id, job):
        directory = self.store.directory(meeting_id)
        transcript = self.store.transcript(meeting_id)
        document = await _disk(transcript.read)
        # The journal can be ahead of the SQL checkpoint if shutdown interrupted a save.
        cursor = max(job["processed_samples"], max((round(s["end_ms"] * 16)
                     for s in document["segments"]), default=0))
        cursor = min(cursor, job["total_samples"])
        meeting = await _disk(self.store.get, meeting_id)
        config = replace(await _disk(self.models.require, "asr"), tokenizer=self.settings.asr_tokenizer)
        decoder = self.decoder_factory(config) if self.decoder_factory else RemoteDecoder(
            config, send_chat_template=self.settings.asr_send_chat_template,
            window_seconds=self.settings.asr_window_seconds, stride_seconds=self.settings.asr_stride_seconds)
        try:
            await decoder.prepare()
            session = SpeechSession(decoder, LANGUAGES.get(meeting["language"], meeting["language"]))
            session.position, session.segment_id = cursor, document["next_segment_id"]
            manifest = json.loads((directory / "audio/manifest.json").read_text())
            capture_id = manifest["captures"][0]["id"]
            async def save(events):
                for event in events:
                    if event["type"] != "final":
                        continue
                    await _disk(transcript.final, event["segment_id"], event["text"],
                                event["start_ms"], event["end_ms"], capture_id)
                    await _disk(self._update, meeting_id,
                                processed_samples=min(job["total_samples"], round(event["end_ms"] * 16)))
            while cursor < job["total_samples"]:
                end = min(cursor + SAMPLE_RATE, job["total_samples"])
                audio = await _disk(read_audio, directory, cursor, end)
                await save(await session.feed_samples(audio))
                cursor = end
            await save(await session.flush())
            await _disk(self._update, meeting_id, processed_samples=job["total_samples"])
        finally:
            await decoder.close()

    async def _run(self, meeting_id):
        async with self.slots:
            try:
                job = await _disk(self._job, meeting_id)
                await _disk(self._update, meeting_id, status="running", attempts=job["attempts"] + 1)
                if job["stage"] == "transcribing":
                    await self._transcribe(meeting_id, job)
                    meeting = await _disk(self.store.get, meeting_id)
                    if not meeting["text"].strip():
                        raise MeetingError("音频中未识别到有效讲话内容，无法生成会议总结", 422)
                    await _disk(self._update, meeting_id, stage="diarizing")
                    job["stage"] = "diarizing"
                if job["stage"] == "diarizing":
                    await self.diarization.correct_import(meeting_id)
                    await _disk(self._update, meeting_id, stage="summarizing")
                result = await self.minutes.get(meeting_id)
                if result["status"] != "ready" or result.get("stale"):
                    await self.minutes.start(meeting_id)
                    result = await self.minutes.wait(meeting_id)
                if result["status"] != "ready":
                    raise MeetingError(result.get("error") or "会议总结生成失败，请重试")
                await _disk(self._update, meeting_id, status="ready", error="")
            except asyncio.CancelledError:
                raise  # Keep the current stage and checkpoint for startup recovery.
            except Exception as exc:
                logger.exception("Audio import failed for %s", meeting_id)
                message = str(exc) if isinstance(exc, (MeetingError, ASRError)) else "音频处理失败，已保存的内容已保留，请重试"
                await _disk(self._update, meeting_id, status="failed", error=message)

    async def close(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
