from __future__ import annotations

import re
from typing import Protocol

from openai import NOT_GIVEN, AsyncOpenAI

from .audio import is_silent_wav, to_wav
from .config import Settings

LANGUAGE_ALIASES = {"Chinese": "zh", "English": "en", "Japanese": "ja"}
ASR_PREFIX = re.compile(r"^(?:language\s+[^<\r\n]+\s*)?<asr_text>")


def _parse_transcription_text(raw: str) -> str:
    text = raw.strip().removeprefix("<|im_start|>assistant").strip()
    text = re.sub(r"(?:<\|(?:im_end|endoftext)\|>\s*)+$", "", text).strip()
    # Strip only leading protocol fields, preserving literal tags inside ordinary text.
    while match := ASR_PREFIX.match(text):
        text = text[match.end():].strip()
    return text


class Transcriber(Protocol):
    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        ...


class VLLMTranscriber:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = AsyncOpenAI(
            base_url=settings.vllm_base_url,
            api_key=settings.vllm_api_key,
            timeout=settings.asr_timeout_seconds,
            # Preserve the previous single-attempt behavior for live transcription.
            max_retries=0,
        )

    async def close(self) -> None:
        await self.client.close()

    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        wav_audio = await to_wav(audio, timeout=self.settings.asr_timeout_seconds)
        if is_silent_wav(wav_audio):
            return ""
        response = await self.client.audio.transcriptions.create(
            model=self.settings.vllm_model,
            file=("recording.wav", wav_audio, "audio/wav"),
            response_format="json",
            language=LANGUAGE_ALIASES.get(language, language) if language else NOT_GIVEN,
        )
        text = getattr(response, "text", None)
        if not isinstance(text, str):
            raise RuntimeError("vLLM returned an invalid transcription response")
        return _parse_transcription_text(text)


class MockTranscriber:
    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        if not audio:
            return ""
        return "模拟转写：已收到音频内容。"


def build_transcriber(settings: Settings) -> Transcriber:
    if settings.asr_mode.lower() == "mock":
        return MockTranscriber()
    if settings.asr_mode.lower() != "api":
        raise ValueError("ASR_MODE must be 'api'")
    return VLLMTranscriber(settings)
