from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from anyio import CancelScope
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .asr import Transcriber, build_transcriber
from .audio import AudioNotReadyError
from .config import Settings, get_settings
from .meetings import MeetingError, MeetingStore
from .minutes import MinutesGenerator, MinutesService
from .model_configs import ModelConfigInput, ModelConfigStore, ModelKind

logger = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    language: str | None = Field(default=None, max_length=40)

    @field_validator("title")
    @classmethod
    def nonempty_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入会议名称")
        return value.strip()


def create_app(
    settings: Settings | None = None,
    transcriber: Transcriber | None = None,
    minutes_generator: MinutesGenerator | None = None,
) -> FastAPI:
    app_settings = settings or get_settings()
    store = MeetingStore(app_settings.database_path or app_settings.data_dir / "meetings.sqlite3", app_settings.data_dir)
    models = ModelConfigStore(store.path)
    minutes = MinutesService(store, models, app_settings, minutes_generator)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await asyncio.to_thread(store.recover)
        try:
            yield
        finally:
            await minutes.close()
            close = getattr(transcriber, "close", None)
            if close is not None:
                await close()

    app = FastAPI(title=app_settings.app_name, lifespan=lifespan)
    app.state.settings = app_settings
    app.state.meeting_store = store
    app.state.transcriber = transcriber
    app.state.minutes_service = minutes
    app.state.model_configs = models
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(MeetingError)
    async def meeting_error_handler(_, exc: MeetingError):
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_, exc: RequestValidationError):
        # Do not echo submitted API keys in validation responses.
        return JSONResponse(status_code=422, content={"detail": [
            {key: error[key] for key in ("loc", "msg", "type")} for error in exc.errors()
        ]})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/model-configs")
    def list_model_configs() -> list[dict[str, Any]]:
        return models.list()

    @app.put("/api/model-configs/{kind}")
    def save_model_config(kind: ModelKind, payload: ModelConfigInput) -> dict[str, Any]:
        return models.save(kind, payload)

    @app.get("/api/meetings")
    def list_meetings() -> list[dict[str, Any]]:
        return store.list()

    @app.post("/api/meetings", status_code=201)
    def create_meeting(payload: MeetingCreate) -> dict[str, Any]:
        return store.create(payload.title, payload.language)

    @app.get("/api/meetings/{meeting_id}")
    def get_meeting(meeting_id: str) -> dict[str, Any]:
        meeting = store.get(meeting_id)
        if meeting is None:
            raise HTTPException(404, "会议不存在")
        return meeting

    @app.post("/api/meetings/{meeting_id}/end")
    async def end_meeting(meeting_id: str) -> dict[str, Any]:
        meeting = await asyncio.to_thread(store.transition, meeting_id, "end")
        await minutes.after_end(meeting)
        return meeting

    @app.get("/api/meetings/{meeting_id}/minutes")
    async def get_minutes(meeting_id: str) -> dict[str, Any]:
        return await minutes.get(meeting_id)

    @app.post("/api/meetings/{meeting_id}/minutes", status_code=202)
    async def generate_minutes(meeting_id: str) -> dict[str, Any]:
        return await minutes.start(meeting_id)

    @app.get("/api/meetings/{meeting_id}/minutes/download")
    def download_minutes(meeting_id: str) -> Response:
        meeting = get_meeting(meeting_id)
        result = store.get_minutes(meeting_id)
        if not result["text"]:
            raise HTTPException(404, "会议纪要尚未生成")
        return Response(
            result["text"] + "\n", media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(meeting['title'] + '-会议纪要.md', safe='')}"},
        )

    @app.get("/api/meetings/{meeting_id}/download")
    def download_meeting(meeting_id: str) -> Response:
        meeting = get_meeting(meeting_id)
        return Response(
            meeting["text"] + "\n", media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(meeting['title'] + '.txt', safe='')}"},
        )

    @app.websocket("/ws/meetings/{meeting_id}")
    async def meeting_socket(websocket: WebSocket, meeting_id: str) -> None:
        await websocket.accept()
        owner = uuid4().hex
        claimed = False
        audio = bytearray()
        recognized_bytes = 0
        mime_type = "audio/webm"
        initialized = False
        session_text = ""
        no_speech_notified = False
        asr = transcriber

        async def send_event(event: dict[str, Any]) -> None:
            await websocket.send_json({**event, "meeting_id": meeting_id})

        async def send_state(action: str) -> None:
            await send_event({"type": "state", "action": action, "meeting": meeting})

        def combined_text() -> str:
            return "\n\n".join(part for part in (base_text, session_text) if part)

        async def recognize(final: bool = False) -> bool:
            nonlocal session_text, recognized_bytes, no_speech_notified
            if not audio or len(audio) == recognized_bytes:
                return True
            try:
                text = (await asr.transcribe(bytes(audio), mime_type, meeting["language"])).strip()
                if text:
                    session_text = text
                    no_speech_notified = False
                await asyncio.to_thread(store.save_text, meeting_id, combined_text(), owner)
                recognized_bytes = len(audio)
                if text:
                    await send_event({"type": "transcript", "text": combined_text(), "bytes": len(audio)})
                elif not no_speech_notified:
                    await send_event({"type": "no_speech", "bytes": len(audio)})
                    no_speech_notified = True
                return True
            except AudioNotReadyError:
                # An initial MP4 header contains no samples. Keep it for the next fragment.
                return final
            except WebSocketDisconnect:
                raise
            except Exception:
                logger.exception("ASR request failed for meeting %s", meeting_id)
                await send_event({"type": "error", "action": "end" if final else None, "message": "识别服务暂时不可用，请稍后重试", "meeting": await asyncio.to_thread(store.get, meeting_id)})
                return False

        try:
            meeting = await asyncio.to_thread(store.claim, meeting_id, owner)
            claimed = True
            if asr is None:
                asr = build_transcriber(await asyncio.to_thread(models.require, "asr"))
            base_text = meeting["text"]
            await send_event({"type": "ready", "meeting": meeting})
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    if meeting["status"] != "recording":
                        await send_event({"type": "error", "message": "请先开始或继续会议录音"})
                        continue
                    chunk = message["bytes"]
                    if len(audio) + len(chunk) > app_settings.max_audio_bytes:
                        await send_event({"type": "error", "message": "本次录音超过 25 MB，已保存文字，请重新进入会议继续"})
                        await websocket.close(code=1009)
                        return
                    audio.extend(chunk)
                    await recognize()
                    continue
                action = None
                try:
                    payload = json.loads(message.get("text") or "null")
                    if not isinstance(payload, dict):
                        raise MeetingError("消息必须是 JSON 对象", 400)
                    action = payload.get("type")
                    if payload.get("meeting_id", meeting_id) != meeting_id:
                        raise MeetingError("消息中的会议 ID 与当前连接不一致", 400)
                    if action in {"start", "resume"}:
                        if not initialized:
                            value = payload.get("mime_type", "audio/webm")
                            if not isinstance(value, str):
                                raise MeetingError("音频类型必须是文本", 400)
                            mime_type = value
                        meeting = await asyncio.to_thread(store.transition, meeting_id, action, owner)
                        initialized = True
                        await send_state(action)
                    elif action == "pause":
                        meeting = await asyncio.to_thread(store.transition, meeting_id, "pause", owner)
                        await send_state(action)
                    elif action == "end":
                        # Stop counting recording time before waiting for a final recognition retry.
                        if meeting["status"] == "recording":
                            meeting = await asyncio.to_thread(store.transition, meeting_id, "pause", owner)
                        if not await recognize(final=True):
                            continue
                        meeting = await asyncio.to_thread(store.transition, meeting_id, "end", owner)
                        await minutes.after_end(meeting)
                        await send_state(action)
                        await websocket.close(code=1000)
                        return
                    elif action == "ping":
                        await send_event({"type": "pong"})
                    else:
                        raise MeetingError("未知会议操作", 400)
                except (ValueError, TypeError):
                    await send_event({"type": "error", "action": action, "message": "消息格式不正确"})
                except MeetingError as exc:
                    await send_event({"type": "error", "action": action, "message": str(exc)})
        except MeetingError as exc:
            await send_event({"type": "error", "message": str(exc)})
            await websocket.close(code=1008)
        except WebSocketDisconnect:
            return
        finally:
            # Finish persistence/client cleanup even if the socket task is cancelled.
            with CancelScope(shield=True):
                try:
                    if claimed:
                        await asyncio.to_thread(store.release, meeting_id, owner)
                finally:
                    if asr is not transcriber:
                        close = getattr(asr, "close", None)
                        if close is not None:
                            await close()

    # Mounts also match WebSockets, but StaticFiles only handles HTTP scopes.
    # Keep this fallback after the meeting socket and before the static mount.
    @app.websocket("/{path:path}")
    async def unknown_socket(websocket: WebSocket, path: str) -> None:
        logger.warning("Rejected WebSocket connection to unknown path: /%s", path)
        await websocket.close(code=1008, reason="Unknown WebSocket endpoint")

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()
