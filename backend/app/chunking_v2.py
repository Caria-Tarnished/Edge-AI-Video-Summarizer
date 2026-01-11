import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple


def sha256_json(obj: Any) -> str:
    s = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _is_natural_boundary(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False

    return t.endswith(
        (
            "\u3002",
            "\uff01",
            "\uff1f",
            ".",
            "!",
            "?",
            "\uff1b",
            ";",
        )
    )


def segments_to_time_chunks(
    segments: List[Dict[str, Any]],
    *,
    target_window_seconds: float,
    max_window_seconds: float,
    min_window_seconds: float,
    overlap_seconds: float,
    silence_gap_seconds: float = 0.8,
) -> List[Dict[str, Any]]:
    segs: List[Tuple[float, float, str]] = []
    for seg in segments:
        start_v = seg.get("start")
        end_v = seg.get("end")
        if start_v is None or end_v is None:
            continue
        try:
            s = float(start_v)
            e = float(end_v)
        except Exception:
            continue
        if e <= s:
            continue
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segs.append((s, e, text))

    if not segs:
        return []

    chunks: List[Dict[str, Any]] = []
    i = 0
    n = len(segs)

    while i < n:
        start_time = segs[i][0]
        end_time = segs[i][1]
        texts = [segs[i][2]]
        last_boundary_j: Optional[int] = None

        j = i
        while True:
            cur_len = end_time - start_time
            if cur_len >= target_window_seconds:
                if _is_natural_boundary(texts[-1]):
                    last_boundary_j = j

                if j + 1 < n:
                    gap = segs[j + 1][0] - segs[j][1]
                    if gap >= silence_gap_seconds:
                        last_boundary_j = j

                if (
                    last_boundary_j is not None
                    and cur_len >= min_window_seconds
                ):
                    j = last_boundary_j
                    end_time = segs[j][1]
                    texts = [t for _, _, t in segs[i:j + 1]]
                    break

            if cur_len >= max_window_seconds:
                break

            if j + 1 >= n:
                break

            j += 1
            end_time = segs[j][1]
            texts.append(segs[j][2])

        chunk_text = " ".join(texts).strip()
        chunks.append(
            {
                "start_time": float(start_time),
                "end_time": float(end_time),
                "text": chunk_text,
            }
        )

        if j + 1 >= n:
            break

        next_start_threshold = float(end_time) - float(overlap_seconds)
        k = j
        while k > i and segs[k - 1][1] > next_start_threshold:
            k -= 1

        i = max(k, i + 1)

    return chunks
