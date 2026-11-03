import { normalizeSttConfig } from "../shared/defaults.js";
import { meetingQuery } from "./meeting-catalog.js";

const CHUNK_THRESHOLD = 100 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class MeetingApi {
  constructor(config) {
    this.config = normalizeSttConfig(config);
    try {
      this.baseUrl = new URL(this.config.baseUrl);
      if (!["http:", "https:"].includes(this.baseUrl.protocol))
        throw new Error();
    } catch {
      throw new Error("请填写 audio2text 服务地址，例如 http://127.0.0.1:8000");
    }
  }

  url(path, websocket = false, query = {}) {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    if (websocket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  async request(path, options = {}) {
    const { query, ...init } = options;
    const response = await fetch(this.url(path, false, query), {
      cache: "no-store",
      ...init,
      headers: {
        ...(localStorage.getItem("meeting-auth-token") ? { Authorization: `Bearer ${localStorage.getItem("meeting-auth-token")}` } : {}),
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: options.signal || AbortSignal.timeout(150000),
    });
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      localStorage.removeItem("meeting-auth-token");
      window.dispatchEvent(new Event("auth-expired"));
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.detail;
      throw new Error(
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((item) => item.msg).join("；")
            : payload?.message || `会议服务请求失败（HTTP ${response.status}）`,
      );
    }
    return payload;
  }

  authMe() { return this.request("/api/auth/me"); }
  authLogin(account, password) {
    return this.request("/api/auth/login", { method: "POST", body: JSON.stringify({ account, password }) });
  }
  authRegister(account, password, department, employeeId) {
    return this.request("/api/auth/register", { method: "POST", body: JSON.stringify({ account, password, department, employee_id: employeeId }) });
  }

  async probe() {
    const meetings = await this.request("/api/meetings", {
      signal: AbortSignal.timeout(5000),
    });
    if (!Array.isArray(meetings))
      throw new Error("服务未返回会议列表，请检查 audio2text 接口地址");
    return {
      ok: true,
      modelFound: true,
      message: "audio2text 会议接口连接正常",
    };
  }

  list(filters = {}, options = {}) {
    return this.request("/api/meetings", {
      ...options,
      query: meetingQuery(filters),
    });
  }

  departments(options = {}) {
    return this.request("/api/departments", options);
  }

  saveDepartment(name, id) {
    return this.request(
      id ? `/api/departments/${encodeURIComponent(id)}` : "/api/departments",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({ name: name.trim() }),
      },
    );
  }

  deleteDepartment(id) {
    return this.request(`/api/departments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  minutes(id, options = {}) {
    return this.request(
      `/api/meetings/${encodeURIComponent(id)}/minutes`,
      options,
    );
  }

  generateMinutes(id) {
    return this.minutes(id, { method: "POST" });
  }

  diarizationStatus(options = {}) {
    return this.request("/api/diarization/status", options);
  }

  retryDiarization(id) {
    return this.request(`/api/meetings/${encodeURIComponent(id)}/diarization`, { method: "POST" });
  }

  modelConfigs(options = {}) {
    return this.request("/api/model-configs", options);
  }

  saveModelConfig(kind, config) {
    return this.request(`/api/model-configs/${kind}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async testModelConfig(kind, config, { signal } = {}) {
    const timeout = AbortSignal.timeout(40000);
    const result = await this.request(`/api/model-configs/${kind}/test`, {
      method: "POST",
      body: JSON.stringify(config),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (typeof result?.success !== "boolean")
      throw new Error("连接测试返回了无效结果，请检查会议服务版本。");
    return result;
  }

  create(title, departmentId = null) {
    return this.request("/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        title: Array.from(String(title || "").trim() || "未命名会议")
          .slice(0, 80)
          .join(""),
        department_id: departmentId || null,
        ...(this.config.language === "auto"
          ? {}
          : { language: this.config.language }),
      }),
    });
  }

  importWav(title, departmentId, file, language = this.config.language, onProgress) {
    if (file.size > CHUNK_THRESHOLD) return this.importWavChunked(title, file, language, onProgress);
    const body = new FormData();
    body.set("title", title);
    body.set("file", file);
    if (departmentId) body.set("department_id", departmentId);
    if (language && language !== "auto") body.set("language", language);
    return this.request("/api/meetings/import", {
      method: "POST", body, signal: AbortSignal.timeout(900000),
    });
  }

  async importWavChunked(title, file, language = this.config.language, onProgress) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const started = await this.request("/api/meetings/import/chunked", {
      method: "POST",
      body: JSON.stringify({ title, language: language === "auto" ? null : language, filename: file.name, file_size: file.size, total_chunks: totalChunks, chunk_size: CHUNK_SIZE }),
      signal: AbortSignal.timeout(900000),
    });
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = file.slice(index * CHUNK_SIZE, Math.min(file.size, (index + 1) * CHUNK_SIZE));
      await this.request(`/api/meetings/import/chunked/${started.upload_id}/${index}`, {
        method: "PUT",
        body: chunk,
        headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": await sha256Hex(chunk) },
        signal: AbortSignal.timeout(900000),
      });
      onProgress?.(index + 1, totalChunks);
    }
    return this.request(`/api/meetings/import/chunked/${started.upload_id}/complete`, {
      method: "POST", signal: AbortSignal.timeout(900000),
    });
  }

  retryImport(id) {
    return this.request(`/api/meetings/${encodeURIComponent(id)}/import/retry`, { method: "POST" });
  }

  get(id, options = {}) {
    return this.request(`/api/meetings/${encodeURIComponent(id)}`, options);
  }

  end(id) {
    return this.request(`/api/meetings/${encodeURIComponent(id)}/end`, {
      method: "POST",
    });
  }

  socketUrl(id) {
    return `${this.url(`/ws/meetings/${encodeURIComponent(id)}`, true)}?token=${encodeURIComponent(localStorage.getItem("meeting-auth-token") || "")}`;
  }

  stageSummarySocketUrl(id) {
    return `${this.url(
      `/ws/meetings/${encodeURIComponent(id)}/stage-summaries`,
      true,
    )}?token=${encodeURIComponent(localStorage.getItem("meeting-auth-token") || "")}`;
  }

  stageSummaries(id, options = {}) {
    return this.request(
      `/api/meetings/${encodeURIComponent(id)}/stage-summaries`,
      options,
    );
  }

  retryStageSummaries(id) {
    return this.request(
      `/api/meetings/${encodeURIComponent(id)}/stage-summaries/retry`,
      { method: "POST" },
    );
  }

  audioDownloadUrl(id) {
    return `${this.url(`/api/meetings/${encodeURIComponent(id)}/audio/download`)}?token=${encodeURIComponent(localStorage.getItem("meeting-auth-token") || "")}`;
  }

  downloadTranscript(id) {
    return this.downloadFile(
      `${this.url(`/api/meetings/${encodeURIComponent(id)}/download`)}?token=${encodeURIComponent(localStorage.getItem("meeting-auth-token") || "")}`,
      "转写文本",
    );
  }

  downloadAudio(id) {
    return this.downloadFile(this.audioDownloadUrl(id), "录音");
  }

  async downloadFile(url, label) {
    const response = await fetch(url, {
      method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(response.status === 404
        ? `会议暂无可导出的${label}，请刷新后重试`
        : `${label}无法导出（HTTP ${response.status}）`);
    }
    // Electron's CSP blocks remote iframes. Use its native download manager.
    if (globalThis.window?.meetingDesktop?.downloadFile) {
      await window.meetingDesktop.downloadFile(url);
      return;
    }
    // Browser downloads stream to disk; a failed GET must not navigate the app.
    let frame = document.getElementById("meeting-download-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "meeting-download-frame";
      frame.hidden = true;
      frame.title = "会议文件下载";
      document.body.appendChild(frame);
    }
    frame.src = url;
  }
}
