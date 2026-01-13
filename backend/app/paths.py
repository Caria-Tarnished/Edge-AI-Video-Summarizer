import os

from .settings import settings


def ensure_dirs() -> None:
    for rel in [
        "data",
        settings.chroma_relpath,
        os.path.join("storage", "audio"),
        os.path.join("storage", "transcripts"),
        os.path.join("storage", "keyframes"),
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


def keyframes_dir(video_id: str) -> str:
    return os.path.join(
        settings.data_dir,
        "storage",
        "keyframes",
        video_id,
    )


def keyframe_jpg_relpath(video_id: str, keyframe_id: str) -> str:
    return os.path.join(
        "storage",
        "keyframes",
        video_id,
        f"{keyframe_id}.jpg",
    )


def keyframe_jpg_abspath(video_id: str, keyframe_id: str) -> str:
    return os.path.join(
        settings.data_dir,
        keyframe_jpg_relpath(video_id, keyframe_id),
    )
