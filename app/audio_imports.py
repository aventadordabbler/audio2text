"""HTTP file imports with durable jobs, independent of live recording sessions."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import json
import hashlib
import hmac
import logging
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

import numpy as np

from .asr import LANGUAGES
from .audio import SpeechSession
from .meetings import MeetingError
from .qwen_streaming import ASRError, RemoteDecoder
from .recordings import AudioArchive, SAMPLE_RATE, read_audio

logger = logging.getLogger(__name__)
DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024


async def _disk(function, *args, **kwargs):
    """Finish disk operations before cancellation can release locks or remove staging files."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class AudioImportService:
    def __init__(self, store, models, settings, system_settings, diarization, minutes, decoder_factory=None, stage_summaries=None, events=None):
        self.store, self.models, self.settings, self.system_settings = store, models, settings, system_settings
        self.diarization, self.minutes = diarization, minutes
        self.stage_summaries = stage_summaries
        self.events = events
        self.decoder_factory = decoder_factory
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(settings.audio_import_workers)
        self.upload_slots = asyncio.Semaphore(settings.audio_import_workers)
        self.chunk_lock = asyncio.Lock()
        self.closed = False

    def _job(self, meeting_id):
        with self.store._connection() as db:
            row = db.execute("SELECT * FROM meeting_imports WHERE meeting_id = ?", (meeting_id,)).fetchone()
            if row is None:
                raise MeetingError("导入任务不存在", 404)
            return dict(row)

    def _update_db(self, meeting_id, **values):
        values["updated_at"] = datetime.now(timezone.utc).isoformat()
        with self.store._connection() as db:
            db.execute(f"UPDATE meeting_imports SET {', '.join(key + ' = ?' for key in values)} WHERE meeting_id = ?",
                       (*values.values(), meeting_id))

    async def _update(self, meeting_id, **values):
        changes = dict(values)
        await _disk(self._update_db, meeting_id, **values)
        if self.events:
            self.events.publish(meeting_id, {"type": "import.status", "import_job": changes})

    @staticmethod
    def _source_name(filename, index=None):
        suffix = Path(filename).suffix.lower()
        if suffix not in {".wav", ".mp3"}:
            raise MeetingError("请选择 WAV 或 MP3 音频文件", 422)
        return f"source{f'-{index}' if index is not None else ''}{suffix}"

    async def create(self, upload, title, language, department_id, user_id=None, minutes_format_id=None,
                     key_speaker_ids=None):
        uploads = upload if isinstance(upload, (list, tuple)) else [upload]
        if not uploads:
            raise MeetingError("请至少选择一个音频文件", 422)
        filenames = [(item.filename or "").replace("\\", "/").rsplit("/", 1)[-1] for item in uploads]
        source_names = [self._source_name(filename, index if len(uploads) > 1 else None)
                        for index, filename in enumerate(filenames)]
        if self.decoder_factory is None:
            await _disk(self.models.require, "asr")
        if not self.minutes.available:
            raise MeetingError("请先配置大语言模型，再导入音频生成会议总结", 503)
        upload_directory = self.store.path.parent / ".audio-uploads"
        upload_directory.mkdir(parents=True, exist_ok=True)
        async with self.upload_slots:
            with TemporaryDirectory(prefix="wav-", dir=upload_directory) as temporary:
                directory = Path(temporary)
                for index, (item, source_name) in enumerate(zip(uploads, source_names)):
                    source = directory / source_name
                    size = 0
                    with source.open("wb") as output:
                        while chunk := await item.read(1024 * 1024):
                            size += len(chunk)
                            if size > self.settings.audio_import_max_bytes:
                                raise MeetingError("音频文件超过服务端允许的大小", 413)
                            await _disk(output.write, chunk)
                    if source_name.endswith(".wav"):
                        with source.open("rb") as audio:
                            header = audio.read(12)
                        if len(header) < 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:] != b"WAVE":
                            raise MeetingError("文件不是有效的 WAV 音频", 422)
                    await self._decode(directory, source_name, continue_capture=index > 0)
                # Publish the meeting only after its complete archive and exact duration exist.
                publishing = asyncio.create_task(self._publish(directory, title, language, department_id,
                                                               "、".join(filenames), user_id, minutes_format_id,
                                                               key_speaker_ids))
                try:
                    return await asyncio.shield(publishing)
                except asyncio.CancelledError:
                    # A committed meeting must keep processing even if the upload client leaves.
                    await publishing
                    raise

    def _chunk_path(self, upload_id):
        if not upload_id or len(upload_id) != 32 or any(char not in "0123456789abcdef" for char in upload_id):
            raise MeetingError("上传会话不存在", 404)
        return self.store.path.parent / ".audio-uploads" / f"chunked-{upload_id}"

    def _read_chunk_meta(self, upload_id, user_id):
        directory = self._chunk_path(upload_id)
        try:
            meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise MeetingError("上传会话不存在或已失效", 404) from exc
        if meta.get("user_id") != user_id:
            raise MeetingError("上传会话不存在", 404)
        return directory, meta

    async def start_chunked(self, title, language, files, user_id=None, minutes_format_id=None,
                            key_speaker_ids=None):
        if not files:
            raise MeetingError("请至少选择一个音频文件", 422)
        normalized = []
        for index, item in enumerate(files):
            filename = (item["filename"] or "").replace("\\", "/").rsplit("/", 1)[-1]
            source_name = self._source_name(filename, index if len(files) > 1 else None)
            file_size, total_chunks, chunk_size = item["file_size"], item["total_chunks"], item["chunk_size"]
            if type(file_size) is not int or file_size <= 0 or file_size > self.settings.audio_import_max_bytes:
                raise MeetingError("音频文件超过服务端允许的大小", 413)
            if type(chunk_size) is not int or not 1024 * 1024 <= chunk_size <= 32 * 1024 * 1024:
                raise MeetingError("分片大小必须在 1–32 MiB 之间", 422)
            expected_chunks = (file_size + chunk_size - 1) // chunk_size
            if type(total_chunks) is not int or total_chunks != expected_chunks:
                raise MeetingError("分片数量与文件大小不匹配", 422)
            normalized.append({
                "index": index, "filename": filename, "source_name": source_name,
                "file_size": file_size, "chunk_size": chunk_size, "total_chunks": total_chunks,
                "received": {},
            })
        if self.decoder_factory is None:
            await _disk(self.models.require, "asr")
        if not self.minutes.available:
            raise MeetingError("请先配置大语言模型，再导入音频生成会议总结", 503)
        uploads = self.store.path.parent / ".audio-uploads"
        uploads.mkdir(parents=True, exist_ok=True)
        upload_id = uuid4().hex
        directory = uploads / f"chunked-{upload_id}"
        directory.mkdir()
        filename = "、".join(item["filename"] for item in normalized)
        meeting = await _disk(
            self.store.create, title, language, None, minutes_format_id, key_speaker_ids,
            filename=filename, user_id=user_id, import_pending=True,
        )
        meta = {
            "upload_id": upload_id, "title": title.strip(), "language": language,
            "files": normalized, "user_id": user_id, "minutes_format_id": minutes_format_id,
            "key_speaker_ids": key_speaker_ids or [], "meeting_id": meeting["id"],
        }
        (directory / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
        result = {"upload_id": upload_id, "files": [
            {key: value for key, value in item.items() if key != "received"} | {"received": []}
            for item in normalized
        ]}
        if len(normalized) == 1:
            item = normalized[0]
            result.update({key: item[key] for key in ("filename", "file_size", "chunk_size", "total_chunks")})
            result["received"] = []
        result["meeting"] = meeting
        return result

    async def upload_chunk(self, upload_id, file_index, index, stream, digest, user_id=None):
        async with self.chunk_lock:
            directory, meta = self._read_chunk_meta(upload_id, user_id)
            files = meta.get("files")
            if files is None:
                files = [{key: meta[key] for key in ("filename", "source_name", "file_size", "chunk_size", "total_chunks", "received")}]
            if type(file_index) is not int or not 0 <= file_index < len(files):
                raise MeetingError("文件序号无效", 422)
            item = files[file_index]
            if type(index) is not int or not 0 <= index < item["total_chunks"]:
                raise MeetingError("分片序号无效", 422)
            if not isinstance(digest, str) or len(digest) != 64:
                raise MeetingError("分片校验值无效", 422)
            expected_size = min(item["chunk_size"], item["file_size"] - index * item["chunk_size"])
            chunk_path = directory / f"file-{file_index:04d}-chunk-{index:08d}.part"
            existing = item["received"].get(str(index))
            if existing and chunk_path.exists():
                if existing["sha256"] == digest and existing["size"] == expected_size:
                    return {"file_index": file_index, "index": index, "size": expected_size,
                            "received": sorted(map(int, item["received"]))}
                raise MeetingError("该分片已上传但校验值不一致", 409)
            size = 0
            hasher = hashlib.sha256()
            temporary = chunk_path.with_suffix(".tmp")
            try:
                with temporary.open("wb") as output:
                    async for block in stream:
                        size += len(block)
                        if size > expected_size:
                            raise MeetingError("分片大小不正确", 422)
                        hasher.update(block)
                        output.write(block)
                if size != expected_size or not hmac.compare_digest(hasher.hexdigest(), digest):
                    raise MeetingError("分片完整性校验失败", 422)
                temporary.replace(chunk_path)
                item["received"][str(index)] = {"size": size, "sha256": digest}
                (directory / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
            finally:
                temporary.unlink(missing_ok=True)
            return {"file_index": file_index, "index": index, "size": size,
                    "received": sorted(map(int, item["received"]))}

    async def complete_chunked(self, upload_id, user_id=None):
        async with self.chunk_lock:
            directory, meta = self._read_chunk_meta(upload_id, user_id)
            files = meta.get("files")
            if files is None:
                files = [{key: meta[key] for key in ("filename", "source_name", "file_size", "chunk_size", "total_chunks", "received")}]
            if any(len(item["received"]) != item["total_chunks"] for item in files):
                raise MeetingError("仍有分片未上传完成", 409)
            try:
                for file_index, item in enumerate(files):
                    source_name = item.get("source_name", self._source_name(item["filename"], file_index if len(files) > 1 else None))
                    source = directory / source_name
                    size = 0
                    with source.open("wb") as output:
                        for index in range(item["total_chunks"]):
                            chunk_path = directory / f"file-{file_index:04d}-chunk-{index:08d}.part"
                            chunk_meta = item["received"].get(str(index))
                            if chunk_meta is None or not chunk_path.exists():
                                raise MeetingError("分片文件缺失，请重新上传", 409)
                            with chunk_path.open("rb") as chunk:
                                chunk_hasher = hashlib.sha256()
                                while block := chunk.read(1024 * 1024):
                                    size += len(block)
                                    chunk_hasher.update(block)
                                    output.write(block)
                                if not hmac.compare_digest(chunk_hasher.hexdigest(), chunk_meta["sha256"]):
                                    raise MeetingError("分片文件完整性校验失败", 422)
                    if size != item["file_size"]:
                        raise MeetingError("合并后的文件大小不一致", 422)
                    if source_name.endswith(".wav"):
                        with source.open("rb") as audio:
                            header = audio.read(12)
                        if len(header) < 12 or header[:4] not in {b"RIFF", b"RF64"} or header[8:] != b"WAVE":
                            raise MeetingError("文件不是有效的 WAV 音频", 422)
                    await self._decode(directory, source_name, continue_capture=file_index > 0)
                    for chunk_path in directory.glob(f"file-{file_index:04d}-chunk-*.part"):
                        chunk_path.unlink()
                (directory / "metadata.json").unlink(missing_ok=True)
                return await self._publish(directory, meta["title"], meta["language"], None,
                                           "、".join(item["filename"] for item in files), user_id,
                                           meta.get("minutes_format_id"), meta.get("key_speaker_ids", []),
                                           meta.get("meeting_id"))
            except BaseException as exc:
                if meta.get("meeting_id"):
                    await self._update(meta["meeting_id"], status="failed", stage="initializing",
                                       error=str(exc) if isinstance(exc, MeetingError) else "音频上传初始化失败")
                if directory.exists():
                    shutil.rmtree(directory, ignore_errors=True)
                raise

    async def _publish(self, directory, title, language, department_id, filename, user_id=None,
                       minutes_format_id=None, key_speaker_ids=None, meeting_id=None):
        async with self.lock:
            if meeting_id:
                meeting = await _disk(self.store.attach_import, meeting_id, directory, filename, user_id)
                shutil.rmtree(directory, ignore_errors=True)
            else:
                meeting = await _disk(self.store.create, title, language, department_id, minutes_format_id,
                                      key_speaker_ids, imported_audio=directory, filename=filename, user_id=user_id)
            self._schedule(meeting["id"])
            if self.events:
                self.events.publish(meeting["id"], {"type": "snapshot", "meeting": meeting})
            return meeting

    async def fail_chunked(self, upload_id, user_id=None, error="音频上传失败，请重新导入"):
        directory, meta = self._read_chunk_meta(upload_id, user_id)
        meeting_id = meta.get("meeting_id")
        if meeting_id:
            await self._update(meeting_id, status="failed", stage="initializing", error=error[:500])
        shutil.rmtree(directory, ignore_errors=True)
        return {"meeting_id": meeting_id, "status": "failed"}

    async def _decode(self, directory, source_name="source.wav", continue_capture=False):
        archive = await _disk(AudioArchive, directory)
        if continue_capture and archive.manifest["captures"]:
            archive.capture_id = archive.manifest["captures"][-1]["id"]
        else:
            await _disk(archive.begin)
        try:
            input_format = ["-f", "wav"] if source_name.endswith(".wav") else []
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-v", "error", "-xerror", *input_format, "-i", str(directory / source_name),
                "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise MeetingError("音频导入需要服务端安装 FFmpeg", 503) from exc
        try:
            async with asyncio.timeout(self.settings.audio_import_decode_timeout_seconds):
                remainder = b""
                decoded_samples = 0
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
                    decoded_samples += len(samples)
                    if archive.samples + len(samples) > self.settings.audio_import_max_seconds * SAMPLE_RATE:
                        raise MeetingError("音频时长超过服务端允许的范围", 413)
                    await _disk(archive.append, samples)
                if await process.wait() or remainder or not decoded_samples:
                    raise MeetingError("音频解码失败或没有有效音频，请检查文件是否完整", 422)
                await _disk(archive.end)
        except TimeoutError as exc:
            raise MeetingError("音频解析超时，请检查文件或调整服务端导入超时设置", 422) from exc
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
            return [row[0] for row in db.execute(
                "SELECT meeting_id FROM meeting_imports WHERE status = 'queued' AND stage != 'initializing'"
            )]

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
            await self._update(meeting_id, status="queued", error="", attempts=0)
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
            config, use_request_chat_template=self.system_settings.get()["asr_use_request_chat_template"],
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
                    saved = await _disk(transcript.final, event["segment_id"], event["text"],
                                        event["start_ms"], event["end_ms"], capture_id)
                    if saved and self.events:
                        self.events.publish(meeting_id, saved)
                    await self._update(
                        meeting_id,
                        processed_samples=min(job["total_samples"], round(event["end_ms"] * 16)),
                    )
            while cursor < job["total_samples"]:
                end = min(cursor + SAMPLE_RATE, job["total_samples"])
                audio = await _disk(read_audio, directory, cursor, end)
                await save(await session.feed_samples(audio))
                cursor = end
            await save(await session.flush())
            await self._update(meeting_id, processed_samples=job["total_samples"])
        finally:
            await decoder.close()

    async def _run(self, meeting_id):
        async with self.slots:
            stage = "unknown"
            try:
                job = await _disk(self._job, meeting_id)
                stage = job["stage"]
                await self._update(meeting_id, status="running", attempts=job["attempts"] + 1)
                if job["stage"] == "transcribing":
                    await self._transcribe(meeting_id, job)
                    meeting = await _disk(self.store.get, meeting_id)
                    if not meeting["text"].strip():
                        raise MeetingError("音频中未识别到有效讲话内容，无法生成会议总结", 422)
                    await self._update(meeting_id, stage="diarizing")
                    job["stage"] = "diarizing"
                    stage = "diarizing"
                if job["stage"] == "diarizing":
                    speaker_ready = await self.diarization.correct_import(meeting_id)
                    if speaker_ready and self.stage_summaries is not None:
                        await self.stage_summaries.finish(meeting_id, job["total_samples"])
                    await self._update(meeting_id, stage="summarizing")
                    stage = "summarizing"
                result = await self.minutes.get(meeting_id)
                if result["status"] != "ready" or result.get("stale"):
                    await self.minutes.start(meeting_id)
                    result = await self.minutes.wait(meeting_id)
                if result["status"] != "ready":
                    raise MeetingError(result.get("error") or "会议总结生成失败，请重试")
                await self._update(meeting_id, status="ready", error="")
            except asyncio.CancelledError:
                raise  # Keep the current stage and checkpoint for startup recovery.
            except Exception as exc:
                if stage == "summarizing":
                    logger.error("Meeting summary generation failed for %s: %s", meeting_id, exc)
                else:
                    logger.exception("Audio import failed for %s", meeting_id)
                message = str(exc) if isinstance(exc, (MeetingError, ASRError)) else "音频处理失败，已保存的内容已保留，请重试"
                await self._update(meeting_id, status="failed", error=message)

    async def close(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
