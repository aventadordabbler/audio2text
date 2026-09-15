from __future__ import annotations

from uuid import uuid4
from typing import Protocol

import httpx

from .config import Settings


def _multipart_body(
    fields: list[tuple[str, str]], file_name: str, file_content: bytes, file_type: str
) -> tuple[bytes, str]:
    boundary = uuid4().hex
    boundary_bytes = boundary.encode("ascii")
    body = bytearray()

    def quote(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", "")

    for name, value in fields:
        body.extend(b"--" + boundary_bytes + b"\r\n")
        body.extend(f'Content-Disposition: form-data; name="{quote(name)}"\r\n\r\n'.encode("utf-8"))
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")
    body.extend(b"--" + boundary_bytes + b"\r\n")
    body.extend(
        f'Content-Disposition: form-data; name="file"; filename="{quote(file_name)}"\r\n'
        f"Content-Type: {file_type}\r\n\r\n".encode("utf-8")
    )
    body.extend(file_content)
    body.extend(b"\r\n--" + boundary_bytes + b"--\r\n")
    return bytes(body), f"multipart/form-data; boundary={boundary}"


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
        data: list[tuple[str, str]] = [("model", self.settings.vllm_model), ("response_format", "json")]
        if language:
            data.append(("language", language))
        body, content_type = _multipart_body(data, f"recording{suffix}", audio, mime_type)
        headers["Content-Type"] = content_type
        response = await self.client.post("/audio/transcriptions", headers=headers, content=body)
        response.raise_for_status()
        payload = response.json()
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            raise RuntimeError("vLLM returned an invalid transcription response")
        return text.strip()


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
