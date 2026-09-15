# Qwen3-ASR 原生流式转写调研

调研日期：2026-09-15。以下 vLLM 结论来自官方文档、发行标签源码和官方仓库记录；部署命令与新版本推理未经本项目实际运行。

## 结论

本地部署有两条可选路径：Qwen 官方 Python API 提供有状态、可回滚末尾文本的流式识别；新版 vLLM 提供 `/v1/realtime`，但查询时的 Qwen 实现采用固定 5 秒独立分段。当前项目的 vLLM 0.14.0 不提供后一接口。若目标是采用 Qwen 自身的流式策略，建议先验证 Python API 封装方案，同时为长会议增加分段。具体事实、限制、源码与本地核验如下。

## 当前项目与运行环境核验

2026-09-15 对现有容器进行了只读检查：`audio2text-vllm` 安装 `qwen-asr 0.0.4`、`vllm 0.14.0`；其 vLLM 包内没有 realtime 模块。连接 `ws://127.0.0.1:8001/v1/realtime` 实测返回 `HTTP 403`。结合版本和源码，当前部署不具备新版 vLLM 的 Qwen Realtime 接口。检查没有重启或升级模型服务。

项目 [compose.yaml](../../compose.yaml) 使用 `qwenllm/qwen3-asr:latest` 镜像及 `qwen-asr-serve` 命令；安装版 `qwen_asr/cli/serve.py` 注册模型后调用 vLLM CLI，并未额外挂载流式接口。业务层 [app/asr.py](../../app/asr.py) 当前调用 OpenAI SDK 的文件转写接口，[app/main.py](../../app/main.py) 在每次收到片段后提交该连接的累计录音。

## Qwen 官方 Python 流式接口

