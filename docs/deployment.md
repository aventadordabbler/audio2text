# Audio2Text 部署说明

本文以离线环境导入镜像部署为主。所有命令均在项目根目录执行。compose.yaml 提供三个独立服务：

- app：Audio2Text 应用服务，CPU 运行，不加载 ASR/LLM 权重；
- asr：可选的本地 Qwen ASR 模型服务，需要 NVIDIA GPU；
- llm：可选的本地 vLLM 大语言模型服务，需要 NVIDIA GPU。

ASR 和 LLM 也可以使用外部的 OpenAI 兼容服务。使用外部模型时，只启动 app。

## 1. 准备离线部署包

在可联网或已有镜像的机器上导出镜像。导出时使用的标签必须与离线机器上的 compose.yaml 和 .env 一致：

镜像还必须与目标主机的 CPU 架构、NVIDIA 驱动和 CUDA 环境匹配；导入镜像不会转换架构。

~~~bash
docker save -o audio2text-1.0.0.tar registry.neuro.com/library/audio2text:1.0.0
docker save -o qwen3-asr.tar registry.neuro.com/library/qwenllm-qwen3-asr:latest
docker save -o llm.tar registry.neuro.com/vllm/vllm-openai:v0.30.0-aarch64-cu129
~~~

将以下内容复制到离线部署主机：

- compose.yaml、.env.example 和待使用的 .env；
- `data/certs/server.crt` 和 `data/certs/server.key`；
- 上述镜像 tar 文件；
- ASR/LLM 模型权重目录；
- qwen_streaming 所需的 data/tokenizers/qwen/；
- 可选的说话人模型目录。

离线主机导入镜像并校验标签：

~~~bash
docker load -i audio2text-1.0.0.tar
docker load -i qwen3-asr.tar
docker load -i llm.tar
docker image ls
docker image inspect registry.neuro.com/library/audio2text:1.0.0
docker image inspect registry.neuro.com/library/qwenllm-qwen3-asr:latest
docker image inspect registry.neuro.com/vllm/vllm-openai:v0.30.0-aarch64-cu129
~~~

compose.yaml 中 app 使用固定镜像标签 registry.neuro.com/library/audio2text:1.0.0。若导入 tar 后的标签不同，先重新标记，或修改 compose.yaml 的 image：

~~~bash
docker tag IMAGE_NAME:TAG registry.neuro.com/library/audio2text:1.0.0
~~~

ASR 和 LLM 的镜像标签分别由 VLLM_IMAGE、LLM_VLLM_IMAGE 指定；这两个变量必须与 docker image ls 中的导入标签一致。

如果使用 containerd/nerdctl，将 docker load 替换为 nerdctl load，后续使用对应的 Compose 命令。

初始化目录和环境文件：

~~~bash
cp .env.example .env
mkdir -p data/tokenizers/qwen models/qwen3-asr-1.7b models/llm
chmod -R go-rwx data
docker compose config --quiet
~~~

离线部署不执行 docker compose pull，也不需要登录镜像仓库。镜像导入不会包含 Compose 挂载的模型权重、tokenizer 和 data/，这些文件必须单独复制。

启用 qwen_streaming ASR 模式时，将 tokenizer 文件放入 data/tokenizers/qwen/。使用 transcription 模式时不需要 tokenizer。

## 2. 部署 Audio2Text 服务

### 2.1 配置端口和数据目录

在 .env 中设置应用端口。Compose 默认使用 HTTPS，端口是宿主机端口，容器内固定使用 8000：

~~~dotenv
APP_BIND_ADDRESS=0.0.0.0
APP_PORT=9000
~~~

证书固定从 `data/certs/server.crt` 和 `data/certs/server.key` 读取，并随 `data/` 挂载到容器的 `/app/data/certs/`。证书的 SAN 必须包含浏览器实际访问的域名或 IP；客户端需要信任对应的自签名 CA。

data/ 会挂载到容器的 /app/data，必须持久化。该目录包含 SQLite 数据库、模型配置、API Key、录音、转写和会议纪要。

### 2.2 启动服务

~~~bash
docker compose --profile app up -d app
docker compose --profile app ps app
curl -kfsS https://127.0.0.1:9000/health
~~~

如果修改了 APP_PORT，将健康检查地址中的 9000 替换为实际端口。浏览器访问 `https://<主机>:<端口>`；HTTPS 页面下实时录音使用 WSS。成功时返回：

