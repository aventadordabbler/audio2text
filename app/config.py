from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Audio2Text"
    # Use the real OpenAI-compatible transcription API.
    asr_mode: str = "api"
    vllm_base_url: str = "http://127.0.0.1:8001/v1"
    vllm_model: str = "qwen3-asr-1.7b"
    vllm_api_key: str = "EMPTY"
    asr_timeout_seconds: float = 120.0
    data_dir: Path = Path("data/archives")
    max_audio_bytes: int = 25 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
