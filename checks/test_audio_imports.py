import asyncio
import hashlib
from io import BytesIO
import json
import logging
import subprocess
import threading
import wave
from zipfile import ZipFile

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


def mp3_bytes():
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
        input=wav_bytes(), capture_output=True, check=True,
    )
    return result.stdout


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

    async def generate_format_prompt(self, name, requirement):
        return f"{name}：{requirement}"

    async def generate(self, title, text):
        self.calls.append(text)
        if self.fail:
            raise MinutesGenerationError("模拟总结失败")
        return f"# {title}\n\n{text}"


class StageSummary:
    def __init__(self):
        self.calls = []

    async def generate(self, title, transcript, start_seconds, end_seconds):
        self.calls.append((title, transcript, start_seconds, end_seconds))
        return f"{start_seconds:g}-{end_seconds:g} 秒：{transcript}"


def build(tmp_path, *, decoder=None, minutes=None, stage_summary=None, **settings):
    app = create_app(
        Settings(_env_file=None, data_dir=tmp_path, database_path=tmp_path / "meetings.sqlite3", **settings),
        minutes_generator=minutes or Minutes(), diarization_worker_factory=SpeakerWorker,
        stage_summary_generator=stage_summary,
        import_decoder_factory=lambda _config: decoder or Decoder(),
    )
    app.state.model_configs.save("asr", ModelConfigInput(base_url="http://asr.invalid/v1", model="fixture"))
    return app


async def login(client):
    await client.post("/api/auth/register", json={"account": "fixture", "password": "password1",
                                                  "department": "测试部门", "employee_id": "001"})
    return await login_existing(client)


async def login_existing(client, account="fixture", password="password1"):
    response = await client.post("/api/auth/login", json={"account": account, "password": password})
    client.headers["Authorization"] = f"Bearer {response.json()['token']}"
    return response.json()["user"]


async def admin_login(client):
    response = await client.post("/api/auth/login", json={"account": "admin", "password": ""})
    assert response.status_code == 200, response.text
    client.headers["Authorization"] = f"Bearer {response.json()['token']}"
    return response.json()["user"]


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


async def stage_settled(client, meeting_id):
    async with asyncio.timeout(10):
        while True:
            rows = (await client.get(f"/api/meetings/{meeting_id}/stage-summaries")).json()
            if rows and all(row["status"] == "ready" for row in rows):
                return rows
            await asyncio.sleep(0.02)


async def test_import_transcribes_labels_summarizes_and_exports_with_audio_duration(tmp_path):
    minutes = Minutes()
    stage_summary = StageSummary()
    app = build(tmp_path, minutes=minutes, stage_summary=stage_summary, stage_summary_window_seconds=10)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        await admin_login(client)
        department = (await client.post("/api/departments", json={"name": "研发部"})).json()
        await login_existing(client)
        response = await imported(client, department_id=department["id"], language="zh")
        assert response.status_code == 202, response.text
        initial = response.json()
        assert initial["source"] == "wav" and initial["status"] == "ended"
        assert initial["duration_seconds"] == 3.25
        meeting = await settled(client, initial["id"])
        assert meeting["import_job"]["status"] == "ready", meeting
        assert meeting["department_name"] == "测试部门"
        assert meeting["processing"]["status"] == "ready"
        assert meeting["segments"][0]["speaker_status"] == "assigned"
        assert "[说话人 1]" in minutes.calls[0]
        assert len(minutes.calls) == 1
        prefix = f"/api/meetings/{meeting['id']}"
        exported = await client.get(prefix + "/download")
        assert exported.text == meeting["text"] + "\n"
        assert "# 导入会议" not in exported.text
        assert (await client.get(prefix + "/minutes")).json()["status"] == "ready"
        assert (await client.head(prefix + "/minutes/download")).status_code == 200
        docx = await client.get(prefix + "/minutes/download?format=docx")
        assert docx.status_code == 200
        assert docx.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        assert 'filename="meeting-minutes.docx"' in docx.headers["content-disposition"]
        assert "%E4%BC%9A%E8%AE%AE%E7%BA%AA%E8%A6%81.docx" in docx.headers["content-disposition"]
        with ZipFile(BytesIO(docx.content)) as archive:
            assert archive.testzip() is None
            assert "导入会议" in archive.read("word/document.xml").decode()
        docx_head = await client.head(prefix + "/minutes/download?format=docx")
        assert docx_head.status_code == 200
        assert docx_head.headers["content-length"] == str(len(docx.content))
        stage_rows = await stage_settled(client, meeting["id"])
        assert len(stage_rows) == 1
        assert stage_summary.calls
        assert stage_summary.calls[0][1].startswith("[说话人 1] ")
        stage_export = await client.get(prefix + "/stage-summaries/download")
        assert stage_export.status_code == 200
        assert "阶段总结" in stage_export.text
        assert (await client.head(prefix + "/stage-summaries/download")).headers["content-length"] == str(len(stage_export.content))
        audio = (await client.get(prefix + "/audio/download")).content
        with wave.open(BytesIO(audio)) as archive:
            assert archive.getframerate() == 16000 and archive.getnchannels() == 1
            assert archive.getnframes() / archive.getframerate() == 3.25
        assert (await client.post(prefix + "/import/retry")).status_code == 409
        assert (await client.delete(prefix)).status_code == 204


