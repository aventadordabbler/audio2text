from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace

from .audio import SpeechSession, StreamOptions
from .config import Settings
from .model_configs import ModelConfig
from .qwen_streaming import ASRError, RemoteDecoder
from .recordings import AudioArchive, PCMNormalizer

LANGUAGES = {"zh": "Chinese", "en": "English", "ja": "Japanese"}


@dataclass
class Flush:
    complete: asyncio.Future


@dataclass
class AudioFrame:
    pcm: bytes
    archived: asyncio.Future


class StreamingTranscriber:
    """CPU-only meeting stream with ordered remote requests and bounded PCM queues."""

    def __init__(self, config: ModelConfig, *, decoder=None, options=StreamOptions()):
        self.config = config
        self.decoder = decoder or RemoteDecoder(config)
        self.options = options
        self.input = asyncio.Queue(maxsize=128)
        self.decoding = asyncio.Queue(maxsize=128)
        self.output = asyncio.Queue(maxsize=128)
        self.pending_bytes = 0
        self.max_frame = self.max_pending = 0
        self.worker = None
        self.ingester = None
        self.failure = None
        self.pending_flush = None
        self.archive = None
        self.audio_notify = None
        self.next_segment = 0
        self.sample_rate = 16000
        self.flow_level = "normal"

    def bind_recording(self, archive: AudioArchive, next_segment: int, notify=None):
        self.archive = archive
        self.next_segment = next_segment
        self.audio_notify = notify

    async def start(self, language: str | None, sample_rate: int):
        if type(sample_rate) is not int or not 8000 <= sample_rate <= 96000:
            raise ASRError("音频采样率不受支持。")
        await self.decoder.prepare()
        self.normalizer = PCMNormalizer(sample_rate)
        self.sample_rate = sample_rate
        self.flow_level = "normal"
        self.session = SpeechSession(self.decoder, LANGUAGES.get(language, language), 16000, self.options)
        self.session.segment_id = self.next_segment
        if self.archive is not None:
            self.session.position = self.archive.samples
        self.max_frame, self.max_pending = sample_rate * 2, sample_rate * 2 * 10
        self.worker = asyncio.create_task(self._process())
        self.ingester = asyncio.create_task(self._ingest())

    def _enqueue(self, item):
        if self.failure:
            raise self.failure
        if self.worker is None or self.worker.done():
            raise ASRError("识别会话已停止，请重新进入会议。")
        try:
            self.input.put_nowait(item)
        except asyncio.QueueFull as exc:
            raise ASRError("识别处理积压，录音已停止；已定稿内容已保存。") from exc

    async def send_audio(self, pcm: bytes):
        if not pcm or len(pcm) % 2 or len(pcm) > self.max_frame:
            raise ASRError("音频帧格式不正确，请使用单声道 PCM16 录音。")
        if self.pending_bytes + len(pcm) > self.max_pending:
            raise ASRError("识别处理积压，录音已停止；已定稿内容已保存，请稍后继续。")
        archived = asyncio.get_running_loop().create_future()
        self._enqueue(AudioFrame(pcm, archived))
        self.pending_bytes += len(pcm)
        return await archived

    def flow_status(self):
        """Return a flow-control transition when the bounded queue changes level."""
        pending_seconds = self.pending_bytes / (self.sample_rate * 2)
        high = self.max_pending / (self.sample_rate * 2) * 0.6
        low = self.max_pending / (self.sample_rate * 2) * 0.3
        level = "lagging" if pending_seconds >= high else "normal" if pending_seconds <= low else self.flow_level
        if level == self.flow_level:
            return None
        self.flow_level = level
        return {"type": "flow", "level": level, "pending_seconds": round(pending_seconds, 2)}

    def diagnostics(self):
        decoder = self.decoder.diagnostics() if hasattr(self.decoder, "diagnostics") else {}
        return {
            "mode": self.config.asr_mode,
            "flow_level": self.flow_level,
            "pending_seconds": round(self.pending_bytes / (self.sample_rate * 2), 2),
            "max_pending_seconds": round(self.max_pending / (self.sample_rate * 2), 2),
            **decoder,
        }

    async def _ingest(self):
        frame = None
        try:
            while True:
                item = await self.input.get()
                frame = item if isinstance(item, AudioFrame) else None
                pcm = frame.pcm if frame else item
                samples = self.normalizer.feed(pcm) if frame else self.normalizer.flush()
                if self.archive is not None and len(samples):
                    writing = asyncio.create_task(asyncio.to_thread(self.archive.append, samples))
                    try:
                        await asyncio.shield(writing)
                    except asyncio.CancelledError:
                        # to_thread cannot cancel a filesystem write. Join it before
                        # closing the capture or allowing another recorder to open it.
                        await writing
                        raise
                    if self.audio_notify:
                        self.audio_notify()
                if frame and not frame.archived.done():
                    frame.archived.set_result(self.archive.samples if self.archive else None)
                await self.decoding.put((pcm, samples))
        except Exception as exc:
            self.failure = ASRError("无法归档录音，录音已停止；请检查数据目录和磁盘空间。")
            self.failure.__cause__ = exc
            if frame and not frame.archived.done():
                frame.archived.set_exception(self.failure)
            await self.output.put(self.failure)

    async def _process(self):
        try:
            while True:
                item, samples = await self.decoding.get()
                events = await self.session.feed_samples(samples)
                if not isinstance(item, bytes):
                    events.extend(await self.session.flush())
                for event in events:
                    await self.output.put(event)
                if isinstance(item, bytes):
                    self.pending_bytes -= len(item)
                else:
                    await self.output.put(item)
        except Exception as exc:
            self.failure = exc if isinstance(exc, ASRError) else ASRError("实时识别失败，已定稿内容已保存。")
            await self.output.put(self.failure)

    async def events(self):
        while True:
            event = await self.output.get()
            if isinstance(event, Exception):
                raise event
            if isinstance(event, Flush):
                # The consumer has saved all preceding final events before reaching here.
                if not event.complete.done():
                    event.complete.set_result(None)
            else:
                yield event

    async def flush(self):
        future = asyncio.get_running_loop().create_future()
        self.pending_flush = future
        try:
            self._enqueue(Flush(future))
            await asyncio.wait_for(future, self.config.timeout_seconds)
        except TimeoutError as exc:
            raise ASRError("等待尾音定稿超时，已定稿内容已保存。") from exc
        finally:
            if not future.done():
                future.cancel()
            self.pending_flush = None

    async def close(self):
        if self.ingester:
            self.ingester.cancel()
            await asyncio.gather(self.ingester, return_exceptions=True)
            self.ingester = None
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
        if self.pending_flush and not self.pending_flush.done():
            self.pending_flush.cancel()
        await self.decoder.close()


def build_transcriber(config: ModelConfig, settings: Settings) -> StreamingTranscriber:
    config = replace(config, tokenizer=settings.asr_tokenizer)
    return StreamingTranscriber(
        config,
        decoder=RemoteDecoder(
            config,
            send_chat_template=settings.asr_send_chat_template,
            window_seconds=settings.asr_window_seconds,
            stride_seconds=settings.asr_stride_seconds,
        ),
    )
