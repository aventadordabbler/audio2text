"""Fixed-window Qwen transcription over OpenAI-compatible APIs.

No model weights, torch, qwen_asr or vLLM are loaded in this process.
Algorithm reference: QwenLM/Qwen3-ASR, inference/qwen3_asr.py (Apache-2.0).
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
from functools import lru_cache
import io
from pathlib import Path
import re
from time import perf_counter
import wave

import numpy as np
from openai import AsyncOpenAI, APIConnectionError, APIStatusError, APITimeoutError
from tokenizers import Tokenizer

from .model_configs import ModelConfig


# Build the prompt in the CPU app; vLLM still extracts audio and tokenizes it.
# Read the assistant prefix from messages: Transformers temporarily appends a
# marker there when implementing continue_final_message. Keep text out of Jinja source.
QWEN_AUDIO_PROMPT = (
    "<|im_start|>system\n<|im_end|>\n"
    "<|im_start|>user\n<|audio_start|><|audio_pad|><|audio_end|><|im_end|>\n"
    "<|im_start|>assistant\n"
)
QWEN_CHAT_TEMPLATE = (
    "{{ qwen_asr_prompt }}"
    "{% if messages[-1].role == 'assistant' %}{{ messages[-1].content }}{% endif %}"
)


class ASRError(RuntimeError):
    """A model error safe to display without leaking provider details or credentials."""


@lru_cache(maxsize=4)
def load_tokenizer(source: str) -> Tokenizer:
    path = Path(source).expanduser()
    if path.is_file():
        return Tokenizer.from_file(str(path))
    if path.is_dir() and (path / "tokenizer.json").is_file():
        return Tokenizer.from_file(str(path / "tokenizer.json"))
    if not path.is_dir():
        raise FileNotFoundError("ASR_TOKENIZER 必须指向已有的本地分词器目录或 tokenizer.json 文件")
    # Qwen publishes vocab.json + merges.txt, not necessarily a tokenizer.json.
    # AutoTokenizer converts these on CPU; it never loads model weights or remote code.
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(
        str(path.resolve()), local_files_only=True,
        use_fast=True, trust_remote_code=False, token=False, fix_mistral_regex=True,
    )
    if not tokenizer.is_fast:
        raise ValueError("A fast tokenizer is required for token rollback")
    return tokenizer.backend_tokenizer


def rollback_prefix(raw: str, tokenizer: Tokenizer, count: int = 5) -> str:
    tokens = tokenizer.encode(raw, add_special_tokens=False).ids
    end = max(0, len(tokens) - count)
    while end:
        prefix = tokenizer.decode(tokens[:end], skip_special_tokens=False)
        if "\ufffd" not in prefix:
            return prefix
        end -= 1  # A token cut may bisect a multi-byte Chinese character.
    return ""


def parse_text(raw: str) -> str:
    text = raw.strip().removeprefix("<|im_start|>assistant").strip()
    text = re.sub(r"(?:<\|(?:im_end|endoftext)\|>\s*)+$", "", text).strip()
    # Only remove leading metadata, preserving literal tags within speech.
    prefix = re.compile(r"^(?:language\s+[^<\r\n]+\s*)?<asr_text>", re.IGNORECASE)
    while match := prefix.match(text):
        text = text[match.end():].strip()
    if text.lower() == "language none":
        return ""  # Incomplete metadata is not speech.
    return text


def as_wav(samples: np.ndarray) -> bytes:
    pcm = np.rint(np.clip(samples, -1, 32767 / 32768) * 32768).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(pcm.tobytes())
    return output.getvalue()


@dataclass
class DecodeState:
    language: str | None
    stride_samples: int
    window_samples: int
    pending: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    window: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    total_samples: int = 0
    decoded_samples: int = 0
    chunk_id: int = 0
    raw: str = ""
    text: str = ""
    last_window: dict | None = None


def merge_window_text(previous: str, candidate: str, max_overlap: int = 120) -> str:
    """Merge an independently decoded overlapping window without duplicating its tail."""
    previous, candidate = previous.strip(), candidate.strip()
    if not previous:
        return candidate
    if not candidate:
        return previous
    if candidate.startswith(previous):
        return candidate
    if previous.startswith(candidate):
        return previous
    limit = min(len(previous), len(candidate), max_overlap)
    for size in range(limit, 1, -1):
        if previous[-size:] == candidate[:size]:
            return previous + candidate[size:]
    return previous + candidate


class RemoteDecoder:
    """Each meeting owns a bounded rolling window and an async HTTP client."""

    def __init__(
        self,
        config: ModelConfig,
        client: AsyncOpenAI | None = None,
        *,
        use_request_chat_template: bool = False,
        window_seconds: float = 5.0,
        stride_seconds: float = 2.0,
    ):
        if window_seconds <= 0 or stride_seconds <= 0 or stride_seconds > window_seconds:
            raise ValueError("ASR 固定窗口和步长必须为正，且步长不能大于窗口")
        self.config = config
        self.use_request_chat_template = use_request_chat_template
        self.window_seconds = window_seconds
        self.stride_seconds = stride_seconds
        self.client = client or AsyncOpenAI(
            base_url=config.base_url, api_key=config.api_key or "EMPTY",
            timeout=config.timeout_seconds, max_retries=0,
        )
        self.tokenizer = None
        self.request_count = 0
        self.total_request_ms = 0.0
        self.last_request_ms = 0.0
        self.max_request_ms = 0.0

    def diagnostics(self):
        return {
            "request_count": self.request_count,
            "last_request_ms": round(self.last_request_ms, 2),
            "average_request_ms": (
                round(self.total_request_ms / self.request_count, 2) if self.request_count else 0
            ),
            "max_request_ms": round(self.max_request_ms, 2),
        }

    async def prepare(self):
        if self.config.asr_mode == "qwen_streaming":
            try:
                self.tokenizer = await asyncio.wait_for(
                    asyncio.to_thread(load_tokenizer, self.config.tokenizer), self.config.timeout_seconds,
                )
            except Exception as exc:
                raise ASRError("无法加载本地 ASR 分词器，请检查 ASR_TOKENIZER 路径及文件是否完整。") from exc

    def new_state(self, language, chunk_seconds):
        # chunk_seconds remains part of the decoder protocol for callers that
        # provide a decoder of their own. Remote model requests use the fixed
        # window/stride configured above instead of growing with the utterance.
        return DecodeState(
            language,
            max(1, round(self.stride_seconds * 16000)),
            max(1, round(self.window_seconds * 16000)),
        )

    async def feed(self, audio, state):
        state.pending = np.concatenate((state.pending, audio))
        while len(state.pending) >= state.stride_samples:
            chunk, state.pending = state.pending[:state.stride_samples], state.pending[state.stride_samples:]
            self._append_window(chunk, state)
            if len(state.window) >= state.window_samples:
                await self._decode_window(state)
        return state.text

    async def finish(self, state):
        if len(state.pending):
            self._append_window(state.pending, state)
            state.pending = np.empty(0, dtype=np.float32)
        if state.total_samples > state.decoded_samples and len(state.window):
            await self._decode_window(state)
        return state.text

    @staticmethod
    def _append_window(chunk, state):
        state.total_samples += len(chunk)
        state.window = np.concatenate((state.window, chunk))[-state.window_samples:]

    async def _decode_window(self, state):
        start = state.total_samples - len(state.window)
        await self._decode(state.window, state)
        state.decoded_samples = state.total_samples
        state.last_window = {
            "window_id": f"{round(start / 16)}:{round(state.total_samples / 16)}",
            "start_ms": round(start / 16),
            "end_ms": round(state.total_samples / 16),
        }

    async def _decode(self, chunk, state):
        wav = as_wav(chunk)
        started = perf_counter()
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                if self.config.asr_mode == "transcription":
                    languages = {"Chinese": "zh", "English": "en", "Japanese": "ja"}
                    kwargs = {"language": languages.get(state.language, state.language)} if state.language else {}
                    result = await self.client.audio.transcriptions.create(
                        model=self.config.model, file=("speech.wav", wav, "audio/wav"),
                        response_format="json", **kwargs,
                    )
                    raw = result.text
                else:
                    prefix = rollback_prefix(state.raw, self.tokenizer) if state.chunk_id >= 2 else ""
                    forced = f"language {state.language}<asr_text>" if state.language else ""
                    messages = [
                        {"role": "system", "content": ""},
                        {"role": "user", "content": [{"type": "input_audio", "input_audio": {
                            "format": "wav", "data": base64.b64encode(wav).decode("ascii"),
                        }}]},
                    ]
                    extra = {}
                    if forced or prefix:
                        messages.append({"role": "assistant", "content": forced + prefix})
                        extra = {"continue_final_message": True, "add_generation_prompt": False}
                    if self.use_request_chat_template:
                        extra.update(
                            chat_template=QWEN_CHAT_TEMPLATE,
                            chat_template_kwargs={"qwen_asr_prompt": QWEN_AUDIO_PROMPT},
                        )
                    result = await self.client.chat.completions.create(
                        model=self.config.model, messages=messages, temperature=0,
                        max_tokens=512, extra_body=extra,
                    )
                    if not result.choices or result.choices[0].finish_reason != "stop":
                        raise ASRError("ASR 返回了不完整的识别结果，录音已停止；已定稿内容已保存。")
                    suffix = result.choices[0].message.content
                    if not isinstance(suffix, str):
                        raise ASRError("ASR 返回了无效的文字结果。")
                    raw = prefix + suffix
                if not isinstance(raw, str):
                    raise ASRError("ASR 返回了无效的文字结果。")
                candidate = parse_text(raw)
                if self.config.asr_mode == "transcription":
                    state.text = merge_window_text(state.text, candidate)
                else:
                    # Qwen prefix continuation returns the complete prefix plus
                    # the new suffix, so the latest candidate replaces the
                    # provisional text instead of being appended again.
                    state.text = candidate or state.text
                state.raw = raw
                state.chunk_id += 1
        except (TimeoutError, APITimeoutError) as exc:
            raise ASRError("ASR 请求超时，录音已停止；已定稿内容已保存。") from exc
        except APIConnectionError as exc:
            raise ASRError("无法连接 ASR 服务，请检查模型地址和网络。") from exc
        except APIStatusError as exc:
            if exc.status_code in {401, 403}:
                message = "ASR 服务鉴权失败，请检查 API Key 和访问权限。"
            elif exc.status_code in {400, 404, 422}:
                if self.config.asr_mode == "transcription":
                    message = "ASR 文件转写请求被拒绝，请检查模型名称和 /audio/transcriptions 接口。"
                elif self.use_request_chat_template:
                    message = ("ASR 音频或前缀续写请求被拒绝，请检查模型名称及接口支持；"
                               "应用已发送内置模板，vLLM 需开启 --trust-request-chat-template。"
                               "若使用服务自身的续写模板，请在系统管理中关闭请求级模板；"
                               "不支持续写时，请在模型配置中选择文件转写模式。")
                else:
                    message = ("ASR 服务不支持当前音频或前缀续写请求，请检查模型名称；"
                               "当前使用服务自身模板，该模板需支持 assistant 前缀续写。"
                               "服务允许请求级模板时，可在系统管理中开启请求级模板；"
                               "不支持续写时，请在模型配置中选择文件转写模式。")
            elif exc.status_code == 429:
                message = "ASR 服务繁忙或请求额度不足，请稍后继续。"
            else:
                message = "ASR 服务识别失败，已定稿内容已保存，请检查模型服务日志。"
            raise ASRError(message) from exc
        finally:
            elapsed = (perf_counter() - started) * 1000
            self.request_count += 1
            self.total_request_ms += elapsed
            self.last_request_ms = elapsed
            self.max_request_ms = max(self.max_request_ms, elapsed)

    async def close(self):
        await self.client.close()