官方提供三个方法：`init_streaming_state` 初始化单条音频流，`streaming_transcribe` 接收新音频并更新状态，`finish_streaming_transcribe` 处理不足一个块的尾音频。当前容器已安装这些方法。输入为 16 kHz 单声道 NumPy PCM，支持归一化浮点数据或 int16；`state.text` 是当前音频段的完整识别结果，可能修正末尾文字，客户端应替换当前段正文。官方示例使用 1.7B 模型，说明这条路径可直接用于该型号。[官方示例](https://github.com/QwenLM/Qwen3-ASR/blob/main/examples/example_qwen3_asr_vllm_streaming.py)、[接口实现](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)

以下为模型服务侧流程示意，`pcm_chunks` 是持续产生新增 PCM 的迭代器，`publish` 将当前段完整正文发给调用方；该示例未在当前 GPU 进程中执行：

```python
from qwen_asr import Qwen3ASRModel

# 模型在服务启动时加载一次。
engine = Qwen3ASRModel.LLM(
    model="/models/qwen3-asr-1.7b",
    gpu_memory_utilization=0.8,
    max_new_tokens=32,
)

def recognize_stream(pcm_chunks, publish):
    state = engine.init_streaming_state(
        language="Chinese",
        chunk_size_sec=2.0,
        unfixed_chunk_num=2,
        unfixed_token_num=5,
    )
    for samples in pcm_chunks:
        engine.streaming_transcribe(samples, state)
        publish(state.text)
    engine.finish_streaming_transcribe(state)
    publish(state.text)
```

参数含义：前 2 个识别块不锁定历史输出，之后保留前缀、回退末尾 5 个 token 重新识别；2 秒是模型处理块长，网络可以更频繁地发送小块。该接口目前仅支持 vLLM 后端，不提供流式批处理或时间戳。[官方流式说明](https://github.com/QwenLM/Qwen3-ASR#streaming-inference)

实现中每轮仍将 `audio_accum` 中当前段累计音频重新交给模型，再用已有输出作为前缀续写。因此它提供有状态的流式识别策略，但不能据此承诺恒定内存、恒定延迟或不再重复处理历史音频。长会议仍需应用层分段。[流式实现](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)

官方 `qwen-asr-demo-streaming` 是 Flask 示例，通过 `/api/start`、`/api/chunk`、`/api/finish` 管理状态和音频；它可参考，但不是现成的会议 WebSocket 服务。[官方 demo 源码](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/cli/demo_streaming.py)

## vLLM 的 `/v1/realtime`

### 支持范围与版本

- vLLM 提供输入音频与输出文字双向传输的 WebSocket 接口 `/v1/realtime`。Qwen3-ASR 必须显式指定 `--hf-overrides '{"architectures":["Qwen3ASRRealtimeGeneration"]}'`；默认模型架构不会自动启用这一实现。官方模型表以 `Qwen/Qwen3-ASR-0.6B` 为例。[官方支持表](https://docs.vllm.ai/en/latest/models/supported_models/#realtime-transcription)
- 实现 PR #34613 于 **2026-02-21 UTC** 合入。直接检查发行标签：v0.16.0 尚无该实现，**v0.17.0（2026-03-07 UTC）是本次最早确认包含它的正式版本**；不能仅凭 PR 合入日期推断首个支持版本。[合入 PR](https://github.com/vllm-project/vllm/pull/34613)、[v0.16.0 模型目录](https://github.com/vllm-project/vllm/tree/v0.16.0/vllm/model_executor/models)、[v0.17.0 实现](https://github.com/vllm-project/vllm/blob/v0.17.0/vllm/model_executor/models/qwen3_asr_realtime.py)、[v0.17.0 发布](https://github.com/vllm-project/vllm/releases/tag/v0.17.0)
- 查询时最新正式版为 **v0.29.0，2026-09-09 发布**。以下实现细节以该标签为准，并与查询时 main 核对。[v0.29.0 发布](https://github.com/vllm-project/vllm/releases/tag/v0.29.0)
- **1.7B 不应被理解为不支持**：同一实现继承通用 Qwen3-ASR 模型，没有限定 0.6B 的代码分支；官方仓库中存在 1.7B 的实际运行报告。不过支持表举例与本项目实测不同，本次没有在新 vLLM 上验证本项目 1.7B 权重。[模型实现](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/models/qwen3_asr_realtime.py)、[1.7B 运行报告 #35767](https://github.com/vllm-project/vllm/issues/35767)

### 启动示例

在适配目标 GPU/CUDA 的独立环境安装带音频依赖的 vLLM，例如固定 `vllm[audio]==0.29.0`。下列为依据文档整理的候选命令，**未运行验证**：

```bash
vllm serve Qwen/Qwen3-ASR-1.7B \
  --host 0.0.0.0 \
  --port 8001 \
  --hf-overrides '{"architectures":["Qwen3ASRRealtimeGeneration"]}'
```

可将模型换为官方支持表所举的 `Qwen/Qwen3-ASR-0.6B`。`--hf-overrides` 是这里关键的必需参数；`--enforce-eager`、`--no-async-scheduling` 不是官方支持表规定的统一必需项，是否采用应在选定版本和硬件上验证。历史 torch.compile 问题已由 #35869 修复；异步调度问题 #35755 查询时仍开放，属于部署验证线索，不能据此断言所有新版本都会失败。[音频依赖说明](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/#realtime-api)、[修复 #35869](https://github.com/vllm-project/vllm/pull/35869)、[问题 #35755](https://github.com/vllm-project/vllm/issues/35755)

### 实际协议顺序

连接 `ws://模型服务:8001/v1/realtime` 后，发送和接收可以并发。音频应为 **16 kHz、单声道、有符号 PCM16 原始采样字节的 Base64**，不能直接发送 WebM/MP4 文件内容或 WAV 文件头。[官方协议](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/#realtime-api)、[官方客户端](https://github.com/vllm-project/vllm/blob/v0.29.0/examples/speech_to_text/realtime/openai_realtime_client.py)

```text
服务端 → {"type":"session.created","id":"sess-…","created":…}
客户端 → {"type":"session.update","model":"Qwen/Qwen3-ASR-1.7B"}
客户端 → {"type":"input_audio_buffer.commit","final":false}
客户端 → {"type":"input_audio_buffer.append","audio":"<第 1 块 PCM16 的 Base64>"}
客户端 → {"type":"input_audio_buffer.append","audio":"<第 2 块 PCM16 的 Base64>"}
    ……持续发送新音频，同时接收结果……
服务端 → {"type":"transcription.delta","delta":"<新增原始文本>"}
客户端 → {"type":"input_audio_buffer.commit","final":true}
服务端 → {"type":"transcription.delta","delta":"<剩余文本>"}
服务端 → {"type":"transcription.done","text":"<本轮全部原始文本>","usage":{…}}
```

细节以源码为准：

- `session.update` 的 `model` 位于 JSON 顶层，且开始生成前**必须成功验证**。文档流程写 optional，但当前处理器未验证就拒绝 commit；成功更新没有 `session.updated` 确认事件。
- 首次 `commit`（`final:false`）启动消费音频任务，后续持续 append；结束时 `commit`（`final:true`）标记输入完结并处理不足 5 秒的尾音频。
- 活跃生成中重复普通 commit 被忽略。收到 `done` 后才开始下一轮；处理器会清空旧音频队列，过早发送下一轮音频存在被清空的风险。
- `transcription.delta.delta` 是**新增文字**，应追加；`transcription.done.text` 是**本轮** delta 的累计全文，不能再次追加成重复文本。它不是整场会议的持久记录。
- 未定义词级时间戳、说话人、VAD、文本回滚、片段 ID、语言选择或提示词配置事件；会话更新实际只消费模型名。

以上由 [v0.29.0 协议定义](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/protocol.py) 与 [连接处理器](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/connection.py) 交叉确认。

### 与 Qwen SDK 有状态流式算法的区别

vLLM 当前 Qwen realtime 实现把输入缓冲切成固定 **5 秒、不重叠的音频段**；已消费音频从缓冲移走，下一段使用相同提示词独立识别。它没有累计并重复输入整场音频，也没有消费用于传递历史输出的 `input_stream`。因此，存在模型服务 WebSocket，并不代表使用了 Qwen SDK 的输出前缀复用和回滚算法。[v0.29.0 分段实现](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/models/qwen3_asr_realtime.py#L186)

当前实现还固定 `realtime_max_tokens=64`；没有公开的分段长度会话参数。前端即使每 100 毫秒发送数据，正常首批推理仍需积满约 5 秒音频，加上计算和排队时间；提前 final 可处理更短尾段。多模态处理器在该实现中显式关闭处理器缓存，这不能推导为整个引擎完全没有 KV 缓存。[模型与处理器源码](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/models/qwen3_asr_realtime.py)

连接处理器直接转发原始输出，未调用 Qwen 输出清理；`language Chinese<asr_text>`、`language None<asr_text>` 可能分散在多个 token delta 中，应用仍需跨 delta 缓冲解析并处理无语音。历史问题 #35767 描述了边界重复和上下文丢失；该问题于 2026-08-29 以 `not_planned` 关闭，不能把 closed 当成已修复，当前源码仍保留上述分段行为。[转发源码](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/connection.py#L232)、[问题记录](https://github.com/vllm-project/vllm/issues/35767)、[关闭事件](https://api.github.com/repos/vllm-project/vllm/issues/35767/events)

### 会议隔离、并发与长会议

- 每个上游 WebSocket 有独立 `connection_id`、音频队列和生成任务；单连接同时只有一个生成任务。协议没有业务 `meeting_id`。本项目可继续保留 `/ws/meetings/{meeting_id}`，由后端把各会议映射到各自的上游连接及磁盘文件。后一句是应用设计建议。[连接状态实现](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/connection.py#L33)
- 源码没有给出固定并发会议数，也没有可靠的“会议最长多少小时”承诺；容量取决于 GPU、调度与输入速度。60 秒预分配音频缓冲会扩容，**不是 60 秒时长限制**；模型 `max_audio_clip_s=None` 也不代表可以无限持有一个会话而无需管理资源。[缓冲与模型配置](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/model_executor/models/qwen3_asr_realtime.py)
- 虽然已处理音频被移除，连接仍累计 `full_text`，音频队列无大小上限；生成 token 也持续放进 Qwen 实现未消费的反馈队列。建议按暂停、自然停顿或受控时长提交 final、保存结果、开启新轮次，并添加背压与超时。这是由源码推导的资源管理建议，未做长会议压力测试。[连接处理器](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/connection.py)

### OpenAI Python SDK 兼容边界

vLLM 文档所称兼容 OpenAI 的**文件转写接口**，不能自动延伸为 Realtime 高层 SDK 协议完全兼容。这里存在顶层 `model`、`commit.final`、`transcription.delta`/`transcription.done` 等自己的事件结构。官方示例实际使用 `websockets` 收发 JSON；若使用 OpenAI SDK，应检查其原始消息接口并显式适配，不能照搬 OpenAI Realtime 的高层会话与转写事件代码。[vLLM 协议源码](https://github.com/vllm-project/vllm/blob/v0.29.0/vllm/entrypoints/speech_to_text/realtime/protocol.py)、[官方客户端源码](https://github.com/vllm-project/vllm/blob/v0.29.0/examples/speech_to_text/realtime/openai_realtime_client.py)

## 对本项目的接入建议（设计判断）

若目标是采用 Qwen 自身的前缀回滚流式策略，建议先封装上述 Python API 为独立 GPU 服务，再由现有应用转发。若目标是尽快使用模型服务的 WebSocket 协议，可以评估新版 vLLM Realtime，并接受其当前固定分块策略。两条路径都应通过语音边界、中文准确率、首字延迟、多会议并发测试后再选型。

- 浏览器仍仅连接 `/ws/meetings/{meeting_id}`；每个会议建立独立模型会话和音频状态。
- 音频链路改为持续输出新增 16 kHz 单声道 PCM。可评估浏览器 AudioWorklet 采集及重采样；保留 WebM/MP4 时，需要每条连接独立的持续解码器，处理容器分片顺序。
- 模型实例复用；SDK 的同步 `generate` 应交给受控推理工作队列，避免阻塞 FastAPI 事件循环或假设同一引擎可以任意多线程并发调用。各会议的输入顺序、暂停和结束操作也由各自会话管理。
- 暂停前处理剩余音频并保存当前段，继续录音时开启新段；结束等待尾音频识别完成。长会议按语音停顿或时长上限切段，并明确区分已完成段与可修正段。
- 继续使用已有磁盘正文文件及 SQLite 元数据设计，回推事件保留 `meeting_id`；SDK 的当前段全文不可作为纯增量重复追加。

本地 OpenAI SDK `2.54.0` 的 `AsyncRealtimeConnection` 提供 `send_raw`、`recv_bytes`。据本地源码，保留 OpenAI 库并适配 vLLM 的原始 JSON 协议是可行方向；其高层 `session.update(session=...)` 和不带 `final` 参数的 `commit()` 与 vLLM 协议有差异，尚未与升级后的模型服务联调，不能直接认定完全兼容。

## 是否有必要现在迁移（2026-09-15 补充评估）

**建议先保留现有 OpenAI SDK + vLLM 文件接口，优先整改音频分段和请求积压，再决定是否采用 Qwen Python 流式 API。** 前文的封装方案回答“确定采用官方流式策略后怎样接入”；它不代表已经证明迁移收益高于维护成本。当前没有双方在相同音频、分段、并发条件下的对比结果。

### 当前接口的短音频基线

在现有 RTX 3080 Ti 12 GiB、已运行的模型服务上，将项目公开英文样本 `wav_files/asr_en.wav` 转为 16 kHz 单声道 PCM WAV，截取 5、10、15 秒各请求两次。测量覆盖当前 `VLLMTranscriber.transcribe` 调用，结果如下：

| 输入时长 | 第一次请求 | 第二次请求 |
| --- | --- | --- |
| 5 秒 | 0.596 秒 | 0.147 秒 |
| 10 秒 | 0.240 秒 | 0.211 秒 |
| 15 秒 | 0.340 秒 | 0.299 秒 |

这是单并发、重复样本的少量观测，可能受缓存和连接复用影响，不是冷启动、中文准确率或长会议压力测试。输入提前转好 WAV，未计入浏览器采集等待及 WebM/MP4 解码。当前浏览器约每 2.5 秒发送音频；这组数据表明，短样本下采集周期也是显示延迟的重要组成部分，不能仅凭“原生流式”名称推断迁移收益。

### 主要判断

- 当前代码对同一连接不断累积音频，并反复提交识别，还存在 25 MB 连接上限。长会议的输入体积与请求成本会增长，这是应优先处理的已知问题。[项目处理逻辑](../../app/main.py)
- 官方 SDK 的前缀复用、末尾回滚可能减少重复生成及较早文字的反复变化，但它也会累计当前段音频；模型权重不变，准确率和延迟收益需要实测，不能自动视为提升。[Qwen 流式实现](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)
- 官方封装不提供流式批处理，迁移后需要自行维护 GPU 服务、各会议状态、调度、超时和资源释放；它不会自动增加可并发录音的会议数。[官方限制](https://github.com/QwenLM/Qwen3-ASR#streaming-inference)

建议的评估顺序（尚未实施）：

1. 先设计增量解码与有时长上限的 PCM 音频段；按语音停顿优先切段，保留适量重叠并处理边界重复和漏字。正文由已完成段与可修正的当前段组成。
2. 为每个会议控制请求排队，避免模型跟不上时不断积压；稳定段的最终识别不可被合并或丢弃。
3. 使用同一份长中文会议音频和相同并发条件，比较当前接口分段方案与 Qwen 官方 SDK：端到端文字延迟、尾段完成时间、字符错误率、历史文本改写次数、GPU 利用率、内存及队列增长。
4. 如果分段方案已满足需求，保留现有部署；若 SDK 在同等条件下明显改善延迟或稳定性，再投入服务化改造。