async def test_mp3_import_is_decoded_by_ffmpeg_and_processed(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/meetings/import", data={"title": "MP3 导入"},
                                     files={"file": ("讨论.mp3", mp3_bytes(), "audio/mpeg")})
        assert response.status_code == 202, response.text
        meeting = await settled(client, response.json()["id"])
        assert meeting["import_job"]["status"] == "ready", meeting
        assert 3.2 <= meeting["duration_seconds"] <= 3.5


async def test_multiple_audio_files_create_one_combined_meeting(tmp_path):
    app = build(tmp_path)
    first, second = wav_bytes(2, 16000, 1), wav_bytes(3, 16000, 1)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/meetings/import", data={"title": "多文件导入"}, files=[
            ("file", ("第一段.wav", first, "audio/wav")),
            ("file", ("第二段.wav", second, "audio/wav")),
        ])
        assert response.status_code == 202, response.text
        meeting = await settled(client, response.json()["id"])
        assert meeting["import_job"]["status"] == "ready", meeting
        assert meeting["duration_seconds"] == pytest.approx(5, abs=0.01)
        manifest = json.loads((tmp_path / "meetings" / meeting["id"] / "audio" / "manifest.json").read_text())
        assert len(manifest["captures"]) == 1
        assert len((await client.get("/api/meetings")).json()) == 1


async def test_import_guards_incomplete_results_and_recovers_after_restart(tmp_path):
    app = build(tmp_path, decoder=Decoder(gate=asyncio.Event()))
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        meeting = (await imported(client)).json()
        prefix = f"/api/meetings/{meeting['id']}"
        assert (await client.post(prefix + "/minutes")).status_code == 409
        assert (await client.post(prefix + "/diarization")).status_code == 409
        assert (await client.delete(prefix)).status_code == 409
        assert (await client.post(prefix + "/end")).status_code == 409
    restarted = build(tmp_path)
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(transport=httpx.ASGITransport(restarted), base_url="http://test") as client:
        await login(client)
        completed = await settled(client, meeting["id"])
        assert completed["import_job"]["status"] == "ready", completed
        assert len((await client.get("/api/meetings")).json()) == 1
        assert restarted.state.diarization_service.jobs.recover() == []
        assert restarted.state.stage_summaries.store.recoverable() == []


async def test_summary_retry_keeps_transcript_and_does_not_rerun_asr(tmp_path, caplog):
    caplog.set_level(logging.ERROR)
    decoder, minutes = Decoder(), Minutes(fail=True)
    app = build(tmp_path, decoder=decoder, minutes=minutes)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        meeting = (await imported(client)).json()
        failed = await settled(client, meeting["id"])
        assert failed["import_job"]["status"] == "failed"
        assert failed["import_job"]["stage"] == "summarizing"
        assert "Meeting summary generation failed" in caplog.text
        assert "Audio import failed" not in caplog.text
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
        await login(client)
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
        await login(client)
        response = await client.post("/api/meetings/import", data={"title": "无效音频"}, files={"file": (filename, content)})
        assert response.status_code == status, response.text
        assert (await client.get("/api/meetings")).json() == []
        assert not list((tmp_path / ".audio-uploads").glob("wav-*"))


