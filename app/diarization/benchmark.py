"""Measure local diarization on an existing archive without changing the meeting."""
import argparse
import asyncio
import json
from pathlib import Path
import platform
from tempfile import TemporaryDirectory
import time

import numpy as np

from .service import DiarizationService
from .state import SpeakerState
from .worker import ModelWorker
from .finalize import global_timeline
from ..config import Settings


async def benchmark(args, concurrency, settings):
    workers = [ModelWorker(settings) for _ in range(settings.diarization_workers)]
    pool = asyncio.Queue()
    for worker in workers:
        if error := worker.readiness():
            raise RuntimeError(error)
        pool.put_nowait(worker)
    async def request(payload):
        worker = await pool.get()
        try:
            return await worker.request(payload)
        finally:
            pool.put_nowait(worker)
    try:
        # Model loading is reported separately from steady-state window service.
        start = time.perf_counter()
        await asyncio.gather(*(w.request({"type": "stats"}) for w in workers))
        load_seconds = time.perf_counter() - start
        durations, latencies, windows = [], [], []
        async def one(number):
            with TemporaryDirectory(prefix="meeting-diarization-bench-") as temporary:
                directory = Path(temporary)
                state = SpeakerState(directory)
                started, processed = time.perf_counter(), 0
                while payload := DiarizationService._window(args.meeting_dir, processed, True):
                    if args.max_seconds and processed >= args.max_seconds * 16000:
                        break
                    if args.max_seconds:
                        payload["end"] = min(payload["end"], round(args.max_seconds * 16000))
                    if args.realtime:
                        await asyncio.sleep(max(0, payload["end"] / 16000 - (time.perf_counter() - started)))
                    before = time.perf_counter()
                    result = await request(payload)
                    await asyncio.to_thread(state.accept, result)
                    elapsed = time.perf_counter() - before
                    windows.append(elapsed)
                    if args.realtime:
                        latencies.append(time.perf_counter() - started - result["end"] / 16000)
                    processed = result["end"]
                live_seconds = time.perf_counter() - started
                before = time.perf_counter()
                scores = None
                if state.log.exists():
                    clustered = await request({"type": "cluster", "path": str(state.log)})
                    await asyncio.to_thread(global_timeline, directory, clustered["centroids"], state)
                    if args.reference_rttm:
                        scores = await request({"type": "score", "timeline": str(directory / "speaker-timeline.jsonl"),
                                                "reference": str(args.reference_rttm.resolve()), "uri": args.uri})
                durations.append({"stream": number, "audio_seconds": processed / 16000,
                    "window_processing_seconds": live_seconds, "global_correction_seconds": time.perf_counter() - before,
                    "der": scores})
        await asyncio.gather(*(one(i + 1) for i in range(concurrency)))
        stats = await asyncio.gather(*(w.request({"type": "stats"}) for w in workers))
        return {"concurrent_meetings": concurrency, "worker_count": len(workers),
                "threads_per_worker": settings.diarization_threads, "model_load_seconds": load_seconds,
                "window_service_p95_seconds": float(np.percentile(windows, 95)) if windows else None,
                "label_window_backlog_p95_seconds": float(np.percentile(latencies, 95)) if latencies else None,
                "workers": stats, "streams": durations}
    finally:
        await asyncio.gather(*(w.close() for w in workers))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meeting-dir", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4])
    parser.add_argument("--max-seconds", type=float, default=0, help="0 processes the whole archive")
    parser.add_argument("--realtime", action="store_true", help="Pace input at recorded time to measure backlog")
    parser.add_argument("--reference-rttm", type=Path)
    parser.add_argument("--uri")
    parser.add_argument("--output", type=Path, default=Path("diarization-benchmark.json"))
    args = parser.parse_args()
    if not all(1 <= n <= 16 for n in args.concurrency) or args.max_seconds < 0:
        parser.error("concurrency must be 1..16 and max-seconds nonnegative")
    if args.reference_rttm and args.max_seconds:
        parser.error("DER requires the complete archive; omit --max-seconds")
    settings = Settings()
    async def run():
        results = [await benchmark(args, n, settings) for n in args.concurrency]
        report = {"platform": platform.platform(), "cpu": platform.processor(), "results": results,
                  "limits": "Measures diarization only; excludes remote ASR, browser text latency, and accuracy without RTTM."}
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(args.output)
    asyncio.run(run())


if __name__ == "__main__":
    main()
