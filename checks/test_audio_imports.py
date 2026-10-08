import asyncio
from io import BytesIO
import threading
import wave

import httpx
import numpy as np
import pytest
from starlette.datastructures import UploadFile

from app.config import Settings
from app.main import create_app
from app.minutes import MinutesGenerationError
from app.model_configs import ModelConfigInput


def wav_bytes(seconds=3.25, rate=44100, channels=2):
    samples = (np.sin(np.arange(round(seconds * rate)) * 440 * 2 * np.pi / rate) * 12000).astype("<i2")
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(np.repeat(samples[:, None], channels, axis=1).tobytes())
    return output.getvalue()


class Decoder:
    def __init__(self, gate=None, fail_second=False):
        self.gate, self.fail_second = gate, fail_second
        self.states = 0
        self.samples = 0

    async def prepare(self):
        if self.gate:
            await self.gate.wait()

    def new_state(self, *_args):
        self.states += 1
        return self.states

    async def feed(self, audio, state):
        self.samples += len(audio)
        if state == 2 and self.fail_second:
            raise RuntimeError("fixture failure")
        return "讨论了项目进度和下一步安排。"

    async def finish(self, _state):
        return "讨论了项目进度和下一步安排。"

    async def close(self):
        pass


class SpeakerWorker:
    def readiness(self):
        return None

    async def request(self, request):
        if request["type"] == "cluster":
            return {"centroids": [[1.0, 0.0]]}
        start, end = request["start"], request["end"]
        return {"model_tag": "fixture", "start": start, "end": end,
                "speakers": [{"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": (end - start) / 16,
                              "fresh_ms": (end - request["fresh_from"]) / 16}],
                "turns": [{"start_ms": start / 16, "end_ms": end / 16, "local_ids": [0]}]}

    async def close(self):
        pass


class Minutes:
    def __init__(self, fail=False):
        self.fail, self.calls = fail, []

    async def generate(self, title, text):
        self.calls.append(text)
        if self.fail:
            raise MinutesGenerationError("模拟总结失败")
        return f"# {title}\n\n{text}"


def build(tmp_path, *, decoder=None, minutes=None, **settings):
    app = create_app(
        Settings(_env_file=None, data_dir=tmp_path, database_path=tmp_path / "meetings.sqlite3", **settings),
        minutes_generator=minutes or Minutes(), diarization_worker_factory=SpeakerWorker,
        import_decoder_factory=lambda _config: decoder or Decoder(),
    )
    app.state.model_configs.save("asr", ModelConfigInput(base_url="http://asr.invalid/v1", model="fixture"))
    return app


async def imported(client, **kwargs):
    return await client.post("/api/meetings/import", data={"title": "导入会议", **kwargs},
                             files={"file": ("讨论.WAV", wav_bytes(), "audio/wav")})


async def settled(client, meeting_id):
    async with asyncio.timeout(10):
        while True:
            meeting = (await client.get(f"/api/meetings/{meeting_id}")).json()
            if meeting["import_job"]["status"] in {"ready", "failed"}:
                return meeting
            await asyncio.sleep(0.02)


async def test_import_transcribes_labels_summarizes_and_exports_with_audio_duration(tmp_path):
    minutes = Minutes()
    app = build(tmp_path, minutes=minutes)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        department = (await client.post("/api/departments", json={"name": "研发部"})).json()
        response = await imported(client, department_id=department["id"], language="zh")
        assert response.status_code == 202, response.text
        initial = response.json()
        assert initial["source"] == "wav" and initial["status"] == "ended"
        assert initial["duration_seconds"] == 3.25
        meeting = await settled(client, initial["id"])
        assert meeting["import_job"]["status"] == "ready", meeting
        assert meeting["department_name"] == "研发部"
        assert meeting["processing"]["status"] == "ready"
        assert meeting["segments"][0]["speaker_status"] == "assigned"
        assert "[说话人 1]" in minutes.calls[0]
        assert len(minutes.calls) == 1
        prefix = f"/api/meetings/{meeting['id']}"
        assert (await client.get(prefix + "/download")).text == meeting["text"] + "\n"
        assert (await client.get(prefix + "/minutes")).json()["status"] == "ready"
        audio = (await client.get(prefix + "/audio/download")).content
        with wave.open(BytesIO(audio)) as archive:
            assert archive.getframerate() == 16000 and archive.getnchannels() == 1
            assert archive.getnframes() / archive.getframerate() == 3.25
        assert (await client.post(prefix + "/import/retry")).status_code == 409
        assert (await client.delete(prefix)).status_code == 204


