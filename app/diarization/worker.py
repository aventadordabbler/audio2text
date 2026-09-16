from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
import os
from pathlib import Path
import sys

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[2]


class WorkerError(Exception):
    pass


class ModelWorker:
    def __init__(self, settings):
        self.settings = settings
        self.process = None
        self.lock = asyncio.Lock()
        self.logs = None
        self.model_tag = None

    def readiness(self):
        root = self.settings.diarization_model_dir.resolve()
        required = ["campplus/campplus_cn_en_common.pt", "fsmn/config.yaml", "fsmn/model.pt", "fsmn/am.mvn"]
        missing = [name for name in required if not (root / name).is_file()]
        if not (self.settings.diarization_segmentation_dir / "pytorch_model.bin").is_file():
            return "segmentation-3.0 权重未找到，请检查 DIARIZATION_SEGMENTATION_DIR 下的 pytorch_model.bin。"
        if missing:
            return "本地说话人模型文件缺失，请检查 DIARIZATION_MODEL_DIR：" + "、".join(missing)
        return None

    async def _logs(self):
        async for line in self.process.stderr:
            logger.debug("Diarization worker: %s", line.decode(errors="replace").rstrip())

    async def _start(self):
        if error := self.readiness():
            raise WorkerError(error)
        env = {**os.environ, "OMP_NUM_THREADS": str(self.settings.diarization_threads),
               "MKL_NUM_THREADS": str(self.settings.diarization_threads), "CUDA_VISIBLE_DEVICES": "",
               "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "PYTHONUNBUFFERED": "1"}
        self.process = await asyncio.create_subprocess_exec(
            # Use the app's environment while keeping model inference in a child
            # process. Preserve the venv launcher path without resolving symlinks.
            sys.executable, "-m", "app.diarization",
            "--models", str(self.settings.diarization_model_dir.resolve()),
            "--segmentation-dir", str(self.settings.diarization_segmentation_dir.resolve()),
            "--threads", str(self.settings.diarization_threads),
            cwd=ROOT, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=4 * 1024 * 1024)
        self.logs = asyncio.create_task(self._logs())
        line = await self.process.stdout.readline()
        ready = json.loads(line) if line else {}
        if not ready.get("ready"):
            raise WorkerError("说话人识别模型加载失败，请检查模型与工作进程日志。")
        self.model_tag = ready["model_tag"]

    async def request(self, payload):
        async with self.lock:
            try:
                async with asyncio.timeout(self.settings.diarization_timeout_seconds):
                    if self.process is None or self.process.returncode is not None:
                        await self._stop()
                        await self._start()
                    self.process.stdin.write((json.dumps(payload) + "\n").encode())
                    await self.process.stdin.drain()
                    line = await self.process.stdout.readline()
                    result = json.loads(line) if line else {}
                    if "result" not in result:
                        raise WorkerError("说话人识别未完成，可在会议结束后重试校正。")
                    return result["result"]
            except asyncio.CancelledError:
                await self._stop()
                raise
            except WorkerError:
                await self._stop()
                raise
            except Exception as exc:
                await self._stop()
                raise WorkerError("说话人识别工作进程中断或超时，文字转写不受影响。") from exc

    async def _stop(self):
        if self.process is not None and self.process.returncode is None:
            with suppress(ProcessLookupError):
                self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                with suppress(ProcessLookupError):
                    self.process.kill()
                await self.process.wait()
        if self.logs:
            self.logs.cancel()
            await asyncio.gather(self.logs, return_exceptions=True)
        self.logs = self.process = None

    async def close(self):
        async with self.lock:
            await self._stop()
