from typing import Any, Dict, Iterable, List


def _ts_srt(seconds: float) -> str:
    ms = int(round(float(seconds) * 1000.0))
    h = ms // 3_600_000
    ms -= h * 3_600_000
    m = ms // 60_000
    ms -= m * 60_000
    s = ms // 1000
    ms -= s * 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_vtt(seconds: float) -> str:
    ms = int(round(float(seconds) * 1000.0))
    h = ms // 3_600_000
    ms -= h * 3_600_000
    m = ms // 60_000
    ms -= m * 60_000
    s = ms // 1000
    ms -= s * 1000
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def segments_to_srt(segments: Iterable[Dict[str, Any]]) -> str:
    lines: List[str] = []
    idx = 0
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue

        idx += 1
        start = _ts_srt(float(seg.get("start") or 0.0))
        end = _ts_srt(float(seg.get("end") or 0.0))
        lines.append(str(idx))
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def segments_to_vtt(segments: Iterable[Dict[str, Any]]) -> str:
    lines: List[str] = ["WEBVTT", ""]
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue

        start = _ts_vtt(float(seg.get("start") or 0.0))
        end = _ts_vtt(float(seg.get("end") or 0.0))
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")

    return "\n".join(lines).strip() + "\n"
