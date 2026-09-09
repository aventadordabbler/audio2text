from __future__ import annotations

import hashlib
from typing import Protocol

import httpx

from .config import Settings


class Transcriber(Protocol):
    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        ...


class VLLMTranscriber:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.vllm_base_url.rstrip("/"),
            timeout=settings.asr_timeout_seconds,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        suffix = ".webm" if "webm" in mime_type else ".wav"
        headers = {"Authorization": f"Bearer {self.settings.vllm_api_key}"}
        data: list[tuple[str, str]] = [
            ("model", self.settings.vllm_model),
            ("response_format", "json"),
        ]
        if language:
            data.append(("language", language))
        files = {"file": (f"recording{suffix}", audio, mime_type)}
        response = await self.client.post("/audio/transcriptions", headers=headers, data=data, files=files)
        response.raise_for_status()
        payload = response.json()
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            raise RuntimeError("vLLM returned an invalid transcription response")
        return text.strip()


class MockTranscriber:
    """Small deterministic fallback so the UI and WebSocket can be tested without a GPU."""

    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        digest = hashlib.sha1(audio).hexdigest()[:6]
        language_label = language or "自动检测"
        return f"演示模式：已接收音频片段（{len(audio) // 1024} KB，{language_label}，{digest}）"


def build_transcriber(settings: Settings) -> Transcriber:
    if settings.asr_mode.lower() == "mock":
        return MockTranscriber()
    return VLLMTranscriber(settings)
