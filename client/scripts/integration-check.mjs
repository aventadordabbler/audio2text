import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeetingApi } from "../src/services/meeting-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const sttUrl = process.env.MEETING_STT_URL || "http://127.0.0.1:8000";
const llmBaseUrl = process.env.MEETING_LLM_BASE_URL;
const llmApiKey = process.env.MEETING_LLM_API_KEY;
const llmModel = process.env.MEETING_LLM_MODEL || "MiniMax-M2.5";

const outputDir = path.join(rootDir, "output", "playwright");
await fs.mkdir(outputDir, { recursive: true });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function checkStt() {
  const api = new MeetingApi({ baseUrl: sttUrl });
  return {
    ...await api.probe(),
    endpoint: sttUrl,
  };
}

async function checkLlm() {
  if (!llmBaseUrl || !llmApiKey) {
    throw new Error("MEETING_LLM_BASE_URL and MEETING_LLM_API_KEY are required");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${llmApiKey}`,
  };
  let modelIds = [];

  try {
    const modelsResponse = await withTimeout(
      fetch(`${llmBaseUrl.replace(/\/+$/, "")}/models`, { headers }),
      15000,
      "LLM models request"
    );

    if (modelsResponse.ok) {
      const modelsPayload = await modelsResponse.json();
      modelIds = Array.isArray(modelsPayload?.data)
        ? modelsPayload.data.map((item) => item?.id).filter(Boolean)
        : [];
    }
  } catch {}

  const chatResponse = await withTimeout(
    fetch(`${llmBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: llmModel,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a concise meeting assistant.",
          },
          {
            role: "user",
            content: "Reply with exactly: minimax ok",
          },
        ],
      }),
    }),
    20000,
    "LLM chat request"
  );

  if (!chatResponse.ok) {
    throw new Error(`chat request failed: ${chatResponse.status} ${await chatResponse.text()}`);
  }

  const chatPayload = await chatResponse.json();
  const content = chatPayload?.choices?.[0]?.message?.content ?? "";

  return {
    ok: true,
    baseUrl: llmBaseUrl,
    model: llmModel,
    modelFound: modelIds.length ? modelIds.includes(llmModel) : true,
    responsePreview: String(content).slice(0, 120),
    availableModelCount: modelIds.length,
  };
}

const report = {
  timestamp: new Date().toISOString(),
  stt: null,
  llm: null,
};

try {
  report.stt = await checkStt();
} catch (error) {
  report.stt = {
    ok: false,
    endpoint: sttUrl,
    error: error.message,
  };
}

try {
  report.llm = await checkLlm();
} catch (error) {
  report.llm = {
    ok: false,
    baseUrl: llmBaseUrl || "",
    model: llmModel,
    error: error.message,
  };
}

const reportPath = path.join(outputDir, "integration-report.json");
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify(report, null, 2));

if (!report.stt?.ok || !report.llm?.ok) {
  process.exit(1);
}
