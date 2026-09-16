## 会议助手（Audio2Text）

基于 FastAPI、WebSocket 和浏览器 AudioWorklet 的会议助手，支持实时转写、自动区分说话人及会议纪要。**应用部署在 CPU 服务器上**，通过 OpenAI Python SDK 调用远端 ASR/LLM；本机无需 CUDA、vLLM 或 qwen_asr。说话人分离代码位于 `app/diarization/`，与应用共用 Python 环境，CPU 推理在独立子进程中执行。

SQLite 保存会议元数据、文件路径和模型配置，转写正文与纪要保存在磁盘文件中。

### 启动应用（无需 GPU）

Docker 部署只启动应用：

```bash
docker compose --profile app up -d --build app
```

打开 http://localhost:8000，在侧栏“模型配置”中填写远端 ASR / 大语言模型地址、模型 ID 和密钥。应用不依赖 Compose 中的 `vllm` 服务。本地分词器与说话人模型通过路径配置，不提供联网下载功能。

宿主机运行需安装 uv、Python 3.12、Node.js 24，以及工作者使用的 `libgomp1`、`libsndfile1`、FFmpeg（Debian/Ubuntu 可用 apt 安装）：

```bash
uv sync
npm ci --prefix web
npm run build --prefix web
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

实时传输使用 PCM，不需要通过 FFmpeg 转码。浏览器麦克风需要 HTTPS 或 localhost。未准备分离模型时仍可使用文字转写，页面会显示“说话人识别未就绪”。

### 自动区分说话人（无需提前录音）

系统直接分析当前会议录音，自动建立“说话人 1 / 2 / 3”；不需要录制样本、登记声纹或提供参会者姓名。身份只在本场会议内有效。短句、证据不足或多人重叠时允许显示“说话人待确认 / 多位说话人 / 多人同时讲话”，不猜测真实身份。

唯一后端采用 3D-Speaker 技术路线：FSMN-VAD + CAM++ 中文/英文声纹 + `pyannote/segmentation-3.0` 局部分段。segmentation 是组件，不是另一套可切换后端。所有依赖统一在根目录 `pyproject.toml` 和 `uv.lock` 管理，一次 `uv sync` 即可安装应用与 CPU 推理依赖；项目使用 Python 3.12。运行期间只读取本地权重。

segmentation 默认直接读取 `models/pyannote/segmentation-3.0/pytorch_model.bin`。将已有模型放入本地目录，配置以下路径即可启动，无需运行模型准备脚本或生成清单：

```bash
DIARIZATION_MODEL_DIR=models/diarization
DIARIZATION_SEGMENTATION_DIR=models/pyannote/segmentation-3.0
```

应用只读取本地文件，缺失或不完整时直接报错，不尝试连接模型仓库。默认目录结构：

```text
models/diarization/
  campplus/campplus_cn_en_common.pt
  fsmn/config.yaml
  fsmn/model.pt
  fsmn/am.mvn
models/pyannote/segmentation-3.0/
  pytorch_model.bin
