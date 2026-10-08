from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .model_configs import DEFAULT_TOKENIZER


class Settings(BaseSettings):
    app_name: str = "会议助手"
    asr_tokenizer: str = Field(default=DEFAULT_TOKENIZER, min_length=1, max_length=2000)
    asr_send_chat_template: bool = False
    asr_window_seconds: float = Field(default=5.0, ge=1.0, le=30.0)
    asr_stride_seconds: float = Field(default=2.0, ge=0.5, le=30.0)
    llm_max_tokens: int = Field(default=16384, ge=256)
    llm_chunk_chars: int = Field(default=12000, ge=1000)
    stage_summary_window_seconds: int = Field(default=60, ge=10, le=300)
    stage_summary_max_tokens: int = Field(default=1200, ge=128, le=8192)
    data_dir: Path = Path("data/archives")
    database_path: Path | None = None
    diarization_model_dir: Path = Path("models/diarization")
    diarization_segmentation_dir: Path = Path("models/pyannote/segmentation-3.0")
    diarization_workers: int = Field(default=1, ge=1, le=8)
    diarization_threads: int = Field(default=2, ge=1, le=32)
    diarization_timeout_seconds: float = Field(default=120, ge=5, le=1800)
    diarization_final_timeout_seconds: float = Field(default=1800, ge=10, le=14400)
    audio_import_max_bytes: int = Field(default=1024 * 1024 * 1024, ge=1024)
    audio_import_max_seconds: int = Field(default=8 * 3600, ge=1)
    audio_import_workers: int = Field(default=1, ge=1, le=8)
    audio_import_decode_timeout_seconds: float = Field(default=600, ge=5, le=7200)

    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    @field_validator("asr_tokenizer")
    @classmethod
    def nonempty_tokenizer(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("ASR_TOKENIZER 不能为空")
        return value.strip()

    @model_validator(mode="after")
    def valid_asr_window(self):
        if self.asr_stride_seconds > self.asr_window_seconds:
            raise ValueError("ASR_STRIDE_SECONDS 不能大于 ASR_WINDOW_SECONDS")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
