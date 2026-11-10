"""3D-Speaker model components. No ASR or CUDA runtime is loaded here."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import torch
import torchaudio.compliance.kaldi as kaldi
import yaml

from .campplus.DTDNN import CAMPPlus


def read_pcm(directory, start, end):
    directory = Path(directory)
    manifest = json.loads((directory / "audio/manifest.json").read_text())
    if start < 0 or end < start or end > manifest["samples"] or end - start > 160000:
        raise ValueError("Invalid committed audio window")
    parts = []
    for chunk in manifest["chunks"]:
        low, high = max(start, chunk["start"]), min(end, chunk["end"])
        if high > low:
            with (directory / "audio" / chunk["file"]).open("rb") as source:
                source.seek((low - chunk["start"]) * 2)
                data = source.read((high - low) * 2)
            if len(data) != (high - low) * 2:
                raise ValueError("Truncated audio")
            parts.append(np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768)
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


class Models:
    def __init__(self, root: Path, segmentation_dir: Path, threads=2):
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        checkpoint = segmentation_dir / "pytorch_model.bin"
        # Local files are the only input. Fingerprint loaded assets at startup;
        # no preparation command, registry, or downloaded manifest is required.
        files = {name: root / name for name in (
            "campplus/campplus_cn_en_common.pt", "fsmn/config.yaml", "fsmn/model.pt", "fsmn/am.mvn")}
        files["segmentation"] = checkpoint
        hashes = {}
        for name, path in files.items():
            if not path.is_file():
                raise FileNotFoundError(f"Local model file not found: {path}")
            with path.open("rb") as source:
                hashes[name] = hashlib.file_digest(source, "sha256").hexdigest()
        self.tag = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        self.embedding = CAMPPlus(feat_dim=80, embedding_size=192)
        self.embedding.load_state_dict(torch.load(root / "campplus/campplus_cn_en_common.pt",
                                                 map_location="cpu", weights_only=True))
        self.embedding.eval()
        from funasr import AutoModel
        vad_config = yaml.safe_load((root / "fsmn/config.yaml").read_text())
        # Passing model_conf bypasses FunASR's model-hub resolver altogether.
        self.vad = AutoModel(
            model=vad_config["model"], model_conf=vad_config["model_conf"],
            encoder=vad_config["encoder"], encoder_conf=vad_config["encoder_conf"],
            frontend=vad_config["frontend"],
            frontend_conf={**vad_config["frontend_conf"], "cmvn_file": str(root / "fsmn/am.mvn")},
            init_param=str(root / "fsmn/model.pt"), model_path=str(root / "fsmn"),
            device="cpu", ncpu=threads, disable_update=True,
            disable_pbar=True, disable_log=True, trust_remote_code=False)
        from pyannote.audio import Model, Inference
        self.segmentation = Model.from_pretrained(str(checkpoint), map_location="cpu")
        self.segmentation.eval()
        self.inference = Inference(self.segmentation, window="whole", device=torch.device("cpu"))

    def _masks(self, samples):
        regions = self.vad.generate(input=samples, cache={}, is_final=True, fs=16000, disable_pbar=True)
        regions = regions[0].get("value", []) if regions else []
        if len(samples) > 160000:
            raise ValueError("Embedding audio window is too long")
        waveform = torch.from_numpy(np.pad(samples, (0, 160000 - len(samples)))).unsqueeze(0)
        with torch.inference_mode():
            output = np.asarray(self.inference({"waveform": waveform, "sample_rate": 16000}))
        if output.ndim == 3:
            output = output[0]
        frames = self.segmentation.receptive_field
        centers = np.array([frames[i].middle for i in range(len(output))])
        voiced = np.zeros(len(output), dtype=bool)
        for low, high in regions:
            if low >= 0 and high >= 0:
                voiced |= (centers >= low / 1000) & (centers < high / 1000)
        voiced &= centers < len(samples) / 16000
        active = (output >= 0.5) & voiced[:, None]
        clean = active & (active.sum(1) == 1)[:, None]
        return frames, centers, active, clean

    def _clean_samples(self, samples):
        parts = []
        for start in range(0, len(samples), 160000):
            chunk = samples[start:start + 160000]
            if len(chunk) < 400:
                continue
            _, centers, _, clean = self._masks(chunk)
            indices = np.searchsorted(centers, np.arange(len(chunk)) / 16000, side="right") - 1
            indices = np.clip(indices, 0, len(clean) - 1)
            selected = clean.any(1)[indices]
            if selected.any():
                parts.append(chunk[selected])
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def _embed_clean(self, samples):
        features = []
        for offset in range(0, max(1, len(samples) - 12000), 12000):
            clip = samples[offset:offset + 24000]
            if len(clip) < 400:
                continue
            clip = np.tile(clip, -(-24000 // len(clip)))[:24000]
            feature = kaldi.fbank(torch.from_numpy(clip.copy()).unsqueeze(0), num_mel_bins=80,
                                  sample_frequency=16000, dither=0)
            features.append(feature - feature.mean(0, keepdim=True))
        if not features:
            return None
        with torch.inference_mode():
            embeddings = torch.nn.functional.normalize(self.embedding(torch.stack(features)), dim=1)
            mean = embeddings.mean(0)
            return torch.nn.functional.normalize(mean, dim=0).numpy().tolist()

    def embed(self, samples):
        return self._embed_clean(self._clean_samples(samples))

    def window(self, request):
        start, end = int(request["start"]), int(request["end"])
        fresh = max(start, int(request.get("fresh_from", start)))
        samples = read_pcm(request["directory"], start, end)
        if not len(samples):
            return {"model_tag": self.tag, "speakers": [], "turns": [], "start": start, "end": end,
                    "fresh_from": fresh}
        # Stateless VAD per window avoids shared mutable caches across meetings.
        frames, centers, active, clean = self._masks(samples)
        speakers = []
        for local_id in range(active.shape[1]):
            mask = clean[:, local_id]
            indices = np.searchsorted(centers, np.arange(len(samples)) / 16000, side="right") - 1
            indices = np.clip(indices, 0, len(mask) - 1)
            selected = mask[indices]
            audio = samples[selected]
            embedding = self._embed_clean(audio) if len(audio) >= 5600 else None
            new_count = int(np.count_nonzero(selected[max(0, fresh - start):]))
            if active[:, local_id].any():
                speakers.append({"local_id": local_id, "embedding": embedding,
                                 "active_ms": round(float(np.count_nonzero(active[:, local_id]) * frames.step * 1000), 3),
                                 "clean_ms": len(audio) / 16, "fresh_ms": new_count / 16})
        turns = []
        for i, row in enumerate(active):
            ids = np.flatnonzero(row).tolist()
            low = max(start / 16, (start / 16000 + centers[i] - frames.step / 2) * 1000)
            high = min(end / 16, low + frames.step * 1000)
            if not ids or high <= low:
                continue
            if turns and turns[-1]["local_ids"] == ids and low - turns[-1]["end_ms"] < 2:
                turns[-1]["end_ms"] = high
            else:
                turns.append({"start_ms": low, "end_ms": high, "local_ids": ids})
        return {"model_tag": self.tag, "speakers": speakers, "turns": turns, "start": start, "end": end,
                "fresh_from": fresh}

    def embed_archive(self, directory, samples):
        parts = [read_pcm(directory, start, min(start + 160000, samples))
                 for start in range(0, samples, 160000)]
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return self.embed(audio)
