import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export async function startBackend({ controlledDiarization = false, archiveAudio = false } = {}) {
  const root = path.resolve(import.meta.dirname, "../..");
  const backendDir =
    process.env.AUDIO2TEXT_DIR || "/root/project/pyproj/audio2text";
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-backend-"),
  );
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const backend = spawn(
    process.env.AUDIO2TEXT_PYTHON ||
      path.join(
        backendDir,
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      ),
    [path.join(root, "scripts/fixtures/meeting-backend.py"), String(port)],
    {
      cwd: directory,
      env: {
        ...process.env,
        AUDIO2TEXT_DIR: backendDir,
        DATA_DIR: directory,
        DATABASE_PATH: path.join(directory, "meetings.sqlite3"),
        DESKTOP_TEST_DIARIZATION: controlledDiarization ? "1" : "0",
        DESKTOP_TEST_ARCHIVE: archiveAudio ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  backend.stdout.on("data", (data) => {
    logs += data;
  });
  backend.stderr.on("data", (data) => {
    logs += data;
  });
  backend.on("error", (error) => {
    logs += error.message;
  });
  async function close() {
    if (backend.pid && backend.exitCode === null) {
      const exited = once(backend, "exit");
      backend.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fetch(`${baseUrl}/health`)
          .then((response) => response.ok)
          .catch(() => false)
      )
        return { baseUrl, close };
      if (backend.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Test backend did not start: ${logs}`);
  } catch (error) {
    await close();
    throw error;
  }
}
