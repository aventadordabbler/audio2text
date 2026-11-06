from __future__ import annotations

import asyncio
import json
import logging
import math
import time

from .state import SpeakerState, label_segment
from .worker import ModelWorker, WorkerError
from .jobs import ProcessingJobs
from .finalize import global_timeline, label_document, SegmentCorrector
from ..meetings import MeetingError
from ..recordings import SAMPLE_RATE, read_audio_summary

logger = logging.getLogger(__name__)

FINAL_TIMEOUT_BASE_SECONDS = 5 * 60
FINAL_TIMEOUT_SECONDS_PER_AUDIO_SECOND = 2


class DiarizationService:
    def __init__(self, store, models, minutes, settings, events, worker_factory=None, stage_summaries=None):
        self.store, self.models, self.minutes = store, models, minutes
        self.settings, self.events = settings, events
        self.stage_summaries = stage_summaries
        self.workers = [worker_factory() if worker_factory else ModelWorker(settings)
                        for _ in range(settings.diarization_workers)]
        self.available_workers = asyncio.Queue()
        for worker in self.workers:
            self.available_workers.put_nowait(worker)
        self.live = {}
        self.finalizers = {}
        self.dirty = set()
        self.closed = False
        self.jobs = ProcessingJobs(store)
        self.finish_lock = asyncio.Lock()
        self.final_slots = asyncio.Semaphore(settings.diarization_workers)
        self.timers = {}
        self.next_run = {}

    async def request(self, payload):
        worker = await self.available_workers.get()
        try:
            return await worker.request(payload)
        finally:
            self.available_workers.put_nowait(worker)

    async def embed(self, directory, samples):
        return await self.request({"type": "embed", "directory": str(directory.resolve()), "samples": samples})

    def notify(self, meeting_id):
        if self.closed or meeting_id in self.finalizers:
            return
        self.dirty.add(meeting_id)
        if meeting_id in self.live or meeting_id in self.timers:
            return
        delay = max(0, self.next_run.get(meeting_id, 0) - time.monotonic())
        if delay:
            self.timers[meeting_id] = asyncio.get_running_loop().call_later(delay, self._launch, meeting_id)
        else:
            self._launch(meeting_id)

    def _launch(self, meeting_id):
        self.timers.pop(meeting_id, None)
        if not self.closed and meeting_id not in self.finalizers and meeting_id not in self.live:
            self.next_run[meeting_id] = time.monotonic() + 1
            self.live[meeting_id] = asyncio.create_task(self._live(meeting_id))

    async def _status(self, meeting_id, status, error=""):
        transcript = self.store.transcript(meeting_id)
        doc = await asyncio.to_thread(transcript.read)
        processing = {"status": status, "error": error}
        if doc["processing"] == processing:
            return
        event = await asyncio.to_thread(transcript.update, processing=processing)
        self.events.publish(meeting_id, event)

    @staticmethod
    def _window(directory, processed, final=False):
        path = directory / "audio/manifest.json"
        if not path.exists():
            return None
        manifest = json.loads(path.read_text())
        for capture in manifest["captures"]:
            if capture["end"] <= processed:
                continue
            cursor = max(processed, capture["start"])
            next_end = capture["start"] + 160000 if cursor == capture["start"] else cursor + 16000
            if next_end > capture["end"]:
                if not final and not capture.get("closed"):
                    return None
                next_end = capture["end"]
            return {"type": "window", "directory": str(directory.resolve()),
                    "start": max(capture["start"], next_end - 160000), "end": next_end,
                    "fresh_from": cursor}
        return None

    async def _apply(self, meeting_id, state):
        transcript = self.store.transcript(meeting_id)
        for _ in range(3):
            doc = await asyncio.to_thread(transcript.read)
            low = max(0, state.value["processed"] / 16 - 60000)
            changes = []
            for segment in doc["segments"]:
                if segment["end_ms"] <= low:
                    continue
                # Retain older assignments when the new window only covers a segment's tail.
                earlier = [t for t in segment.get("speaker_turns", []) if t["end_ms"] <= low]
                updated = label_segment(segment, earlier + state.value["turns"], state.value["processed"] / 16)
                if updated != segment:
                    changes.append(updated)
            names = {key: value for key, value in state.names.items() if doc["speakers"].get(key) != value}
            if not changes and not names:
                return
            event = await asyncio.to_thread(transcript.update, segments=changes, speakers=names,
                                            expected_revision=doc["revision"])
            if event:
                self.events.publish(meeting_id, event)
                if self.stage_summaries:
                    self.stage_summaries.notify_diarization(meeting_id)
                return

    async def _live(self, meeting_id):
        try:
            if error := self.workers[0].readiness():
                self.next_run[meeting_id] = time.monotonic() + 30
                await self._status(meeting_id, "unavailable", error)
                return
            directory = self.store.directory(meeting_id)
            state = await asyncio.to_thread(SpeakerState, directory, self.store.list_voiceprints())
            await self._status(meeting_id, "pending")
            while meeting_id in self.dirty:
                self.dirty.discard(meeting_id)
                while request := await asyncio.to_thread(self._window, directory, state.value["processed"]):
                    result = await self.request(request)
                    await asyncio.to_thread(state.accept, result)
                    await self._apply(meeting_id, state)
                await self._apply(meeting_id, state)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.next_run[meeting_id] = time.monotonic() + 30
            logger.exception("Live diarization failed for %s", meeting_id)
            await self._status(meeting_id, "failed", str(exc) if isinstance(exc, WorkerError) else "说话人识别暂不可用，会议文字已保留。")
        finally:
            self.live.pop(meeting_id, None)
            self.dirty.discard(meeting_id)

    async def start(self):
        for job in await asyncio.to_thread(self.jobs.recover):
            meeting_id = job["meeting_id"]
            if job["status"] == "queued":
                self._schedule(meeting_id)
            else:
                await self._status(meeting_id, job["status"], job["error"])
                await self._minutes(meeting_id)

    async def finish(self, meeting_id, retry=False):
        async with self.finish_lock:
            meeting = await asyncio.to_thread(self.store.get, meeting_id)
            if meeting is None:
                raise MeetingError("会议不存在", 404)
            if meeting["status"] != "ended":
                raise MeetingError("请先结束会议，再校正说话人")
            if await asyncio.to_thread(self.jobs.queue, meeting_id, retry):
                if timer := self.timers.pop(meeting_id, None):
                    timer.cancel()
                await self._status(meeting_id, "queued")
                self._schedule(meeting_id)

    def _schedule(self, meeting_id):
        if meeting_id not in self.finalizers:
            task = asyncio.create_task(self._finalize(meeting_id))
            self.finalizers[meeting_id] = task
            def finished(completed):
                self.finalizers.pop(meeting_id, None)
                self.next_run.pop(meeting_id, None)
                self.dirty.discard(meeting_id)
                if not completed.cancelled() and completed.exception():
                    logger.error("Could not save finalization state for %s", meeting_id, exc_info=completed.exception())
            task.add_done_callback(finished)

    async def _minutes(self, meeting_id):
        # A saved attempt is the durable deduplication boundary, including failed
        # attempts interrupted by a restart. Only an explicit user action retries it.
        result = await self.minutes.get(meeting_id)
        if result["status"] == "not_started":
            await self.minutes.after_end(await asyncio.to_thread(self.store.get, meeting_id))
        self.events.publish(meeting_id, {"type": "minutes", "minutes": await self.minutes.get(meeting_id)})

    async def _finalize(self, meeting_id):
        completed = False
        audio = None
        try:
            audio = await asyncio.to_thread(read_audio_summary, self.store.directory(meeting_id))
            if task := self.live.get(meeting_id):
                await task
            await self._status(meeting_id, "queued")
            async with self.final_slots:
                await asyncio.to_thread(self.jobs.set, meeting_id, "running")
                await self._status(meeting_id, "running")
                async with asyncio.timeout(self._final_timeout_seconds(
                    audio.samples if audio is not None else 0
                )):
                    if error := self.workers[0].readiness():
                        raise WorkerError(error)
                    if not await self._correct(meeting_id):
                        raise WorkerError("未生成有效的说话人时间线，请检查音频内容或模型配置。")
            await asyncio.to_thread(self.jobs.set, meeting_id, "ready")
            await self._status(meeting_id, "ready")
            completed = True
        except asyncio.CancelledError:
            # Keep the durable running marker: startup retries at most twice.
            raise
        except Exception as exc:
            logger.warning("Diarization finalization failed for %s: %s", meeting_id, type(exc).__name__)
            message = str(exc) if isinstance(exc, WorkerError) else "说话人校正未完成，已保留原转写，可重试。"
            status = "unavailable" if self.workers[0].readiness() else "failed"
            await asyncio.to_thread(self.jobs.set, meeting_id, status, message)
            await self._status(meeting_id, status, message)
        if completed and self.stage_summaries:
            try:
                if audio is not None:
                    await self.stage_summaries.finish(meeting_id, audio.samples)
                self.stage_summaries.notify_diarization(meeting_id)
            except Exception:
                logger.exception("Could not release stage summaries after diarization for %s", meeting_id)
        if not self.closed:
            await self._minutes(meeting_id)

    async def _correct(self, meeting_id):
        directory = self.store.directory(meeting_id)
        meeting = await asyncio.to_thread(self.store.get, meeting_id)
        state = await asyncio.to_thread(SpeakerState, directory, self.store.list_voiceprints())
        while payload := await asyncio.to_thread(self._window, directory, state.value["processed"], True):
            result = await self.request(payload)
            await asyncio.to_thread(state.accept, result)
            await asyncio.sleep(0)  # Let waiting live meetings enter the worker pool.
        transcript = self.store.transcript(meeting_id)
        document = await asyncio.to_thread(transcript.read)
        if not state.log.exists():
            return False
        result = await self.request({"type": "cluster", "path": str(state.log.resolve())})
        names = await asyncio.to_thread(global_timeline, directory, result["centroids"], state)
        segments = await asyncio.to_thread(lambda: list(label_document(directory, document, state.value["processed"] / 16)))
        corrector = SegmentCorrector(directory, self.models, self.settings, meeting["language"])
        changed, removed, number = [], [], document["next_segment_id"]
        original = {s["segment_id"]: s for s in document["segments"]}
        try:
            for segment in segments:
                try:
                    split = await corrector.split(segment)
                except Exception:
                    logger.warning("Keeping unsplit ASR segment %s/%s", meeting_id, segment["segment_id"])
                    split = None
                if split:
                    removed.append(segment["segment_id"])
                    for part in split:
                        child = {**segment, "segment_id": number,
                            "parent_segment_id": segment["segment_id"], "original_text": segment["text"],
                            "text": part["text"], "start_ms": part["start_ms"], "end_ms": part["end_ms"],
                            "speaker_ids": [part["speaker_id"]], "speaker_status": "assigned",
                            "speaker_turns": []}
                        changed.append(label_segment(child, segment["speaker_turns"], part["end_ms"]))
                        number += 1
                elif segment != original[segment["segment_id"]]:
                    changed.append(segment)
            names = {key: value for key, value in names.items() if document["speakers"].get(key) != value}
            if changed or removed or names:
                event = await asyncio.to_thread(transcript.update, segments=changed, remove=removed,
                    speakers=names, expected_revision=document["revision"])
                if event is None:
                    raise WorkerError("校正时转写版本发生变化，请重试。")
                self.events.publish(meeting_id, event)
        finally:
            await corrector.close()
        return True

    def _final_timeout_seconds(self, samples: int) -> float:
        if self.settings.diarization_final_timeout_seconds is not None:
            return self.settings.diarization_final_timeout_seconds
        duration = samples / SAMPLE_RATE if samples > 0 else self.settings.audio_import_max_seconds
        windows = max(1, math.ceil(duration))
        # shortcut: budget two wall-clock seconds per fresh audio second; replace
        # with measured throughput if the diarization model or stride changes.
        return FINAL_TIMEOUT_BASE_SECONDS + windows * FINAL_TIMEOUT_SECONDS_PER_AUDIO_SECOND

    async def correct_import(self, meeting_id):
        """The import job owns persistence and summary scheduling for uploaded audio."""
        await self._status(meeting_id, "queued")
        try:
            async with self.final_slots:
                await self._status(meeting_id, "running")
                if error := self.workers[0].readiness():
                    await self._status(meeting_id, "unavailable", error)
                    return False
                audio = await asyncio.to_thread(read_audio_summary, self.store.directory(meeting_id))
                async with asyncio.timeout(self._final_timeout_seconds(
                    audio.samples if audio is not None else 0
                )):
                    completed = await self._correct(meeting_id)
                if not completed:
                    await self._status(meeting_id, "failed", "未生成有效的说话人时间线，请检查音频内容或模型配置。")
                    return False
            await self._status(meeting_id, "ready")
            return True
        except Exception as exc:
            logger.exception("Imported audio speaker correction failed for %s", meeting_id)
            await self._status(meeting_id, "failed", str(exc) if isinstance(exc, WorkerError)
                               else "说话人校正未完成，已保留转写，可重试。")
            return False

    async def close(self):
        self.closed = True
        for timer in self.timers.values():
            timer.cancel()
        self.timers.clear()
        tasks = [*self.live.values(), *self.finalizers.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(w.close() for w in self.workers))
