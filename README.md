## 会议助手（Audio2Text）

一个基于 FastAPI、WebSocket、浏览器 MediaRecorder 和 Qwen3-ASR-1.7B/vLLM 的会议助手。支持实时转写与会议结束后的纪要总结。SQLite 保存会议元数据、任务状态、文件路径和模型配置，转写正文与纪要保存在磁盘文件中。

### 本地启动（宿主机 uv + vLLM 容器）

宿主机需安装 Node.js 24（用于前端构建）和 [FFmpeg](https://ffmpeg.org/download.html)，并确保 `ffmpeg` 在 PATH 中（Debian/Ubuntu：`sudo apt-get install ffmpeg`）。应用容器已在 Dockerfile 中安装此依赖。

    cp .env.example .env
    docker compose --profile gpu up -d vllm
    npm ci --prefix web
    npm run build --prefix web
    uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

打开 http://localhost:8000，首页按创建时间倒序显示会议记录。首次使用需点击侧栏“模型配置”，设置 ASR 模型；需要生成纪要时再配置大语言模型。宿主机运行应用时，本地 ASR 地址填写 `http://localhost:8001/v1`，模型名称填写 `qwen3-asr-1.7b`。配置保存后，点击“创建会议”，填写会议名称与识别语言，进入会议后点击“开始录音”并允许麦克风权限。模型目录 `./models/qwen3-asr-1.7b` 会以只读方式挂载到 vLLM 容器内的 `/models/qwen3-asr-1.7b`。

### 前端开发与构建

前端使用 React、TypeScript、Vite、Tailwind CSS 和 [shadcn/ui](https://ui.shadcn.com/docs/installation/vite)，组件源码位于 `web/src/components/ui`，通过官方 CLI 安装。`web/components.json` 保存组件配置，`web/package-lock.json` 锁定依赖。

开发时保持后端运行，并在另一个终端启动前端：

    npm ci --prefix web
    npm run dev --prefix web

访问 http://localhost:5173，Vite 会将 `/api` 和 `/ws` 代理到本机 8000 端口。构建时执行 `npm run build --prefix web`，会先检查 TypeScript，再输出 `web/dist`；FastAPI 从这个目录提供页面。修改前端源码后需重新构建，或使用开发服务器即时预览。

Dockerfile 会在 Node.js 构建阶段自动编译前端，将静态文件复制到 Python 运行镜像；运行镜像保留 FFmpeg，容器启动方式与数据卷保持不变。

如果使用 `uv run main.py` 启动，后端不会自动重载；新增接口后需要重启该进程。开发时可使用上面的 `uvicorn --reload` 命令。Docker 部署更新应用代码时，执行 `docker compose --profile app up -d --build app` 重建并启动应用。仅重建前端会使新页面访问旧后端不存在的接口，例如 `/minutes` 返回 `404 Not Found`。

### GPU + vLLM

需要已安装 NVIDIA Container Toolkit 的 Docker 主机：

    docker compose --profile gpu up -d vllm

使用 GPU profile 时，官方 Qwen3-ASR 镜像通过 `qwen-asr-serve` 从本地目录加载模型，不需要再次下载权重。默认显存利用率设为 `0.8`，上下文长度设为 `32768`，适合 12 GiB 显卡并为 KV cache 和其他进程留出余量；可分别通过 `VLLM_GPU_MEMORY_UTILIZATION` 和 `VLLM_MAX_MODEL_LEN` 调整。模型服务监听容器内 8001，应用使用 OpenAI Python SDK 的 `AsyncOpenAI` 调用兼容的 [`/v1/audio/transcriptions` 接口](https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create)。页面“模型配置 → ASR 模型”中的模型名称必须与 vLLM `/v1/models` 返回的模型 ID 完全一致。Compose 中 vLLM 服务的模型名称由 `VLLM_MODEL` 指定，默认为 `qwen3-asr-1.7b`，应用端需在页面填写相同名称。

### 模型配置

侧栏“模型配置”提供 **ASR 模型 / 大语言模型** 两个页签，每类保存一份配置：API 基础地址、模型名称、API Key 和请求超时。API 地址通常以 `/v1` 结尾，使用的是后端能访问的地址；应用在 Docker 中运行时，`localhost` 指向应用容器自身。同一 Compose 中的 vLLM 服务地址填写 `http://vllm:8001/v1`。Compose 的 `app` 服务不再传入模型环境变量，模型配置通过页面保存到数据库。

- **ASR 模型**：需要支持 OpenAI 兼容的 `/audio/transcriptions` 接口，用于实时语音转写。
- **大语言模型**：需要支持 OpenAI 兼容的 `/chat/completions` 接口，用于会议纪要；需单独提供文本生成模型。
- 配置保存至同一个 SQLite 数据库的 `model_configs` 表，刷新页面和重启服务后保留。后续录音连接和纪要任务从数据库读取配置，无需重启；正在进行的任务沿用启动时的配置。
- API Key 只提交给后端保存，读取配置时不返回原值。编辑时留空保留已有密钥，勾选“清除已保存的密钥”可移除。无鉴权的本地服务可留空。
- 应用的模型地址、名称、密钥和请求超时只从数据库读取，不再通过环境变量初始化。尚未配置 ASR 时，录音连接会提示先添加模型。`.env` 中的 `VLLM_MODEL`、`VLLM_MODEL_PATH` 等仅用于启动 Compose 的 vLLM 服务。

### 会议纪要

会议结束且存在转写正文、已配置大语言模型时，后端自动启动纪要任务。结束操作无需等待总结完成；离开或刷新页面后仍在后台生成。详情页通过“实时转写 / 会议纪要”切换，保留各自的滚动区域。

纪要包含会议主题、核心结论、决策事项、待办事项（任务、责任人、预计完成时间）、风险与阻塞、下一步安排。提示词要求以原文为依据，对未明确的信息标注“未明确”。页面通过 [react-markdown](https://github.com/remarkjs/react-markdown) 和 [remark-gfm](https://github.com/remarkjs/remark-gfm) 展示标题、列表与表格，支持复制 Markdown 和下载 `.md` 文件。

历史会议可以手动“生成纪要”，生成后可“重新生成”。同一会议同时只运行一个任务，不同会议相互独立。失败后可重试，重新生成失败时保留上一版纪要和原始转写。无语音的会议不会调用总结模型；服务重启时，中断的任务标记为失败，可重新生成。

长会议按 `LLM_CHUNK_CHARS`（默认 12000 个字符）提取分段要点，再合并整理；每次模型输出上限由 `LLM_MAX_TOKENS`（默认 16384）控制。字符限制并非精确的 token 限制，应根据文本模型的上下文容量调整。输出为空、被截断或仅含思考过程时不会当作成功纪要保存。

### 会议操作

- **创建会议**：先创建再录音；进入会议页面不会自动打开麦克风。
- **开始 / 暂停 / 继续**：暂停会停止采集，累计时长只计算录音时间；继续后保留已有正文。在同一页面暂停后继续会复用录音流，重新进入会议则追加新的录音段落。
- **结束会议**：等待剩余音频识别完成后保存，录音不可继续；已配置大语言模型时自动生成纪要。没有检测到语音时，保留用户创建的会议，正文为空，不生成纪要。
- **查找会议**：按状态筛选，或搜索会议名称与正文；按 `/` 快速聚焦搜索框。
- **自动滚动**：实时转写默认跟随最新内容；取消勾选可停留在之前的位置阅读。
- **返回列表 / 连接中断**：返回列表会先暂停并保存；连接断开后会议自动暂停，已经识别的内容保留，可重新进入继续。尚未成功上传或识别的音频不会持久化。

同一会议同时只允许一个页面录音，其他页面可查看已保存的记录。浏览器麦克风需要 HTTPS 或 localhost。

### 数据存储

默认目录：

    data/archives/
      meetings.sqlite3            # 会议元数据、文件路径、纪要任务状态、模型配置
      transcripts/<会议 ID>.txt   # UTF-8 转写正文，识别后实时更新
      minutes/<会议 ID>.md        # UTF-8 Markdown 会议纪要

SQLite 不存储转写正文或纪要正文。页面查看、恢复会议和下载时，后端通过数据库中的 `text_path` 或 `meeting_minutes.file_path` 读取文件。写入采用同目录临时文件替换，避免读取到半写入的内容。模型 API Key 保存在数据库中，配置读取接口不回显密钥；数据库备份同时包含这些配置。

`DATA_DIR` 默认为 `data/archives`；可通过 `DATABASE_PATH` 指定数据库位置，`transcripts` 和 `minutes` 目录位于数据库同级，数据库中的文件路径相对于该目录保存。备份、迁移时应一起保留数据库和两个文件目录；运行中的数据库请使用 SQLite 的备份工具，或停止应用后复制整个目录。Docker Compose 已挂载 `./data:/app/data`，数据库和文件都会持久保存，SQLite 使用 Python 标准库，无需新增数据库容器。

启动时会将 `DATA_DIR` 内旧版 JSON 归档导入为已结束的会议，保留原 JSON/TXT 文件，重复启动不会重复导入。应用重启后，未结束的录音恢复为暂停，录音时长保留至最后一次保存；当前按单个应用进程运行。

### 接口与协议

HTTP 接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/meetings` | 按创建时间倒序列出会议 |
| `POST /api/meetings` | 创建会议，正文 `{"title":"产品周会","language":"zh"}`；语言可省略 |
| `GET /api/meetings/{id}` | 读取会议状态及文件中的正文 |
| `POST /api/meetings/{id}/end` | 结束未占用录音连接的会议 |
| `GET /api/meetings/{id}/download` | 下载 UTF-8 文本 |
| `GET /api/meetings/{id}/minutes` | 读取纪要任务状态、可用性及文件中的纪要正文 |
| `POST /api/meetings/{id}/minutes` | 生成或重新生成纪要，返回 `202` 和任务状态；仅用于已结束且有正文的会议 |
| `GET /api/meetings/{id}/minutes/download` | 下载 Markdown 纪要 |
| `GET /api/model-configs` | 读取 ASR 和大语言模型配置；不返回 API Key |
| `PUT /api/model-configs/{asr\|llm}` | 保存对应模型配置 |

纪要状态为 `not_started → generating → ready / failed`；可通过重复读取纪要接口获取任务结果。生成失败时 `error` 包含可展示的错误提示，有上一版纪要时 `text` 仍可读取。模型保存正文包含 `base_url`、`model`、可选 `api_key` 和 `timeout_seconds`；省略 `api_key` 表示保留，空字符串表示清除。

先通过 `POST /api/meetings` 创建会议，使用返回的 `id` 连接实时转写 WebSocket `/ws/meetings/{meeting_id}`。这是唯一的实时转写接口，必须指定已有会议，不能省略会议 ID。

每条连接固定绑定一个会议，音频缓冲、语言、转写正文和开始/暂停/继续/结束操作都属于该会议。不同会议可以同时录音，结果只回推到各自的连接，正文分别写入各自的文件。同一会议同时只允许一个录音连接；重复连接会收到 `error` 并以 `1008` 关闭。断开连接后，该会议录音自动暂停，可重新连接继续。

消息顺序：

1. 服务端发送 `{"type":"ready","meeting":{...}}`。
2. 客户端发送 `{"type":"start","mime_type":"audio/webm;codecs=opus"}`；恢复已暂停会议时使用 `resume`。
3. 收到 `{"type":"state","action":"start","meeting":{...}}` 后开始发送 MediaRecorder 二进制音频片段。
4. 暂停前先暂停采集、发送剩余音频，再发送 `{"type":"pause"}`；收到状态确认后可发送 `resume` 继续。暂停时不发送音频帧。
5. 结束时先停止采集、发送剩余音频，再发送 `{"type":"end"}`；服务端回推最终状态并关闭连接。

服务端回推 `ready`、`state`、`transcript`、`no_speech`、`error` 和 `pong` 事件，每条事件都携带当前连接的 `meeting_id`。客户端命令无需重复传会议 ID；如果传入其他会议 ID，服务端会拒绝该命令，不能通过消息切换会议。`transcript.text` 是会议完整正文，页面收到后替换显示并自动滚动。状态依次为 `created → recording ⇄ paused → ended`，未录音的会议也可直接结束。旧版 `/api/archives` 已由会议 HTTP 接口替代。

录音期间浏览器约每 1 秒发送一段音频，服务端识别完成就推送文字并保存正文，无需等待暂停或结束。例如：

```json
{"type":"transcript","meeting_id":"会议 ID","text":"当前会议的完整转写正文","bytes":16384}
```

### 音频与模型输出

后端使用 OpenAI SDK 调用模型，解析 Qwen3-ASR 的 `language …<asr_text>` 输出，只返回转写正文；无语音标记或空文本以 `no_speech` 通知页面等待语音，同一段等待状态只通知一次，已有正文保留。全零 PCM 静音会跳过模型请求；不使用音量阈值或 VAD，背景噪声等非零音频仍交给模型判断。

浏览器优先录制 WebM/Opus，也可回退到 MP4；后端通过 FFmpeg 将累计录音解码为 16 kHz、单声道、16 位 PCM WAV，再提交给模型，WAV 输入直接复用。MP4 首片段可能只有容器头，后端会等待后续音频数据，只有容器头的会议可以正常结束并保存空正文。应用 Dockerfile 已安装 FFmpeg。

当前仍使用 transcription 文件接口：每个片段到达后，以本次连接的累计录音重新识别并回推完整文本。单次连接限制 25 MB；长录音会增加重复推理成本，后续可接入原生流式接口或增加服务端音频切片。
