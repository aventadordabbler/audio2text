"""Real Audio2Text routes/store with a deterministic PCM streaming recognizer."""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["AUDIO2TEXT_DIR"])
from app.asr import ASRError
from app.config import Settings
from app.main import create_app
from app.recordings import PCMNormalizer
import uvicorn


class TestStream:
    def __init__(self):
        self.output = asyncio.Queue()
        self.segment = 0
        self.pending = ""
        self.position_ms = 0

    async def start(self, language, sample_rate):
        self.sample_rate = sample_rate

    async def emit(self, kind, text, start_ms=0, end_ms=0):
        await self.output.put({"type": kind, "segment_id": self.segment, "text": text,
                               "start_ms": start_ms, "end_ms": end_ms})
        if kind == "final":
            self.segment += 1

    async def send_audio(self, audio):
        if not audio or len(audio) % 2 or len(audio) > self.sample_rate * 2:
            raise ASRError("音频帧格式不正确，请使用单声道 PCM16 录音。")
        start_ms = self.position_ms
        if audio.startswith(b"TEST"):
            text = audio[4:].rstrip(b"\0").decode("utf-8")
            if text == "fatal":
                raise ASRError("测试识别连接中断")
            if text.startswith("partial:"):
                self.pending = text[8:]
                await self.emit("partial", self.pending, start_ms, self.position_ms)
                return
            text = text.removeprefix("final:")
        else:
            self.position_ms += len(audio) // 2 * 1000 / self.sample_rate
            text = f"浏览器 PCM16 录音已识别，共 {len(audio) // 2} 个采样。"
            await self.emit("partial", "正在识别浏览器录音", start_ms, self.position_ms)
        self.pending = ""
        await self.emit("final", text, start_ms, self.position_ms)

    async def flush(self):
        if self.pending:
            await self.emit("final", self.pending)
            self.pending = ""
        future = asyncio.get_running_loop().create_future()
        await self.output.put(future)
        await future

    async def events(self):
        while True:
            event = await self.output.get()
            if isinstance(event, asyncio.Future):
                event.set_result(None)
            else:
                yield event

    def diagnostics(self):
        return {
            "mode": "transcription", "flow_level": "normal",
            "pending_seconds": 0, "max_pending_seconds": 10,
            "request_count": 1, "last_request_ms": 1,
            "average_request_ms": 1, "max_request_ms": 1,
        }

    async def close(self):
        pass


class TestMinutesGenerator:
    def __init__(self):
        self.calls = 0

    async def generate(self, title, transcript):
        self.calls += 1
        await asyncio.sleep(0.1)
        return f"# {title}\n\n## 核心结论\n\n{transcript}\n\n| 待办事项 | 负责人 |\n| --- | --- |\n| 确认下一步安排 | 项目组 |"


class TestStageSummaryGenerator:
    async def generate(self, title, transcript, start_seconds, end_seconds):
        return f"阶段总结 {start_seconds:g}-{end_seconds:g} 秒：{transcript}"


class TestRecordedStream(TestStream):
    """Use the real archive for desktop WAV download checks, with fixture ASR."""

    def bind_recording(self, archive, next_segment, notify=None):
        self.archive = archive
        self.segment = next_segment
        self.position_ms = archive.samples / 16

    async def start(self, language, sample_rate):
        await super().start(language, sample_rate)
        self.normalizer = PCMNormalizer(sample_rate)

    async def send_audio(self, audio):
        if audio and len(audio) % 2 == 0 and not audio.startswith(b"TEST"):
            self.archive.append(self.normalizer.feed(audio))
        await super().send_audio(audio)
        return self.archive.samples

    async def flush(self):
        self.archive.append(self.normalizer.flush())
        await super().flush()


settings = Settings(_env_file=None, data_dir=Path(os.environ["DATA_DIR"]))
generator = TestMinutesGenerator()


class TestWorker:
    def readiness(self):
        return None

    async def request(self, payload):
        raise AssertionError("This fixture has no archived audio; no model should load")

    async def close(self):
        pass


controlled = os.environ.get("DESKTOP_TEST_DIARIZATION") == "1"
archive_audio = os.environ.get("DESKTOP_TEST_ARCHIVE") == "1"


class TestUnavailableWorker(TestWorker):
    def readiness(self):
        return "桌面录音测试不加载说话人模型"


app = create_app(settings, TestRecordedStream if archive_audio else TestStream, generator,
                 TestWorker if controlled else TestUnavailableWorker if archive_audio else None,
                 TestStageSummaryGenerator())
if controlled:
    # Only this localhost test process exposes controls. Real routes, durable
    # revisions, job scheduling and minutes generation still run unchanged.
    from fastapi import APIRouter
    from app.diarization.worker import WorkerError
    controls = {}
    store, events = app.state.meeting_store, app.state.meeting_events
    router = APIRouter()

    @router.post("/__test/meetings/{meeting_id}/{action}")
    async def control(meeting_id: str, action: str, payload: dict):
        if action == "configure":
            gate = asyncio.Event()
            if not payload.get("hold"):
                gate.set()
            controls[meeting_id] = {**payload, "gate": gate}
        elif action == "release":
            controls[meeting_id]["gate"].set()
        elif action == "revise":
            event = store.transcript(meeting_id).update(
                segments=payload.get("segments", []), remove=payload.get("remove", []),
                speakers=payload.get("speakers", {}), processing=payload.get("processing"))
            if payload.get("publish", True):
                events.publish(meeting_id, event)
        return {"minutes_calls": generator.calls, "meeting": store.get(meeting_id)}

    async def correct(meeting_id):
        state = controls.get(meeting_id, {})
        if state.get("gate"):
            await state["gate"].wait()
        if state.get("fail"):
            raise WorkerError("模拟校正失败，可重试")
        document = store.transcript(meeting_id).read()
        if not document["segments"]:
            return
        number = document["next_segment_id"]
        ids = [f"{meeting_id}-speaker-{n}" for n in (1, 2)]
        segments = [{"segment_id": number + i, "text": text, "start_ms": 65000 + i * 1000,
                     "end_ms": 66000 + i * 1000, "speaker_ids": [ids[i]], "speaker_status": "assigned",
                     "speaker_turns": []} for i, text in enumerate(("第一位发言。", "第二位发言。"))]
        event = store.transcript(meeting_id).update(segments=segments,
            remove=[s["segment_id"] for s in document["segments"]],
            speakers={key: {"name": f"说话人 {i + 1}"} for i, key in enumerate(ids)})
        events.publish(meeting_id, event)

    app.state.diarization_service._correct = correct
    app.router.routes[:0] = router.routes
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="critical")
