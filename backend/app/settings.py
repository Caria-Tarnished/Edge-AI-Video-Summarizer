import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    data_dir: str = os.getenv(
        "EDGE_VIDEO_AGENT_DATA_DIR",
        os.path.join(os.path.expanduser("~"), ".edge-video-agent"),
    )
    db_relpath: str = os.getenv("EDGE_VIDEO_AGENT_DB", "data/database.db")

    chroma_relpath: str = os.getenv(
        "EDGE_VIDEO_AGENT_CHROMA_DIR",
        os.path.join("data", "chromadb"),
    )

    asr_model: str = os.getenv("ASR_MODEL", "small")
    asr_device: str = os.getenv("ASR_DEVICE", "cpu")
    asr_compute_type: str = os.getenv("ASR_COMPUTE_TYPE", "int8")
    asr_language: str = os.getenv("ASR_LANGUAGE", "zh")

    segment_seconds: int = int(os.getenv("ASR_SEGMENT_SECONDS", "60"))
    overlap_seconds: int = int(os.getenv("ASR_OVERLAP_SECONDS", "3"))

    index_target_window_seconds: float = float(
        os.getenv("INDEX_TARGET_WINDOW_SECONDS", "45")
    )
    index_max_window_seconds: float = float(
        os.getenv("INDEX_MAX_WINDOW_SECONDS", "60")
    )
    index_min_window_seconds: float = float(
        os.getenv("INDEX_MIN_WINDOW_SECONDS", "20")
    )
    index_overlap_seconds: float = float(
        os.getenv("INDEX_OVERLAP_SECONDS", "5")
    )

    embedding_model: str = os.getenv("EMBEDDING_MODEL", "hash")
    embedding_dim: int = int(os.getenv("EMBEDDING_DIM", "384"))

    enable_cloud_summary: bool = os.getenv("ENABLE_CLOUD_SUMMARY", "0") in (
        "1",
        "true",
        "True",
        "yes",
        "YES",
    )
    dashscope_api_key: str = os.getenv("DASHSCOPE_API_KEY", "")
    cloud_llm_model: str = os.getenv("CLOUD_LLM_MODEL", "qwen-plus")


settings = Settings()
