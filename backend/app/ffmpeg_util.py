import os
import re
import shutil
import subprocess
from typing import List, Optional


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def resolve_ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found

    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def resolve_ffprobe_bin() -> Optional[str]:
    return shutil.which("ffprobe")


def run(cmd: List[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        detail = (e.stderr or e.stdout or "").strip()
        raise RuntimeError(
            "Command failed:\n"
            f"  cmd: {' '.join(cmd)}\n"
            f"  detail: {detail[:2000]}"
        ) from e


def get_duration_seconds(media_path: str) -> float:
    ffprobe = resolve_ffprobe_bin()
    if ffprobe:
        out = run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                media_path,
            ]
        ).stdout.strip()
        return float(out)

    ffmpeg = resolve_ffmpeg_bin()
    proc = subprocess.run(
        [ffmpeg, "-i", media_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    m = _DURATION_RE.search(proc.stderr or "")
    if not m:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"Unable to parse duration: {detail[:2000]}")

    hours = int(m.group(1))
    minutes = int(m.group(2))
    seconds = float(m.group(3))
    return hours * 3600 + minutes * 60 + seconds


def extract_audio_wav(
    media_path: str,
    wav_path: str,
    start_seconds: float = 0.0,
    duration_seconds: Optional[float] = None,
) -> None:
    ffmpeg = resolve_ffmpeg_bin()
    cmd: List[str] = [ffmpeg, "-y"]
    if start_seconds and start_seconds > 0:
        cmd += ["-ss", str(start_seconds)]
    cmd += ["-i", media_path]
    if duration_seconds is not None:
        cmd += ["-t", str(duration_seconds)]
    cmd += [
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        wav_path,
    ]
    os.makedirs(os.path.dirname(wav_path), exist_ok=True)
    run(cmd)
