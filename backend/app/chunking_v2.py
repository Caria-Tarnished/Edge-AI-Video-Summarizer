import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple


def sha256_json(obj: Any) -> str:
    s = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _is_natural_boundary(text: str) -> bool:
    """
    判断文本片段是否以自然句读（标点符号）结尾。
    在进行基于时间的 Chunking 时，如果达到目标时间长度且刚好遇到这些标点，就会断句，避免把一句话切断。
    """
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
    """
    【核心 Chunking 逻辑 - 基于时间的策略】
    不同于传统的基于 Token 或字符数的切片 (如 LangChain 的 RecursiveCharacterTextSplitter)，
    由于视频/音频的特殊性，这里的 Chunking 是基于时间跨度的。
    参数说明:
        - target: 期望每个 Chunk 覆盖多长时间的视频内容。
        - max/min: 限制单个 Chunk 时间长度的上下限。
        - overlap: 相邻两个 Chunk 时间上的重叠量，这在 RAG 中非常重要，可以避免关键上下文在切分处丢失。
        - silence_gap: 如果两段语音之间有超过此阈值的静音，也会被视作一个天然的断句边界。
    """
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
