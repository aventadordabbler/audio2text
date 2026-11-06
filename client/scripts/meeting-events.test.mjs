import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startBackend } from "./fixtures/start-backend.mjs";
import { MeetingRecorder } from "../src/services/meeting-recorder.js";
import { sessionFromMeeting, sessionWithMinutes } from "../src/services/meeting-catalog.js";
import { applyTranscriptEvent, speakerLabel } from "../src/services/transcript.js";
import { fileURLToPath } from "node:url";

let backend;
const recorders = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error("Condition timed out");
}
class Microphone {
  static async create(onAudio) { return new Microphone(onAudio); }
  constructor(onAudio) {
    this.onAudio = onAudio; this.sampleRate = 16000; this.state = "paused";
    this.stream = { getTracks: () => [] };
  }
  async resume() { this.state = "recording"; }
  async pause() { this.state = "paused"; }
  close() { this.state = "inactive"; }
  emit(text) {
    const bytes = new TextEncoder().encode("TEST" + text);
    const frame = new Uint8Array(bytes.length + bytes.length % 2);
    frame.set(bytes); this.onAudio(frame.buffer);
  }
}
before(async () => { backend = await startBackend({ controlledDiarization: true }); });
after(async () => { recorders.forEach((r) => r.disconnect()); await backend?.close(); });
async function command(recorder, action, payload = {}) {
  return recorder.api.request(`/__test/meetings/${recorder.meeting.id}/${action}`, { method: "POST", body: JSON.stringify(payload) });
}
async function start() {
  const recorder = new MeetingRecorder({ createRecorder: Microphone.create });
  recorders.push(recorder);
  const updates = [], events = [], previews = [];
  await recorder.configure({ baseUrl: backend.baseUrl });
  await recorder.start(1, (text, payload) => updates.push(payload), (text) => previews.push(text), (event) => events.push(event), "事件闭环");
  recorder.mediaRecorder.emit("final:尚未校正的发言。");
  await until(() => recorder.meeting.text.includes("尚未校正"));
  return { recorder, updates, events, previews };
}

test("ending keeps a read-only subscription through delayed correction and automatic minutes", async () => {
  const { recorder, events } = await start();
  await command(recorder, "configure", { hold: true });
  await recorder.stop();
  assert.equal(recorder.socket.readyState, WebSocket.OPEN);
  assert.equal(recorder.mediaRecorder, null);
  await until(() => recorder.meeting.processing.status === "running");
  await until(() => events.some((e) => e.type === "minutes" && e.minutes.status === "not_started"));
  const before = (await command(recorder, "stats")).minutes_calls;
  await command(recorder, "release");
  await until(() => events.some((e) => e.type === "minutes" && e.minutes.status === "ready"));
  assert.equal(recorder.meeting.text, "第一位发言。\n\n第二位发言。");
  assert.equal(recorder.meeting.processing.status, "ready");
  const session = sessionFromMeeting(recorder.meeting, backend.baseUrl);
  assert.deepEqual(session.transcript.map((s) => [s.speakerLabel, s.timeLabel]), [["说话人 1", "00:01:05"], ["说话人 2", "00:01:06"]]);
  assert.equal((await command(recorder, "stats")).minutes_calls, before + 1);
  await assert.rejects(recorder.sendCommand("resume"), /只能查看/);
  recorder.disconnect();
});

test("failed correction retries without regenerating minutes; revised content marks minutes stale", async () => {
  const { recorder, events } = await start();
  await command(recorder, "configure", { fail: true });
  await recorder.stop();
  await until(() => recorder.meeting.processing.status === "failed" && events.some((e) => e.type === "minutes" && e.minutes.status === "ready"));
  const before = (await command(recorder, "stats")).minutes_calls;
  await command(recorder, "configure", {});
  await recorder.retryDiarization();
  await until(() => events.some((e) => e.type === "minutes" && e.minutes.stale));
  const stale = events.filter((e) => e.type === "minutes").at(-1).minutes;
  assert.equal(sessionWithMinutes({}, stale).minutesStale, true);
  assert.equal((await command(recorder, "stats")).minutes_calls, before);
  await recorder.generateMinutes();
  await until(() => events.filter((e) => e.type === "minutes").at(-1)?.minutes.status === "ready" && !events.filter((e) => e.type === "minutes").at(-1)?.minutes.stale);
  assert.equal((await command(recorder, "stats")).minutes_calls, before + 1);
  recorder.disconnect();
});

