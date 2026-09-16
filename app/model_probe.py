"""Check a draft model configuration without changing the saved configuration."""
from __future__ import annotations

import asyncio
from time import perf_counter

from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from pydantic import BaseModel

from .model_configs import ModelConfig


class ModelProbeResult(BaseModel):
    success: bool
    message: str
    elapsed_ms: int


async def probe_model(config: ModelConfig) -> ModelProbeResult:
    started = perf_counter()
    success = False
    timeout = min(config.timeout_seconds, 30)
    try:
        async with asyncio.timeout(timeout):
            async with AsyncOpenAI(
                base_url=config.base_url, api_key=config.api_key or "EMPTY",
                timeout=timeout, max_retries=0,
            ) as client:
                models = await client.models.list()
                if not isinstance(models.data, list) or any(not isinstance(model.id, str) for model in models.data):
                    message = "服务已响应，但模型列表格式不正确，请检查 API 地址和服务兼容性。"
                elif not any(model.id == config.model for model in models.data):
                    message = "服务连接成功，但模型列表中未找到所填模型，请检查模型名称和访问权限。"
                else:
                    success = True
                    message = "连接成功，鉴权通过，已找到所填模型。"
    except (TimeoutError, APITimeoutError):
        message = f"连接超时（{timeout:g} 秒），请检查服务状态和网络。"
    except APIConnectionError:
        message = "无法连接模型服务，请检查 API 地址、网络和 HTTPS 证书。"
    except APIStatusError as exc:
        if exc.status_code in {401, 403}:
            message = f"鉴权失败（HTTP {exc.status_code}），请检查 API Key 和访问权限。"
        elif exc.status_code in {404, 405}:
            message = f"模型列表接口不可用（HTTP {exc.status_code}），请检查 API 基础地址及服务是否支持 GET /models。"
        elif exc.status_code == 429:
            message = "服务限流或额度不足（HTTP 429），请稍后重试。"
        elif exc.status_code >= 500:
            message = f"模型服务异常（HTTP {exc.status_code}），请检查服务状态后重试。"
        else:
            message = f"测试请求被拒绝（HTTP {exc.status_code}），请检查配置和服务兼容性。"
    except Exception:
        # Provider errors can contain credentials; only return our own messages.
        message = "无法完成连通性检查，请检查 API 地址和模型服务的响应格式。"
    return ModelProbeResult(success=success, message=message, elapsed_ms=round((perf_counter() - started) * 1000))