async def test_import_guards_incomplete_results_and_recovers_after_restart(tmp_path):
    app = build(tmp_path, decoder=Decoder(gate=asyncio.Event()))
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        meeting = (await imported(client)).json()
        prefix = f"/api/meetings/{meeting['id']}"
        assert (await client.post(prefix + "/minutes")).status_code == 409
        assert (await client.post(prefix + "/diarization")).status_code == 409
        assert (await client.delete(prefix)).status_code == 409
        assert (await client.post(prefix + "/end")).status_code == 409
    restarted = build(tmp_path)
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(transport=httpx.ASGITransport(restarted), base_url="http://test") as client:
        completed = await settled(client, meeting["id"])
        assert completed["import_job"]["status"] == "ready", completed
        assert len((await client.get("/api/meetings")).json()) == 1
        assert restarted.state.diarization_service.jobs.recover() == []
        assert restarted.state.stage_summaries.store.recoverable() == []


async def test_summary_retry_keeps_transcript_and_does_not_rerun_asr(tmp_path):
    decoder, minutes = Decoder(), Minutes(fail=True)
    app = build(tmp_path, decoder=decoder, minutes=minutes)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        meeting = (await imported(client)).json()
        failed = await settled(client, meeting["id"])
        assert failed["import_job"]["status"] == "failed"
        assert failed["import_job"]["stage"] == "summarizing"
        samples = decoder.samples
        minutes.fail = False
        assert (await client.post(f"/api/meetings/{meeting['id']}/import/retry")).status_code == 202
        completed = await settled(client, meeting["id"])
        assert completed["import_job"]["status"] == "ready"
        assert completed["segments"] == failed["segments"]
        assert decoder.samples == samples


async def test_asr_retry_resumes_after_last_saved_segment(tmp_path):
    decoder = Decoder(fail_second=True)
    app = build(tmp_path, decoder=decoder)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/api/meetings/import", data={"title": "长音频"},
                                     files={"file": ("long.wav", wav_bytes(24, 16000, 1), "audio/wav")})
        meeting = await settled(client, response.json()["id"])
        assert meeting["import_job"]["status"] == "failed"
        assert len(meeting["segments"]) == 1
        decoder.fail_second = False
        before = decoder.samples
        await client.post(f"/api/meetings/{meeting['id']}/import/retry")
        completed = await settled(client, meeting["id"])
        assert completed["import_job"]["status"] == "ready", completed
        assert len(completed["segments"]) == 2
        assert decoder.samples - before <= 4 * 16000
        assert completed["segments"][0]["text"] == meeting["segments"][0]["text"]


@pytest.mark.parametrize("filename,content,status", [
    ("bad.mp3", b"not WAV", 422), ("bad.wav", b"not WAV", 422),
    ("bad.wav", b"RIFF" + b"\0" * 4 + b"WAVE", 422), ("large.wav", b"x" * 1025, 413),
])
async def test_invalid_import_creates_no_meeting(tmp_path, filename, content, status):
    app = build(tmp_path, audio_import_max_bytes=1024)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/api/meetings/import", data={"title": "无效音频"}, files={"file": (filename, content)})
        assert response.status_code == status, response.text
        assert (await client.get("/api/meetings")).json() == []
        assert not list((tmp_path / ".audio-uploads").glob("wav-*"))