test("speaker revisions preserve partial text; version gaps and read-only reconnects restore snapshots", async () => {
  const { recorder, previews, events } = await start();
  recorder.mediaRecorder.emit("partial:尚未定稿");
  await until(() => previews.at(-1) === "尚未定稿");
  await command(recorder, "revise", { speakers: { one: { name: "说话人 1" } } });
  await until(() => recorder.meeting.speakers.one);
  assert.equal(previews.at(-1), "尚未定稿");
  await command(recorder, "configure", {});
  await recorder.stop();
  await until(() => events.some((e) => e.type === "minutes" && e.minutes.status === "ready"));
  await command(recorder, "revise", { speakers: { hidden: { name: "漏发事件" } }, publish: false });
  await command(recorder, "revise", { speakers: { latest: { name: "后续事件" } } });
  await until(() => recorder.meeting.speakers.latest);
  assert.equal(recorder.meeting.speakers.hidden.name, "漏发事件");
  const previousSocket = recorder.socket;
  previousSocket.close();
  await until(() => recorder.socket && recorder.socket !== previousSocket && recorder.socket.readyState === WebSocket.OPEN);
  await command(recorder, "revise", { speakers: { resumed: { name: "恢复订阅" } } });
  await until(() => recorder.meeting.speakers.resumed);
  await recorder.api.request(`/api/meetings/${recorder.meeting.id}`, { method: "DELETE" });
  await until(() => events.some((e) => e.type === "deleted"));
  assert.equal(recorder.socket, null);
});

test("segment replacement is ordered and idempotent, and ambiguous speech is displayed honestly", () => {
  const original = { transcript_revision: 2, next_segment_id: 1, segments: [{ segment_id: 0, start_ms: 0, text: "跨人原文" }], speakers: {} };
  const event = { revision: 3, remove_segment_ids: [0], upsert_segments: [{ segment_id: 2, start_ms: 1000, text: "乙" }, { segment_id: 1, start_ms: 0, text: "甲" }], next_segment_id: 3 };
  const updated = applyTranscriptEvent(original, event);
  assert.deepEqual(updated.segments.map((s) => s.segment_id), [1, 2]);
  assert.equal(updated.text, "甲\n\n乙");
  assert.equal(applyTranscriptEvent(updated, event), updated);
  assert.equal(applyTranscriptEvent(original, { ...event, revision: 4 }), null);
  assert.equal(speakerLabel({ speaker_status: "overlap" }), "多人同时讲话");
  assert.equal(speakerLabel({ speaker_status: "unknown" }), "说话人待确认");
});

