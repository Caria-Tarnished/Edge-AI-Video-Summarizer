import re
from typing import Any, Dict, List, Optional

from .paths import chroma_dir


class VectorStoreUnavailable(RuntimeError):
    pass


LEGACY_COLLECTION_NAME = "video_chunks"


def _sanitize_collection_part(s: str) -> str:
    v = (s or "").strip().lower()
    v = re.sub(r"[^a-z0-9_-]+", "_", v)
    v = v.strip("_")
    return v or "default"


def chunks_collection_name(embed_model: str, embed_dim: int) -> str:
    m = _sanitize_collection_part(embed_model)
    d = int(embed_dim)
    return f"video_chunks__{m}__d{d}"


def _require_chromadb():
    try:
        import chromadb  # type: ignore
        from chromadb.api.models.Collection import Collection  # type: ignore

        return chromadb, Collection
    except Exception as e:
        raise VectorStoreUnavailable("CHROMADB_NOT_AVAILABLE") from e


_client: Any = None


def get_client():
    global _client
    if _client is not None:
        return _client

    chromadb, _ = _require_chromadb()
    try:
        _client = chromadb.PersistentClient(path=chroma_dir())
        return _client
    except Exception as e:
        _client = None
        raise VectorStoreUnavailable("CHROMADB_CLIENT_FAILED") from e


def get_collection(name: str):
    try:
        client = get_client()
        return client.get_or_create_collection(name=name)
    except VectorStoreUnavailable:
        raise
    except Exception as e:
        raise VectorStoreUnavailable("CHROMADB_COLLECTION_FAILED") from e


def get_collection_existing(name: str):
    try:
        client = get_client()
        return client.get_collection(name=name)
    except VectorStoreUnavailable:
        raise
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "does not exist" in msg:
            raise VectorStoreUnavailable(
                "CHROMADB_COLLECTION_NOT_FOUND"
            ) from e
        raise VectorStoreUnavailable("CHROMADB_COLLECTION_FAILED") from e


def delete_video_vectors(*, collection_name: str, video_id: str) -> None:
    try:
        col = get_collection(collection_name)
        col.delete(where={"video_id": video_id})
    except VectorStoreUnavailable:
        raise
    except Exception as e:
        raise VectorStoreUnavailable("CHROMADB_DELETE_FAILED") from e


def upsert_vectors(
    *,
    collection_name: str,
    ids: List[str],
    documents: List[str],
    embeddings: List[List[float]],
    metadatas: List[Dict[str, Any]],
) -> None:
    try:
        col = get_collection(collection_name)
        col.upsert(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas,
        )
    except VectorStoreUnavailable:
        raise
    except Exception as e:
        raise VectorStoreUnavailable("CHROMADB_UPSERT_FAILED") from e


def query_vectors(
    *,
    collection_name: str,
    query_embedding: List[float],
    top_k: int,
    where: Optional[Dict[str, Any]] = None,
    create_if_missing: bool = True,
) -> Dict[str, Any]:
    try:
        if create_if_missing:
            col = get_collection(collection_name)
        else:
            try:
                col = get_collection_existing(collection_name)
            except VectorStoreUnavailable as e:
                if str(e) == "CHROMADB_COLLECTION_NOT_FOUND":
                    return {
                        "ids": [[]],
                        "documents": [[]],
                        "metadatas": [[]],
                        "distances": [[]],
                        "_collection_missing": True,
                    }
                raise
        res = col.query(
            query_embeddings=[query_embedding],
            n_results=int(top_k),
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        return res
    except VectorStoreUnavailable:
        raise
    except Exception as e:
        raise VectorStoreUnavailable("CHROMADB_QUERY_FAILED") from e
