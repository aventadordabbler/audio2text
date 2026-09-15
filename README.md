## Audio2Text

一个基于 FastAPI、WebSocket、浏览器 MediaRecorder 和 Qwen3-ASR-1.7B/vLLM 的实时转写原型。

### 本地启动（宿主机 uv + vLLM 容器）

    cp .env.example .env
    docker compose --profile gpu up -d vllm
    uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

打开 http://localhost:8000，点击“开始录音”并允许麦克风权限。应用通过 `.env` 中的 `VLLM_BASE_URL` 调用本机 8001 端口上的 vLLM 服务。模型目录 `./models/qwen3-asr-1.7b` 会以只读方式挂载到 vLLM 容器内的 `/models/qwen3-asr-1.7b`。

### GPU + vLLM

需要已安装 NVIDIA Container Toolkit 的 Docker 主机：

    docker compose --profile gpu up -d vllm

使用 GPU profile 时，官方 Qwen3-ASR 镜像通过 `qwen-asr-serve` 从本地目录加载模型，不需要再次下载权重。默认显存利用率设为 `0.8`，上下文长度设为 `32768`，适合 12 GiB 显卡并为 KV cache 和其他进程留出余量；可分别通过 `VLLM_GPU_MEMORY_UTILIZATION` 和 `VLLM_MAX_MODEL_LEN` 调整。模型服务监听容器内 8001，应用通过 OpenAI 兼容的 `/v1/audio/transcriptions` 请求调用。`VLLM_MODEL` 必须与 vLLM `/v1/models` 返回的模型 ID 完全一致，默认值为 `qwen3-asr-1.7b`。

### 协议

客户端连接 GET /ws/transcribe：

1. JSON {"type":"start","title":"会议","language":"Chinese","mime_type":"audio/webm;codecs=opus"}
2. 多个二进制 WebSocket 帧，每个是 MediaRecorder 的音频片段。
3. JSON {"type":"stop","title":"会议","language":"Chinese"}。

服务端回推 ready、transcript、error 和 archived 事件。归档同时写入 data/archives/<id>.txt 和 .json，并可通过历史列表查看或下载。

当前原型使用 vLLM 的 OpenAI transcription 文件接口：每个音频片段到达后，以累计录音重新识别并回推完整文本。这样可以先验证实时采集、展示和归档闭环；若要降低长录音的重复推理成本，下一步应接入 Qwen3-ASR 原生流式状态接口或增加服务端音频切片/合并队列。
