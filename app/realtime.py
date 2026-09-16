from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
from uuid import uuid4

from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect

from .asr import ASRError
from .meetings import MeetingError
from .recordings import AudioArchive

logger = logging.getLogger(__name__)


async def meeting_socket(websocket: WebSocket, meeting_id, store, models, minutes, factory, *, settings,
                         diarization=None, events=None):
    """Bind one browser and one model stream to a meeting; persist only final segments."""
    await websocket.accept()
    owner = uuid4().hex
    claimed = False
    stream = None
    results = None
    meeting = None
    confirmed = ""
    next_segment = 0
    local_base = 0
    archive = None
    native_ids = False
    subscription = None
    pump = None
    revision = 0
    send_lock = asyncio.Lock()

    async def send(event):
        nonlocal revision
        async with send_lock:
            if event.get("revision"):
                if event["revision"] <= revision:
                    return
                if event["revision"] != revision + 1:
                    current = await asyncio.to_thread(store.get, meeting_id)
                    event = {"type": "snapshot", "meeting": current}
                    revision = current["transcript_revision"]
                else:
                    revision = event["revision"]
            if "meeting" in event:
                if event["meeting"]["transcript_revision"] < revision:
                    event["meeting"] = await asyncio.to_thread(store.get, meeting_id)
                revision = event["meeting"]["transcript_revision"]
            await websocket.send_json({**event, "meeting_id": meeting_id})

    async def forward():
        while True:
            event = await subscription.get()
            if event["type"] == "resync":
                event = {"type": "snapshot", "meeting": await asyncio.to_thread(store.get, meeting_id)}
            await send(event)
            if event["type"] == "deleted":
                await websocket.close(code=1000)
                return

    async def read_results():
        nonlocal confirmed, next_segment
        async for event in stream.events():
            segment = event["segment_id"] + (0 if native_ids else local_base)
            if segment < next_segment:
                continue  # A repeated final must never duplicate the meeting transcript.
            if segment != next_segment:
                raise ASRError("转写片段顺序异常，录音已停止。")
            text = event["text"].strip()
            if event["type"] == "final":
                saved = await asyncio.to_thread(store.save_segment, meeting_id, owner, segment, text,
                    event.get("start_ms", 0), event.get("end_ms", 0), archive.capture_id if archive else None)
                if text:
                    confirmed = "\n\n".join(part for part in (confirmed, text) if part)
                next_segment += 1
                # Send only the segment; the client already owns previously confirmed text.
                if saved:
                    await send(saved)
                    if events:
                        events.publish(meeting_id, saved, exclude=owner)
                    if diarization:
                        diarization.notify(meeting_id)
            else:
                await send({"type": "partial", "segment_id": segment, "text": text})

    async def receive():
        task = asyncio.create_task(websocket.receive())
        try:
            if results is not None:
                done, _ = await asyncio.wait((task, results), return_when=asyncio.FIRST_COMPLETED)
                if results in done:
                    results.result()
                    raise ASRError("ASR 流式识别已停止。")
            return await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def flush():
        # Observe receiver failures while waiting for the model's flush acknowledgment.
        task = asyncio.create_task(stream.flush())
        try:
            done, _ = await asyncio.wait((task, results), return_when=asyncio.FIRST_COMPLETED)
            if results in done:
                results.result()
                raise ASRError("ASR 流式识别已停止。")
            await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    try:
        meeting = await asyncio.to_thread(store.get, meeting_id)
        if meeting is None:
            raise MeetingError("会议不存在", 404)
        if meeting["status"] != "ended":
            meeting = await asyncio.to_thread(store.claim, meeting_id, owner)
            claimed = True
        confirmed = meeting["text"]
        next_segment = local_base = meeting["next_segment_id"]
        archive = await asyncio.to_thread(AudioArchive, store.directory(meeting_id)) if claimed else None
        config = await asyncio.to_thread(models.require, "asr") if factory is None and claimed else None
        if factory is None and claimed:
            from .asr import build_transcriber
            factory = lambda: build_transcriber(config, settings)
        if events:
            subscription = events.subscribe(meeting_id, owner)
            meeting = await asyncio.to_thread(store.get, meeting_id)
        await send({"type": "ready", "meeting": meeting, "audio_format": "pcm_s16le", "read_only": not claimed})
        if subscription is not None:
            pump = asyncio.create_task(forward())
        sample_rate = None
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                if meeting["status"] != "recording" or stream is None:
                    await send({"type": "error", "message": "请先开始或继续会议录音"})
                    continue
                await stream.send_audio(message["bytes"])
                if hasattr(stream, "flow_status"):
                    flow = stream.flow_status()
                    if flow:
                        await send(flow)
                continue
            action = None
            try:
                raw = message.get("text") or ""
                if len(raw) > 4096:
                    raise MeetingError("消息过长", 400)
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise MeetingError("消息必须是 JSON 对象", 400)
                action = payload.get("type")
                if payload.get("meeting_id", meeting_id) != meeting_id:
                    raise MeetingError("消息中的会议 ID 与当前连接不一致", 400)
                if not claimed and action != "ping":
                    raise MeetingError("会议已结束，只能查看记录")
                if action in {"start", "resume"}:
                    expected = "created" if action == "start" else "paused"
                    if meeting["status"] != expected:
                        raise MeetingError("当前会议状态不支持此操作")
                    rate = payload.get("sample_rate", sample_rate)
                    if type(rate) is not int or not 8000 <= rate <= 96000 or payload.get("format", "pcm_s16le") != "pcm_s16le":
                        raise MeetingError("请提供单声道 PCM16 和有效的采样率", 400)
                    if sample_rate is not None and rate != sample_rate:
                        raise MeetingError("继续录音时采样率不能改变，请重新进入会议", 400)
                    await asyncio.to_thread(archive.begin)
                    if stream is None:
                        stream = factory()
                        native_ids = hasattr(stream, "bind_recording")
                        if native_ids:
                            stream.bind_recording(archive, next_segment,
                                (lambda: diarization.notify(meeting_id)) if diarization else None)
                        await stream.start(meeting["language"], rate)
                        results = asyncio.create_task(read_results())
                    sample_rate = rate
                    meeting = await asyncio.to_thread(store.transition, meeting_id, action, owner)
                elif action in {"pause", "end"}:
                    if action == "pause" and meeting["status"] != "recording":
                        raise MeetingError("当前会议状态不支持此操作")
                    if meeting["status"] == "recording":
                        meeting = await asyncio.to_thread(store.transition, meeting_id, "pause", owner)
                    if stream is not None:
                        await flush()
                    await asyncio.to_thread(archive.end)
                    if diarization:
                        diarization.notify(meeting_id)
                    if action == "end":
                        meeting = await asyncio.to_thread(store.transition, meeting_id, "end", owner)
                        if diarization:
                            await diarization.finish(meeting_id)
                        else:
                            await minutes.after_end(meeting)
                    else:
                        meeting = await asyncio.to_thread(store.get, meeting_id)
                elif action == "ping":
                    await send({"type": "pong"})
                    continue
                else:
                    raise MeetingError("未知会议操作", 400)
                await send({"type": "state", "action": action, "meeting": meeting})
                if action == "end":
                    if results:
                        results.cancel()
                        await asyncio.gather(results, return_exceptions=True)
                        results = None
                    if stream:
                        await stream.close()
                        stream = None
                    await asyncio.to_thread(store.release, meeting_id, owner)
                    claimed = False
            except (ValueError, TypeError):
                await send({"type": "error", "action": action, "message": "消息格式不正确"})
            except MeetingError as exc:
                await send({"type": "error", "action": action, "message": str(exc)})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        if not isinstance(exc, (MeetingError, ASRError)):
            logger.exception("Meeting stream failed for %s", meeting_id)
        text = str(exc) if isinstance(exc, (MeetingError, ASRError)) else "实时识别连接中断，已定稿内容已保存。"
        with suppress(Exception):
            await send({"type": "error", "fatal": True, "message": text})
            await websocket.close(code=1008 if isinstance(exc, MeetingError) else 1011)
    finally:
        with CancelScope(shield=True):
            if events:
                events.unsubscribe(meeting_id, owner)
            if pump:
                pump.cancel()
                await asyncio.gather(pump, return_exceptions=True)
            if results:
                results.cancel()
                await asyncio.gather(results, return_exceptions=True)
            try:
                if stream:
                    await stream.close()
            finally:
                if claimed:
                    if archive:
                        await asyncio.to_thread(archive.end)
                        if diarization:
                            diarization.notify(meeting_id)
                    await asyncio.to_thread(store.release, meeting_id, owner)
