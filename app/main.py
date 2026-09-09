from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .archive import ArchiveStore
from .asr import Transcriber, build_transcriber
from .config import Settings, get_settings

logger = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app(settings: Settings | None = None, transcriber: Transcriber | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    store = ArchiveStore(app_settings.data_dir)
    asr = transcriber or build_transcriber(app_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        app_settings.data_dir.mkdir(parents=True, exist_ok=True)
        try:
            yield
        finally:
            close = getattr(asr, "close", None)
            if close is not None:
                await close()

    app = FastAPI(title=app_settings.app_name, lifespan=lifespan)
    app.state.settings = app_settings
    app.state.archive_store = store
    app.state.transcriber = asr
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "asr_mode": app_settings.asr_mode}

    @app.get("/api/archives")
    async def list_archives() -> list[dict[str, Any]]:
        return store.list()

    @app.get("/api/archives/{archive_id}")
    async def get_archive(archive_id: str) -> dict[str, Any]:
        archive = store.get(archive_id)
        if archive is None:
            raise HTTPException(status_code=404, detail="Archive not found")
        return archive

    @app.get("/api/archives/{archive_id}/download")
    async def download_archive(archive_id: str) -> FileResponse:
        path = store.text_path(archive_id)
        archive = store.get(archive_id)
        if path is None or archive is None:
            raise HTTPException(status_code=404, detail="Archive not found")
        return FileResponse(path, media_type="text/plain; charset=utf-8", filename=f"{archive['title']}.txt")

    @app.websocket("/ws/transcribe")
    async def transcribe_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        audio = bytearray()
        mime_type = "audio/webm"
        language: str | None = None
        current_text = ""
        started = False

        async def recognize(is_final: bool = False) -> bool:
            nonlocal current_text
            if not audio:
                await websocket.send_json({"type": "error", "message": "没有收到音频内容"})
                return False
            if len(audio) > app_settings.max_audio_bytes:
                await websocket.send_json({"type": "error", "message": "录音超过 25 MB 限制"})
                return False
            try:
                text = await asr.transcribe(bytes(audio), mime_type, language)
                if text:
                    current_text = text
                await websocket.send_json(
                    {"type": "transcript", "text": current_text, "is_final": is_final, "bytes": len(audio)}
                )
            except Exception:
                logger.exception("ASR request failed")
                await websocket.send_json({"type": "error", "message": "识别服务暂时不可用，请稍后重试"})
                return False
            return True

        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    if not started:
                        await websocket.send_json({"type": "error", "message": "请先发送 start"})
                        continue
                    chunk = message["bytes"]
                    if len(audio) + len(chunk) > app_settings.max_audio_bytes:
                        await websocket.send_json({"type": "error", "message": "录音超过 25 MB 限制"})
                        await websocket.close(code=1009, reason="Audio too large")
                        return
                    audio.extend(chunk)
                    await recognize()
                    continue
                raw_text = message.get("text")
                if raw_text is None:
                    continue
                payload = json.loads(raw_text)
                if not isinstance(payload, dict):
                    await websocket.send_json({"type": "error", "message": "消息必须是 JSON 对象"})
                    continue
                event_type = payload.get("type")
                if event_type == "start":
                    raw_language = payload.get("language")
                    raw_mime_type = payload.get("mime_type")
                    if raw_language is not None and not isinstance(raw_language, str):
                        await websocket.send_json({"type": "error", "message": "识别语言必须是文本"})
                        continue
                    if raw_mime_type is not None and not isinstance(raw_mime_type, str):
                        await websocket.send_json({"type": "error", "message": "音频类型必须是文本"})
                        continue
                    audio.clear()
                    current_text = ""
                    language = raw_language or None
                    mime_type = raw_mime_type or "audio/webm"
                    started = True
                    await websocket.send_json({"type": "ready"})
                elif event_type == "stop":
                    if not started:
                        await websocket.send_json({"type": "error", "message": "会话尚未开始"})
                        continue
                    title = payload.get("title") or "未命名录音"
                    if not isinstance(title, str):
                        await websocket.send_json({"type": "error", "message": "归档标题必须是文本"})
                        continue
                    if not await recognize(is_final=True):
                        continue
                    archive = store.create(current_text, title, language)
                    await websocket.send_json({"type": "archived", "archive": archive})
                    await websocket.close(code=1000)
                    return
                elif event_type == "ping":
                    await websocket.send_json({"type": "pong"})
                else:
                    await websocket.send_json({"type": "error", "message": f"未知消息类型：{event_type}"})
        except WebSocketDisconnect:
            return
        except (ValueError, json.JSONDecodeError) as exc:
            logger.warning("Invalid WebSocket message: %s", exc)
            await websocket.close(code=1003, reason="Invalid message")

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()
