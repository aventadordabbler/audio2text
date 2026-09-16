"""CPU-only PCM normalization, endpoint detection and bounded utterance state."""
from collections import deque
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class StreamOptions:
    chunk_seconds: float = 0.5
    max_utterance_seconds: float = 20
    end_silence_ms: int = 600
    energy_dbfs: float = -45
    pre_roll_ms: int = 200
    min_speech_ms: int = 60


class SpeechSession:
    """One stream's endpoint detection and Qwen state. Inference is awaited without blocking the application loop."""

    sample_rate = 16000
    frame_samples = 320  # 20 ms; independent of network packet boundaries.

    def __init__(self, engine, language, input_rate=16000, options=StreamOptions()):
        self.engine, self.language, self.options = engine, language, options
        self.input_rate = input_rate
        self.resampler = None
        self.remainder = np.empty(0, dtype=np.float32)
        self.history = deque(maxlen=max(1, options.pre_roll_ms // 20))
        self.position = 0
        self.segment_id = 0
        self.state = None
        self.pending = []
        self.pending_count = 0
        self.segment_samples = 0
        self.start = 0
        self.voiced_ms = 0
        self.silence_ms = 0
        self.last_text = ""
        self.continuing = False
        self._new_resampler()

    def _new_resampler(self):
        if self.input_rate != self.sample_rate:
            import soxr
            self.resampler = soxr.ResampleStream(self.input_rate, self.sample_rate, 1, dtype="float32")

    async def feed(self, pcm: bytes) -> list[dict]:
        if not pcm or len(pcm) % 2:
            raise ValueError("Audio must contain complete PCM16 samples")
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        if self.resampler is not None:
            samples = self.resampler.resample_chunk(samples)
        return await self._frames(samples)

    async def _frames(self, samples, final=False):
        samples = np.concatenate((self.remainder, samples))
        events = []
        count = len(samples) if final else len(samples) // self.frame_samples * self.frame_samples
        for offset in range(0, count, self.frame_samples):
            events.extend(await self._frame(samples[offset:min(offset + self.frame_samples, count)]))
        self.remainder = samples[count:].copy()
        return events

    async def feed_samples(self, samples):
        """Accept normalized mono 16 kHz samples without resampling again."""
        return await self._frames(samples)

    async def _frame(self, frame):
        self.position += len(frame)
        duration_ms = len(frame) * 1000 / self.sample_rate
        energy = float(np.mean(frame * frame))
        voiced = energy >= 10 ** (self.options.energy_dbfs / 10)
        if self.state is None:
            if self.continuing and not voiced:
                self.silence_ms += duration_ms
                if self.silence_ms >= self.options.end_silence_ms:
                    self.continuing = False
            self.history.append(frame.copy())
            self.voiced_ms = self.voiced_ms + duration_ms if voiced else 0
            if self.voiced_ms < self.options.min_speech_ms and not (voiced and self.continuing):
                return []
            self.continuing = False
            lead = np.concatenate(tuple(self.history))
            self.history.clear()
            self.state = self.engine.new_state(self.language, self.options.chunk_seconds)
            self.start = self.position - len(lead)
            self.segment_samples = 0
            self.silence_ms = 0
            frame = lead
        self.silence_ms = 0 if voiced else self.silence_ms + duration_ms
        self.pending.append(frame)
        self.pending_count += len(frame)
        self.segment_samples += len(frame)
        events = []
        if self.pending_count >= round(self.options.chunk_seconds * self.sample_rate):
            text = await self._push()
            if text != self.last_text:
                self.last_text = text
                events.append({"type": "partial", "segment_id": self.segment_id, "text": text})
        at_limit = self.segment_samples >= self.options.max_utterance_seconds * self.sample_rate
        if self.silence_ms >= self.options.end_silence_ms or at_limit:
            events.append(await self._finish())
            # The next voiced sample belongs to known continuous speech, even if stop follows immediately.
            self.continuing = at_limit and voiced
        return events

    async def _push(self):
        audio = np.concatenate(self.pending)
        self.pending.clear()
        self.pending_count = 0
        return (await self.engine.feed(audio, self.state)).strip()

    async def _finish(self):
        if self.pending_count:
            await self._push()
        text = (await self.engine.finish(self.state)).strip()
        event = {"type": "final", "segment_id": self.segment_id, "text": text,
                 "start_ms": round(self.start / 16), "end_ms": round(self.position / 16)}
        self.segment_id += 1
        self.state = None
        self.history.clear()
        self.voiced_ms = self.silence_ms = 0
        self.last_text = ""
        self.segment_samples = 0
        return event

    async def flush(self):
        tail = np.empty(0, dtype=np.float32)
        if self.resampler is not None:
            tail = self.resampler.resample_chunk(tail, last=True)
            self._new_resampler()
        events = await self._frames(tail, final=True)
        if self.state is not None:
            events.append(await self._finish())
        self.history.clear()
        self.voiced_ms = self.silence_ms = 0
        self.continuing = False
        return events
