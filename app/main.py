from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AwareDatetime, BaseModel, Field, field_validator, model_validator

from .realtime import meeting_socket
from .auth import AuthStore
from .config import Settings, get_settings
from .meetings import MeetingError, MeetingStore
from .minutes import MinutesGenerationError, MinutesGenerator, MinutesService
from .model_configs import ModelConfigInput, ModelConfigStore, ModelKind
from .model_probe import ModelProbeResult, probe_model
from .meeting_events import MeetingEvents
from .diarization.service import DiarizationService
from .audio_imports import AudioImportService, DEFAULT_CHUNK_SIZE
from .recordings import (
    AudioExportInvalid,
    AudioExportUnavailable,
    prepare_wav_export,
    read_audio_summary,
)
from .stage_summaries import StageSummaryGenerator, StageSummaryService, stage_summary_socket
from .system_settings import SystemSettingsInput, SystemSettingsStore
from .voiceprints import VoiceprintService
from .transcripts import plain_text
from .docx_export import build_docx

logger = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    language: str | None = Field(default=None, max_length=40)
    department_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    minutes_format_id: str | None = Field(default=None, pattern=r"^(?:[a-f0-9]{32}|default)$")
    key_speaker_ids: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("title")
    @classmethod
    def nonempty_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入会议名称")
        return value.strip()


class DepartmentInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入部门名称")
        return value.strip()


class VoiceprintNameInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入人员姓名")
        return value.strip()


class DepartmentAdminInput(BaseModel):
    enabled: bool


class MinutesFormatInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    prompt: str = Field(min_length=1, max_length=20000)

    @field_validator("name", "prompt")
    @classmethod
    def nonempty_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入有效内容")
        return value.strip()


class MinutesFormatGenerateInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    requirement: str = Field(min_length=1, max_length=6000)

    @field_validator("name", "requirement")
    @classmethod
    def nonempty_generation_value(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入有效内容")
        return value.strip()


class RegisterInput(BaseModel):
    account: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=8, max_length=128)
    department: str = Field(min_length=1, max_length=60)
    employee_id: str = Field(min_length=1, max_length=60)


class LoginInput(BaseModel):
    account: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=0, max_length=128)


class PasswordChangeInput(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class ChunkedImportFile(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    file_size: int = Field(gt=0)
    total_chunks: int = Field(gt=0)
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, ge=1024 * 1024, le=32 * 1024 * 1024)


class ChunkedImportStart(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    language: str | None = Field(default=None, max_length=40)
    files: list[ChunkedImportFile] | None = Field(default=None, min_length=1)
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    file_size: int | None = Field(default=None, gt=0)
    total_chunks: int | None = Field(default=None, gt=0)
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, ge=1024 * 1024, le=32 * 1024 * 1024)
    minutes_format_id: str | None = Field(default=None, pattern=r"^(?:[a-f0-9]{32}|default)$")
    key_speaker_ids: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("title")
    @classmethod
    def nonempty_chunked_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入会议名称")
        return value.strip()

    @model_validator(mode="after")
    def require_files(self):
        if self.files is None and None in (self.filename, self.file_size, self.total_chunks):
            raise ValueError("请提供音频文件分片信息")
        return self


class ChunkedImportFailure(BaseModel):
    error: str = Field(default="音频上传失败，请重新导入", max_length=500)


def parse_key_speaker_ids(value: str) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, ValueError) as exc:
        raise MeetingError("重点人员选择无效", 422) from exc
    if not isinstance(parsed, list):
        raise MeetingError("重点人员选择无效", 422)
    return parsed