test("desktop shows delayed correction, retry, speaker replacements and stale minutes without polling", { timeout: 40000 }, async () => {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright");
  const { recorder } = await start();
  await command(recorder, "configure", { hold: true, fail: true });
  await recorder.stop();
  recorder.disconnect();
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [], minutesReads = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (r) => { if (r.method() === "GET" && r.url().endsWith("/minutes")) minutesReads.push(r.url()); });
    await page.addInitScript(({ baseUrl }) => {
      window.meetingDesktop = {
        getBootstrap: async () => ({ config: { stt: { baseUrl, language: "Chinese" } }, platform: "test" }),
        saveConfig: async () => {}, getWindowState: async () => ({ isMaximized: false }),
      };
    }, { baseUrl: backend.baseUrl });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    const open = async () => {
      await page.locator("tbody tr").filter({ hasText: "事件闭环" }).first().getByRole("button", { name: /^事件闭环/ }).click();
    };
    await open();
    await page.getByRole("tab", { name: "转写记录", exact: true }).click();
    const speakerStatus = page.getByLabel("说话人处理状态");
    const speakerStatusDotStyle = () =>
      speakerStatus.locator(".speaker-status-dot").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          animationName: style.animationName,
          backgroundColor: style.backgroundColor,
        };
      });
    await speakerStatus.getByText("正在校正说话人", { exact: true }).waitFor();
    assert.deepEqual(
      await speakerStatusDotStyle(),
      { animationName: "live-pulse", backgroundColor: "rgb(34, 197, 94)" },
    );
    await page.getByRole("tab", { name: "会议纪要", exact: true }).click();
    await page.getByRole("heading", { name: "正在校正说话人", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "生成纪要", exact: true }).isDisabled(), true);
    await delay(200);
    const readsWhileWaiting = minutesReads.length;
    await delay(1300);
    assert.equal(minutesReads.length, readsWhileWaiting);
    await command(recorder, "release");
    await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
    await page.getByRole("tab", { name: "转写记录", exact: true }).click();
    await page.getByRole("button", { name: "重试说话人校正", exact: true }).waitFor();
    assert.match(
      await speakerStatus.getAttribute("aria-label"),
      /模拟校正失败，可重试/,
    );
    assert.deepEqual(
      await speakerStatusDotStyle(),
      { animationName: "none", backgroundColor: "rgb(245, 158, 11)" },
    );
    const before = (await command(recorder, "stats")).minutes_calls;
    await command(recorder, "configure", {});
    await page.getByRole("button", { name: "重试说话人校正", exact: true }).click();
    await speakerStatus.getByText("说话人校正已完成", { exact: true }).waitFor();
    await page.locator(".speaker-label").filter({ hasText: "说话人 2" }).waitFor();
    assert.equal(await page.locator(".transcript-entry").count(), 2);
    assert.match(await page.getByLabel("会议转写文本").textContent(), /00:01:05/);
    assert.doesNotMatch(await page.getByLabel("会议转写文本").textContent(), /尚未校正/);
    assert.equal((await command(recorder, "stats")).minutes_calls, before);
    await page.getByRole("tab", { name: "会议纪要", exact: true }).click();
    await page.getByText("转写已更新，可重新生成纪要。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await page.getByText("转写已更新，可重新生成纪要。", { exact: true }).waitFor({ state: "hidden" });
    assert.match(await page.locator(".minutes-document").textContent(), /第一位发言/);
    // Reopening the same selected meeting must reattach after releasing its socket.
    await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "会议管理", exact: true }).click();
    await open();
    await page.getByRole("tab", { name: "转写记录", exact: true }).click();
    await page.locator(".speaker-label").filter({ hasText: "说话人 2" }).waitFor();
    const latest = await recorder.api.get(recorder.meeting.id);
    await command(recorder, "revise", { segments: [{ ...latest.segments[1], speaker_status: "unknown" }] });
    await page.locator(".speaker-label").filter({ hasText: "说话人待确认" }).waitFor();
    for (const [width, height] of [[1100, 800], [840, 700]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true);
    }
    await page.reload();
    await open();
    await page.getByRole("tab", { name: "转写记录", exact: true }).click();
    await page.locator(".speaker-label").filter({ hasText: "说话人待确认" }).waitFor();
    const remote = await recorder.api.get(recorder.meeting.id);
    await command(recorder, "revise", { segments: [{ ...remote.segments[0], speaker_status: "overlap" }] });
    await page.locator(".speaker-label").filter({ hasText: "多人同时讲话" }).waitFor();
    await recorder.api.request(`/api/meetings/${recorder.meeting.id}`, { method: "DELETE" });
    await page.getByRole("heading", { name: "会议管理", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