```

`.env.example` 提供 `DIARIZATION_MODEL_DIR`（CAM++、FSMN 所在目录）、`DIARIZATION_SEGMENTATION_DIR`（segmentation 目录）、`DIARIZATION_WORKERS`、`DIARIZATION_THREADS`、单请求超时和会后任务超时。默认 1 个 CPU 工作者、2 个推理线程；从项目根目录启动 uv，子进程自动使用应用当前的 Python 解释器。Compose 将这两处模型目录分别只读挂载到 `/app/models/diarization` 和 `/app/models/pyannote/segmentation-3.0`。更换权重后重启应用；工作者启动时对实际模型文件计算 SHA256 作为模型版本，不依赖 `models.json`。`GET /api/diarization/status` 检查模型文件是否就绪，实际加载失败会体现在会议处理状态。

文字先显示，标签异步补充：首次积累 10 秒音频后开始分段，随后每 1 秒调度；暂停或结束会处理不足 10 秒的尾部。模型窗口最多 3 位局部说话人、每帧最多 2 人重叠，会议内在线身份上限为 16。达到上限或无法可靠匹配时保留未知。初始阈值尚需真实会议验证，CPU 并发容量和标签延迟不作未测承诺。

结束后进行全局校正；对不重叠的跨人片段按音频边界重新调用现有 ASR，成功后替换为各自发言。失败、空结果或边界过短时保留原文和多人标记。校正失败可在实时转写页点击“重试说话人校正”。录音内容按 16kHz 单声道 PCM16 归档，约 **110 MiB/小时**。

### 前端开发

前端使用 React、TypeScript、Vite、Tailwind CSS 和 [shadcn/ui](https://ui.shadcn.com/docs/installation/vite)，源码位于 `web/src`。运行 `npm run dev --prefix web` 后访问 http://localhost:5173，Vite 将 `/api` 和 `/ws` 代理到 8000 端口。

FastAPI 提供 `web/dist` 中的构建结果。更新前端需执行 `npm run build --prefix web`；Dockerfile 自动构建前端。更新后端接口后需重启应用进程，完整 Docker 更新使用上面的 `--build` 命令。

### 模型配置

侧栏“模型配置”分别保存 ASR 模型和大语言模型的 API 地址、模型名称、API Key、请求超时。模型连接信息只从 SQLite 读取，不由应用环境变量初始化。地址必须能从**应用服务器**访问；容器中的 `localhost` 指向容器自身。

ASR 提供两种显式选择的模式，不会在失败时自动切换或重放录音：

| 识别方式 | 远端要求 | 应用行为 |
| --- | --- | --- |
| **Qwen 前缀续写**（默认） | `/chat/completions` 支持 `input_audio` WAV 音频以及 assistant 前缀续写 | 使用固定长度滚动窗口，回退末尾 5 个 token 续写；窗口不会随会议时长增长 |
| **文件转写（兼容模式）** | `/audio/transcriptions` 接受 WAV，返回 JSON `text` | 使用同一固定长度滚动窗口，按重叠文字合并临时结果；不使用 token 前缀 |

两种模式都支持 PCM 采集、会议隔离、分段、临时文字、定稿落盘和暂停/结束尾音。兼容模式不等同于 Qwen 的前缀续写算法。大语言模型继续使用 `/chat/completions` 生成会议纪要。

**Qwen 前缀续写的服务契约：**使用 `messages` 传入空 system、包含 `input_audio: {format: "wav", data: "<base64>"}` 的 user 消息；需要固定语言或历史文字时，末尾追加 assistant 消息，并设置 `continue_final_message: true`、`add_generation_prompt: false`。远端必须从这个 assistant 前缀继续生成，只返回后续文字。仅声明“兼容 OpenAI”不代表支持这些扩展。

**模板来源：**应用环境变量 `ASR_SEND_CHAT_TEMPLATE` 控制是否发送内置模板，仅影响 Qwen 前缀续写模式；模型地址、密钥、识别模式仍从 SQLite 读取。

| 环境变量 | 请求行为 | 适用服务 |
| --- | --- | --- |
| `ASR_SEND_CHAT_TEMPLATE=false`（默认） | 不发送 `chat_template` / `chat_template_kwargs`，使用服务自身模板 | 已有模板能够保留音频和 assistant 前缀的服务，无需允许请求级模板 |
| `ASR_SEND_CHAT_TEMPLATE=true` | 在 `app/qwen_streaming.py` 中组装 Qwen 提示词，通过请求级模板传递；无需部署 Jinja 文件 | 允许请求级模板的 vLLM，需开启 `--trust-request-chat-template` |

例如，在应用的 `.env` 中设置 `ASR_SEND_CHAT_TEMPLATE=true`，或运行 `ASR_SEND_CHAT_TEMPLATE=true uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`。Compose 的 app 服务同样读取这个变量。修改环境变量后需重启应用；`--reload` 不会自动重新读取 `.env`。

关闭开关只切换模板来源，不能让原本忽略 assistant 消息的服务获得前缀续写能力。已有服务既不支持续写又不允许请求级模板时，在页面选择“文件转写（兼容模式）”，仍可通过会议 WebSocket 实时更新文字。应用不在失败时自动切换模式或重发音频；错误提示会说明当前配置与处理方式。vLLM 的请求级模板开关见[官方部署参数](https://docs.vllm.ai/en/v0.13.0/cli/serve/#--trust-request-chat-template---no-trust-request-chat-template)。

**分词器：**后端默认读取本地 `data/tokenizers/qwen` 目录，Compose 默认路径为容器内的 `/app/data/tokenizers/qwen`，页面无需配置，模型配置接口不保存此项。前缀回退按 token 处理，不能按字符截断。首次使用 Qwen 前缀续写前，需将与远端模型匹配的分词器文件放到该目录。支持单个 `tokenizer.json`，也支持 `tokenizer_config.json`、`vocab.json`、`merges.txt` 三个文件的组合；无需模型权重或 GPU。文件转写模式不加载分词器。

已有本项目 Qwen 模型目录时，在项目根目录执行：

```bash
mkdir -p data/tokenizers/qwen
cp models/qwen3-asr-1.7b/{tokenizer_config.json,vocab.json,merges.txt} data/tokenizers/qwen/
```

`.env.example` 使用 `ASR_TOKENIZER=data/tokenizers/qwen`，相对于应用启动目录解析：宿主机从项目根目录启动 uv；Compose 的工作目录是 `/app`，且已有 `./data:/app/data` 挂载，因此该相对路径在两种部署方式下均可使用。也可设置绝对路径或直接指定 `tokenizer.json` 文件。仅接受已有本地路径；缺失文件直接报错，不接受仓库 ID 或联网补齐文件。修改环境配置后，宿主机重启应用，Compose 使用 `docker compose --profile app up -d --no-deps app` 更新应用容器。

- 每类模型保存一份配置；保存后新录音连接和新纪要任务读取最新值，运行中的任务保留原配置。
- **测试连通性**：使用当前表单配置，由后端通过 OpenAI SDK 请求 `GET /models`，验证连接、鉴权及模型名称；测试完成后按钮变为浅绿色，用 √ / × 表示连接成功或失败，可再次点击重测，修改配置后恢复初始样式。测试最长等待 30 秒（配置超时更短时采用该值），不自动保存配置。测试范围为模型列表接口；实际转写、前缀续写、分词器加载和纪要生成可在会议中验证。
- API Key 由后端用于访问模型服务，配置读取接口不返回原值。编辑或测试时留空沿用已保存密钥，勾选“清除已保存的密钥”后测试无密钥连接，点击保存才会持久化修改。
- 密钥保存在 SQLite 中，数据库备份也包含密钥；数据库文件需按部署环境管理访问权限。

### 可选：在 GPU 主机上部署 vLLM

已有远端模型服务时跳过本节。Compose 保留独立的 `gpu` profile 作为部署示例，应用代码不依赖其镜像版本、容器名称或本地端口。

```bash
cp .env.example .env
# 在应用的 .env 中设置 ASR_SEND_CHAT_TEMPLATE=true，使用下述服务的请求级模板能力
# GPU 主机需有 NVIDIA Container Toolkit 和 ./models/qwen3-asr-1.7b 权重
docker compose --profile gpu up -d vllm
```

该示例沿用 Qwen 官方镜像和 `qwen-asr-serve`，开启 `--trust-request-chat-template`，由应用随请求提供内置模板，无需挂载模板文件或设置 `--chat-template-content-format`。连接该示例时，在应用端设置 `ASR_SEND_CHAT_TEMPLATE=true`。镜像可用 `VLLM_IMAGE` 指定，应用无需派生专用 GPU 镜像，也不使用私有模型 WebSocket 协议。已有模型服务按上表选择模板来源，不必采用此 Compose 示例。

宿主机应用连接本机模型时地址示例为 `http://localhost:8001/v1`；同一 Compose 内可使用 `http://vllm:8001/v1`；跨服务器填写模型服务器地址。模型名称需与服务发布的 ID 一致。应用和模型都在本机容器运行时可执行 `docker compose --profile gpu --profile app up -d --build`。

