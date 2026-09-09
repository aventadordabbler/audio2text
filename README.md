## Audio2Text

一个基于 FastAPI、WebSocket、浏览器 MediaRecorder 和 Qwen3-ASR-1.7B/vLLM 的实时转写原型。

### 本地启动（无需 GPU）

    cp .env.example .env
    docker compose up --build

打开 http://localhost:8000，点击“开始录音”并允许麦克风权限。默认 ASR_MODE=mock，用于验证页面、WebSocket 和归档流程，不会加载模型。

### GPU + vLLM

需要已安装 NVIDIA Container Toolkit 的 Docker 主机：

    ASR_MODE=vllm docker compose --profile gpu up --build

vllm 服务会在首次启动时下载 Qwen/Qwen3-ASR-1.7B。模型服务监听容器内 8001，应用通过 OpenAI 兼容的 /v1/audio/transcriptions 请求调用。

### 协议

客户端连接 GET /ws/transcribe：

1. JSON {"type":"start","title":"会议","language":"Chinese","mime_type":"audio/webm;codecs=opus"}
2. 多个二进制 WebSocket 帧，每个是 MediaRecorder 的音频片段。
3. JSON {"type":"stop","title":"会议","language":"Chinese"}。

服务端回推 ready、transcript、error 和 archived 事件。归档同时写入 data/archives/<id>.txt 和 .json，并可通过历史列表查看或下载。

当前原型使用 vLLM 的 OpenAI transcription 文件接口：每个音频片段到达后，以累计录音重新识别并回推完整文本。这样可以先验证实时采集、展示和归档闭环；若要降低长录音的重复推理成本，下一步应接入 Qwen3-ASR 原生流式状态接口或增加服务端音频切片/合并队列。
