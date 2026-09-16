from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .meetings import MeetingError

ModelKind = Literal["asr", "llm"]
ASRMode = Literal["qwen_streaming", "transcription"]
DEFAULT_TOKENIZER = "data/tokenizers/qwen"


@dataclass(frozen=True)
class ModelConfig:
    base_url: str
    model: str
    api_key: str = field(repr=False)
    timeout_seconds: float
    asr_mode: ASRMode = "qwen_streaming"
    tokenizer: str = DEFAULT_TOKENIZER


class ModelConfigInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=4096, repr=False)
    timeout_seconds: float = Field(default=120, gt=0, le=600)
    asr_mode: ASRMode = "qwen_streaming"

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("请输入有效的 HTTP/HTTPS API 地址，密钥请填写在 API Key 中")
        return value

    @field_validator("model")
    @classmethod
    def nonempty_model(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请输入模型名称")
        return value.strip()


class ModelConfigStore:
    """One saved configuration for speech and one for text; secrets stay on the server."""

    def __init__(self, path: Path) -> None:
        self.path = path
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS model_configs (
                kind TEXT PRIMARY KEY CHECK(kind IN ('asr', 'llm')),
                base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL,
                timeout_seconds REAL NOT NULL, updated_at TEXT NOT NULL,
                asr_mode TEXT NOT NULL DEFAULT 'qwen_streaming'
            )""")

    def get(self, kind: ModelKind) -> dict[str, Any] | None:
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("""SELECT kind, base_url, model, api_key, timeout_seconds, updated_at, asr_mode
                FROM model_configs WHERE kind = ?""", (kind,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def public(record: dict[str, Any]) -> dict[str, Any]:
        result = {key: value for key, value in record.items() if key != "api_key"}
        result["api_key_configured"] = bool(record["api_key"] and record["api_key"] != "EMPTY")
        result["configured"] = True
        return result

    def list(self) -> list[dict[str, Any]]:
        return [self.public(record) if (record := self.get(kind)) else {
            "kind": kind, "base_url": "", "model": "", "timeout_seconds": 120,
            "asr_mode": "qwen_streaming",
            "api_key_configured": False, "configured": False, "updated_at": None,
        } for kind in ("asr", "llm")]

    def save(self, kind: ModelKind, payload: ModelConfigInput) -> dict[str, Any]:
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT api_key FROM model_configs WHERE kind = ?", (kind,)).fetchone()
            key = payload.api_key if payload.api_key is not None else existing[0] if existing else ""
            db.execute("""INSERT INTO model_configs
                (kind, base_url, model, api_key, timeout_seconds, updated_at, asr_mode)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind) DO UPDATE SET base_url = excluded.base_url, model = excluded.model,
                api_key = excluded.api_key, timeout_seconds = excluded.timeout_seconds, updated_at = excluded.updated_at,
                asr_mode = excluded.asr_mode""",
                (kind, payload.base_url, payload.model, key, payload.timeout_seconds, datetime.now(timezone.utc).isoformat(),
                 payload.asr_mode))
        record = self.get(kind)
        assert record is not None
        return self.public(record)

    def require(self, kind: ModelKind) -> ModelConfig:
        record = self.get(kind)
        if record is None:
            name = "ASR 模型" if kind == "asr" else "大语言模型"
            raise MeetingError(f"尚未配置{name}，请在模型配置中添加。", 503)
        return ModelConfig(
            base_url=record["base_url"],
            model=record["model"],
            api_key=record["api_key"],
            timeout_seconds=record["timeout_seconds"],
            asr_mode=record["asr_mode"],
        )

    def resolve_draft(self, kind: ModelKind, payload: ModelConfigInput) -> ModelConfig:
        record = self.get(kind)
        key = payload.api_key if payload.api_key is not None else record["api_key"] if record else ""
        return ModelConfig(
            base_url=payload.base_url, model=payload.model, api_key=key,
            timeout_seconds=payload.timeout_seconds, asr_mode=payload.asr_mode,
        )
