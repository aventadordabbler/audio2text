# Audio2Text 部署手册

本文面向测试、内网和生产环境部署。推荐使用 Docker Compose 运行应用服务，ASR 与大语言模型通过 OpenAI 兼容接口接入；它们可以位于任意可达的独立主机，本项目不负责模型服务的 GPU 分配或调度。

## 1. 部署拓扑

```text
浏览器 / Electron 客户端
          │ HTTPS + WSS
          ▼
反向代理（生产环境推荐）
          │ HTTP + WS
          ▼
Audio2Text 应用 :8000
   ├── SQLite、录音与转写归档：data/
   ├── HTTP 调用 ASR 服务
   ├── HTTP 调用 LLM 服务
   └── CPU 说话人校正（可选本地模型）
```

应用自身不加载 ASR 或 LLM 权重。`compose.yaml` 中的 `vllm` 服务只是可选的本地 ASR 部署示例；使用远程 ASR 时不需要启动该服务。

## 2. 部署前准备

### 2.1 基础依赖

推荐环境：

- Linux x86_64 服务器；
- Docker Engine 与 Docker Compose v2；
- 部署主机可以拉取 `Dockerfile` 中的 `quantitative.io/library/*` 基础镜像；仓库需要鉴权时先完成 `docker login quantitative.io`；
- 可访问的 OpenAI 兼容 ASR 服务；
- 需要会议纪要和阶段总结时，还需可访问的 OpenAI 兼容 LLM 服务；
- 使用 Compose 内置 ASR 示例时，需要 NVIDIA 驱动及 NVIDIA Container Toolkit。

网络至少需要满足：

- 客户端能访问 Audio2Text 的 HTTPS/WSS 地址；
- Audio2Text 容器能访问 ASR 和 LLM 的 API 地址；
- 生产环境只对外开放反向代理的 80/443，端口 8000 和模型端口应限制在本机或内网。

Compose 默认将应用的 8000 和本地 ASR 的 8001 绑定到 `127.0.0.1`。确需从可信局域网直接访问时，可在 `.env` 设置 `APP_BIND_ADDRESS` 或 `VLLM_BIND_ADDRESS` 为指定内网地址；不要设置为 `0.0.0.0` 后直接暴露到公网。

> 浏览器从非 `localhost` 地址采集麦克风时应使用 HTTPS；同一域名下的 WebSocket 会自动使用 WSS。

### 2.2 持久化目录

在项目根目录准备数据目录：

```bash
install -d -m 0700 data data/archives data/tokenizers data/tokenizers/qwen
chmod -R go-rwx data
```

`data/` 必须持久化。它包含会议数据库、模型连接配置、API Key、录音、转写和总结，不能在升级镜像时删除。应限制该目录的主机文件权限，并将备份视为含密钥的敏感数据。

若启用 `qwen_streaming` ASR 模式，将完整 tokenizer 文件放入 `data/tokenizers/qwen/`。若使用 `transcription` 模式，则不需要本地 tokenizer。

说话人校正是可选能力。启用时需准备以下本地文件：

```text
models/diarization/
  campplus/campplus_cn_en_common.pt
  fsmn/config.yaml
  fsmn/model.pt
  fsmn/am.mvn
models/pyannote/segmentation-3.0/
  pytorch_model.bin
```

缺少这些文件不会阻止实时转写，但说话人校正会显示不可用。

## 3. 使用远程 ASR 和 LLM 部署

这是推荐的生产方案。应用运行在 CPU 服务器，ASR 与 LLM 由独立服务提供。

### 3.1 创建环境文件

```bash
cp .env.example .env
```

按需修改 `.env`：

```dotenv
ASR_WINDOW_SECONDS=5
ASR_STRIDE_SECONDS=2

LLM_MAX_TOKENS=16384
LLM_CHUNK_CHARS=12000
STAGE_SUMMARY_WINDOW_SECONDS=300
STAGE_SUMMARY_MAX_TOKENS=1200

DIARIZATION_WORKERS=1
DIARIZATION_THREADS=2
DIARIZATION_TIMEOUT_SECONDS=120
DIARIZATION_FINAL_TIMEOUT_SECONDS=1800
```

这些参数的含义：

