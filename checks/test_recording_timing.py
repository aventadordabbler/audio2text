import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from app.asr import StreamingTranscriber
from app.audio import SpeechSession, StreamOptions
from app.meetings import MeetingError, MeetingStore
from app.model_configs import ModelConfig
from app.qwen_streaming import RemoteDecoder
from app.recordings import AudioArchive


def test_meeting_duration_uses_archived_audio_samples(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("sample clock")
    archive = AudioArchive(store.directory(meeting["id"]))
    archive.begin()
    archive.append(np.zeros(32000, dtype=np.float32))
    archive.end()

    assert store.get(meeting["id"])["duration_seconds"] == 2.0


def test_meeting_delete_only_allows_unstarted_or_ended(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    created = store.create("unstarted")
    store.delete(created["id"])
    assert store.get(created["id"]) is None

    paused = store.create("paused")
    store.transition(paused["id"], "start")
    store.transition(paused["id"], "pause")
    with pytest.raises(MeetingError, match="只能删除未开始或已结束的会议"):
        store.delete(paused["id"])

    ended = store.create("ended")
    store.transition(ended["id"], "end")
    store.delete(ended["id"])
    assert store.get(ended["id"]) is None


class FakeTranscriptions:
    async def create(self, **_kwargs):
        return SimpleNamespace(text="transcribed")


class FakeOpenAI:
    def __init__(self):
        self.audio = SimpleNamespace(transcriptions=FakeTranscriptions())

    async def close(self):
        pass


async def test_decoder_diagnostics_summarize_request_latency():
    decoder = RemoteDecoder(
        ModelConfig("http://asr.invalid", "test", "", 10, "transcription"),
        client=FakeOpenAI(),
    )
    state = decoder.new_state("Chinese", 0.5)
    await decoder.feed(np.zeros(32000, dtype=np.float32), state)
    await decoder.finish(state)

    assert state.last_window == {
        "window_id": "0:2000",
        "start_ms": 0,
        "end_ms": 2000,
    }

    diagnostics = decoder.diagnostics()

    assert diagnostics["request_count"] == 1
    assert diagnostics["last_request_ms"] >= 0
    assert diagnostics["average_request_ms"] >= 0
    assert diagnostics["max_request_ms"] >= diagnostics["last_request_ms"]


class WindowMetadataEngine:
    def new_state(self, _language, _chunk_seconds):
        return SimpleNamespace(last_window=None, calls=0)

    async def feed(self, audio, state):
        state.calls += 1
        state.last_window = {
            "window_id": f"window-{state.calls}",
            "start_ms": (state.calls - 1) * 500,
            "end_ms": state.calls * 500,
        }
        return f"partial-{state.calls}"

    async def finish(self, _state):
        return "final"


def test_partial_events_keep_decoder_window_metadata_until_final():
    session = SpeechSession(
        WindowMetadataEngine(), "zh",
        options=StreamOptions(chunk_seconds=0.5, end_silence_ms=600),
    )

    async def run():
        events = await session.feed_samples(np.full(16000, 0.2, dtype=np.float32))
        events.extend(await session.flush())
        return events

    events = asyncio.run(run())
    partials = [event for event in events if event["type"] == "partial"]
    assert [(event["window_id"], event["start_ms"], event["end_ms"]) for event in partials] == [
        ("window-1", 0, 500),
        ("window-2", 500, 1000),
    ]
    assert events[-1]["type"] == "final"


class SlowDecoder:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def prepare(self):
        pass

    def new_state(self, _language, _chunk_seconds):
        return object()

    async def feed(self, _audio, _state):
        self.entered.set()
        await self.release.wait()
        return ""

    async def finish(self, _state):
        return ""

    def diagnostics(self):
        return {
            "request_count": 1,
            "last_request_ms": 2500.0,
            "average_request_ms": 2500.0,
            "max_request_ms": 2500.0,
        }

    async def close(self):
        pass


async def test_stream_diagnostics_combine_backlog_and_request_latency(tmp_path):
    decoder = SlowDecoder()
    archive = AudioArchive(tmp_path)
    archive.begin()
    stream = StreamingTranscriber(
        ModelConfig("http://asr.invalid", "slow", "", 10, "transcription"),
        decoder=decoder,
    )
    stream.bind_recording(archive, 0)
    await stream.start("Chinese", 16000)
    frame = b"\xff\x7f" * 16000
    try:
        assert await stream.send_audio(frame) == 16000
        await decoder.entered.wait()
        for _ in range(5):
            await stream.send_audio(frame)
        assert archive.samples == 96000
        assert stream.flow_status()["level"] == "lagging"

        assert stream.diagnostics() == {
            "mode": "transcription",
            "flow_level": "lagging",
            "pending_seconds": 6.0,
            "max_pending_seconds": 10.0,
            "request_count": 1,
            "last_request_ms": 2500.0,
            "average_request_ms": 2500.0,
            "max_request_ms": 2500.0,
        }
    finally:
        decoder.release.set()
        await stream.close()
        archive.end()
