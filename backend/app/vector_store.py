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

        return chromadb
    except Exception as e:
        raise VectorStoreUnavailable(
            f"CHROMADB_NOT_AVAILABLE: {type(e).__name__}: {e}"
        ) from e


_client: Any = None


def get_client():
    """
    【向量数据库客户端初始化】
    获取 ChromaDB 持久化客户端实例，数据保存在本地 `.chroma` 目录中。
    使用单例模式 `_client` 避免重复初始化。
    """
    global _client
    if _client is not None:
        return _client

    chromadb = _require_chromadb()
    try:
        _client = chromadb.PersistentClient(path=chroma_dir())
        return _client
    except Exception as e:
        _client = None
        raise VectorStoreUnavailable(
            f"CHROMADB_CLIENT_FAILED: {type(e).__name__}: {e}"
        ) from e


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
    """
    【向量入库】
    将处理好的 Chunks (文本片段 + 对应的向量表示 + 元数据) 插入到指定的 ChromaDB 集合中。
    `upsert` 表示如果 ID 存在则更新，不存在则插入。
    此函数被 `worker.py` 的 `_run_index` 任务调用。
    """
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
    """
    【向量检索 (相似度搜索)】
    核心 Retrieval 函数：给定用户 Query 的向量 `query_embedding`，
    在 ChromaDB 中找出距离最近（最相似）的 `top_k` 个文本块。
    支持附加过滤条件 `where` (比如只搜索特定 video_id 下的文本块)。
    被 `main.py` 的 `/chat` 和 `/search` 接口调用。
    """
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