~~~json
{"status":"ok"}
~~~

### 2.3 配置模型连接

启动后进入 Web 页面的“模型配置”，分别保存并测试 ASR 和 LLM。

同一 Compose 网络中的本地模型使用容器服务名：

| 模型 | 接口地址 | 模型名称 |
| --- | --- | --- |
| ASR | http://asr:8001/v1 | VLLM_MODEL 的值 |
| LLM | http://llm:8002/v1 | LLM_VLLM_MODEL 的值 |

外部模型填写应用容器可以访问的地址，例如 https://asr.example.com/v1。应用容器中的 localhost 只代表应用容器自身，不能用来访问宿主机或其他容器。

## 3. 部署 ASR 模型服务

### 3.1 准备模型和参数

本地 ASR 服务使用 asr profile。将 Qwen3-ASR 权重放到宿主机的 ./models/qwen3-asr-1.7b，并让 VLLM_MODEL_PATH 指向容器内的 /models/qwen3-asr-1.7b；Compose 会把 ./models 挂载到容器 /models。

在 .env 中设置：

~~~dotenv
VLLM_IMAGE=registry.neuro.com/library/qwenllm-qwen3-asr:latest
VLLM_MODEL=qwen3-asr-1.7b
VLLM_MODEL_PATH=/models/qwen3-asr-1.7b
VLLM_BIND_ADDRESS=127.0.0.1
VLLM_PORT=8010
VLLM_GPU_MEMORY_UTILIZATION=0.8
VLLM_MAX_MODEL_LEN=16384
~~~

容器内 ASR 固定监听 8001，VLLM_PORT 是宿主机映射端口。ASR 和 LLM 共用 GPU 时，降低两个服务的显存占用比例并为 CUDA 运行时预留余量。

### 3.2 启动并检查

~~~bash
docker compose --profile asr up -d asr
docker compose --profile asr ps asr
curl -fsS http://127.0.0.1:8010/v1/models
~~~

在“模型配置”中使用：

~~~text
接口地址：http://asr:8001/v1       # app 与 asr 同一 Compose 网络时
模型名称：与 VLLM_MODEL 完全一致
识别模式：qwen_streaming
~~~

如果 Audio2Text 运行在宿主机或其他主机，接口地址改为 http://<ASR主机>:<VLLM_PORT>/v1。如果使用 qwen_streaming，还必须在应用服务中准备 ASR_TOKENIZER 指向的 tokenizer。

外部 ASR 服务不需要启动 asr 容器，但必须提供 GET /v1/models 和与识别模式匹配的 OpenAI 兼容接口：qwen_streaming 使用 /chat/completions，transcription 使用 /audio/transcriptions。

## 4. 部署 LLM 模型服务

### 4.1 准备模型和参数

本地 LLM 服务使用 llm profile。将模型文件放入 LLM_VLLM_MODEL_DIR 指定的宿主机目录。

在 .env 中设置：

~~~dotenv
LLM_VLLM_IMAGE=registry.neuro.com/vllm/vllm-openai:v0.30.0-aarch64-cu129
LLM_VLLM_MODEL_DIR=./models/llm
LLM_VLLM_MODEL_PATH=/models/llm
LLM_VLLM_MODEL=local-llm
LLM_VLLM_BIND_ADDRESS=127.0.0.1
LLM_VLLM_PORT=8002
LLM_VLLM_GPU_MEMORY_UTILIZATION=0.6
LLM_VLLM_MAX_MODEL_LEN=32768
~~~

镜像必须与主机 CPU 架构、NVIDIA 驱动和 CUDA 版本匹配。容器内 LLM 固定监听 8002，LLM_VLLM_PORT 是宿主机映射端口。

### 4.2 启动并检查

~~~bash
docker compose --profile llm up -d llm
docker compose --profile llm ps llm
curl -fsS http://127.0.0.1:8002/v1/models
~~~

在“模型配置”中使用：

~~~text
接口地址：http://llm:8002/v1       # app 与 llm 同一 Compose 网络时
模型名称：与 LLM_VLLM_MODEL 完全一致
~~~

LLM 必须提供 OpenAI 兼容的 GET /v1/models 和 POST /v1/chat/completions 接口。使用外部 LLM 时，只需在“模型配置”中填写外部地址、模型名称和 API Key。

## 5. 同时启动三个本地服务

ASR 和 LLM 的参数、模型目录准备完成后，可一次启动：

