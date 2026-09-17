import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBackend } from "./fixtures/start-backend.mjs";
import { MeetingApi } from "../src/services/meeting-api.js";
import { MeetingRecorder } from "../src/services/meeting-recorder.js";
import { normalizeSttConfig } from "../src/shared/defaults.js";
import { meetingQuery } from "../src/services/meeting-catalog.js";
import { replaceTranscript } from "../src/services/transcript.js";

const root = fileURLToPath(new URL("../", import.meta.url));
let backend, baseUrl;
const activeRecorders = [];

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition timed out");
}

// Substitute microphone hardware while preserving the real PCM/WebSocket lifecycle.
class TestPcmRecorder {
  static async create(onAudio, onError, chunkSeconds) {
    return new TestPcmRecorder(onAudio, chunkSeconds);
  }
  constructor(onAudio, chunkSeconds) {
    this.onAudio = onAudio;
    this.chunkSeconds = chunkSeconds;
    this.sampleRate = 16000;
    this.state = "paused";
    const track = {
      enabled: false,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    this.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  }
  async resume() {
    this.state = "recording";
    this.stream.getAudioTracks()[0].enabled = true;
  }
  emit(text) {
    const bytes = new TextEncoder().encode("TEST" + text);
    const buffer = new Uint8Array(bytes.length + (bytes.length % 2));
    buffer.set(bytes);
    this.onAudio(buffer.buffer);
  }
  emitAudio(seconds = 1) {
    this.onAudio(new ArrayBuffer(this.sampleRate * 2 * seconds));
  }
  async pause() {
    if (this.nextChunk) {
      this.emit(this.nextChunk);
      this.nextChunk = "";
    }
    this.state = "paused";
    this.stream.getAudioTracks()[0].enabled = false;
  }
  close() {
    this.state = "inactive";
    this.stream.getTracks().forEach((track) => track.stop());
  }
}

before(async () => {
  backend = await startBackend();
  baseUrl = backend.baseUrl;
});
after(async () => {
  activeRecorders.forEach((recorder) => recorder.disconnect());
  await backend?.close();
});

async function start(language = "Chinese") {
  const recorder = new MeetingRecorder({
    createRecorder: TestPcmRecorder.create,
  });
  activeRecorders.push(recorder);
  const events = [],
    snapshots = [];
  let rows = [];
  await recorder.configure({ baseUrl, language });
  await recorder.start(
    2,
    async (text, payload) => {
      assert.equal(payload.cumulative, true);
      rows = replaceTranscript(rows, text, "12:00:00");
      snapshots.push(text);
    },
    () => {},
    (event) => events.push(event),
    "协议测试会议",
  );
  return { recorder, events, snapshots, rows: () => rows };
}

test("legacy URLs migrate without losing host, TLS or proxy prefix", () => {
  const config = normalizeSttConfig({
    baseUrl: "wss://example.test/prefix/ws/transcribe/",
    language: "auto",
  });
  assert.equal(config.baseUrl, "https://example.test/prefix");
  const api = new MeetingApi(config);
  assert.equal(
    api.socketUrl("abc"),
    "wss://example.test/prefix/ws/meetings/abc",
  );
  assert.equal(
    api.url("/api/meetings"),
    "https://example.test/prefix/api/meetings",
  );
  assert.throws(() => new MeetingApi({ baseUrl: "invalid" }), /服务地址/);
});

test("probe uses the new REST API without creating meetings", async () => {
  const api = new MeetingApi({ baseUrl });
  const before = await api.request("/api/meetings");
  assert.equal((await api.probe()).ok, true);
  assert.deepEqual(await api.request("/api/meetings"), before);
  await assert.rejects(api.get("missing"), /会议不存在/);
});

test("departments and meeting filters use backend CRUD and combined search", async () => {
  const api = new MeetingApi({ baseUrl });
  const first = await api.saveDepartment("产品研发");
  const second = await api.saveDepartment("市场运营");
  const empty = await api.saveDepartment("待删除部门");
  await assert.rejects(api.saveDepartment("产品研发"), /已存在/);
  const created = await api.create("研发 100%_周会", first.id);
  await api.create("市场周会", second.id);
  await api.create("未分类周会");
  await api.end(created.id);
  const today = new Date(created.created_at);
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const filters = {
    title: "100%_",
    departmentId: first.id,
    status: "ended",
    startDate: day,
    endDate: day,
  };
  assert.deepEqual(
    (await api.list(filters)).map((row) => row.id),
    [created.id],
  );
  assert.equal((await api.list({ ...filters, status: "created" })).length, 0);
  assert.equal(
    (await api.list({ departmentId: "unassigned", title: "未分类周会" }))
      .length,
    1,
  );
  const bounds = meetingQuery(filters);
  assert.ok(new Date(bounds.created_from) <= today);
  assert.ok(new Date(bounds.created_before) > today);
  await assert.rejects(
    api.request("/api/meetings", {
      query: {
        title: created.title,
        created_from: bounds.created_before,
        created_before: bounds.created_from,
      },
    }),
    /开始时间/,
  );
  assert.throws(
    () => api.list({ startDate: "2026-09-17", endDate: "2026-09-16" }),
    /开始日期/,
  );
  assert.equal(
    (
      await api.request("/api/meetings", {
        query: { title: created.title, created_before: created.created_at },
      })
    ).length,
    0,
  );
  await assert.rejects(api.deleteDepartment(first.id), /已有会议/);
  await api.saveDepartment("研发中心", first.id);
  assert.equal((await api.get(created.id)).department_name, "研发中心");
  await api.deleteDepartment(empty.id);
  assert.ok(!(await api.departments()).some((item) => item.id === empty.id));
  await assert.rejects(
    api.create("不存在的部门", "0".repeat(32)),
    /部门不存在/,
  );
});

test("starting a previously created department meeting keeps the same backend ID", async () => {
  const api = new MeetingApi({ baseUrl });
  const department = await api.saveDepartment("续录测试部门");
  const meeting = await api.create("等待录音的会议", department.id);
  const recorder = new MeetingRecorder({
    createRecorder: TestPcmRecorder.create,
  });
  activeRecorders.push(recorder);
  await recorder.configure({ baseUrl });
  await recorder.start(
    1,
    () => {},
    () => {},
    () => {},
    meeting.title,
    { meetingId: meeting.id },
  );
  assert.equal(recorder.meeting.id, meeting.id);
  assert.equal(recorder.meeting.department_id, department.id);
  assert.equal((await api.list({ title: meeting.title })).length, 1);
  await recorder.stop();
});

test("PCM stream preserves partial/final ordering, pause flush, resume and final tail", async () => {
  const { recorder, events, snapshots, rows } = await start();
  assert.equal(recorder.meeting.status, "recording");
  assert.equal(recorder.meeting.language, "Chinese");
  assert.equal(recorder.mediaRecorder.chunkSeconds, 1);
  const previews = [];
  recorder.onPreview = (text) => previews.push(text);
  recorder.mediaRecorder.emit("partial:临时转写");
  await until(() => previews.includes("临时转写"));
  assert.equal((await recorder.api.get(recorder.meeting.id)).text, "");
  recorder.mediaRecorder.emit("final:修订后的定稿。");
  await until(() => snapshots.includes("修订后的定稿。"));
  recorder.mediaRecorder.nextChunk = "partial:暂停前尾音。";
  await recorder.pause();
  assert.equal(recorder.meeting.status, "paused");
  assert.equal(recorder.stream.getAudioTracks()[0].enabled, false);
  assert.equal(
    (await recorder.api.get(recorder.meeting.id)).text,
    "修订后的定稿。\n\n暂停前尾音。",
  );
  await recorder.resume();
  recorder.mediaRecorder.nextChunk = "partial:结束前尾音";
  const ended = await recorder.stop();
  assert.equal(ended.status, "ended");
  assert.equal(ended.text, "修订后的定稿。\n\n暂停前尾音。\n\n结束前尾音");
  assert.equal(
    rows()
      .map((row) => row.text)
      .join(""),
    "修订后的定稿。暂停前尾音。结束前尾音",
  );
  assert.equal(recorder.stream, null);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
});

test("heartbeat returns hidden ASR diagnostics without interrupting recording", async () => {
  const { recorder, events } = await start();

  await until(() =>
    events.some((event) => event.type === "diagnostics" && event.asr),
  );

  const diagnostics = events.find(
    (event) => event.type === "diagnostics" && event.asr,
  );
  assert.equal(diagnostics.asr.mode, "transcription");
  assert.equal(diagnostics.asr.pending_seconds, 0);
  assert.equal(recorder.running, true);
  await recorder.stop();
});

test("recording clock advances from sent PCM duration", async () => {
  const { recorder, events } = await start();

  recorder.mediaRecorder.emitAudio(1);
  await until(() => events.some((event) => event.type === "clock"));

  assert.equal(events.filter((event) => event.type === "clock").at(-1).seconds, 1);
  await recorder.stop();
});

test("ending a paused meeting preserves its saved transcript", async () => {
  const { recorder } = await start();
  recorder.mediaRecorder.nextChunk = "partial:已保存。";
  await recorder.pause();
  assert.equal((await recorder.stop()).text, "已保存。");
});

test("empty meetings end successfully and auto language is omitted", async () => {
  const { recorder } = await start("auto");
  assert.equal(recorder.meeting.language, null);
  assert.equal((await recorder.stop()).text, "");
});

test("disconnection stops the microphone and reconnects to the same meeting", async () => {
  const { recorder, events, snapshots } = await start();
  const id = recorder.meeting.id;
  recorder.mediaRecorder.emit("final:断线前。");
  await until(() => snapshots.includes("断线前。"));
  const track = recorder.stream.getAudioTracks()[0];
  recorder.socket.close();
  await until(() => events.some((event) => event.type === "disconnected"));
  await until(async () => (await recorder.api.get(id)).status === "paused");
  assert.equal(track.stopped, true);
  await recorder.resume();
  recorder.mediaRecorder.emit("partial:恢复后的临时文字");
  const previews = [];
  recorder.onPreview = (text) => previews.push(text);
  await until(() => previews.includes("恢复后的临时文字"));
  recorder.mediaRecorder.emit("final:恢复后。");
  await until(() => snapshots.at(-1) === "断线前。\n\n恢复后。");
  assert.equal(recorder.nextSegment, 2);
  assert.equal((await recorder.stop()).text, "断线前。\n\n恢复后。");
});

test("fatal ASR error retains confirmed text and permits ending via REST", async () => {
  const { recorder, events, snapshots } = await start();
  recorder.mediaRecorder.emit("final:已定稿。");
  await until(() => snapshots.includes("已定稿。"));
  recorder.mediaRecorder.emit("fatal");
  await until(() => events.some((event) => event.type === "disconnected"));
  assert.match(
    events.find((event) => event.type === "disconnected").text,
    /测试识别连接中断/,
  );
  await until(
    async () =>
      (await recorder.api.get(recorder.meeting.id)).status === "paused",
  );
  assert.equal(recorder.mediaRecorder, null);
  assert.equal((await recorder.stop()).text, "已定稿。");
});

test("full transcript replacement preserves repeated sentences and unpunctuated text", () => {
  let rows = replaceTranscript([], "大家好。大家好。未完成", "first");
  rows = replaceTranscript(rows, "大家好。大家好。已经完成。", "second");
  assert.deepEqual(rows, [
    { timeLabel: "first", text: "大家好。" },
    { timeLabel: "first", text: "大家好。" },
    { timeLabel: "second", text: "已经完成。" },
  ]);
  assert.deepEqual(replaceTranscript(rows, "", "third"), []);
});

test(
  "desktop UI creates a department meeting and records real PCM16 audio",
  { timeout: 30000 },
  async () => {
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright");
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    let browser;
    try {
      await server.listen();
      const port = server.httpServer.address().port;
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [
          "--no-sandbox",
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
        ],
      });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(
        ({ baseUrl }) => {
          const state = {
            config: {
              stt: {
                baseUrl: baseUrl.replace("http:", "ws:") + "/ws/transcribe",
                language: "Chinese",
              },
              chunkSeconds: 1,
            },
          };
          const copy = (value) => JSON.parse(JSON.stringify(value));
          window.__desktopState = state;
          window.meetingDesktop = {
            getBootstrap: async () => copy({ ...state, platform: "test" }),
            saveConfig: async (config) => {
              state.config = copy(config);
            },
            getWindowState: async () => ({ isMaximized: false }),
          };
        },
        { baseUrl },
      );
      await page.goto(`http://127.0.0.1:${port}`);
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "部门管理" })
        .click();
      await page.getByRole("button", { name: "新增部门", exact: true }).click();
      await page.getByLabel("部门名称", { exact: true }).fill("浏览器测试部门");
      await page.getByRole("button", { name: "保存部门", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "会议管理" })
        .click();
      await page.getByRole("button", { name: "新建会议", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("会议名称", { exact: true })
        .fill("浏览器协议测试");
      await dialog.getByRole("combobox", { name: "所属部门" }).click();
      await page
        .getByRole("option", { name: "浏览器测试部门", exact: true })
        .click();
      await dialog.getByRole("button", { name: "创建并进入" }).click();
      await page.getByRole("button", { name: "开始会议", exact: true }).click();
      await page
        .getByText(/浏览器 PCM16 录音已识别，共 \d+ 个采样。/)
        .first()
        .waitFor();
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      await until(async () =>
        page.getByRole("button", { name: "继续", exact: true }).isEnabled(),
      );
      const api = new MeetingApi({ baseUrl });
      const [paused] = await api.list({ title: "浏览器协议测试" });
      assert.equal(paused.status, "paused");
      assert.match(paused.text, /共 16000 个采样/);
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await until(async () =>
        page.getByRole("button", { name: "暂停", exact: true }).isEnabled(),
      );
      await page.getByRole("button", { name: "结束会议", exact: true }).click();
      await until(async () => (await api.get(paused.id)).status === "ended");
      await until(
        async () => (await api.minutes(paused.id)).status === "ready",
      );
      const remote = await api.get(paused.id);
      assert.equal(remote.department_name, "浏览器测试部门");
      const rendered = await page.getByLabel("会议转写文本").textContent();
      for (const paragraph of remote.text.split("\n\n"))
        assert.ok(rendered.includes(paragraph));
      await page.getByRole("tab", { name: "会议总结", exact: true }).click();
      await page
        .getByRole("heading", { name: "核心结论", exact: true })
        .waitFor();
      assert.equal(await page.locator(".minutes-document table").count(), 1);
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => window.__desktopState.config.stt.baseUrl),
        baseUrl,
      );
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);

