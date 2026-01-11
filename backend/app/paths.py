import os

from .settings import settings


def ensure_dirs() -> None:
    for rel in [
        "data",
        settings.chroma_relpath,
        os.path.join("storage", "audio"),
        os.path.join("storage", "transcripts"),
        "logs",
    ]:
        os.makedirs(os.path.join(settings.data_dir, rel), exist_ok=True)


def db_path() -> str:
    return os.path.join(settings.data_dir, settings.db_relpath)


def chroma_dir() -> str:
    return os.path.join(settings.data_dir, settings.chroma_relpath)


def transcript_jsonl_path(video_id: str) -> str:
    return os.path.join(
        settings.data_dir,
        "storage",
        "transcripts",
        f"{video_id}.jsonl",
    )


def audio_wav_path(video_id: str) -> str:
    return os.path.join(
        settings.data_dir,
        "storage",
        "audio",
        f"{video_id}.wav",
    )
