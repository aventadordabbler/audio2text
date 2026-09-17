"""Committed PCM chunks, sample-based meeting clock, and capture boundaries."""
from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
import os
from pathlib import Path
from uuid import uuid4

import numpy as np

from .transcripts import atomic_json

SAMPLE_RATE = 16000
CHUNK_SAMPLES = SAMPLE_RATE * 30
WAV_HEADER_BYTES = 44
WAV_MAX_DATA_BYTES = (1 << 32) - 1 - 36
WAV_READ_BYTES = 1024 * 1024


class AudioExportUnavailable(FileNotFoundError):
    """The meeting has no committed audio that can be exported."""


class AudioExportInvalid(ValueError):
    """The committed audio manifest or one of its chunks is invalid."""


@dataclass(frozen=True)
class WavExport:
    """A validated, streaming view over the committed PCM chunks."""

    sample_rate: int
    samples: int
    chunks: tuple[tuple[Path, int], ...]

    @property
    def data_bytes(self) -> int:
        return self.samples * 2

    @property
    def content_length(self) -> int:
        return WAV_HEADER_BYTES + self.data_bytes

    def header(self) -> bytes:
        data_size = self.data_bytes
        byte_rate = self.sample_rate * 2
        return b"".join((
            b"RIFF", (36 + data_size).to_bytes(4, "little"), b"WAVE",
            b"fmt ", (16).to_bytes(4, "little"), (1).to_bytes(2, "little"),
            (1).to_bytes(2, "little"), self.sample_rate.to_bytes(4, "little"),
            byte_rate.to_bytes(4, "little"), (2).to_bytes(2, "little"),
            (16).to_bytes(2, "little"), b"data", data_size.to_bytes(4, "little"),
        ))

    def iter_bytes(self):
        yield self.header()
        for path, expected in self.chunks:
            with path.open("rb") as source:
                remaining = expected
                while remaining:
                    block = source.read(min(WAV_READ_BYTES, remaining))
                    if not block:
                        raise OSError("录音文件在导出过程中变得不完整")
                    remaining -= len(block)
                    yield block


@dataclass(frozen=True)
class AudioSummary:
    """Authoritative sample clock from a committed audio manifest."""

    sample_rate: int
    samples: int

    @property
    def duration_seconds(self) -> float:
        return self.samples / self.sample_rate


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


def _load_audio_manifest(directory: Path) -> tuple[Path, dict, AudioSummary]:
    audio_directory = directory / "audio"
    manifest_path = audio_directory / "manifest.json"
    if not manifest_path.is_file():
        raise AudioExportUnavailable("会议暂无录音")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AudioExportInvalid("录音清单无法读取") from exc
    if not isinstance(manifest, dict):
        raise AudioExportInvalid("录音清单格式无效")
    if manifest.get("format") != "pcm_s16le":
        raise AudioExportInvalid("录音格式不受支持")
    sample_rate = manifest.get("sample_rate")
    samples = manifest.get("samples")
    chunks = manifest.get("chunks")
    if (
        not isinstance(sample_rate, int)
        or isinstance(sample_rate, bool)
        or sample_rate <= 0
        or sample_rate > 0xFFFFFFFF // 2
    ):
        raise AudioExportInvalid("录音采样率无效")
    if not isinstance(samples, int) or isinstance(samples, bool) or samples < 0:
        raise AudioExportInvalid("录音采样数无效")
    return audio_directory, manifest, AudioSummary(sample_rate, samples)


def read_audio_summary(directory: Path) -> AudioSummary | None:
    """Return committed sample metadata, or ``None`` for a missing/invalid archive."""
    try:
        return _load_audio_manifest(directory)[2]
    except (AudioExportUnavailable, AudioExportInvalid):
        return None


def prepare_wav_export(directory: Path) -> WavExport:
    """Validate a committed archive and return a streaming WAV view.

    The manifest is authoritative: files are read only for the sample ranges
    declared there, so bytes left behind by an interrupted capture are omitted.
    """
    audio_directory, manifest, summary = _load_audio_manifest(directory)
    sample_rate, samples = summary.sample_rate, summary.samples
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        raise AudioExportInvalid("录音分片清单无效")
    if samples == 0:
        raise AudioExportUnavailable("会议暂无录音")
    data_bytes = samples * 2
    if data_bytes > WAV_MAX_DATA_BYTES:
        raise AudioExportInvalid("录音时长超过 WAV 格式限制")

    root = audio_directory.resolve()
    expected_start = 0
    seen_files: set[str] = set()
    sources: list[tuple[Path, int]] = []
    for item in chunks:
        if not isinstance(item, dict):
            raise AudioExportInvalid("录音分片清单格式无效")
        file_name = item.get("file")
        start = item.get("start")
        end = item.get("end")
        if (
            not isinstance(file_name, str)
            or not file_name
            or not isinstance(start, int)
            or isinstance(start, bool)
            or not isinstance(end, int)
            or isinstance(end, bool)
            or start != expected_start
            or end <= start
            or file_name in seen_files
        ):
            raise AudioExportInvalid("录音分片清单不连续")
        path = (audio_directory / file_name).resolve()
        if not path.is_relative_to(root):
            raise AudioExportInvalid("录音分片路径无效")
        if not path.is_file():
            raise AudioExportInvalid("录音分片不存在")
        expected_bytes = (end - start) * 2
        try:
            actual_bytes = path.stat().st_size
        except OSError as exc:
            raise AudioExportInvalid("录音分片不存在") from exc
        if actual_bytes < expected_bytes:
            raise AudioExportInvalid("录音分片不完整")
        seen_files.add(file_name)
        sources.append((path, expected_bytes))
        expected_start = end

    if expected_start != samples:
        raise AudioExportInvalid("录音分片总长度与清单不一致")
    return WavExport(sample_rate=sample_rate, samples=samples, chunks=tuple(sources))


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
