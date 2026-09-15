from __future__ import annotations

import asyncio
import io
import wave


class AudioNotReadyError(RuntimeError):
    """The recording has a container header but no decodable samples yet."""


def is_silent_wav(audio: bytes) -> bool:
    """Recognize digital PCM silence without filtering out quiet speech."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as recording:
            silence = b"\x80" if recording.getsampwidth() == 1 else b"\0"
            frames = recording.readframes(recording.getnframes())
    except (wave.Error, EOFError):
        # Leave unsupported WAV encodings and invalid audio to the model's decoder.
        return False
    return bool(frames) and frames.count(silence) == len(frames)


async def to_wav(audio: bytes, *, timeout: float) -> bytes:
    """Decode a cumulative browser recording into a WAV the model can read."""
    if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        return audio

    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "pipe", "-i", "pipe:0",
            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("FFmpeg is required to decode browser audio; install ffmpeg") from exc

    try:
        pcm, stderr = await asyncio.wait_for(process.communicate(audio), timeout=timeout)
    except TimeoutError as exc:
        raise RuntimeError("Audio decoding timed out") from exc
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()

    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Audio decoding failed: {detail}")
    if not pcm:
        raise AudioNotReadyError("The recording has no audio samples yet")

    # A seekable buffer lets wave write the actual length, including for live fragments.
    output = io.BytesIO()
    with wave.open(output, "wb") as recording:
        recording.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        recording.writeframes(pcm)
    return output.getvalue()