~~~bash
docker compose --profile app --profile asr --profile llm up -d app asr llm
docker compose --profile app --profile asr --profile llm ps
~~~

然后按第 2.3 节在“模型配置”中保存并测试两个模型。

## 6. 环境变量说明

下面的值是部署建议值；未在 .env 中设置时，Compose 使用 compose.yaml 中的默认值。

### 应用服务和 ASR 运行参数

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| APP_BIND_ADDRESS | 127.0.0.1 | 应用宿主机端口绑定地址；仅影响 Compose 端口映射。 |
| APP_PORT | 9000 | 应用宿主机端口；容器端口固定为 8000。 |
| ASR_TOKENIZER | data/tokenizers/qwen | qwen_streaming 所需 tokenizer 路径；容器内对应 /app/data/tokenizers/qwen。 |
| ASR_WINDOW_SECONDS | 5 | 每次 ASR 请求的音频窗口长度，单位秒。 |
| ASR_STRIDE_SECONDS | 2 | ASR 窗口推进步长，不能大于窗口长度。 |
| DIARIZATION_MODEL_DIR | models/diarization | 宿主机说话人模型目录，挂载到容器 /app/models/diarization。 |
| DIARIZATION_SEGMENTATION_DIR | models/pyannote/segmentation-3.0 | 宿主机 segmentation 模型目录，挂载到容器 /app/models/pyannote/segmentation-3.0。 |
| DIARIZATION_WORKERS | 2 | 说话人校正后台工作者数量。 |
| DIARIZATION_THREADS | 2 | 每个说话人工作者使用的线程数。 |
| DIARIZATION_TIMEOUT_SECONDS | 600 | 单次说话人处理超时时间，单位秒。 |
| DIARIZATION_FINAL_TIMEOUT_SECONDS | 空 | 会议结束时的说话人处理超时；为空时使用应用的动态超时。 |

DATA_DIR 在 Compose 中固定为容器路径 /app/data/archives，不需要在 .env 中修改。DATABASE_PATH 也没有从 Compose 注入，数据库、API Key 和会议文件都随 data/ 持久化。

### ASR 模型服务参数

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| VLLM_IMAGE | registry.neuro.com/library/qwenllm-qwen3-asr:latest | ASR 容器镜像。 |
| VLLM_MODEL | qwen3-asr-1.7b | 对外提供的模型 ID，必须与“模型配置”中的模型名称一致。 |
| VLLM_MODEL_PATH | /models/qwen3-asr-1.7b | 容器内模型路径；宿主机目录位于 ./models/ 下。 |
| VLLM_BIND_ADDRESS | 127.0.0.1 | ASR 宿主机端口绑定地址。 |
| VLLM_PORT | 8010 | ASR 宿主机端口；容器端口固定为 8001。 |
| VLLM_GPU_MEMORY_UTILIZATION | 0.8 | ASR 使用的 GPU 显存比例。 |
| VLLM_MAX_MODEL_LEN | 16384 | ASR 最大上下文长度。 |

### LLM 模型服务参数

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| LLM_VLLM_IMAGE | registry.neuro.com/vllm/vllm-openai:v0.30.0-aarch64-cu129 | LLM 容器镜像。 |
| LLM_VLLM_MODEL_DIR | ./models/llm | 宿主机 LLM 模型目录。 |
| LLM_VLLM_MODEL_PATH | /models/llm | 容器内 LLM 模型路径。 |
| LLM_VLLM_MODEL | local-llm | 对外提供的模型 ID，必须与“模型配置”中的模型名称一致。 |
| LLM_VLLM_BIND_ADDRESS | 127.0.0.1 | LLM 宿主机端口绑定地址。 |
| LLM_VLLM_PORT | 8002 | LLM 宿主机端口；容器端口固定为 8002。 |
| LLM_VLLM_GPU_MEMORY_UTILIZATION | 0.6 | LLM 使用的 GPU 显存比例。 |
| LLM_VLLM_MAX_MODEL_LEN | 32768 | LLM 最大上下文长度。 |

### 不通过 Compose 注入的参数

AUDIO_IMPORT_MAX_BYTES、AUDIO_IMPORT_MAX_SECONDS、AUDIO_IMPORT_WORKERS 和 AUDIO_IMPORT_DECODE_TIMEOUT_SECONDS 是应用直接运行时的配置；当前 compose.yaml 没有将它们传入 app 容器。需要调整这些值时，应先把变量加入 Compose 的 app.environment，再重新创建容器。