### 会议纪要

会议结束后先校正说话人，再按固定的转写内容版本生成一次纪要。校正失败或模型未就绪时使用已保存文字生成一次；之后重试校正不会自动反复生成纪要，有变更时标记“转写已更新”，由用户重新生成。结束操作无需等待后台任务；离开或刷新页面后继续处理。状态通过会议 WebSocket 推送，页面不持续轮询纪要接口。

纪要包含会议主题、核心结论、决策事项、待办事项（任务、责任人、预计完成时间）、风险与阻塞、下一步安排。提示词要求以原文为依据，对未明确的信息标注“未明确”。页面通过 [react-markdown](https://github.com/remarkjs/react-markdown) 和 [remark-gfm](https://github.com/remarkjs/remark-gfm) 展示标题、列表与表格，支持复制 Markdown 和下载 `.md` 文件。

历史会议可以手动“生成纪要”，生成后可“重新生成”。同一会议同时只运行一个任务，不同会议相互独立。失败后可重试，重新生成失败时保留上一版纪要和原始转写。无语音的会议不会调用总结模型；服务重启时，中断的任务标记为失败，可重新生成。

长会议按 `LLM_CHUNK_CHARS`（默认 12000 个字符）提取分段要点，再合并整理；每次模型输出上限由 `LLM_MAX_TOKENS`（默认 16384）控制。字符限制并非精确的 token 限制，应根据文本模型的上下文容量调整。输出为空、被截断或仅含思考过程时不会当作成功纪要保存。

### 会议操作

- **会议管理**：按部门、创建日期范围、会议状态和名称组合筛选；日期使用浏览器本地时区，包含结束当天，名称按字面关键词匹配。
- **部门管理**：支持新增、重命名、删除。名称不能重复；已有会议的部门可重命名，但不能删除。
- **创建会议**：可选择所属部门，未选择时归为“未分类”。先创建再录音；进入会议页面不会自动打开麦克风。
- **开始 / 暂停 / 继续**：暂停会停止采集，累计时长只计算录音时间；继续后保留已有正文。暂停前冲刷浏览器尾音并等待模型定稿；继续后从新的语音段开始，连接可复用。
- **结束会议**：等待剩余音频识别完成后保存，录音不可继续；已配置大语言模型时自动生成纪要。没有检测到语音时，保留用户创建的会议，正文为空，不生成纪要。
- **查找会议**：按状态筛选，或搜索会议名称与正文；按 `/` 快速聚焦搜索框。
- **自动滚动**：实时转写默认跟随最新内容；取消勾选可停留在之前的位置阅读。
- **返回列表 / 连接中断**：返回列表会先暂停并保存；断线后会议自动暂停，已定稿文字与已提交录音保留。未上传成功的音频不能恢复。

同一会议同时只允许一个页面录音，其他页面可查看已保存的记录。浏览器麦克风需要 HTTPS 或 localhost。

### 数据存储

默认目录：

    data/archives/
      meetings.sqlite3            # 会议元数据、文件路径、纪要任务状态、模型配置
      meetings/<会议 ID>/
        audio/*.pcm               # 每块最多 30 秒的已提交录音
        audio/manifest.json       # 采样位置、采集轮次、块清单
        events.jsonl              # 带版本的转写和标签修订日志
        transcript.json           # 可重建的结构化快照
        transcript.txt            # 派生纯文本
        speaker-state.json        # 会议级说话人检查点
        speaker-features.jsonl    # 增量特征与可恢复状态日志
        speaker-timeline.jsonl    # 会后校正区间
        speaker-corrections.json  # 跨人片段重转写缓存
        minutes.md                # Markdown 纪要

SQLite 不存储音频、声纹向量、转写正文或纪要正文；仅记录元数据、路径、版本、模型配置与任务状态。事件先 fsync 落盘，再广播；快照通过原子替换更新。重启可重放未投影的事件，截断日志末尾不完整记录和未提交 PCM。结构化日志是正文的事实来源，不要手工修改派生的 `transcript.txt`。

`DATA_DIR` 默认为 `data/archives`；可通过 `DATABASE_PATH` 指定数据库位置，`meetings` 目录位于数据库同级。备份时应一起保留数据库和会议目录；运行中的数据库使用 SQLite 备份工具，或停止应用后复制整个目录。Docker Compose 挂载 `./data:/app/data`。

启动时会将 `DATA_DIR` 内旧版 JSON 归档导入为已结束的会议，保留原 JSON/TXT 文件，重复启动不会重复导入。应用重启后，未结束的录音恢复为暂停，录音时长保留至最后一次保存；当前按单个应用进程运行。

### 接口与协议

HTTP 接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/departments` | 部门列表及各部门会议数 |
| `POST /api/departments` | 新增部门，正文 `{"name":"研发部"}` |
| `PUT /api/departments/{id}` | 重命名部门，正文 `{"name":"研发中心"}` |
| `DELETE /api/departments/{id}` | 删除没有会议的部门，成功返回 `204` |
| `GET /api/meetings` | 按创建时间倒序列出会议，支持下述组合筛选参数 |
| `POST /api/meetings` | 创建会议，正文 `{"title":"产品周会","language":"zh","department_id":null}`；语言、部门均可省略，部门可传已有部门 ID |
| `GET /api/meetings/{id}` | 读取会议状态及文件中的正文 |
| `DELETE /api/meetings/{id}` | 删除未占用、无运行中任务的会议及其录音、特征、转写、纪要；返回 `204` |
| `POST /api/meetings/{id}/end` | 结束未占用录音连接的会议 |
| `POST /api/meetings/{id}/diarization` | 重试已结束会议的说话人校正，返回 `202` |
| `GET /api/diarization/status` | 检查本地分离工作者与模型文件 |
| `GET /api/meetings/{id}/download` | 下载 UTF-8 文本 |
| `GET /api/meetings/{id}/minutes` | 读取纪要任务状态、可用性及文件中的纪要正文 |
| `POST /api/meetings/{id}/minutes` | 生成或重新生成纪要，返回 `202` 和任务状态；仅用于已结束且有正文的会议 |
| `GET /api/meetings/{id}/minutes/download` | 下载 Markdown 纪要 |
| `GET /api/model-configs` | 读取 ASR 和大语言模型配置；不返回 API Key |
| `POST /api/model-configs/{kind}/test` | 使用与保存相同的请求体测试 `asr` / `llm` 配置；返回 `success`、`message`、`elapsed_ms`，不写入数据库 |
| `PUT /api/model-configs/{asr\|llm}` | 保存对应模型配置 |

纪要状态为 `not_started → generating → ready / failed`；可通过重复读取纪要接口获取任务结果。生成失败时 `error` 包含可展示的错误提示，有上一版纪要时 `text` 仍可读取。模型保存正文包含 `base_url`、`model`、可选 `api_key` 和 `timeout_seconds`；ASR 另包含 `asr_mode`（`qwen_streaming` / `transcription`）；分词器由后端配置，不在模型配置接口中传递。省略 `api_key` 表示保留，空字符串表示清除。

`GET /api/meetings` 支持 `title`（会议名称包含关键词）、`department_id`（部门 ID，或 `unassigned` 查询未分类）、`status`（`created` / `recording` / `paused` / `ended`）、`created_from`（包含起点）、`created_before`（不包含终点）。时间参数须为含时区的 ISO 8601 时间；按天查询时，终点传结束日期的次日零点。所有条件以 AND 组合，省略参数表示不限。

先通过 `POST /api/meetings` 创建会议，使用返回的 `id` 连接实时转写 WebSocket `/ws/meetings/{meeting_id}`。这是唯一的实时转写接口，必须指定已有会议，不能省略会议 ID。

每条连接固定绑定一个会议，语言、识别状态和开始/暂停/继续/结束操作都属于该会议。不同会议拥有独立模型状态和文件；同一会议同时只允许一个录音连接，重复连接收到 `error` 并以 `1008` 关闭。断开后会议自动暂停，已定稿内容保留；尚未定稿的临时文字不会作为正式记录保存。

消息顺序：

1. 服务端发送 `{"type":"ready","meeting_id":"…","meeting":{...},"audio_format":"pcm_s16le"}`。
2. 客户端发送 `{"type":"start","format":"pcm_s16le","sample_rate":16000}`；恢复会议时使用 `resume`。
3. 收到 `state` 确认后开始发送单声道、小端 PCM16 二进制帧。浏览器每约 100 ms 发送一帧。
4. `partial` 携带当前句 `segment_id` 和累计临时 `text`，前端替换当前临时文字；临时文字可以修订，不写入文件。
5. `final` 携带该句文字、`start_ms / end_ms`、`revision`、`upsert_segments` 和 `next_segment_id`；先保存再发送。时间戳和编号在整个会议内连续，暂停不补静音，重连不归零。
6. `transcript.update` 按版本更新标签或替换校正后的子片段；`processing` 推送校正状态，`minutes` 推送纪要状态。版本缺口通过 `snapshot` 恢复；`ready` 包含完整结构化快照。
7. 暂停/结束前，浏览器冲刷尾音；应用排空 ASR、提交音频清单后返回 `state`。结束释放录音拥有权，原 WebSocket 保留为只读订阅，重新进入已结束会议也可订阅；后台任务不依赖连接存活。

所有消息携带 `meeting_id`。`segment_id` 在会议内递增，后台拆分使用新编号并保留 `parent_segment_id`，按音频时间排序。客户端不能通过消息切换会议。致命 `error` 带 `fatal:true`，录音停止，会议保留为可继续状态；识别失败不自动重放音频，以避免重复内容。

### 音频处理与积压控制

浏览器 AudioWorklet 混合输入声道并编码 PCM16，每约 100 ms 发送一帧。优先使用浏览器原生 16 kHz AudioContext；不支持时上传实际采样率，应用使用有状态的 soxr 重采样到 16 kHz，暂停时冲刷尾部。前端无需自写重采样算法。

应用把音频切成固定 20 ms 帧，使用能量阈值（默认 -45 dBFS）和连续 60 ms 有声判断起句，保留约 200 ms 开口前音频。默认每 2 秒推进一次模型窗口，窗口最长 5 秒；连续 600 ms 尾静音或 20 秒段长触发定稿。VAD 参数集中在 `app/audio.py` 的 `StreamOptions` 中，窗口参数由 `ASR_WINDOW_SECONDS` 和 `ASR_STRIDE_SECONDS` 控制。

Qwen 模式参考[官方流式算法](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)，每轮提交固定长度滚动窗口及回退后的文字前缀；每段结束丢弃状态。`ASR_WINDOW_SECONDS` 控制窗口上限，`ASR_STRIDE_SECONDS` 控制相邻请求的推进距离；窗口重叠用于减少句子边界丢字。文件转写模式使用同一窗口调度器，并通过重叠文字合并结果。HTTP 带宽、模型延迟和并发容量仍需在实际部署上测量。

每个会议使用独立状态和异步 HTTP 客户端，会议内请求按序执行，不同会议可以同时等待远端响应。模型请求最多只包含一个固定窗口，输入最多积压约 10 秒音频，单帧最多 1 秒，浏览器发送缓冲最多约 3 秒。超限会明确报错并停止录音，保留已定稿内容，不静默丢帧。每次 HTTP 请求和尾音处理都有超时，取消录音连接会取消正在等待的请求。

临时文字可以替换或清空，不写入正文。暂停/结束会先停止采集，再处理浏览器、重采样器和解码缓冲中的尾音，等待定稿保存后确认状态。异常断线时只保证已定稿内容，未完成的片段可能丢失。

### 验证

```bash
uv sync --group dev
uv run pytest -q
npm run build --prefix web
docker compose --profile app config --quiet
```

测试覆盖会议采样时间线、重采样、尾音、慢 ASR 时独立归档、日志恢复、说话人隔离、会后替换、任务重启、纪要去重和删除清理；使用模拟工作者与远端模型，无需 GPU 或分离权重。

可选浏览器流程：`uv run --with playwright==1.62.0 python -m checks.browser_diarization`，需本机已有 Playwright Chromium。它使用合成麦克风和确定性的模型输出，验证操作、展示和推送，不评估真实分人准确率。

真实模型效果与 CPU 容量验收需要完整模型和会议录音，运行步骤见 [说话人处理说明](docs/diarization.md)；测试音频只用于验收，不是用户使用时的前置条件。本轮不构建 Docker 镜像。
