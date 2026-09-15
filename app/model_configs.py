from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

from .config import Settings

ModelKind = Literal["asr", "llm"]


class ModelConfigInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=4096, repr=False)
    timeout_seconds: float = Field(default=120, gt=0, le=600)

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

    def __init__(self, path: Path, defaults: Settings) -> None:
        self.path = path
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS model_configs (
                kind TEXT PRIMARY KEY CHECK(kind IN ('asr', 'llm')),
                base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL,
                timeout_seconds REAL NOT NULL, updated_at TEXT NOT NULL
            )""")
            # Bootstrap existing deployments once. Saved database values always take precedence.
            for kind, url, model, key, timeout in [
                ("asr", defaults.vllm_base_url, defaults.vllm_model, defaults.vllm_api_key, defaults.asr_timeout_seconds),
                ("llm", defaults.llm_base_url, defaults.llm_model, defaults.llm_api_key, defaults.llm_timeout_seconds),
            ]:
                if url.strip() and model.strip():
                    db.execute("INSERT OR IGNORE INTO model_configs VALUES (?, ?, ?, ?, ?, ?)", (
                        kind, url.strip().rstrip("/"), model.strip(), key, timeout, datetime.now(timezone.utc).isoformat(),
                    ))

    def get(self, kind: ModelKind) -> dict[str, Any] | None:
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM model_configs WHERE kind = ?", (kind,)).fetchone()
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
            "api_key_configured": False, "configured": False, "updated_at": None,
        } for kind in ("asr", "llm")]

    def save(self, kind: ModelKind, payload: ModelConfigInput) -> dict[str, Any]:
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT api_key FROM model_configs WHERE kind = ?", (kind,)).fetchone()
            key = payload.api_key if payload.api_key is not None else existing[0] if existing else ""
            db.execute("""INSERT INTO model_configs VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind) DO UPDATE SET base_url = excluded.base_url, model = excluded.model,
                api_key = excluded.api_key, timeout_seconds = excluded.timeout_seconds, updated_at = excluded.updated_at""",
                (kind, payload.base_url, payload.model, key, payload.timeout_seconds, datetime.now(timezone.utc).isoformat()))
        record = self.get(kind)
        assert record is not None
        return self.public(record)

    def settings(self, kind: ModelKind, defaults: Settings) -> Settings:
        record = self.get(kind)
        prefix = "vllm" if kind == "asr" else "llm"
        return defaults.model_copy(update={
            f"{prefix}_base_url": record["base_url"] if record else "",
            f"{prefix}_model": record["model"] if record else "",
            f"{prefix}_api_key": record["api_key"] or "EMPTY" if record else "EMPTY",
            f"{'asr' if kind == 'asr' else 'llm'}_timeout_seconds": record["timeout_seconds"] if record else 120,
        })