| 参数 | 说明 |
| --- | --- |
| `ASR_WINDOW_SECONDS` | 单次 ASR 滚动窗口长度 |
| `ASR_STRIDE_SECONDS` | ASR 请求推进步长；不得大于窗口长度 |
| `LLM_MAX_TOKENS` | 完整会议纪要最大输出 token |
| `LLM_CHUNK_CHARS` | 长会议纪要分段字符数 |
| `STAGE_SUMMARY_WINDOW_SECONDS` | 阶段总结使用的实际归档录音窗口，范围 10–3600 秒 |
| `STAGE_SUMMARY_MAX_TOKENS` | 单个阶段总结最大输出 token |
| `DIARIZATION_WORKERS` | CPU 说话人工作进程数 |
| `DIARIZATION_THREADS` | 每个说话人工作进程的 CPU 线程数 |

ASR 和 LLM 的 URL、模型名、API Key 与请求超时不放在 `.env`，而是在应用的“模型配置”中保存到服务端 SQLite。

后续宿主机命令以默认 `APP_PORT=8000`、`VLLM_PORT=8001` 为例；如果覆盖了端口，请在健康检查、SSH 隧道、Nginx `proxy_pass` 和宿主机模型地址中使用实际值。容器之间仍使用内部端口 8000/8001。

### 3.2 启动应用

```bash
docker compose --profile app config --quiet
docker compose --profile app up -d --build app
docker compose --profile app ps
```

Compose 已为应用配置 `restart: unless-stopped`。在使用 systemd 的 Linux 上，还应确保 Docker 随主机启动：

```bash
sudo systemctl enable --now docker
```

可检查实际端口绑定和重启策略：

```bash
docker compose --profile app ps
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' audio2text-server
```

查看日志：

```bash
docker compose --profile app logs -f --tail=200 app
```

本机健康检查：

```bash
curl -fsS http://127.0.0.1:8000/health
```

成功响应：

```json
{"status":"ok"}
```

### 3.3 配置模型连接

Compose 默认只监听服务器回环地址。反向代理尚未配置时，可从管理电脑建立 SSH 隧道：

```bash
ssh -N -L 8000:127.0.0.1:8000 deploy@meeting-server
```

随后打开 `http://127.0.0.1:8000`。若已经完成第 5 节的反向代理，则直接使用 `https://meeting.example.com`。进入“模型配置”，分别保存并测试：

| 类型 | 基础地址示例 | 必需能力 |
| --- | --- | --- |
| ASR / `qwen_streaming` | `http://asr.internal:8001/v1` | `GET /models`、`POST /chat/completions`、音频输入和 assistant 前缀续写 |
| ASR / `transcription` | `https://asr.example.com/v1` | `GET /models`、`POST /audio/transcriptions` |
| LLM | `https://llm.example.com/v1` | `GET /models`、`POST /chat/completions` |

注意：

- 地址应填写 API 基础地址，通常以 `/v1` 结尾；
- 模型名必须与 `GET /models` 返回的 ID 一致；
- 容器内的 `127.0.0.1` 和 `localhost` 指向应用容器自身，远程模型应填写容器可访问的 DNS 名或内网地址；
- 模型测试通过后再创建正式会议；
- 阶段总结与完整会议纪要复用同一份 LLM 配置。

## 4. 可选：使用 Compose 启动本地 ASR

将 ASR 权重放在宿主机 `models/` 下，并在 `.env` 设置：

```dotenv
VLLM_IMAGE=qwenllm/qwen3-asr:latest
VLLM_MODEL=qwen3-asr-1.7b
VLLM_MODEL_PATH=/models/qwen3-asr-1.7b
VLLM_GPU_MEMORY_UTILIZATION=0.8
VLLM_MAX_MODEL_LEN=32768
ASR_SEND_CHAT_TEMPLATE=true
```

启动 ASR 与应用：

```bash
docker compose --profile gpu --profile app up -d --build
docker compose --profile gpu --profile app ps
```

在 Audio2Text 的 ASR 模型配置中填写：

```text
接口地址：http://vllm:8001/v1
模型名称：与 VLLM_MODEL 一致
识别模式：qwen_streaming
```

宿主机访问该 ASR 时使用 `http://127.0.0.1:8001/v1`；覆盖 `VLLM_PORT` 后应替换为实际端口。LLM 仍按实际部署填写独立地址；项目不要求 ASR 和 LLM 位于同一 GPU 或同一服务器。

## 5. HTTPS 与 WebSocket 反向代理

应用同时使用普通 HTTP API、会议 WebSocket 和阶段总结 WebSocket。代理必须转发 `Upgrade`、关闭响应缓冲并允许长连接。

