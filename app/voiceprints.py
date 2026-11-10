"""Registered speaker embeddings and their small audio ingestion pipeline."""
from __future__ import annotations

import asyncio
from pathlib import Path
import tempfile

import numpy as np

from .meetings import MeetingError
from .recordings import AudioArchive, SAMPLE_RATE


class VoiceprintService:
    def __init__(self, store, diarization, settings):
        self.store, self.diarization, self.settings = store, diarization, settings

    @staticmethod
    def _validate_name(name: str) -> str:
        value = name.strip()
        if not value or len(value) > 60:
            raise MeetingError("声纹名称须为 1–60 个字符", 422)
        return value

    async def create(self, upload, name: str, department_id: str, user_id: str, source: str):
        name = self._validate_name(name)
        if not department_id:
            raise MeetingError("请选择所属部门", 422)
        if source not in {"recording", "import"}:
            raise MeetingError("声纹来源无效", 422)
        filename = (upload.filename or "voiceprint.wav").replace("\\", "/").rsplit("/", 1)[-1]
        suffix = Path(filename).suffix.lower()
        if source == "import" and suffix not in {".wav", ".mp3", ".m4a", ".flac", ".ogg"}:
            raise MeetingError("请选择 WAV、MP3、M4A、FLAC 或 OGG 音频文件", 422)
        root = self.store.path.parent
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="voiceprint-", dir=root) as temporary:
            directory = Path(temporary)
            input_path = directory / ("source" + (suffix if suffix else ".wav"))
            size = 0
            with input_path.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.settings.voiceprint_max_bytes:
                        raise MeetingError("声纹音频超过服务端允许的大小", 413)
                    await asyncio.to_thread(output.write, chunk)
            archive = await asyncio.to_thread(AudioArchive, directory)
            await asyncio.to_thread(archive.begin)
            input_format = ["-f", "wav"] if suffix == ".wav" else []
            try:
                process = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-nostdin", "-v", "error", "-xerror", *input_format, "-i", str(input_path),
                    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
            except FileNotFoundError as exc:
                raise MeetingError("声纹录入需要服务端安装 FFmpeg", 503) from exc
            sample_count = 0
            remainder = b""
            try:
                async with asyncio.timeout(self.settings.voiceprint_decode_timeout_seconds):
                    while block := await process.stdout.read(SAMPLE_RATE * 2 * 10):
                        block = remainder + block
                        length = len(block) // 2 * 2
                        remainder = block[length:]
                        samples = np.frombuffer(block[:length], dtype="<i2").astype(np.float32) / 32768
                        sample_count += len(samples)
                        if sample_count > self.settings.voiceprint_max_seconds * SAMPLE_RATE:
                            raise MeetingError("声纹音频时长超过服务端允许的范围", 413)
                        await asyncio.to_thread(archive.append, samples)
                    if await process.wait() or remainder or not sample_count:
                        raise MeetingError("音频解码失败或没有有效音频，请检查文件是否完整", 422)
                    await asyncio.to_thread(archive.end)
            except TimeoutError as exc:
                raise MeetingError("声纹音频解析超时，请检查文件或调整服务端设置", 422) from exc
            finally:
                if process.returncode is None:
                    process.kill()
                await process.communicate()
            result = await self.diarization.embed(directory, sample_count)
            if not result.get("embedding"):
                raise MeetingError("音频中未检测到足够的清晰讲话内容", 422)
            return await asyncio.to_thread(
                self.store.create_voiceprint, user_id, name, department_id, result["embedding"],
                sample_count / SAMPLE_RATE, source,
            )

    def list(self, department_id=None):
        rows = self.store.list_voiceprints(department_id=department_id)
        for row in rows:
            row.pop("embedding", None)
        return rows

    def rename(self, voiceprint_id: str, name: str):
        return self.store.rename_voiceprint(voiceprint_id, self._validate_name(name))

    def delete(self, voiceprint_id: str):
        return self.store.delete_voiceprint(voiceprint_id)
