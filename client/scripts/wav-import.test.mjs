import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { startBackend } from "./fixtures/start-backend.mjs";

let backend, server, browser;
before(async () => {
  backend = await startBackend({ archiveAudio: true, importAudio: true });
  server = await createServer({ root: new URL("../", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
  await server?.close();
  await backend?.close();
});

function wav() {
  const samples = 44100 * 3.25, channels = 2;
  const data = Buffer.alloc(44 + samples * channels * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(44100, 24); data.writeUInt32LE(44100 * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < samples; i++) for (let ch = 0; ch < channels; ch++)
    data.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 44100) * 12000), 44 + (i * channels + ch) * 2);
  return { name: "已有会议.wav", mimeType: "audio/wav", buffer: data };
}

for (const frontend of ["client", "web"]) {
  test(`${frontend}: WAV creation, recovery view, retry, summary and TXT export use HTTP only`, { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [], sockets = [], requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => { if (socket.url().includes("/ws/meetings/")) sockets.push(socket.url()); });
    page.on("request", (request) => requests.push(request));
    await page.addInitScript(({ baseUrl }) => {
      window.__microphoneCalls = 0;
      window.__downloads = [];
      navigator.mediaDevices.getUserMedia = async () => { window.__microphoneCalls++; throw new Error("Import must not record"); };
      window.meetingDesktop = {
        getBootstrap: async () => ({ config: { stt: { baseUrl, language: "auto" } }, platform: "test" }),
        downloadFile: async (url) => { window.__downloads.push(url); },
        saveConfig: async () => {}, getWindowState: async () => ({ isMaximized: false }),
      };
    }, { baseUrl: backend.baseUrl });
    try {
      const title = `${frontend} 音频导入重试`;
      await page.goto(frontend === "web" ? backend.baseUrl : `http://127.0.0.1:${server.httpServer.address().port}`);
      await page.getByRole("button", { name: /新建会议|创建会议/ }).first().click();
      await page.getByRole("combobox", { name: "创建方式" }).click();
      await page.getByRole("option", { name: "导入音频（WAV/MP3）" }).click();
      await page.getByLabel("音频文件").setInputFiles(wav());
      await page.getByRole("dialog").getByLabel("会议名称").fill(title);
      const started = page.waitForResponse((response) => response.url().endsWith("/api/meetings/import/chunked") && response.request().method() === "POST");
      await page.getByRole("button", { name: "上传并创建", exact: true }).click();
      const response = await started;
      assert.equal(response.status(), 200);
      const meeting = (await response.json()).meeting;
      assert.equal(meeting.duration_seconds, 0);
      assert.equal(meeting.source, "wav");
      assert.equal(meeting.import_job.stage, "initializing");
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.getByRole("heading", { name: "导入音频", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "开始录音", exact: true }).count(), 0);
      await page.locator(".import-progress").getByText("导入处理失败", { exact: true }).waitFor();
      await page.getByRole("button", { name: "重试处理", exact: true }).click();
      await page.locator(".import-progress").getByText("导入处理完成", { exact: true }).waitFor();
      await page.getByRole("tab", { name: "会议纪要", exact: true }).click();
      await page.getByRole("heading", { name: "核心结论", exact: true }).waitFor();
      const regeneration = page.waitForResponse((response) => response.url().endsWith(`/api/meetings/${meeting.id}/minutes`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "重新生成", exact: true }).click();
      assert.equal((await regeneration).status(), 202);
      await page.getByRole("button", { name: "重新生成", exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "重新生成" && !button.disabled));
      await page.getByRole("tab", { name: "转写记录", exact: true }).click();
      await page.getByText("导入音频讨论了项目进度和下一步安排。", { exact: true }).first().waitFor();
      if (frontend === "web") {
        const downloading = page.waitForEvent("download");
        await page.getByRole("link", { name: "导出文本（TXT）", exact: true }).click();
        const download = await downloading;
        assert.equal(download.suggestedFilename(), `${title}.txt`);
        assert.match(await fs.readFile(await download.path(), "utf8"), /导入音频讨论了项目进度/);
      } else {
        // Browser fixture stands in for Electron's native download manager.
        await page.getByRole("button", { name: "导出文本（TXT）", exact: true }).click();
        await page.waitForFunction(() => window.__downloads.length === 1);
        const url = await page.evaluate(() => window.__downloads[0]);
        assert.equal(url, `${backend.baseUrl}/api/meetings/${meeting.id}/download`);
        assert.match(await (await fetch(url)).text(), /导入音频讨论了项目进度/);
      }
      // Re-open through the history list to exercise completed import entry, too.
      if (frontend === "web") await page.locator("#back-button").click();
      else await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "会议管理", exact: true }).click();
      await page.getByRole(frontend === "web" ? "link" : "button", { name: new RegExp(`^${title}`) }).first().click();
      await page.locator(".import-progress").getByText("导入处理完成", { exact: true }).waitFor();
      for (const [width, height] of [[1100, 800], [840, 700]]) {
        await page.setViewportSize({ width, height });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator(".meeting-aside").count(), 0);
        const widths = await page.locator(".meeting-workspace").evaluate((element) => ({
          workspace: element.getBoundingClientRect().width,
          content: element.querySelector(".meeting-content").getBoundingClientRect().width,
        }));
        assert.ok(Math.abs(widths.workspace - widths.content) < 2);
      }
      await fs.mkdir(new URL("../output/playwright/imports/", import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL(`../output/playwright/imports/${frontend}.png`, import.meta.url).pathname, animations: "disabled" });
      assert.equal(await page.evaluate(() => window.__microphoneCalls), 0);
      assert.deepEqual(sockets, []);
      assert.deepEqual(errors, []);
      assert.ok(requests.some((request) => request.method() === "GET" && request.url().endsWith(`/api/meetings/${meeting.id}`)));
    } finally { await page.close(); }
  });
}