async def test_decoded_duration_limit_and_invalid_department_leave_no_meeting(tmp_path):
    app = build(tmp_path, audio_import_max_seconds=1)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        assert (await imported(client)).status_code == 413
        async with asyncio.timeout(5):
            oversized = await client.post("/api/meetings/import", data={"title": "长音频"},
                                          files={"file": ("long.wav", wav_bytes(24, 16000, 1))})
        assert oversized.status_code == 413
        app.state.audio_import_service.settings.audio_import_max_seconds = 10
        assert (await imported(client, department_id="0" * 32)).status_code == 422
        assert (await client.get("/api/meetings")).json() == []
        assert not list((tmp_path / ".audio-uploads").glob("wav-*"))


async def test_truncated_wav_data_is_rejected_without_creating_a_meeting(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/api/meetings/import", data={"title": "截断文件"},
                                     files={"file": ("truncated.wav", wav_bytes()[:-1024])})
        assert response.status_code == 422, response.text
        assert (await client.get("/api/meetings")).json() == []


async def test_missing_speaker_models_preserves_transcription_and_summary(tmp_path):
    app = build(tmp_path)
    app.state.diarization_service.workers[0].readiness = lambda: "缺少本地说话人模型"
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        meeting = await settled(client, (await imported(client)).json()["id"])
        assert meeting["import_job"]["status"] == "ready"
        assert meeting["processing"]["status"] == "unavailable"
        assert meeting["text"]
        assert (await client.get(f"/api/meetings/{meeting['id']}/minutes")).json()["status"] == "ready"


async def test_silence_retains_audio_duration_without_hallucinating_minutes(tmp_path):
    app = build(tmp_path)
    silence = bytearray(wav_bytes())
    silence[44:] = bytes(len(silence) - 44)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/api/meetings/import", data={"title": "静音"},
                                     files={"file": ("silence.wav", bytes(silence))})
        assert response.status_code == 202, response.text
        meeting = await settled(client, response.json()["id"])
        assert meeting["duration_seconds"] == 3.25
        assert not meeting["text"]
        assert meeting["import_job"]["status"] == "failed"
        assert "未识别到有效讲话" in meeting["import_job"]["error"]
        assert (await client.get(f"/api/meetings/{meeting['id']}/minutes")).json()["status"] == "not_started"


async def test_import_queue_does_not_change_recording_lifecycle(tmp_path):
    gate = asyncio.Event()
    app = build(tmp_path, decoder=Decoder(gate=gate))
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        first = (await imported(client)).json()
        second = (await imported(client)).json()
        assert (await client.get(f"/api/meetings/{second['id']}")).json()["import_job"]["status"] == "queued"
        live = (await client.post("/api/meetings", json={"title": "实时录音"})).json()
        assert live["source"] == "recording" and live["import_job"] is None and live["status"] == "created"
        ended = (await client.post(f"/api/meetings/{live['id']}/end")).json()
        assert ended["status"] == "ended" and ended["duration_seconds"] == 0
        assert (await client.get(f"/api/meetings/{first['id']}")).json()["import_job"]["status"] == "running"
        gate.set()
        assert (await settled(client, first["id"]))["import_job"]["status"] == "ready"
        assert (await settled(client, second["id"]))["import_job"]["status"] == "ready"


async def test_client_cancellation_during_publication_still_schedules_meeting(tmp_path):
    app = build(tmp_path)
    store = app.state.meeting_store
    create = store.create
    entered, release = threading.Event(), threading.Event()

    def delayed_create(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return create(*args, **kwargs)

    store.create = delayed_create
    upload = UploadFile(BytesIO(wav_bytes()), filename="meeting.wav")
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        task = asyncio.create_task(app.state.audio_import_service.create(upload, "上传取消", None, None))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            task.cancel()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            meetings = (await client.get("/api/meetings")).json()
            assert len(meetings) == 1
            assert (await settled(client, meetings[0]["id"]))["import_job"]["status"] == "ready"
        finally:
            release.set()
            await upload.close()
