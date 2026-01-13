import os
import re
import shutil
import subprocess
from typing import List, Optional


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")

_PTS_TIME_RE = re.compile(r"pts_time:(\d+(?:\.\d+)?)")
_SCENE_SCORE_RE = re.compile(r"lavfi\.scene_score=(\d+(?:\.\d+)?)")


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


def extract_video_frame_jpg(
    media_path: str,
    jpg_path: str,
    *,
    timestamp_seconds: float,
    target_width: Optional[int] = None,
) -> None:
    ffmpeg = resolve_ffmpeg_bin()
    cmd: List[str] = [
        ffmpeg,
        "-y",
        "-ss",
        str(float(timestamp_seconds)),
        "-i",
        media_path,
        "-frames:v",
        "1",
        "-q:v",
        "3",
    ]
    if target_width is not None and int(target_width) > 0:
        cmd += ["-vf", f"scale={int(target_width)}:-2"]
    cmd.append(jpg_path)
    os.makedirs(os.path.dirname(jpg_path), exist_ok=True)
    run(cmd)


def get_jpg_dimensions(jpg_path: str) -> tuple[int, int]:
    with open(jpg_path, "rb") as f:
        data = f.read(256 * 1024)

    if len(data) < 4 or data[0:2] != b"\xFF\xD8":
        raise RuntimeError("INVALID_JPG")

    i = 2
    n = len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            i += 1
            continue

        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break

        marker = data[i]
        i += 1

        if marker in (0xD8, 0xD9):
            continue
        if marker == 0xDA:
            break

        if i + 2 > n:
            break
        seg_len = (data[i] << 8) + data[i + 1]
        i += 2
        if seg_len < 2 or i + (seg_len - 2) > n:
            break

        if marker in (
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        ):
            if seg_len < 7:
                break
            h = (data[i + 1] << 8) + data[i + 2]
            w = (data[i + 3] << 8) + data[i + 4]
            if w <= 0 or h <= 0:
                raise RuntimeError("INVALID_JPG_DIM")
            return (w, h)

        i += seg_len - 2

    raise RuntimeError("JPG_DIM_NOT_FOUND")


def detect_scene_changes(
    media_path: str,
    *,
    scene_threshold: float = 0.3,
) -> list[tuple[float, float]]:
    thr = float(scene_threshold)
    if thr <= 0:
        thr = 0.3
    if thr > 1.0:
        thr = 1.0

    ffmpeg = resolve_ffmpeg_bin()
    vf = f"select='gt(scene,{thr})',metadata=print"
    cmd: List[str] = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-i",
        media_path,
        "-vf",
        vf,
        "-an",
        "-f",
        "null",
        "-",
    ]

    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(
            "Command failed:\n"
            f"  cmd: {' '.join(cmd)}\n"
            f"  detail: {detail[:2000]}"
        )

    text = (proc.stderr or "") + "\n" + (proc.stdout or "")
    out: list[tuple[float, float]] = []
    last_pts_time: Optional[float] = None
    for line in text.splitlines():
        m_pts = _PTS_TIME_RE.search(line)
        if m_pts:
            try:
                last_pts_time = float(m_pts.group(1))
            except Exception:
                last_pts_time = None
            continue

        m_score = _SCENE_SCORE_RE.search(line)
        if m_score and last_pts_time is not None:
            try:
                sc = float(m_score.group(1))
                out.append((float(last_pts_time), sc))
            except Exception:
                pass

    return out
