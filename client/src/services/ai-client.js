import { MOCK_TRANSCRIPTS } from "../shared/defaults.js";

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function responseDetails(response) {
  const requestId = response.headers.get("x-request-id") || response.headers.get("request-id");
  return `HTTP ${response.status}${requestId ? `，请求编号: ${requestId}` : ""}`;
}

async function parseError(response) {
  let message = response.statusText || "模型服务请求失败";
  try {
    const data = await response.json();
    message = data.error?.message || data.message || JSON.stringify(data);
  } catch {}
  return `${message}（${responseDetails(response)}）`;
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === "string") {
    return content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .join("")
      .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
      .trim();
  }
  return "";
}

function isMockConfig(config) {
  return String(config?.baseUrl || "").startsWith("mock://");
}

let mockTranscriptIndex = 0;

function buildMockSummary(transcriptText) {
  const lines = transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);

  return [
    "当前议题",
    lines[0] || "围绕会议记录工具的交付推进。",
    "",
    "关键结论",
    "1. 保持轻量桌面形态，优先保证录音、总结、纪要闭环。",
    "2. 语音转文字模型和大语言模型都使用可配置接口，便于切换模型与部署位置。",
    "",
    "待办事项",
    "1. 补录音链路稳定性验证。",
    "2. 打磨纪要模板与导出格式。",
  ].join("\n");
}

function buildMockMinutes(transcriptText) {
  return [
    "一、会议主题",
    "会议记录小程序方案确认与交付推进",
    "",
    "二、核心结论",
    "1. 采用小型悬浮窗形态，支持托盘和跨平台运行。",
    "2. 语音转文字与大语言模型均通过可配置接口接入。",
    "3. 会议过程要支持实时记录和最终会议总结输出。",
    "",
    "三、决策事项",
    "1. 先完成主流程闭环，再补高可靠细节。",
    "2. 后续重点验证录音兼容性和模型网关稳定性。",
    "",
    "四、待办事项",
    "1. 补录音真实链路测试。",
    "2. 补导出模板和历史会话。",
    "",
    "五、会议原文摘录",
    transcriptText || "暂无",
  ].join("\n");
}

export class AiClient {
  async probe(config) {
    if (isMockConfig(config)) {
      return {
        ok: true,
        mode: "mock",
        modelFound: true,
        message: "mock://local 已启用",
        models: [config.model || "mock-model"],
      };
    }

    if (!config.baseUrl || !config.model) {
      throw new Error("配置不完整");
    }

    // Listing a model does not prove its upstream can generate a response.
    await this.chat(
      [
        { role: "system", content: "You are a connectivity probe. Reply with exactly: ok" },
        { role: "user", content: "ok" },
      ],
      config
    );

    return {
      ok: true,
      mode: "remote",
      modelFound: true,
      models: [config.model],
      message: `模型 ${config.model} 实际生成测试通过`,
    };
  }

  async transcribe(_, config) {
    if (!isMockConfig(config)) {
      throw new Error("实时转写已改为 WebSocket 流式采集，不应走文件转写接口");
    }

    const text = MOCK_TRANSCRIPTS[mockTranscriptIndex % MOCK_TRANSCRIPTS.length];
    mockTranscriptIndex += 1;
    return text;
  }

  async summarize(transcriptText, config, systemPrompt, summaryPrompt) {
    if (isMockConfig(config)) {
      return buildMockSummary(transcriptText);
    }

    return this.chat(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${summaryPrompt}\n\n以下是新增会议内容：\n${transcriptText}`,
        },
      ],
      config
    );
  }

  async createMinutes(transcriptText, config, systemPrompt, minutesPrompt) {
    if (isMockConfig(config)) {
      return buildMockMinutes(transcriptText);
    }

    return this.chat(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${minutesPrompt}\n\n以下是完整会议内容：\n${transcriptText}`,
        },
      ],
      config
    );
  }

  async createTitle(transcriptText, minutesText, config, systemPrompt) {
    if (isMockConfig(config)) {
      const firstLine = minutesText
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !/^[一二三四五六七八九十]+、/.test(line));
      return (firstLine || "会议记录整理").slice(0, 18);
    }

    return this.chat(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            "请基于以下会议内容生成一个正式、简洁、适合企业内部留档的中文会议标题，只输出标题本身，控制在 8 到 18 个汉字。\n\n" +
            `会议总结：\n${minutesText || "暂无"}\n\n会议原文：\n${transcriptText}`,
        },
      ],
      config
    );
  }

  async chat(messages, config) {
    if (!config.baseUrl || !config.model) {
      throw new Error("大语言模型配置不完整");
    }

    const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(config.apiKey),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`模型响应读取失败: ${error.message}（${responseDetails(response)}）`);
    }
    const content = extractContent(payload);
    if (!content) throw new Error(`模型未返回有效文本（${responseDetails(response)}）`);
    return content;
  }
}
