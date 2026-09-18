import asyncio

import numpy as np
import pytest

from app.config import Settings
from app.meetings import MeetingError, MeetingStore
from app.minutes import SYSTEM_PROMPT
from app.recordings import AudioArchive
from app.stage_summaries import STAGE_PROMPT, StageSummaryService


def test_stage_prompt_requests_a_plain_conversation_summary():
    assert "总结概括" in STAGE_PROMPT
    assert "固定栏目" in STAGE_PROMPT
    assert "按照用户指定的方式" in SYSTEM_PROMPT
    for section in ("本阶段主题与进展", "已明确的结论或决策", "待办、风险"):
        assert section not in STAGE_PROMPT


async def until(check, timeout=2):
    async with asyncio.timeout(timeout):
        while not await check():
            await asyncio.sleep(0.01)


class RecordingGenerator:
    def __init__(self):
        self.calls = []

    async def generate(self, title, transcript, start_seconds, end_seconds):
        self.calls.append((title, transcript, start_seconds, end_seconds))
        return f"{start_seconds:g}-{end_seconds:g} 秒：{transcript}"


class RecoveringGenerator(RecordingGenerator):
    def __init__(self):
        super().__init__()
        self.available = False

    async def generate(self, title, transcript, start_seconds, end_seconds):
        if not self.available:
            raise MeetingError("尚未配置大语言模型", 503)
        return await super().generate(title, transcript, start_seconds, end_seconds)


class BlockingGenerator:
    def __init__(self):
        self.entered = asyncio.Event()

    async def generate(self, *_args):
        self.entered.set()
        await asyncio.Event().wait()


class GateGenerator(RecordingGenerator):
    def __init__(self):
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def generate(self, *args):
        self.entered.set()
        await self.release.wait()
        return await super().generate(*args)


