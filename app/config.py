from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "会议助手"
    # Use the real OpenAI-compatible transcription API.
    asr_mode: str = "api"
    vllm_base_url: str = "http://127.0.0.1:8001/v1"
    vllm_model: str = "qwen3-asr-1.7b"
    vllm_api_key: str = "EMPTY"
    asr_timeout_seconds: float = 120.0
    # Text generation uses a separate model endpoint from speech recognition.
    llm_base_url: str = ""
    llm_model: str = ""
    llm_api_key: str = "EMPTY"
    llm_timeout_seconds: float = Field(default=120.0, gt=0)
    llm_max_tokens: int = Field(default=3000, ge=256)
    llm_chunk_chars: int = Field(default=12000, ge=1000)
    data_dir: Path = Path("data/archives")
    database_path: Path | None = None
    max_audio_bytes: int = 25 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
