from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class StubTranscriber:
    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        return f"片段 {len(audio)} bytes"


class FailingTranscriber:
    async def transcribe(self, audio: bytes, mime_type: str, language: str | None = None) -> str:
        raise RuntimeError("provider failure")


def make_client(tmp_path: Path) -> TestClient:
    settings = Settings(asr_mode="mock", data_dir=tmp_path / "archives")
    return TestClient(create_app(settings=settings, transcriber=StubTranscriber()))


def test_health_and_empty_archives(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        assert client.get("/health").json() == {"status": "ok", "asr_mode": "mock"}
        assert client.get("/api/archives").json() == []


def test_websocket_transcribes_and_archives(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        with client.websocket_connect("/ws/transcribe") as websocket:
            websocket.send_json({"type": "start", "title": "测试会议", "language": "Chinese", "mime_type": "audio/webm"})
            assert websocket.receive_json()["type"] == "ready"
            websocket.send_bytes(b"audio")
            assert websocket.receive_json()["text"] == "片段 5 bytes"
            websocket.send_json({"type": "stop", "title": "测试会议", "language": "Chinese"})
            final_transcript = websocket.receive_json()
            assert final_transcript["is_final"] is True
            archive = websocket.receive_json()["archive"]
        assert archive["title"] == "测试会议"
        assert client.get(f"/api/archives/{archive['id']}").json()["text"] == "片段 5 bytes"
        assert client.get(f"/api/archives/{archive['id']}/download").text.strip() == "片段 5 bytes"


def test_static_frontend_is_served(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "实时音频转写" in response.text


def test_failed_final_transcription_does_not_archive(tmp_path: Path) -> None:
    settings = Settings(asr_mode="mock", data_dir=tmp_path / "archives")
    with TestClient(create_app(settings=settings, transcriber=FailingTranscriber())) as client:
        with client.websocket_connect("/ws/transcribe") as websocket:
            websocket.send_json({"type": "start"})
            assert websocket.receive_json()["type"] == "ready"
            websocket.send_bytes(b"audio")
            assert websocket.receive_json()["type"] == "error"
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "error"
        assert client.get("/api/archives").json() == []


def test_archive_ids_cannot_escape_archive_directory(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        assert client.get("/api/archives/../outside").status_code in {404, 307}
