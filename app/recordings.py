"""Committed PCM chunks, sample-based meeting clock, and capture boundaries."""
from __future__ import annotations

import json
from copy import deepcopy
import os
from pathlib import Path
from uuid import uuid4

import numpy as np

from .transcripts import atomic_json

SAMPLE_RATE = 16000
CHUNK_SAMPLES = SAMPLE_RATE * 30


class PCMNormalizer:
    def __init__(self, input_rate):
        self.input_rate = input_rate
        self._reset()

    def _reset(self):
        self.resampler = None
        if self.input_rate != SAMPLE_RATE:
            import soxr
            self.resampler = soxr.ResampleStream(self.input_rate, SAMPLE_RATE, 1, dtype="float32")

    def feed(self, pcm):
        if not pcm or len(pcm) % 2:
            raise ValueError("请提供完整的 PCM16 音频采样")
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        return self.resampler.resample_chunk(samples) if self.resampler is not None else samples

    def flush(self):
        tail = np.empty(0, dtype=np.float32)
        if self.resampler is not None:
            tail = self.resampler.resample_chunk(tail, last=True)
        self._reset()
        return tail


class AudioArchive:
    def __init__(self, directory: Path):
        self.directory = directory / "audio"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "manifest.json"
        self.manifest = json.loads(self.path.read_text()) if self.path.exists() else {
            "format": "pcm_s16le", "sample_rate": SAMPLE_RATE, "samples": 0,
            "chunks": [], "captures": [],
        }
        # Uncommitted bytes can remain after interruption; only the manifest is authoritative.
        for chunk in self.manifest["chunks"]:
            path = self.directory / chunk["file"]
            expected = (chunk["end"] - chunk["start"]) * 2
            if path.stat().st_size < expected:
                raise OSError("录音文件短于已提交的音频位置")
            if path.stat().st_size > expected:
                with path.open("r+b") as out:
                    out.truncate(expected)
        self.capture_id = None

    @property
    def samples(self):
        return self.manifest["samples"]

    def begin(self):
        for capture in self.manifest["captures"]:
            capture["closed"] = True
        self.capture_id = uuid4().hex
        self.manifest["captures"].append({"id": self.capture_id, "start": self.samples, "end": self.samples})
        atomic_json(self.path, self.manifest)
        return self.capture_id

    def append(self, samples):
        committed = deepcopy(self.manifest)
        try:
            self._append(samples)
        except BaseException:
            self.manifest = committed
            raise

    def _append(self, samples):
        if not len(samples):
            return
        if self.capture_id is None:
            raise ValueError("录音轮次未建立")
        pcm = np.rint(np.clip(samples, -1, 32767 / 32768) * 32768).astype("<i2")
        offset = 0
        while offset < len(pcm):
            chunks = self.manifest["chunks"]
            if not chunks or chunks[-1]["end"] - chunks[-1]["start"] >= CHUNK_SAMPLES:
                chunks.append({"file": f"{len(chunks):06d}.pcm", "start": self.samples, "end": self.samples})
            chunk = chunks[-1]
            count = min(len(pcm) - offset, CHUNK_SAMPLES - (chunk["end"] - chunk["start"]))
            path = self.directory / chunk["file"]
            with path.open("r+b" if path.exists() else "w+b") as out:
                out.seek((chunk["end"] - chunk["start"]) * 2)
                out.write(pcm[offset:offset + count].tobytes())
                out.truncate()
                out.flush()
                os.fsync(out.fileno())
            chunk["end"] += count
            self.manifest["samples"] += count
            offset += count
        self.manifest["captures"][-1]["end"] = self.samples
        atomic_json(self.path, self.manifest)

    def end(self):
        if self.capture_id is not None:
            self.manifest["captures"][-1]["closed"] = True
            atomic_json(self.path, self.manifest)
        self.capture_id = None


def read_audio(directory: Path, start: int, end: int):
    manifest = json.loads((directory / "audio" / "manifest.json").read_text())
    if start < 0 or end < start or end > manifest["samples"]:
        raise ValueError("录音范围超出已提交音频")
    parts = []
    for chunk in manifest["chunks"]:
        low, high = max(start, chunk["start"]), min(end, chunk["end"])
        if high <= low:
            continue
        with (directory / "audio" / chunk["file"]).open("rb") as source:
            source.seek((low - chunk["start"]) * 2)
            data = source.read((high - low) * 2)
        if len(data) != (high - low) * 2:
            raise OSError("录音文件不完整")
        parts.append(np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768)
    return np.concatenate(parts) if parts else np.empty(0, dtype=np.float32)