async def test_department_management_is_admin_only(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        assert (await client.get("/api/departments")).status_code == 403
        assert (await client.post("/api/departments", json={"name": "普通用户不应创建"})).status_code == 403

        regular_token = client.headers["Authorization"]
        await admin_login(client)
        created = await client.post("/api/departments", json={"name": "管理员部门"})
        assert created.status_code == 201, created.text
        department_id = created.json()["id"]
        assert (await client.get("/api/departments")).status_code == 200
        assert (await client.put(f"/api/departments/{department_id}", json={"name": "管理员部门二"})).status_code == 200
        assert (await client.delete(f"/api/departments/{department_id}")).status_code == 204

        client.headers["Authorization"] = regular_token
        assert (await client.put(f"/api/departments/{department_id}", json={"name": "越权修改"})).status_code == 403
        assert (await client.delete(f"/api/departments/{department_id}")).status_code == 403


async def test_admin_can_view_all_users_meetings(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        fixture_meeting = await client.post("/api/meetings", json={"title": "Fixture meeting"})
        assert fixture_meeting.status_code == 201

        await client.post("/api/auth/register", json={
            "account": "second-user", "password": "password1",
            "department": "第二部门", "employee_id": "002",
        })
        await login_existing(client, "second-user")
        second_meeting = await client.post("/api/meetings", json={"title": "Second meeting"})
        assert second_meeting.status_code == 201
        assert len((await client.get("/api/meetings")).json()) == 1

        await admin_login(client)
        meetings = await client.get("/api/meetings")
        assert {item["title"] for item in meetings.json()} == {"Fixture meeting", "Second meeting"}
        assert (await client.get(f"/api/meetings/{fixture_meeting.json()['id']}")).status_code == 200
        assert (await client.get(f"/api/meetings/{second_meeting.json()['id']}")).status_code == 200


async def test_admin_can_generate_minutes_format_prompt(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        denied = await client.post("/api/minutes-formats/generate", json={
            "name": "项目评审会", "requirement": "包含结论和待办",
        })
        assert denied.status_code == 403

        await admin_login(client)
        response = await client.post("/api/minutes-formats/generate", json={
            "name": "项目评审会", "requirement": "包含结论和待办",
        })
        assert response.status_code == 200
        assert response.json() == {"prompt": "项目评审会：包含结论和待办"}


async def test_decoded_duration_limit_and_department_bound_to_user(tmp_path):
    app = build(tmp_path, audio_import_max_seconds=1)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        user = await login(client)
        assert (await imported(client)).status_code == 413
        async with asyncio.timeout(5):
            oversized = await client.post("/api/meetings/import", data={"title": "长音频"},
                                          files={"file": ("long.wav", wav_bytes(24, 16000, 1))})
        assert oversized.status_code == 413
        app.state.audio_import_service.settings.audio_import_max_seconds = 10
        meeting = (await imported(client, department_id="0" * 32)).json()
        assert meeting["department_id"] == user["department_id"]
        assert len((await client.get("/api/meetings")).json()) == 1


async def test_truncated_wav_data_is_rejected_without_creating_a_meeting(tmp_path):
    app = build(tmp_path)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/meetings/import", data={"title": "截断文件"},
                                     files={"file": ("truncated.wav", wav_bytes()[:-1024])})
        assert response.status_code == 422, response.text
        assert (await client.get("/api/meetings")).json() == []


async def test_chunked_import_checks_integrity_and_reassembles_in_order(tmp_path):
    app = build(tmp_path)
    content = wav_bytes(35, 16000, 1)
    chunk_size = 1024 * 1024
    chunks = [content[start:start + chunk_size] for start in range(0, len(content), chunk_size)]
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        started = await client.post("/api/meetings/import/chunked", json={
            "title": "分片导入", "filename": "chunked.wav", "file_size": len(content),
            "total_chunks": len(chunks), "chunk_size": chunk_size,
        })
        assert started.status_code == 200, started.text
        upload_id = started.json()["upload_id"]
        wrong = await client.put(f"/api/meetings/import/chunked/{upload_id}/0", content=chunks[0],
                                 headers={"X-Chunk-SHA256": "0" * 64})
        assert wrong.status_code == 422, wrong.text
        assert (await client.post(f"/api/meetings/import/chunked/{upload_id}/complete")).status_code == 409
        for index, chunk in enumerate(chunks):
            digest = hashlib.sha256(chunk).hexdigest()
            response = await client.put(f"/api/meetings/import/chunked/{upload_id}/{index}", content=chunk,
                                         headers={"X-Chunk-SHA256": digest})
            assert response.status_code == 200, response.text
        duplicate = await client.put(f"/api/meetings/import/chunked/{upload_id}/0", content=chunks[0],
                                     headers={"X-Chunk-SHA256": hashlib.sha256(chunks[0]).hexdigest()})
        assert duplicate.status_code == 200
        completed = await client.post(f"/api/meetings/import/chunked/{upload_id}/complete")
        assert completed.status_code == 202, completed.text
        meeting = await settled(client, completed.json()["id"])
        assert meeting["title"] == "分片导入"
        assert meeting["import_job"]["status"] == "ready"
        assert not list((tmp_path / ".audio-uploads").glob("chunked-*"))


async def test_chunked_mp3_import_uses_the_same_decode_pipeline(tmp_path):
    app = build(tmp_path)
    content = mp3_bytes()
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        started = await client.post("/api/meetings/import/chunked", json={
            "title": "分片 MP3", "filename": "chunked.mp3", "file_size": len(content),
            "total_chunks": 1, "chunk_size": 1024 * 1024,
        })
        upload_id = started.json()["upload_id"]
        response = await client.put(f"/api/meetings/import/chunked/{upload_id}/0", content=content,
                                     headers={"X-Chunk-SHA256": hashlib.sha256(content).hexdigest()})
        assert response.status_code == 200, response.text
        completed = await client.post(f"/api/meetings/import/chunked/{upload_id}/complete")
        assert completed.status_code == 202, completed.text
        meeting = await settled(client, completed.json()["id"])
        assert meeting["import_job"]["status"] == "ready", meeting


async def test_chunked_multiple_audio_files_create_one_combined_meeting(tmp_path):
    app = build(tmp_path)
    contents = [wav_bytes(2, 16000, 1), wav_bytes(3, 16000, 1)]
    chunk_size = 1024 * 1024
    files = [{"filename": f"part-{index}.wav", "file_size": len(content),
              "total_chunks": (len(content) + chunk_size - 1) // chunk_size,
              "chunk_size": chunk_size} for index, content in enumerate(contents)]
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        started = await client.post("/api/meetings/import/chunked", json={"title": "分片多文件", "files": files})
        assert started.status_code == 200, started.text
        upload_id = started.json()["upload_id"]
        for file_index, content in enumerate(contents):
            response = await client.put(
                f"/api/meetings/import/chunked/{upload_id}/file/{file_index}/0", content=content,
                headers={"X-Chunk-SHA256": hashlib.sha256(content).hexdigest()},
            )
            assert response.status_code == 200, response.text
        completed = await client.post(f"/api/meetings/import/chunked/{upload_id}/complete")
        assert completed.status_code == 202, completed.text
        meeting = await settled(client, completed.json()["id"])
        assert meeting["import_job"]["status"] == "ready", meeting
        assert meeting["duration_seconds"] == pytest.approx(5, abs=0.01)
        assert len((await client.get("/api/meetings")).json()) == 1


async def test_missing_speaker_models_preserves_transcription_and_summary(tmp_path):
    stage_summary = StageSummary()
    app = build(tmp_path, stage_summary=stage_summary, stage_summary_window_seconds=10)
    app.state.diarization_service.workers[0].readiness = lambda: "缺少本地说话人模型"
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
        meeting = await settled(client, (await imported(client)).json()["id"])
        assert meeting["import_job"]["status"] == "ready"
        assert meeting["processing"]["status"] == "unavailable"
        assert meeting["text"]
        assert (await client.get(f"/api/meetings/{meeting['id']}/minutes")).json()["status"] == "ready"
        assert stage_summary.calls == []
        assert (await client.get(f"/api/meetings/{meeting['id']}/stage-summaries")).json() == []


async def test_silence_retains_audio_duration_without_hallucinating_minutes(tmp_path):
    app = build(tmp_path)
    silence = bytearray(wav_bytes())
    silence[44:] = bytes(len(silence) - 44)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        await login(client)
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
        await login(client)
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
        user = await login(client)
        task = asyncio.create_task(app.state.audio_import_service.create(upload, "上传取消", None, None, user["id"]))
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
