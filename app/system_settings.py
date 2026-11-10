from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


SYSTEM_SETTING_DEFAULTS = {
    "slogan": "",
    "asr_use_request_chat_template": False,
    "llm_max_tokens": 16384,
    "llm_chunk_chars": 12000,
    "stage_summary_window_seconds": 120,
    "stage_summary_max_tokens": 1200,
}


class SystemSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slogan: str = Field(default="", max_length=200)
    asr_use_request_chat_template: bool
    llm_max_tokens: int = Field(ge=256)
    llm_chunk_chars: int = Field(ge=1000)
    stage_summary_window_seconds: int = Field(ge=10, le=300)
    stage_summary_max_tokens: int = Field(ge=128, le=8192)


class SystemSettingsStore:
    """Persist application-wide settings in the meeting database."""

    def __init__(self, path: Path) -> None:
        self.path = path
        with sqlite3.connect(path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS system_settings "
                "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            db.executemany(
                "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
                SYSTEM_SETTING_DEFAULTS.items(),
            )

    def get(self) -> dict[str, int | bool | str]:
        with sqlite3.connect(self.path) as db:
            rows = db.execute("SELECT key, value FROM system_settings").fetchall()
        values = dict(SYSTEM_SETTING_DEFAULTS)
        for key, value in rows:
            if key in values:
                if key == "asr_use_request_chat_template":
                    values[key] = str(value).lower() in {"1", "true", "yes", "on"}
                elif key == "slogan":
                    values[key] = str(value)
                else:
                    values[key] = int(value)
        return values

    def save(self, values: SystemSettingsInput | Mapping[str, Any]) -> dict[str, int | bool | str]:
        validated = (
            values
            if isinstance(values, SystemSettingsInput)
            else SystemSettingsInput.model_validate(values)
        )
        with sqlite3.connect(self.path) as db:
            db.executemany(
                "INSERT INTO system_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                validated.model_dump().items(),
            )
        return self.get()
