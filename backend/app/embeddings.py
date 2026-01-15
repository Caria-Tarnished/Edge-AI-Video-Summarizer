import hashlib
from typing import Any, Dict, List


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
    model_raw = (model or "").strip()
    model_norm = model_raw.lower()
    dim_i = int(dim)
    if dim_i <= 0:
        raise ValueError("EMBEDDING_DIM_INVALID")

    if model_norm == "hash":
        return [_hash_embedding(t, dim=dim_i) for t in texts]

    if model_norm.startswith("fastembed"):
        model_name = ""
        if ":" in model_raw:
            model_name = model_raw.split(":", 1)[1].strip()
        if not model_name:
            model_name = "BAAI/bge-small-en-v1.5"

        return _embed_texts_fastembed(
            texts,
            model_name=model_name,
            dim=dim_i,
        )

    raise ValueError("EMBEDDING_MODEL_NOT_SUPPORTED")


_fastembed_models: Dict[str, Any] = {}


def _normalize_dim(vec: List[float], dim: int) -> List[float]:
    dim_i = int(dim)
    if len(vec) == dim_i:
        return vec
    if len(vec) > dim_i:
        return vec[:dim_i]
    return vec + [0.0] * (dim_i - len(vec))


def _embed_texts_fastembed(
    texts: List[str],
    *,
    model_name: str,
    dim: int,
) -> List[List[float]]:
    try:
        from fastembed import TextEmbedding  # type: ignore
    except Exception as e:
        raise RuntimeError(
            f"FASTEMBED_NOT_AVAILABLE: {type(e).__name__}: {e}"
        ) from e

    key = (model_name or "").strip()
    if not key:
        raise ValueError("FASTEMBED_MODEL_INVALID")

    emb = _fastembed_models.get(key)
    if emb is None:
        emb = TextEmbedding(model_name=key)
        _fastembed_models[key] = emb

    out: List[List[float]] = []
    for v in emb.embed(texts):
        try:
            vv = v.tolist()  # type: ignore[attr-defined]
        except Exception:
            vv = list(v)
        out.append(_normalize_dim([float(x) for x in vv], dim=int(dim)))
    return out