test("PCM worklet sends one-second little-endian frames and flushes tail before pause", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  let Processor;
  const messages = [];
  runInNewContext(
    await readFile(
      new URL("../src/services/pcm-worklet.js", import.meta.url),
      "utf8",
    ),
    {
      sampleRate: 16000,
      AudioWorkletProcessor: class {
        port = { postMessage: (message) => messages.push(message) };
      },
      registerProcessor: (name, value) => {
        Processor = value;
      },
    },
  );
  const worklet = new Processor();
  worklet.port.onmessage({ data: { type: "resume", id: 1 } });
  const samples = new Float32Array(16000);
  samples.set([-2, -0.5, 0, 0.5, 2]);
  worklet.process([[samples]]);
  const audio = messages.filter((message) => message.type === "audio");
  assert.equal(audio.length, 1);
  assert.equal(audio[0].bytes.byteLength, 32000);
  const view = new DataView(audio[0].bytes);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => view.getInt16(index * 2, true)),
    [-32768, -16384, 0, 16384, 32767],
  );
  worklet.process([[new Float32Array([1]), new Float32Array([-1])]]);
  worklet.port.onmessage({ data: { type: "pause", id: 2 } });
  assert.equal(messages.at(-2).type, "audio");
  assert.equal(messages.at(-2).bytes.byteLength, 2);
  assert.equal(new DataView(messages.at(-2).bytes).getInt16(0, true), 0);
  assert.equal(messages.at(-1).id, 2);
  const count = messages.length;
  worklet.process([[samples]]);
  assert.equal(messages.length, count);
});
