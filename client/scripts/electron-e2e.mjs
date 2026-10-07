import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { startBackend } from "./fixtures/start-backend.mjs";
import { MeetingApi } from "../src/services/meeting-api.js";

const rootDir = path.resolve(import.meta.dirname, "..");
const win7 = process.argv.includes("--win7");
const outputDir = path.join(rootDir, "output", "playwright", win7 ? "win7" : "modern");
// Test the actual packaged Electron 22 runtime and renderer, not the dev server.
const legacyExecutable = process.platform === "win32"
  ? path.join(rootDir, "release/win7/win-unpacked/Meeting Float Desktop Win7.exe")
  : path.join(rootDir, "release/win7/linux-unpacked/meeting-float-desktop");
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-ui-"));
await fs.mkdir(outputDir, { recursive: true });
const backend = await startBackend({ archiveAudio: true });
const api = new MeetingApi({ baseUrl: backend.baseUrl });
let electronApp;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Condition timed out");
}
async function writeServerTranscript(meeting) {
  const socket = new WebSocket(api.socketUrl(meeting.id));
  try {
    const receive = (type) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Missing ${type}`)),
          10000,
        );
        function listener({ data }) {
          const message = JSON.parse(data);
          if (message.type === type) {
            clearTimeout(timer);
            socket.removeEventListener("message", listener);
            resolve(message);
          }
        }
        socket.addEventListener("message", listener);
      });
    await receive("ready");
    let state = receive("state");
    socket.send(
      JSON.stringify({
        type: "start",
        format: "pcm_s16le",
        sample_rate: 16000,
      }),
    );
    await state;
    const text = new TextEncoder().encode(
      "TESTfinal:转写来自服务端，关闭桌面后仍可读取。",
    );
    const pcm = new Uint8Array(text.length + (text.length % 2));
    pcm.set(text);
    const final = receive("final");
    socket.send(pcm);
    await final;
    state = receive("state");
    socket.send(JSON.stringify({ type: "pause" }));
    await state;
  } finally {
    socket.close();
  }
}

async function checkTranscriptDownload(page, meeting) {
  const current = await api.get(meeting.id);
  const expected = `${current.text}\n`;
  const url = api.url(`/api/meetings/${meeting.id}/download`);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(expected));
  assert.equal(await head.text(), "");

  const textPath = path.join(profileDir, `${meeting.id}.txt`);
  await electronApp.evaluate(({ BrowserWindow }, downloadPath) => {
    globalThis.transcriptDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_, item) => {
      item.setSavePath(downloadPath);
      item.once("done", (_, state) => {
        globalThis.transcriptDownload = { state, filename: item.getFilename() };
      });
    });
  }, textPath);
  await page.getByRole("button", { name: "导出文本（TXT）", exact: true }).click();
  await until(() => electronApp.evaluate(() => Boolean(globalThis.transcriptDownload)));
  assert.deepEqual(await electronApp.evaluate(() => globalThis.transcriptDownload), {
    state: "completed", filename: `${meeting.title}.txt`,
  });
  assert.equal(await fs.readFile(textPath, "utf8"), expected);
}

try {
  const department = await api.saveDepartment("产品研发部");
  const meeting = await api.create("界面验证会议", department.id);
  await writeServerTranscript(meeting);
  await api.create("待开始的讨论");
  electronApp = await electron.launch({
    ...(win7 ? { executablePath: legacyExecutable } : {}),
    args: [
      ...(process.platform === "linux" && process.getuid?.() === 0
        ? ["--no-sandbox"]
        : []),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--user-data-dir=${path.join(profileDir, "chromium")}`,
      ...(!win7 ? ["."] : []),
    ],
    cwd: rootDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: profileDir,
      VITE_DEV_SERVER_URL: "",
      MEETING_FLOAT_AUTOTEST: "0",
    },
  });
  await electronApp.evaluate(
    ({ app }, directory) => app.setPath("userData", directory),
    profileDir,
  );
  const page = await electronApp.firstWindow();
  const errors = [];
  const observe = (window) =>
    window.on("pageerror", (error) => errors.push(error.message));
  observe(page);
  electronApp.on("window", observe);
  await page.waitForFunction(() => Boolean(window.meetingDesktop));
  const bootstrap = await page.evaluate(() =>
    window.meetingDesktop.getBootstrap(),
  );
  assert.equal(bootstrap.versions.electron, win7 ? "22.3.27" : "35.7.5");
  assert.equal(await page.evaluate(() => typeof AbortSignal.any), "function");
  // Exercise cancellation of a real request on Chromium 108, where any() is polyfilled.
  assert.equal(await page.evaluate(async () => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by test", "AbortError");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    controller.abort(reason);
    try { await fetch("http://127.0.0.1:1", { signal }); }
    catch (error) { return error.name === "AbortError" && signal.reason === reason; }
    return false;
  }), true);
  assert.equal("sessions" in bootstrap, false);
  assert.equal(
    await page.evaluate(() => typeof window.meetingDesktop.saveSession),
    "undefined",
  );
  const config = {
    ...bootstrap.config,
    stt: {
      ...bootstrap.config.stt,
      baseUrl: backend.baseUrl,
      language: "Chinese",
    },
  };
  const storePath = path.join(profileDir, "meeting-float-desktop-store.json");
  // Simulate the old store; bootstrap must migrate it to preferences only.
  await fs.writeFile(
    storePath,
    JSON.stringify({
      config: { ...config, meetingTitle: "旧本地名称" },
      sessions: [
        { data: { transcript: ["旧本地转写"], minutes: "旧本地总结" } },
      ],
    }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "会议管理", exact: true }).waitFor();
  const migrated = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.deepEqual(Object.keys(migrated), ["config"]);
  assert.equal(migrated.config.meetingTitle, "");
  assert.equal(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.session.isPersistent(),
    ),
    false,
  );

  const navigation = page.getByRole("navigation", {
    name: "主导航",
    exact: true,
  });
  const go = (name) =>
    navigation.getByRole("button", { name, exact: true }).click();
  async function screenshot(name, window = page) {
    await window.evaluate(() => document.fonts.ready);
    await window.screenshot({
      path: path.join(outputDir, name),
      animations: "disabled",
    });
  }
  async function select(label, option) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  async function resizeWindow(width, height) {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await page.waitForFunction((nextWidth) => innerWidth === nextWidth, width);
  }
  for (const [width, height] of [
    [840, 700],
    [1280, 720],
  ]) {
    await resizeWindow(width, height);
    assert.deepEqual(
      await page.evaluate(() =>
        [
          document.documentElement,
          ...document.querySelectorAll(".workspace-sidebar, .main-workspace"),
        ]
          .filter((element) => element.scrollWidth > element.clientWidth)
          .map((element) => element.className || element.tagName),
      ),
      [],
    );
  }

  // Four filters combine on the server, including the full end date.
  await page.getByRole("textbox", { name: "搜索会议" }).fill("界面验证");
  await select("所属部门", "产品研发部");
  await select("会议状态", "已暂停");
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await page.getByLabel("开始日期", { exact: true }).fill(day);
  await page.getByLabel("结束日期", { exact: true }).fill(day);
  await page
    .locator("tbody")
    .getByRole("button", { name: /^界面验证会议/ })
    .waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByLabel("开始日期", { exact: true }).fill("2099-01-01");
  await page.getByText("开始日期不能晚于结束日期", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重置筛选" }).click();
  await page
    .locator("tbody")
    .getByRole("button", { name: /^界面验证会议/ })
    .click();
  await page.locator(".page-heading h1").filter({ hasText: meeting.title }).waitFor();
  await checkTranscriptDownload(page, meeting);
  assert.match(
    await page.getByLabel("会议转写文本").textContent(),
    /转写来自服务端/,
  );
  await go("会议管理");
  await api.end(meeting.id);
  await until(async () => (await api.minutes(meeting.id)).status === "ready");
  const minutesBefore = await api.minutes(meeting.id);
  const readRequests = [];
  const onRequest = (request) => {
    if (request.url().startsWith(backend.baseUrl))
      readRequests.push(request.method());
  };
  page.on("request", onRequest);
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  const meetingRow = page
    .locator("tbody tr")
    .filter({ hasText: meeting.title });
  await meetingRow.getByText("已结束", { exact: true }).waitFor();
  await meetingRow.getByRole("button", { name: /^界面验证会议/ }).click();
  await page.locator(".page-heading h1").filter({ hasText: meeting.title }).waitFor();
  page.off("request", onRequest);
  assert.ok(
    readRequests.length >= 3 &&
      readRequests.every((method) => method === "GET"),
  );
  assert.equal(
    (await api.minutes(meeting.id)).updated_at,
    minutesBefore.updated_at,
  );
  await page.getByRole("tab", { name: "会议总结", exact: true }).click();
  await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
  assert.equal(await page.locator(".minutes-document table").count(), 1);
  await screenshot("electron-main.png");

  await go("部门管理");
  assert.equal(
    await page
      .getByRole("button", { name: "删除部门：产品研发部", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "编辑部门：产品研发部" }).click();
  await page.getByLabel("部门名称", { exact: true }).fill("研发中心");
  await page.getByRole("button", { name: "保存部门", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新增部门", exact: true }).click();
  await page.getByLabel("部门名称", { exact: true }).fill("临时部门");
  await page.getByRole("button", { name: "保存部门", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "删除部门：临时部门" }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await until(async () => (await api.departments()).length === 1);
  await page
    .getByRole("button", { name: "编辑部门：研发中心", exact: true })
    .waitFor();
  await screenshot("electron-departments.png");

  await go("会议管理");
  await page.getByRole("button", { name: "新建会议", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const dialogStyles = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return { background: [...context.getImageData(0, 0, 1, 1).data], position: style.position };
  });
  assert.deepEqual(dialogStyles.background, [255, 255, 255, 255]);
  assert.equal(dialogStyles.position, "fixed");
  await dialog
    .getByLabel("会议名称", { exact: true })
    .fill("桌面 PCM 录音验证");
  await dialog.getByRole("combobox", { name: "所属部门" }).click();
  await page.getByRole("option", { name: "研发中心", exact: true }).click();
  await dialog.getByRole("button", { name: "创建并进入" }).click();
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class TestWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).endsWith("/stage-summaries"))
          window.__activeMeetingSocket = this;
      }
    };
  });
  await page.getByRole("button", { name: "开始会议", exact: true }).click();
  await page
    .getByText(/浏览器 PCM16 录音已识别，共 16000 个采样。/)
    .first()
    .waitFor();
  const speakerStatus = page.getByLabel("说话人处理状态");
  await speakerStatus.waitFor();
  assert.equal(
    await speakerStatus.evaluate((element) =>
      Boolean(element.closest(".document-heading")),
    ),
    true,
  );
  const speakerStatusDot = await speakerStatus
    .locator(".speaker-status-dot")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
        backgroundColor: style.backgroundColor,
      };
    });
  assert.deepEqual(speakerStatusDot, {
    animationName: "none",
    backgroundColor: "rgb(245, 158, 11)",
  });
  assert.equal(await page.getByLabel("ASR 运行诊断").count(), 0);
  await page.getByRole("button", { name: "显示运行诊断", exact: true }).click();
  await page
    .getByLabel("ASR 运行诊断")
    .getByText("文件转写", { exact: true })
    .waitFor();
  for (const [width, height] of [
    [840, 700],
    [1280, 720],
  ]) {
    await resizeWindow(width, height);
    const workspaceColumns = await page.evaluate(() => {
      const aside = document.querySelector(".meeting-aside");
      const transcript = document.querySelector(
        '.meeting-panel[data-state="active"] .document-card',
      );
      const stageSummary = document.querySelector(".stage-summary-panel");
      const recording = document.querySelector(".recording-card--top");
      const recordingRect = recording?.getBoundingClientRect();
      const transcriptRect = transcript?.getBoundingClientRect();
      const stageSummaryRect = stageSummary?.getBoundingClientRect();
      return {
        top: recordingRect?.top ?? -1,
        bottom: recordingRect?.bottom ?? Number.POSITIVE_INFINITY,
        stageTop: stageSummaryRect?.top ?? -1,
        transcriptTop: transcriptRect?.top ?? -1,
        asideOverflowY: getComputedStyle(aside).overflowY,
        contentFits: [...recording.children]
          .filter((child) => !child.classList.contains("recording-diagnostics"))
          .every((child) => {
            const rect = child.getBoundingClientRect();
            return (
              rect.height === 0 ||
              (rect.top >= recordingRect.top - 1 &&
                rect.bottom <= recordingRect.bottom + 1)
            );
          }),
        controlsVisible: [...recording.querySelectorAll("button")].every(
          (button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.top >= recordingRect.top - 1 &&
              rect.bottom <= recordingRect.bottom + 1
            );
          },
        ),
      };
    });
    assert.equal(workspaceColumns.top >= 0, true, JSON.stringify(workspaceColumns));
    assert.equal(
      workspaceColumns.bottom <= height,
      true,
      JSON.stringify(workspaceColumns),
    );
    assert.equal(workspaceColumns.asideOverflowY, "auto");
    assert.equal(
      Math.abs(workspaceColumns.stageTop - workspaceColumns.transcriptTop) <= 2,
      true,
      JSON.stringify(workspaceColumns),
    );
    assert.equal(
      workspaceColumns.contentFits,
      true,
      JSON.stringify(workspaceColumns),
    );
    assert.equal(
      workspaceColumns.controlsVisible,
      true,
      JSON.stringify(workspaceColumns),
    );
  }
  await page.getByRole("button", { name: "隐藏运行诊断", exact: true }).click();
  await page.getByLabel("ASR 运行诊断").waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.querySelector(".recording-timer strong")?.textContent !== "00:00:00",
  );
  await page.evaluate(() => window.__activeMeetingSocket.close());
  await until(async () => {
    const [active] = await api.list({ title: "桌面 PCM 录音验证" });
    return (await api.get(active.id)).status === "paused";
  });
  await until(async () =>
    page.getByRole("button", { name: "继续", exact: true }).isEnabled(),
  );
  const frozenClock = await page.locator(".recording-timer strong").textContent();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await until(async () =>
    page.getByRole("button", { name: "暂停", exact: true }).isEnabled(),
  );
  await page.waitForFunction(
    (previous) => document.querySelector(".recording-timer strong")?.textContent !== previous,
    frozenClock,
  );
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
  assert.equal(
    await page.getByRole("tab", { name: "阶段总结", exact: true }).count(),
    0,
  );
  await page
    .getByLabel("阶段总结")
    .locator(".ai-insight-heading")
    .getByText("阶段总结", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("AI 会议助手", { exact: true }).count(),
    0,
  );
  const latestStageSummary = page
    .getByLabel("阶段总结")
    .locator("article.ai-insight-item")
    .last();
  await latestStageSummary
    .getByRole("button", { name: "展开全文", exact: true })
    .waitFor();
  const stageCopy = latestStageSummary.locator(".ai-insight-item-body");
  const stageBodyLayout = await stageCopy
    .evaluate((body) => ({
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
    }));
  assert.equal(
    stageBodyLayout.scrollHeight <= stageBodyLayout.clientHeight + 1,
    true,
    JSON.stringify(stageBodyLayout),
  );
  const collapsedStageText = await stageCopy.textContent();
  assert.equal(Array.from(collapsedStageText).length, 81);
  assert.equal(collapsedStageText.endsWith("…"), true);
  await screenshot("electron-stage-summary-panel.png");
  await latestStageSummary
    .getByRole("button", { name: "展开全文", exact: true })
    .click();
  assert.equal(Array.from(await stageCopy.textContent()).length > 80, true);
  await latestStageSummary
    .getByRole("button", { name: "收起", exact: true })
    .click();
  for (const removedText of [
    "会议服务同步",
    "转写与总结均由服务端保存",
    "从讨论到行动",
    "实时转写保留完整记录，会议总结帮你梳理重点与下一步。",
    "管理模型设置",
  ]) {
    assert.equal(await page.getByText(removedText, { exact: true }).count(), 0);
  }
  await page.getByRole("tab", { name: "会议总结", exact: true }).click();
  await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
  const [recorded] = await api.list({ title: "桌面 PCM 录音验证" });
  assert.equal(recorded.department_name, "研发中心");
  assert.equal(recorded.status, "ended");
  await checkTranscriptDownload(page, recorded);
  const wavPath = path.join(profileDir, "recording.wav");
  // Electron 22 lacks CDP download context management; observe the native API.
  await electronApp.evaluate(({ BrowserWindow }, downloadPath) => {
    globalThis.recordingDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_, item) => {
      item.setSavePath(downloadPath);
      item.once("done", (_, state) => {
        globalThis.recordingDownload = { state, filename: item.getFilename() };
      });
    });
  }, wavPath);
  await page.getByRole("button", { name: "导出录音（WAV）", exact: true }).click();
  await until(() => electronApp.evaluate(() => Boolean(globalThis.recordingDownload)));
  assert.deepEqual(await electronApp.evaluate(() => globalThis.recordingDownload), {
    state: "completed", filename: "桌面 PCM 录音验证-录音.wav",
  });
  const bytes = await fs.readFile(wavPath);
  assert.ok(bytes.length > 44);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.length, bytes.readUInt32LE(4) + 8);

  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "模型设置", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("接口地址", { exact: true }).inputValue(),
    backend.baseUrl,
  );
  await page.evaluate(() => {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const originalResume = AudioContext.prototype.resume;
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await originalGetUserMedia(...args);
      window.__microphoneTestTracks = stream.getTracks();
      return stream;
    };
    AudioContext.prototype.resume = function delayedResume() {
      return new Promise((resolve) => {
        window.__resumeMicrophoneTest = resolve;
      });
    };
    window.__restoreMicrophoneTest = () => {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
      AudioContext.prototype.resume = originalResume;
    };
  });
  await page.getByText("麦克风输入测试", { exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__resumeMicrophoneTest));
  await page.getByText("麦克风输入测试", { exact: true }).click();
  await page.waitForFunction(() =>
    window.__microphoneTestTracks?.every((track) => track.readyState === "ended"),
  );
  await page.evaluate(() => window.__resumeMicrophoneTest());
  await page.evaluate(() => window.__restoreMicrophoneTest());
  await page.getByText("麦克风输入测试", { exact: true }).click();
  const microphoneLevel = page.getByRole("meter", {
    name: "麦克风输入音量",
  });
  await microphoneLevel.waitFor();
  await page.waitForFunction(() => {
    const meter = document.querySelector(
      '[role="meter"][aria-label="麦克风输入音量"]',
    );
    return Number(meter?.getAttribute("aria-valuenow")) > 0;
  });
  assert.equal(
    await page.getByText(/getUserMedia:|AudioContext:|WebSocket:/).count(),
    0,
  );
  await page.getByText("麦克风输入测试", { exact: true }).click();
  await select("识别语言", "English");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.meetingDesktop.getBootstrap()).config.stt.language ===
      "English",
  );
  await page.getByRole("tab", { name: "大语言模型", exact: true }).click();
  await page
    .getByLabel("接口地址", { exact: true })
    .fill("https://example.invalid/v1");
  await page.getByLabel("模型名称", { exact: true }).fill("test-server-model");
  await page.getByLabel("接口密钥", { exact: true }).fill("test-secret");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByText("模型配置已保存到服务端", { exact: true }).waitFor();
  const llm = (await api.modelConfigs()).find((item) => item.kind === "llm");
  assert.equal(llm.model, "test-server-model");
  assert.equal(llm.api_key_configured, true);
  assert.ok(!(await fs.readFile(storePath, "utf8")).includes("test-secret"));
  await screenshot("electron-settings.png");

  // Reload drops memory; all displayed records must be reloaded from the server.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator("tbody")
    .getByRole("button", { name: /^桌面 PCM 录音验证/ })
    .click();
  await page.getByRole("tab", { name: "会议总结", exact: true }).click();
  await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
  await go("会议管理");
  await page
    .locator("tbody")
    .getByRole("button", { name: /^界面验证会议/ })
    .waitFor();
  await screenshot("electron-management.png");
  await page
    .locator("tbody")
    .getByRole("button", { name: /^界面验证会议/ })
    .click();
  await page.getByRole("tab", { name: "会议总结", exact: true }).click();
  await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
  const minutesReady = electronApp.waitForEvent("window");
  await page.getByRole("button", { name: "独立窗口", exact: true }).click();
  const minutesPage = await minutesReady;
  await minutesPage
    .getByRole("heading", { name: "核心结论", exact: true })
    .waitFor();
  assert.equal(await minutesPage.locator(".minutes-document table").count(), 1);
  await screenshot("electron-minutes.png", minutesPage);
  await page.evaluate(() =>
    window.meetingDesktop.openMinutesWindow({
      title: "更新后的会议总结",
      minutes: "## 最新结论\n\n总结窗口已更新。",
    }),
  );
  await minutesPage
    .getByRole("heading", { name: "最新结论", exact: true })
    .waitFor();
  assert.equal(electronApp.windows().length, 2);
  const stored = await fs.readFile(storePath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(stored)), ["config"]);
  assert.ok(!/界面验证会议|桌面 PCM|转写来自|核心结论|旧本地/.test(stored));
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);

  // Exercise the real in-app dialog, including native close requests such as Alt+F4.
  const mainWindowId = await (await electronApp.browserWindow(page)).evaluate((window) => window.id);
  await electronApp.evaluate(({ BrowserWindow }, windowId) => {
    const state = { windowId, minimizeCount: 0 };
    globalThis.closeConfirmationTest = state;
    const window = BrowserWindow.fromId(windowId);
    const minimize = window.minimize.bind(window);
    window.minimize = () => { state.minimizeCount++; minimize(); };
  }, mainWindowId);
  const closeDialog = page.getByRole("dialog", { name: "关闭窗口", exact: true });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await closeDialog.waitFor();
  assert.equal(await closeDialog.getByRole("button", { name: "最小化窗口", exact: true }).evaluate((button) => button === document.activeElement), true);
  for (const [width, height] of [[840, 700], [1280, 720]]) {
    await electronApp.evaluate(({ BrowserWindow }, { windowId, width, height }) => {
      BrowserWindow.fromId(windowId).setSize(width, height);
    }, { windowId: mainWindowId, width, height });
    await page.waitForFunction((width) => innerWidth === width, width);
    await until(() => closeDialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 1 &&
        Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 1;
    }));
  }
  const closeStyles = await closeDialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.fillStyle = style.backgroundColor;
    canvas.fillRect(0, 0, 1, 1);
    return { background: [...canvas.getImageData(0, 0, 1, 1).data], position: style.position };
  });
  assert.deepEqual(closeStyles, dialogStyles);
  await screenshot("electron-close-confirmation.png");
  await electronApp.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId).close(), mainWindowId);
  assert.equal(await closeDialog.count(), 1);
  assert.deepEqual(await minutesPage.evaluate(() => window.meetingDesktop.respondCloseWindow("close")), { ok: false });
  await page.keyboard.press("Escape");
  await closeDialog.waitFor({ state: "hidden" });
  assert.equal(electronApp.windows().length, 2);
  assert.equal(page.isClosed(), false);

  await electronApp.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId).close(), mainWindowId);
  await closeDialog.getByRole("button", { name: "取消", exact: true }).click();
  await closeDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await closeDialog.getByRole("button", { name: "最小化窗口", exact: true }).click();
  await until(() => electronApp.evaluate(() => globalThis.closeConfirmationTest.minimizeCount === 1));
  assert.equal(page.isClosed(), false);
  await electronApp.evaluate(({ BrowserWindow }, windowId) => {
    const window = BrowserWindow.fromId(windowId);
    window.restore();
    window.show();
    window.focus();
  }, mainWindowId);
  await closeDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await Promise.all([
    page.waitForEvent("close"),
    closeDialog.getByRole("button", { name: "关闭窗口", exact: true }).click().catch((error) => {
      // Electron can destroy the renderer before Playwright receives the click reply.
      if (!page.isClosed()) throw error;
    }),
  ]);
  assert.equal(electronApp.windows().length, 1);
  assert.deepEqual(errors, []);
  const report = {
    timestamp: new Date().toISOString(),
    electron: bootstrap.versions.electron,
    chromium: bootstrap.versions.chrome,
    platform: process.platform,
    result: "passed",
    temporaryProfile: true,
    checks: [
      "Production file:// PCM16 capture at 1 second",
      "Socket interruption resumes the sample-based recording clock",
      "Hidden heartbeat and ASR diagnostics panel",
      "Independent live stage-summary feed and persisted tail window",
      "Native TXT download matches saved transcripts before and after meeting end",
      "Native WAV download and renderer request cancellation",
      "Department CRUD and meeting assignment",
      "Combined department/date/status/title filters",
      "Server list refresh and latest transcript/summary query",
      "Server summary rendering and reload",
      "No local meeting storage and legacy migration",
      "Nonpersistent renderer session",
      "Server LLM settings",
      "Microphone input level without environment implementation details",
      "Minimum window layout",
      "Separate summary window and confirmed close",
      "Styled close dialog centered at minimum and normal window sizes",
      "Escape/cancel, minimization, confirmed close and duplicate prompt prevention",
    ],
    pageErrors: errors,
    notes: [
      "Real backend routes/store with deterministic ASR and summary fixtures; no live model calls.",
    ],
  };
  await fs.writeFile(
    path.join(outputDir, "electron-e2e-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = electronApp?.windows()[0];
  if (page) {
    await page
      .screenshot({ path: path.join(outputDir, "electron-failure.png") })
      .catch(() => {});
    console.error(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  await electronApp?.close();
  await backend.close();
  await fs.rm(profileDir, { recursive: true, force: true });
}
