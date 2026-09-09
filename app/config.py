from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Audio2Text"
    asr_mode: str = "mock"
    vllm_base_url: str = "http://localhost:8001/v1"
    vllm_model: str = "Qwen/Qwen3-ASR-1.7B"
    vllm_api_key: str = "EMPTY"
    asr_timeout_seconds: float = 120.0
    data_dir: Path = Path("data/archives")
    max_audio_bytes: int = 25 * 1024 * 1024

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