async def test_fixed_windows_generate_in_background_and_persist(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("阶段总结会议")
    transcript = store.transcript(meeting["id"])
    transcript.final(0, "第一阶段内容。", 1000, 2000, "capture")
    transcript.final(1, "尾段内容。", 11000, 12000, "capture")
    generator = RecordingGenerator()
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    service = StageSummaryService(store, None, settings, generator)
    await service.start()
    try:
        assert service.offer(meeting["id"], 16000 * 10) is None

        async def first_ready():
            return len(await service.list(meeting["id"])) == 1

        await until(first_ready)
        await service.finish(meeting["id"], 16000 * 12)

        async def all_ready():
            rows = await service.list(meeting["id"])
            return len(rows) == 2 and all(row["status"] == "ready" for row in rows)

        await until(all_ready)

        assert generator.calls == [
            ("阶段总结会议", "第一阶段内容。", 0, 10),
            ("阶段总结会议", "尾段内容。", 10, 12),
        ]
        rows = await service.list(meeting["id"])
        assert [(row["start_seconds"], row["end_seconds"]) for row in rows] == [
            (0, 10),
            (10, 12),
        ]
        assert [row["text"] for row in rows] == [
            "0-10 秒：第一阶段内容。",
            "10-12 秒：尾段内容。",
        ]
    finally:
        await service.close()


async def test_generating_window_recovers_after_service_restart(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("重启恢复")
    store.transcript(meeting["id"]).final(0, "重启后仍需总结。", 0, 1000, "capture")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    blocked = BlockingGenerator()
    first = StageSummaryService(store, None, settings, blocked)
    await first.start()
    await first.finish(meeting["id"], 16000)
    await asyncio.wait_for(blocked.entered.wait(), 2)
    await first.close()

    second = StageSummaryService(store, None, settings, RecordingGenerator())
    await second.start()
    try:
        async def recovered():
            rows = await second.list(meeting["id"])
            return bool(rows and rows[0]["status"] == "ready")

        await until(recovered)
        assert (await second.list(meeting["id"]))[0]["text"] == "0-1 秒：重启后仍需总结。"
    finally:
        await second.close()


async def test_failed_window_can_be_retried_after_model_configuration(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("重试阶段总结")
    store.transcript(meeting["id"]).final(0, "需要恢复的内容。", 0, 1000, "capture")
    generator = RecoveringGenerator()
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    service = StageSummaryService(store, None, settings, generator)
    await service.start()
    try:
        await service.finish(meeting["id"], 16000)

        async def failed():
            rows = await service.list(meeting["id"])
            return bool(rows and rows[0]["status"] == "failed")

        await until(failed)
        generator.available = True
        assert await service.retry_failed(meeting["id"]) == 1

        async def recovered():
            rows = await service.list(meeting["id"])
            return bool(rows and rows[0]["status"] == "ready")

        await until(recovered)
        assert (await service.list(meeting["id"]))[0]["text"] == "0-1 秒：需要恢复的内容。"
    finally:
        await service.close()


async def test_pause_boundary_is_persisted_while_previous_window_is_generating(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("慢速总结期间暂停")
    transcript = store.transcript(meeting["id"])
    transcript.final(0, "完整窗口。", 0, 1000, "capture")
    transcript.final(1, "暂停前尾段。", 11000, 12000, "capture")
    transcript.final(2, "恢复后的窗口。", 13000, 22000, "capture")
    generator = GateGenerator()
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    service = StageSummaryService(store, None, settings, generator)
    await service.start()
    try:
        service.offer(meeting["id"], 16000 * 10)
        await asyncio.wait_for(generator.entered.wait(), 2)

        await service.finish(meeting["id"], 16000 * 12)
        service.offer(meeting["id"], 16000 * 22)
        rows = await service.list(meeting["id"])
        assert [(row["start_seconds"], row["end_seconds"]) for row in rows] == [
            (0, 10),
            (10, 12),
        ]

        generator.release.set()

        async def all_ready():
            rows = await service.list(meeting["id"])
            return len(rows) == 3 and all(row["status"] == "ready" for row in rows)

        await until(all_ready)
        assert [
            (row["start_seconds"], row["end_seconds"])
            for row in await service.list(meeting["id"])
        ] == [(0, 10), (10, 12), (12, 22)]
    finally:
        generator.release.set()
        await service.close()


async def test_active_summary_blocks_delete_then_notifies_subscribers(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    meeting = store.create("阶段总结删除协调")
    store.transcript(meeting["id"]).final(0, "待总结内容。", 0, 1000, "capture")
    generator = GateGenerator()
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    service = StageSummaryService(store, None, settings, generator)
    await service.start()
    subscription = service.subscribe(meeting["id"], "test")
    try:
        await service.finish(meeting["id"], 16000)
        await asyncio.wait_for(generator.entered.wait(), 2)
        with pytest.raises(MeetingError, match="阶段总结正在生成"):
            store.delete(meeting["id"])

        generator.release.set()

        async def ready():
            rows = await service.list(meeting["id"])
            return bool(rows and rows[0]["status"] == "ready")

        await until(ready)
        while not subscription.empty():
            subscription.get_nowait()
        for index in range(subscription.maxsize):
            subscription.put_nowait({"type": "stage_summary.update", "index": index})
        store.delete(meeting["id"])
        service.deleted(meeting["id"])
        assert await asyncio.wait_for(subscription.get(), 1) == {"type": "deleted"}
        assert subscription.empty()
    finally:
        generator.release.set()
        service.unsubscribe(meeting["id"], "test")
        await service.close()


async def test_registered_meeting_reconciles_unplanned_windows_after_restart(tmp_path):
    store = MeetingStore(tmp_path / "meetings.sqlite3")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        database_path=store.path,
        stage_summary_window_seconds=10,
    )
    interrupted = StageSummaryService(store, None, settings, RecordingGenerator())
    meeting = store.create("崩溃恢复切窗")
    store.transcript(meeting["id"]).final(0, "已经定稿的内容。", 0, 12000, "capture")
    archive = AudioArchive(store.directory(meeting["id"]))
    archive.begin()
    archive.append(np.zeros(16000 * 12, dtype=np.float32))
    archive.end()
    store.transition(meeting["id"], "start")
    store.release(meeting["id"], None)

    recovered = StageSummaryService(store, None, settings, RecordingGenerator())
    await recovered.start()
    try:
        async def ready():
            rows = await recovered.list(meeting["id"])
            return len(rows) == 2 and all(row["status"] == "ready" for row in rows)

        await until(ready)
        assert [
            (row["start_seconds"], row["end_seconds"])
            for row in await recovered.list(meeting["id"])
        ] == [(0, 10), (10, 12)]
    finally:
        await recovered.close()
