# Meeting Float Desktop

## UI

The desktop follows the workspace design and frontend stack in `/root/project/pyproj/audio2text/web`:

- React 19.3, shadcn/ui (`radix-nova`, neutral), Radix UI 1.6, Tailwind CSS 4.3, Vite 8.3.
- Shared shadcn components in `src/components/ui/`, configured through `components.json`; TypeScript checks run before every build. Existing recording and service logic remains in JavaScript.
- Geist typography, Lucide icons, a neutral sidebar, a transcript workspace with recording controls, searchable local history, and separate speech/model settings.
- Meeting summaries render Markdown headings, lists and tables in both the workspace and the independent summary window.

## Testing Notes

## Basic Checks

- Start the app with `npm run dev` or `npm start`
- Verify microphone permission prompt appears
- Verify tray minimize and restore
- Verify settings save and reload
- Verify mock flow can generate transcript, summaries, and minutes
- Verify history sessions can be reopened
- Verify minutes window opens correctly

## Build Check

```bash
npm run build
```

## Desktop UI Smoke Check

```bash
npm run build
npm run test:e2e
```

On headless Linux, run `xvfb-run -a npm run test:e2e`. The smoke check uses a temporary profile and synthetic meeting data; no model credentials are required. It checks settings persistence across reloads, navigation, history search, Markdown summaries and the separate Electron summary window. Screenshots and a JSON report are written to `output/playwright/`.

## Packaging Check

```bash
npm run pack
```

```bash
npm run dist:win
```

## Current Limits

- Real-time STT uses the Audio2Text meeting API from `/root/project/pyproj/audio2text`; start that FastAPI service before recording. Configure the service base URL, for example `http://127.0.0.1:8000`. Saved legacy `/ws/transcribe` URLs are automatically converted to the same server's HTTP base URL.
- LLM summary/minutes/title features require a reachable OpenAI-compatible endpoint
- The LLM connection test sends a short `/chat/completions` request to the configured model. A successful model listing alone cannot pass the test. HTTP errors retain the response status and request ID when exposed by the gateway; a short probe does not guarantee that a longer meeting summary will succeed.
- Windows distribution now uses `electron-builder`

## Audio2Text Meeting Protocol

- Connection test: `GET /api/meetings`, without creating a test meeting.
- Start: `POST /api/meetings` with the meeting title and optional language, then connect to `/ws/meetings/{id}`. Wait for `ready`, send `start` with `mime_type`, and wait for the matching `state` before recording.
- Audio remains binary MediaRecorder data (prefer WebM/Opus); the backend converts it to WAV. The default upload interval is 1 second; saved 2-second configurations migrate to 1 second when loaded or saved.
- Pause: pause capture, flush buffered audio, send `pause`, and wait for confirmation. Resume waits for the `resume` confirmation before capturing again.
- End: flush the last audio and send `end`. Completion depends on the `state` event with `action: "end"`; failed recognition can be retried. A disconnected meeting can be ended through `POST /api/meetings/{id}/end`.
- `transcript.text` replaces the full transcript, including corrections to earlier words. No `is_final` or `archived` events are required. `no_speech` preserves existing text and allows empty meetings to end normally.
- The desktop saves the backend meeting ID with its local session. During an active meeting, connection loss releases the microphone; click Continue to reconnect to the same meeting. Desktop history and generated summaries remain stored locally.

## Protocol Regression Checks

```bash
npm run test:protocol
```

Requires the Audio2Text checkout with its `.venv`, FFmpeg and a Playwright Chromium installation (`npx playwright install chromium`). Set `AUDIO2TEXT_DIR` for a different backend checkout; optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable.

The tests start the current backend in a temporary directory, exercise its real HTTP/WebSocket routes and storage, and replace ASR with deterministic responses. A browser test uses a simulated microphone with real MediaRecorder encoding and backend WAV conversion. It verifies the desktop start/pause/resume/end flow and checks that the saved transcript matches the backend. It does not measure real model accuracy or latency.
