import hashlib
from typing import List


def _hash_embedding(text: str, dim: int) -> List[float]:
    b = hashlib.sha256((text or "").encode("utf-8")).digest()
    out: List[float] = []
    n = len(b)
    for i in range(int(dim)):
        v = b[i % n]
        out.append((float(v) - 128.0) / 128.0)
    return out


def embed_texts(
    texts: List[str],
    *,
    model: str,
    dim: int,
) -> List[List[float]]:
    model = (model or "").strip().lower()
    if model != "hash":
        raise ValueError("EMBEDDING_MODEL_NOT_SUPPORTED")

    return [_hash_embedding(t, dim=int(dim)) for t in texts]