以下为 Nginx 示例，证书路径按实际环境调整：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name meeting.example.com;

    ssl_certificate     /etc/letsencrypt/live/meeting.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/meeting.example.com/privkey.pem;

    location / {
        # 仅允许实际使用本系统的可信网段；按部署网络删改。
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;

        # 覆盖 APP_PORT 时同步修改此处的宿主机端口。
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

代理完成后验证：

```bash
curl -fsS https://meeting.example.com/health
```

生产环境不要将当前服务直接暴露到公网：应用没有内置用户认证，模型配置接口具有修改能力。上例使用内网 IP 白名单；也可以只允许 VPN 网段。若 Nginx 前方还有 CDN 或其他代理，必须先正确配置真实客户端 IP，再使用 `allow`/`deny`，否则白名单判断的是上游代理地址。Compose 的默认回环绑定可以防止绕过 Nginx 直接访问源站。

## 6. 客户端部署

### 6.1 浏览器客户端

Web 前端已编译进应用镜像，直接访问部署地址即可：

```text
https://meeting.example.com
```

首次使用时允许麦克风权限，然后在“模型配置”中完成 ASR 和 LLM 配置。

### 6.2 Electron 客户端

建议在对应 Windows 环境构建安装包：

```bash
npm ci --prefix client
npm run dist:win --prefix client
```

标准版产物位于 `client/release/`。Win7 64 位兼容版：

```bash
npm run dist:win7 --prefix client
```

产物位于 `client/release/win7/`。安装后在“设置 → 语音转写”中填写 Audio2Text 服务地址，例如：

```text
https://meeting.example.com
```

不要填写 `/api` 或 `/ws` 路径。客户端会自行建立会议和阶段总结 WebSocket。

## 7. 数据备份与恢复

需要一起备份 SQLite 和会议文件。最稳妥的方式是短暂停止应用后复制整个 `data/`：

```bash
set -euo pipefail
BACKUP_DIR=/var/backups/audio2text
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$BACKUP_DIR"
umask 077
BACKUP_ARCHIVE="$BACKUP_DIR/audio2text-data-$(date +%Y%m%d-%H%M%S).tar.gz"
trap 'docker compose --profile app start app >/dev/null 2>&1 || true' EXIT
docker compose --profile app stop app
tar -C . -czf "$BACKUP_ARCHIVE" data
tar -tzf "$BACKUP_ARCHIVE" data/archives/meetings.sqlite3 >/dev/null
docker compose --profile app start app
trap - EXIT
echo "Backup created: $BACKUP_ARCHIVE"
```

备份目录位于 Git 工作区外，且目录和新文件只允许当前用户访问。项目的 `.gitignore` 也会拦截误放在仓库根目录的同名备份。

恢复前先停止服务并保留当前数据副本：

```bash
set -euo pipefail
BACKUP_ARCHIVE=/absolute/path/audio2text-data-20260918-120000.tar.gz
test -r "$BACKUP_ARCHIVE"
tar -tzf "$BACKUP_ARCHIVE" data/archives/meetings.sqlite3 >/dev/null
RESTORE_DIR=$(mktemp -d "$PWD/.audio2text-restore.XXXXXX")
tar -xzf "$BACKUP_ARCHIVE" -C "$RESTORE_DIR"
test -f "$RESTORE_DIR/data/archives/meetings.sqlite3"
chmod -R go-rwx "$RESTORE_DIR/data"
CURRENT_DATA_BACKUP="$PWD/data.before-restore-$(date +%Y%m%d-%H%M%S)"
test ! -e "$CURRENT_DATA_BACKUP"
docker compose --profile app stop app
mv data "$CURRENT_DATA_BACKUP"
mv "$RESTORE_DIR/data" data
rmdir "$RESTORE_DIR"
docker compose --profile app up -d --force-recreate app
APP_PORT_FOR_CHECK=8000  # 覆盖 APP_PORT 时改为实际值
APP_READY=false
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$APP_PORT_FOR_CHECK/health" >/dev/null; then
        APP_READY=true
        break
    fi
    sleep 2
done
if [ "$APP_READY" != true ] || \
   ! curl -fsS "http://127.0.0.1:$APP_PORT_FOR_CHECK/api/meetings" >/dev/null; then
    docker compose --profile app stop app
    echo "Restore validation failed; app stopped, previous data: $CURRENT_DATA_BACKUP" >&2
    exit 1
fi
```

上述脚本先在同一文件系统的临时目录中完整解压并验证，归档不可读或缺少 `data/archives/meetings.sqlite3` 时不会停止服务或移动现有数据。它只停止并重建应用容器，不影响同一 Compose 网络中的本地 ASR；启动后最多等待 60 秒。恢复后还应在 Web 或 Electron 客户端抽查已知会议、转写和录音。若启动或业务校验失败，脚本会重新停止应用；将当前 `data/` 移走，再把脚本输出的 `data.before-restore-*` 目录改回 `data/`。

不要只备份 `meetings.sqlite3`。录音、转写事件和 Markdown 纪要位于同一数据目录下的会议子目录中。

## 8. 升级与回滚

升级前先按上一节备份 `data/`，然后执行：

```bash
git fetch --tags
git checkout <目标版本或提交>
docker compose --profile app build --pull app
docker compose --profile app up -d app
docker compose --profile app logs --tail=200 app
curl -fsS http://127.0.0.1:8000/health
```

升级不会要求删除数据目录。若需要回滚：

1. 停止应用；
2. 切回原版本；
3. 恢复升级前的完整 `data/` 备份；
4. 重新构建并启动应用；
5. 完成下方验收清单。

## 9. 部署验收清单

按顺序验证：

1. `/health` 返回 `{"status":"ok"}`；
2. Web 页面可打开，Electron 客户端的服务连接测试通过；
3. ASR 与 LLM 模型测试均通过；
4. 新建会议，录制至少 15 秒，确认音量、录音时长和实时转写正常变化；
5. 暂停后继续，确认录音时长按已归档音频继续累计；
6. 在 Electron 客户端打开“阶段总结”，暂停录音后确认尾段总结出现；若要验收完整窗口，将 `.env` 中 `STAGE_SUMMARY_WINDOW_SECONDS` 暂时改为 10，并执行 `docker compose --profile app up -d --force-recreate app`，连续录制超过 10 秒后确认总结出现；验收完成后恢复原值并再次执行同一重建命令；
7. 结束会议，确认尾段阶段总结和完整会议纪要可生成；
8. 导出 WAV 并播放，确认录音完整；
9. 重启应用，确认历史会议、转写和总结仍可访问；
10. 若部署了说话人模型，确认会议结束后的说话人校正成功。

## 10. 常见问题

### 模型测试失败，但模型服务本身可访问

- 确认填写的是 API 基础地址而不是网页地址；
- 确认服务实现 `GET /models`，且模型 ID 与配置完全一致；
- 从应用容器内测试网络，而不是只在宿主机测试；
- 检查代理证书、API Key、限流和模型服务日志。

容器内连通性示例：

```bash
docker compose --profile app exec app \
  python -c "import urllib.request; print(urllib.request.urlopen('http://asr.internal:8001/v1/models').status)"
```

### 应用镜像构建时无法拉取基础镜像

- 确认部署主机能解析并访问 `quantitative.io`；
- 仓库要求鉴权时执行 `docker login quantitative.io`；
- 在受限网络中，将 `Dockerfile` 的基础镜像同步到可访问的内部镜像仓库后再构建；
- 不要跳过锁文件或改用未固定版本的依赖来规避镜像问题。

### 录音一段时间后自动停止

- 打开客户端录音卡片上的小型诊断按钮，检查 ASR 平均耗时和积压；
- ASR 平均处理时间应长期低于 `ASR_STRIDE_SECONDS`；
- 检查反向代理是否保留 WebSocket Upgrade，并将读写超时设置为长连接；
- 检查模型服务是否限流、超时或发生连接重置。

### 阶段总结一直等待或显示失败

- 确认 LLM 已配置并通过连接测试；
- 检查应用能访问 LLM 的 `/chat/completions`；
- 查看 `docker compose logs app` 中的阶段总结错误；
- 修复模型配置后，在客户端点击“重试失败阶段”。

### 页面可以打开但没有麦克风权限

- 非本机地址使用 HTTPS；
- 检查浏览器或操作系统的麦克风权限；
- 确认页面没有嵌入到禁止麦克风权限的 iframe 中。

### 说话人校正不可用

- 按第 2.2 节检查五个模型文件；
- 确认模型目录已正确挂载到容器；
- 检查 `DIARIZATION_THREADS` 是否超过服务器可用 CPU；
- 即使说话人模型不可用，实时转写仍可继续使用。
