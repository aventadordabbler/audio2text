from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "会议助手"
    llm_max_tokens: int = Field(default=16384, ge=256)
    llm_chunk_chars: int = Field(default=12000, ge=1000)
    data_dir: Path = Path("data/archives")
    database_path: Path | None = None
    max_audio_bytes: int = 25 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
