import json
import os
from typing import Any, Dict, Iterable, List, Optional

from .hashing import sha256_file
from .paths import ensure_dirs, transcript_jsonl_path


def load_segments(
    video_id: str,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    path = transcript_jsonl_path(video_id)
    if not os.path.exists(path):
        return []

    segments: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            segments.append(json.loads(line))
            if limit is not None and len(segments) >= limit:
                break
    return segments


def get_last_end_time(video_id: str) -> float:
    path = transcript_jsonl_path(video_id)
    if not os.path.exists(path):
        return 0.0

    last_end = 0.0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                end_t = float(obj.get("end", 0.0))
                if end_t > last_end:
                    last_end = end_t
            except Exception:
                continue
    return last_end


def append_segments(video_id: str, segments: Iterable[Dict[str, Any]]) -> None:
    ensure_dirs()
    path = transcript_jsonl_path(video_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for seg in segments:
            f.write(json.dumps(seg, ensure_ascii=False) + "\n")


def transcript_exists(video_id: str) -> bool:
    return os.path.exists(transcript_jsonl_path(video_id))


def get_transcript_hash(video_id: str) -> str:
    path = transcript_jsonl_path(video_id)
    if not os.path.exists(path):
        return ""
    return sha256_file(path)


def delete_transcript(video_id: str) -> None:
    path = transcript_jsonl_path(video_id)
    try:
        os.remove(path)
    except FileNotFoundError:
        return
