// `auto` omits the language when creating a backend meeting.
export const STT_LANGUAGE_OPTIONS = Object.freeze([
  { value: "auto", label: "自动检测" },
  { value: "Chinese", label: "中文" },
  { value: "English", label: "English" },
  { value: "Cantonese", label: "粤语" },
  { value: "Arabic", label: "العربية" },
  { value: "German", label: "Deutsch" },
  { value: "French", label: "Français" },
  { value: "Spanish", label: "Español" },
  { value: "Portuguese", label: "Português" },
  { value: "Indonesian", label: "Bahasa Indonesia" },
  { value: "Italian", label: "Italiano" },
  { value: "Korean", label: "한국어" },
  { value: "Russian", label: "Русский" },
  { value: "Thai", label: "ไทย" },
  { value: "Vietnamese", label: "Tiếng Việt" },
  { value: "Japanese", label: "日本語" },
  { value: "Turkish", label: "Türkçe" },
  { value: "Hindi", label: "हिन्दी" },
  { value: "Malay", label: "Bahasa Melayu" },
  { value: "Dutch", label: "Nederlands" },
  { value: "Swedish", label: "Svenska" },
  { value: "Danish", label: "Dansk" },
  { value: "Finnish", label: "Suomi" },
  { value: "Polish", label: "Polski" },
  { value: "Czech", label: "Čeština" },
  { value: "Filipino", label: "Filipino" },
  { value: "Persian", label: "فارسی" },
  { value: "Greek", label: "Ελληνικά" },
  { value: "Hungarian", label: "Magyar" },
  { value: "Macedonian", label: "Македонски" },
  { value: "Romanian", label: "Română" },
]);

const STT_LANGUAGE_VALUES = new Set(STT_LANGUAGE_OPTIONS.map((option) => option.value));

export function normalizeSttBaseUrl(value = "") {
  const raw = String(value).trim();
  if (!raw || raw.startsWith("mock://")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/+$/, "")
      .replace(/\/(?:ws\/transcribe|ws\/meetings(?:\/[^/]+)?|api\/meetings(?:\/[^/]+)?)$/, "");
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

export function normalizeSttConfig(config = {}) {
  return {
    baseUrl: normalizeSttBaseUrl(config.baseUrl),
    protocol: "audio2text",
    language: STT_LANGUAGE_VALUES.has(config.language) ? config.language : "auto",
  };
}

export const DEFAULT_CONFIG = {
  meetingTitle: "",
  exportDir: "",
  stt: {
    baseUrl: "http://127.0.0.1:8000",
    protocol: "audio2text",
    language: "Chinese",
  },
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  chunkSeconds: 1,
  systemPrompt: "你是一个严谨的会议助手，需要输出清晰、简洁、结构化的中文内容。",
  minutesPrompt:
    "请将完整会议内容整理成正式会议总结，至少包含：会议主题、核心结论、决策事项、待办事项、风险与阻塞、下一步安排。",
};

export const MOCK_TRANSCRIPTS = [
  "今天先过一下项目整体进度，客户端联调已经完成，剩下的是部署验证。",
  "语音转写这块需要兼容在线模型和本地网关，两套配置都要支持。",
  "会议总结里要单独列出决策事项、责任人和预计完成时间。",
  "下周需要安排一次专项评审，把跨平台打包和国产系统适配一起过掉。",
];