def create_app(
    settings: Settings | None = None,
    stream_factory=None,
    minutes_generator: MinutesGenerator | None = None,
    diarization_worker_factory=None,
    stage_summary_generator: StageSummaryGenerator | None = None,
    import_decoder_factory=None,
) -> FastAPI:
    app_settings = settings or get_settings()
    store = MeetingStore(app_settings.database_path or app_settings.data_dir / "meetings.sqlite3", app_settings.data_dir)
    auth = AuthStore(store.path)
    auth.ensure_admin()
    models = ModelConfigStore(store.path)
    system_settings = SystemSettingsStore(store.path)
    events = MeetingEvents()
    minutes = MinutesService(store, models, system_settings, minutes_generator, events=events)
    stage_summaries = StageSummaryService(store, models, system_settings, stage_summary_generator)
    diarization = DiarizationService(
        store, models, minutes, app_settings, events, diarization_worker_factory,
        stage_summaries=stage_summaries, system_settings=system_settings,
    )
    audio_imports = AudioImportService(
        store, models, app_settings, system_settings, diarization, minutes, import_decoder_factory,
        stage_summaries=stage_summaries, events=events,
    )
    voiceprints = VoiceprintService(store, diarization, app_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await asyncio.to_thread(store.recover)
        await stage_summaries.start()
        await diarization.start()
        await audio_imports.start()
        try:
            yield
        finally:
            await audio_imports.close()
            await diarization.close()
            await stage_summaries.close()
            await minutes.close()

    app = FastAPI(title=app_settings.app_name, lifespan=lifespan)
    app.state.settings = app_settings
    app.state.meeting_store = store
    app.state.minutes_service = minutes
    app.state.model_configs = models
    app.state.system_settings = system_settings
    app.state.meeting_events = events
    app.state.stage_summaries = stage_summaries
    app.state.diarization_service = diarization
    app.state.audio_import_service = audio_imports
    app.state.auth_store = auth
    app.state.voiceprint_service = voiceprints
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def require_auth(request: Request, call_next):
        if request.method != "OPTIONS" and request.url.path.startswith("/api/") and request.url.path not in {
            "/api/auth/login", "/api/auth/register", "/api/auth/logout",
        }:
            authorization = request.headers.get("Authorization", "")
            token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else request.query_params.get("token")
            user = auth.user_for_token(token)
            if user is None:
                return JSONResponse(status_code=401, content={"detail": "请先登录"})
            request.state.user = user
        response = await call_next(request)
        return response

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

    @app.post("/api/auth/register", status_code=201)
    def register(payload: RegisterInput) -> dict[str, Any]:
        return auth.register(payload.account, payload.password, payload.department, payload.employee_id)

    @app.post("/api/auth/login")
    def login(payload: LoginInput) -> dict[str, Any]:
        token, expires_at, user = auth.login(payload.account, payload.password)
        return {"token": token, "expires_at": expires_at, "user": user}

    @app.post("/api/auth/password")
    def change_password(payload: PasswordChangeInput, request: Request) -> dict[str, Any]:
        if not request.state.user.get("must_change_password"):
            raise HTTPException(403, "当前账户不需要首次设置密码")
        return {"user": auth.change_password(request.state.user["id"], payload.password)}

    @app.get("/api/auth/me")
    def current_user(request: Request) -> dict[str, Any]:
        return request.state.user

    @app.get("/api/settings")
    def public_settings() -> dict[str, str]:
        return {"slogan": system_settings.get()["slogan"]}

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        authorization = request.headers.get("Authorization", "")
        auth.logout(authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else None)
        return Response(status_code=204)

    def require_admin(request: Request) -> None:
        if not request.state.user.get("is_admin"):
            raise HTTPException(403, "只有管理员可以维护此配置")

    def meeting_user_id(request: Request) -> str | None:
        return None if request.state.user.get("is_admin") else request.state.user["id"]

    @app.get("/api/system-settings")
    def list_system_settings(request: Request) -> dict[str, int | bool | str]:
        require_admin(request)
        return system_settings.get()

    @app.put("/api/system-settings")
    def save_system_settings(payload: SystemSettingsInput, request: Request) -> dict[str, int | bool | str]:
        require_admin(request)
        return system_settings.save(payload)

    @app.get("/api/users")
    def list_users(request: Request) -> list[dict[str, Any]]:
        require_admin(request)
        return auth.list_users()

    @app.put("/api/users/{user_id}/department-admin")
    def set_department_admin(user_id: str, payload: DepartmentAdminInput, request: Request) -> dict[str, Any]:
        require_admin(request)
        return auth.set_department_admin(user_id, payload.enabled)

    @app.get("/api/model-configs")
    def list_model_configs(request: Request) -> list[dict[str, Any]]:
        return models.list()

    @app.put("/api/model-configs/{kind}")
    def save_model_config(kind: ModelKind, payload: ModelConfigInput, request: Request) -> dict[str, Any]:
        return models.save(kind, payload)

    @app.post("/api/model-configs/{kind}/test", response_model=ModelProbeResult)
    async def test_model_config(kind: ModelKind, payload: ModelConfigInput, request: Request) -> ModelProbeResult:
        config = await asyncio.to_thread(models.resolve_draft, kind, payload)
        return await probe_model(config)

    @app.get("/api/meetings")
    def list_meetings(
        request: Request,
        title: str = Query(default="", max_length=80),
        department_id: str | None = Query(default=None, pattern=r"^(?:[a-f0-9]{32}|unassigned)$"),
        status: Literal["created", "recording", "paused", "ended"] | None = None,
        created_from: AwareDatetime | None = None,
        created_before: AwareDatetime | None = None,
    ) -> list[dict[str, Any]]:
        if created_from and created_before and created_from >= created_before:
            raise HTTPException(422, "开始时间必须早于结束时间")
        return store.list(title=title, department_id=department_id, status=status,
                          created_from=created_from, created_before=created_before,
                          user_id=meeting_user_id(request))

    @app.post("/api/meetings", status_code=201)
    def create_meeting(payload: MeetingCreate, request: Request) -> dict[str, Any]:
        return store.create(payload.title, payload.language, payload.department_id,
                            payload.minutes_format_id, payload.key_speaker_ids, user_id=request.state.user["id"])

    @app.post("/api/meetings/import", status_code=202)
    async def import_meeting(
        request: Request,
        file: list[UploadFile] = File(...),
        title: str = Form(..., min_length=1, max_length=80),
        language: str | None = Form(default=None, max_length=40),
        department_id: str | None = Form(default=None, pattern=r"^[a-f0-9]{32}$"),
        minutes_format_id: str | None = Form(default=None, pattern=r"^(?:[a-f0-9]{32}|default)$"),
        key_speaker_ids: str = Form(default="[]"),
    ) -> dict[str, Any]:
        try:
            if not title.strip():
                raise MeetingError("请输入会议名称", 422)
            return await audio_imports.create(file, title.strip(), language, department_id,
                                              request.state.user["id"], minutes_format_id,
                                              parse_key_speaker_ids(key_speaker_ids))
        finally:
            for item in file:
                await item.close()

    @app.post("/api/meetings/import/chunked")
    async def start_chunked_import(payload: ChunkedImportStart, request: Request) -> dict[str, Any]:
        files = [item.model_dump() for item in payload.files] if payload.files else [{
            "filename": payload.filename,
            "file_size": payload.file_size,
            "total_chunks": payload.total_chunks,
            "chunk_size": payload.chunk_size,
        }]
        return await audio_imports.start_chunked(
            payload.title, payload.language, files, request.state.user["id"], payload.minutes_format_id,
            payload.key_speaker_ids,
        )

    @app.put("/api/meetings/import/chunked/{upload_id}/{index}")
    async def upload_import_chunk(upload_id: str, index: int, request: Request) -> dict[str, Any]:
        return await audio_imports.upload_chunk(
            upload_id, 0, index, request.stream(), request.headers.get("X-Chunk-SHA256", ""),
            request.state.user["id"],
        )

    @app.put("/api/meetings/import/chunked/{upload_id}/file/{file_index}/{index}")
    async def upload_import_file_chunk(upload_id: str, file_index: int, index: int, request: Request) -> dict[str, Any]:
        return await audio_imports.upload_chunk(
            upload_id, file_index, index, request.stream(), request.headers.get("X-Chunk-SHA256", ""),
            request.state.user["id"],
        )

    @app.post("/api/meetings/import/chunked/{upload_id}/complete", status_code=202)
    async def complete_chunked_import(upload_id: str, request: Request) -> dict[str, Any]:
        return await audio_imports.complete_chunked(upload_id, request.state.user["id"])

    @app.post("/api/meetings/import/chunked/{upload_id}/fail", status_code=202)
    async def fail_chunked_import(upload_id: str, payload: ChunkedImportFailure, request: Request) -> dict[str, Any]:
        return await audio_imports.fail_chunked(upload_id, request.state.user["id"], payload.error)

    @app.post("/api/meetings/{meeting_id}/import/retry", status_code=202)
    async def retry_import(meeting_id: str, request: Request) -> dict[str, Any]:
        if store.get(meeting_id, request.state.user["id"]) is None:
            raise HTTPException(404, "会议不存在")
        return await audio_imports.retry(meeting_id)

    @app.get("/api/departments")
    def list_departments(request: Request) -> list[dict[str, Any]]:
        require_admin(request)
        return store.list_departments()

    @app.post("/api/departments", status_code=201)
    def create_department(payload: DepartmentInput, request: Request) -> dict[str, Any]:
        require_admin(request)
        return store.save_department(payload.name)

    @app.put("/api/departments/{department_id}")
    def update_department(department_id: str, payload: DepartmentInput, request: Request) -> dict[str, Any]:
        require_admin(request)
        return store.save_department(payload.name, department_id)

    @app.delete("/api/departments/{department_id}", status_code=204)
    def delete_department(department_id: str, request: Request) -> Response:
        require_admin(request)
        store.delete_department(department_id)
        return Response(status_code=204)

    @app.get("/api/minutes-formats")
    def list_minutes_formats(request: Request) -> list[dict[str, Any]]:
        return store.list_minutes_formats()

    @app.post("/api/minutes-formats/generate")
    async def generate_minutes_format(payload: MinutesFormatGenerateInput, request: Request) -> dict[str, str]:
        require_admin(request)
        try:
            prompt = await minutes.generate_format_prompt(payload.name, payload.requirement)
        except MinutesGenerationError as exc:
            raise MeetingError(str(exc), 503) from exc
        return {"prompt": prompt}

    @app.post("/api/minutes-formats", status_code=201)
    def create_minutes_format(payload: MinutesFormatInput, request: Request) -> dict[str, Any]:
        require_admin(request)
        return store.save_minutes_format(payload.name, payload.prompt)

    @app.put("/api/minutes-formats/{format_id}")
    def update_minutes_format(format_id: str, payload: MinutesFormatInput, request: Request) -> dict[str, Any]:
        require_admin(request)
        return store.save_minutes_format(payload.name, payload.prompt, format_id)

    @app.delete("/api/minutes-formats/{format_id}", status_code=204)
    def delete_minutes_format(format_id: str, request: Request) -> Response:
        require_admin(request)
        store.delete_minutes_format(format_id)
        return Response(status_code=204)

    @app.get("/api/meetings/{meeting_id}")
    def get_meeting(meeting_id: str, request: Request) -> dict[str, Any]:
        meeting = store.get(meeting_id, meeting_user_id(request))
        if meeting is None:
            raise HTTPException(404, "会议不存在")
        return meeting

    @app.post("/api/meetings/{meeting_id}/end")
    async def end_meeting(meeting_id: str, request: Request) -> dict[str, Any]:
        user_id = request.state.user["id"]
        meeting = await asyncio.to_thread(store.transition, meeting_id, "end", None, user_id)
        audio = await asyncio.to_thread(read_audio_summary, store.directory(meeting_id))
        if audio:
            await stage_summaries.finish(meeting_id, audio.samples)
        await diarization.finish(meeting_id)
        return meeting

    @app.post("/api/meetings/{meeting_id}/diarization", status_code=202)
    async def retry_diarization(meeting_id: str, request: Request):
        meeting = get_meeting(meeting_id, request)
        if meeting.get("import_job") and meeting["import_job"]["status"] != "ready":
            raise MeetingError("请先完成导入处理，失败时请重试导入任务")
        await diarization.finish(meeting_id, retry=True)
        return await asyncio.to_thread(store.get, meeting_id, meeting_user_id(request))

    @app.delete("/api/meetings/{meeting_id}", status_code=204)
    async def delete_meeting(meeting_id: str, request: Request):
        user_id = meeting_user_id(request)
        if store.get(meeting_id, user_id) is None:
            raise HTTPException(404, "会议不存在")
        async with audio_imports.lock, diarization.finish_lock, minutes._lock:
            if meeting_id in diarization.live or meeting_id in diarization.finalizers:
                raise MeetingError("正在处理说话人，请完成后再删除")
            await asyncio.to_thread(store.delete, meeting_id, user_id)
            if timer := diarization.timers.pop(meeting_id, None):
                timer.cancel()
            diarization.dirty.discard(meeting_id)
        stage_summaries.deleted(meeting_id)
        events.publish(meeting_id, {"type": "deleted"})
        return Response(status_code=204)

    @app.get("/api/diarization/status")
    def diarization_status(request: Request):
        error = diarization.workers[0].readiness()
        return {"available": error is None, "error": error or ""}

    @app.get("/api/voiceprints")
    def list_voiceprints(request: Request):
        department_id = None if request.state.user.get("is_admin") or request.state.user.get("is_department_admin") else request.state.user["department_id"]
        return voiceprints.list(department_id=department_id)

    @app.post("/api/voiceprints", status_code=201)
    async def create_voiceprint(request: Request, file: UploadFile = File(...), name: str = Form(...),
                                department_id: str = Form(...),
                                source: Literal["recording", "import"] = Form("import")):
        if not request.state.user.get("is_admin"):
            raise HTTPException(403, "只有管理员可以管理声纹")
        try:
            return await voiceprints.create(file, name, department_id, request.state.user["id"], source)
        finally:
            await file.close()

    @app.put("/api/voiceprints/{voiceprint_id}")
    def update_voiceprint(voiceprint_id: str, payload: VoiceprintNameInput, request: Request):
        if not request.state.user.get("is_admin"):
            raise HTTPException(403, "只有管理员可以管理声纹")
        return voiceprints.rename(voiceprint_id, payload.name)

    @app.delete("/api/voiceprints/{voiceprint_id}", status_code=204)
    def delete_voiceprint(voiceprint_id: str, request: Request):
        if not request.state.user.get("is_admin"):
            raise HTTPException(403, "只有管理员可以管理声纹")
        voiceprints.delete(voiceprint_id)
        return Response(status_code=204)

    @app.get("/api/meetings/{meeting_id}/minutes")
    async def get_minutes(meeting_id: str, request: Request) -> dict[str, Any]:
        get_meeting(meeting_id, request)
        return await minutes.get(meeting_id)

    @app.get("/api/meetings/{meeting_id}/stage-summaries")
    async def get_stage_summaries(meeting_id: str, request: Request) -> list[dict[str, Any]]:
        get_meeting(meeting_id, request)
        return await stage_summaries.list(meeting_id)

    @app.post("/api/meetings/{meeting_id}/stage-summaries/retry", status_code=202)
    async def retry_stage_summaries(meeting_id: str, request: Request) -> list[dict[str, Any]]:
        get_meeting(meeting_id, request)
        await stage_summaries.retry_failed(meeting_id)
        return await stage_summaries.list(meeting_id)

    @app.post("/api/meetings/{meeting_id}/minutes", status_code=202)
    async def generate_minutes(meeting_id: str, request: Request) -> dict[str, Any]:
        get_meeting(meeting_id, request)
        return await minutes.start(meeting_id)

    @app.head("/api/meetings/{meeting_id}/minutes/download")
    @app.get("/api/meetings/{meeting_id}/minutes/download")
    def download_minutes(meeting_id: str, request: Request,
                         format: Literal["markdown", "docx"] = Query("markdown")) -> Response:
        meeting = get_meeting(meeting_id, request)
        result = store.get_minutes(meeting_id)
        if not result["text"]:
            raise HTTPException(404, "会议纪要尚未生成")
        if format == "docx":
            content = build_docx(meeting["title"], result["text"])
            filename = meeting["title"] + "-会议纪要.docx"
            fallback_filename = "meeting-minutes.docx"
            media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            content = (result["text"] + "\n").encode("utf-8")
            filename = meeting["title"] + "-会议纪要.md"
            fallback_filename = "meeting-minutes.md"
            media_type = "text/markdown; charset=utf-8"
        return Response(
            content if request.method != "HEAD" else None,
            media_type=media_type,
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{fallback_filename}"; '
                    f"filename*=UTF-8''{quote(filename, safe='')}"
                ),
                "Content-Length": str(len(content)),
                "Cache-Control": "no-store",
            },
        )

    @app.head("/api/meetings/{meeting_id}/stage-summaries/download")
    @app.get("/api/meetings/{meeting_id}/stage-summaries/download")
    async def download_stage_summaries(meeting_id: str, request: Request) -> Response:
        meeting = get_meeting(meeting_id, request)
        summaries = [
            summary for summary in await stage_summaries.list(meeting_id)
            if summary["status"] == "ready" and summary["text"].strip()
        ]
        if not summaries:
            raise HTTPException(404, "阶段总结尚未生成")

        def stage_time(seconds: float) -> str:
            total = max(0, int(seconds))
            return f"{total // 60:02d}:{total % 60:02d}"

        sections = [
            f"## {stage_time(summary['start_seconds'])}–{stage_time(summary['end_seconds'])}\n\n{summary['text'].strip()}"
            for summary in summaries
        ]
        content = f"# {meeting['title']} - 阶段总结\n\n" + "\n\n".join(sections) + "\n"
        encoded = content.encode("utf-8")
        return Response(
            encoded if request.method != "HEAD" else None,
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(meeting['title'] + '-阶段总结.md', safe='')}",
                "Content-Length": str(len(encoded)),
                "Cache-Control": "no-store",
            },
        )

    @app.head("/api/meetings/{meeting_id}/download")
    @app.get("/api/meetings/{meeting_id}/download")
    def download_meeting(meeting_id: str, request: Request) -> Response:
        meeting = get_meeting(meeting_id, request)
        transcript = (
            plain_text(store.transcript(meeting_id).read())
            if meeting["text_path"].startswith("meetings/")
            else meeting["text"]
        )
        content = (transcript + "\n").encode("utf-8")
        return Response(
            content if request.method != "HEAD" else None,
            media_type="text/plain; charset=utf-8",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(meeting['title'] + '.txt', safe='')}",
                "Content-Length": str(len(content)),
                "Cache-Control": "no-store",
            },
        )

    @app.head("/api/meetings/{meeting_id}/audio/download")
    @app.get("/api/meetings/{meeting_id}/audio/download")
    def download_audio(meeting_id: str, request: Request) -> Response:
        meeting = get_meeting(meeting_id, request)
        try:
            export = prepare_wav_export(store.directory(meeting_id))
        except AudioExportUnavailable as exc:
            raise HTTPException(404, str(exc)) from exc
        except AudioExportInvalid as exc:
            logger.exception("Invalid audio archive for meeting %s", meeting_id)
            raise HTTPException(500, "录音归档无法导出，请检查数据目录") from exc
        headers = {
            "Content-Length": str(export.content_length),
            "Cache-Control": "no-store",
            "Content-Disposition": (
                "attachment; "
                f"filename*=UTF-8''{quote(meeting['title'] + '-录音.wav', safe='')}"
            ),
        }
        if request.method == "HEAD":
            return Response(media_type="audio/wav", headers=headers)
        return StreamingResponse(export.iter_bytes(), media_type="audio/wav", headers=headers)

    @app.websocket("/ws/meetings/{meeting_id}")
    async def recognize_meeting(websocket: WebSocket, meeting_id: str) -> None:
        user = auth.user_for_token(websocket.query_params.get("token"))
        if user is None:
            await websocket.close(code=1008, reason="请先登录")
            return
        await meeting_socket(websocket, meeting_id, store, models, minutes, stream_factory,
                             settings=app_settings, diarization=diarization, events=events,
                             stage_summaries=stage_summaries, system_settings=system_settings,
                             user_id=None if user.get("is_admin") else user["id"])

    @app.websocket("/ws/meetings/{meeting_id}/stage-summaries")
    async def summarize_meeting_stages(websocket: WebSocket, meeting_id: str) -> None:
        user = auth.user_for_token(websocket.query_params.get("token"))
        if user is None:
            await websocket.close(code=1008, reason="请先登录")
            return
        await stage_summary_socket(websocket, meeting_id, store, stage_summaries,
                                   user_id=None if user.get("is_admin") else user["id"])

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
