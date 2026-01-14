import asyncio
import json
import mimetypes
import os
import threading
from typing import Any, Dict, Optional

from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi import WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from .cloud_summary import summarize
from .db import init_db
from .ffmpeg_util import get_duration_seconds
from .hashing import sha256_file
from .llm_provider import (
    ChatMessage,
    LLMPreferences,
    get_provider,
    list_providers,
)
from .repo import (
    cancel_job,
    create_job,
    create_or_get_video,
    delete_chunks_for_video,
    delete_video_keyframe_index,
    delete_video_keyframes_for_video,
    delete_video_summary,
    delete_video_index,
    get_default_llm_preferences,
    get_default_runtime_preferences,
    get_active_job_for_video,
    get_job,
    get_video,
    get_video_index,
    get_video_keyframe,
    get_video_keyframe_index,
    get_nearest_video_keyframe,
    get_video_summary,
    list_chunks,
    list_video_keyframes,
    list_jobs,
    list_videos,
    recover_incomplete_state,
    reset_job,
    set_default_llm_preferences,
    set_default_runtime_preferences,
    set_video_status,
)
from .paths import keyframes_dir
from .runtime import (
    apply_runtime_preferences,
    get_effective_runtime_preferences,
    limit_llm,
    refresh_runtime_preferences,
)
from .settings import settings
from .subtitle import segments_to_srt, segments_to_vtt
from .transcript_store import (
    delete_transcript,
    get_transcript_hash,
    load_segments,
    transcript_exists,
)
from .vector_store import (
    LEGACY_COLLECTION_NAME,
    VectorStoreUnavailable,
    chunks_collection_name,
    delete_video_vectors,
    query_vectors,
)
from .embeddings import embed_texts
from .worker import JobWorker


class UTF8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


def _probe_openai_models(base_url: str) -> Dict[str, Any]:
    url = str(base_url or "").rstrip("/") + "/models"
    req = UrlRequest(url, method="GET")
    try:
        with urlopen(req, timeout=2.5) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        obj = json.loads(raw or "{}")
        items = obj.get("data") or []
        models = []
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict) and it.get("id") is not None:
                    models.append(str(it.get("id")))
        return {
            "ok": True,
            "models": models,
        }
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "error": f"HTTP_{e.code}:{detail[:500]}",
        }
    except TimeoutError:
        return {
            "ok": False,
            "error": "TIMEOUT",
        }
    except URLError as e:
        return {
            "ok": False,
            "error": f"URL_ERROR:{e}",
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"ERROR:{type(e).__name__}:{e}",
        }


class ImportVideoRequest(BaseModel):
    file_path: str


class CreateTranscribeJobRequest(BaseModel):
    video_id: str
    segment_seconds: Optional[int] = None
    overlap_seconds: Optional[int] = None
    from_scratch: bool = False


class CreateIndexJobRequest(BaseModel):
    from_scratch: bool = True
    embed_model: Optional[str] = None
    embed_dim: Optional[int] = None
    target_window_seconds: Optional[float] = None
    max_window_seconds: Optional[float] = None
    min_window_seconds: Optional[float] = None
    overlap_seconds: Optional[float] = None


class CreateSummarizeJobRequest(BaseModel):
    from_scratch: bool = False
    target_window_seconds: Optional[float] = None
    max_window_seconds: Optional[float] = None
    min_window_seconds: Optional[float] = None
    overlap_seconds: Optional[float] = None


class CreateKeyframesJobRequest(BaseModel):
    from_scratch: bool = False
    mode: str = "interval"
    interval_seconds: Optional[float] = None
    scene_threshold: Optional[float] = None
    min_gap_seconds: Optional[float] = None
    max_frames: Optional[int] = None
    target_width: Optional[int] = None


class ChatRequest(BaseModel):
    video_id: str
    query: str
    top_k: int = 5
    stream: bool = False
    confirm_send: bool = False


class CloudSummaryRequest(BaseModel):
    text: str
    api_key: Optional[str] = None
    confirm_send: bool = False


class LLMDefaultPreferencesRequest(BaseModel):
    provider: str = "fake"
    model: Optional[str] = None
    temperature: float = 0.2
    max_tokens: int = 512


class RuntimeProfileRequest(BaseModel):
    profile: Optional[str] = None
    asr_concurrency: Optional[int] = None
    llm_concurrency: Optional[int] = None
    llm_timeout_seconds: Optional[int] = None
    asr_device: Optional[str] = None
    asr_compute_type: Optional[str] = None


class RetryJobRequest(BaseModel):
    from_scratch: bool = False


app = FastAPI(
    title="Edge Video Agent Backend",
    default_response_class=UTF8JSONResponse,
)

_cors_raw = str(os.getenv("EDGE_VIDEO_AGENT_CORS_ORIGINS", "") or "").strip()
if _cors_raw:
    _cors_origins = [
        s.strip() for s in _cors_raw.split(",") if str(s or "").strip()
    ]
    if _cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=_cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

_worker: Optional[JobWorker] = None
_worker_thread: Optional[threading.Thread] = None


@app.on_event("startup")
def _startup() -> None:
    global _worker
    global _worker_thread

    init_db()
    recover_incomplete_state()
    refresh_runtime_preferences()

    if os.getenv("EDGE_VIDEO_AGENT_DISABLE_WORKER", "0") in (
        "1",
        "true",
        "True",
        "yes",
        "YES",
    ):
        return
    _worker = JobWorker()
    _worker_thread = threading.Thread(target=_worker.run_forever, daemon=True)
    _worker_thread.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _worker is not None:
        _worker.stop()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "data_dir": settings.data_dir,
        "cloud_summary_default": bool(settings.enable_cloud_summary),
    }


@app.get("/llm/preferences/default")
def get_llm_default_preferences_api() -> Dict[str, Any]:
    return {
        "preferences": get_default_llm_preferences(),
    }


@app.get("/llm/providers")
def list_llm_providers_api() -> Dict[str, Any]:
    return {
        "providers": ["none"] + list_providers(),
    }


@app.get("/llm/local/status")
def llm_local_status_api() -> Dict[str, Any]:
    base_url = str(settings.llm_local_base_url or "").rstrip("/")
    res = _probe_openai_models(base_url)
    return {
        "provider": "openai_local",
        "base_url": base_url,
        "default_model": str(settings.llm_local_model or ""),
        **res,
    }


@app.put("/llm/preferences/default")
def set_llm_default_preferences_api(
    req: LLMDefaultPreferencesRequest,
) -> Dict[str, Any]:
    prefs = {
        "provider": str(req.provider or "").strip(),
        "model": req.model,
        "temperature": float(req.temperature),
        "max_tokens": int(req.max_tokens),
    }
    return {
        "preferences": set_default_llm_preferences(prefs),
    }


@app.get("/runtime/profile")
def get_runtime_profile_api() -> Dict[str, Any]:
    prefs = get_default_runtime_preferences()
    return {
        "preferences": prefs,
        "effective": get_effective_runtime_preferences(prefs),
    }


@app.put("/runtime/profile")
def set_runtime_profile_api(req: RuntimeProfileRequest) -> Dict[str, Any]:
    prefs: Dict[str, Any] = dict(get_default_runtime_preferences())
    if req.profile is not None:
        prefs["profile"] = str(req.profile or "balanced").strip().lower()
    if req.asr_concurrency is not None:
        prefs["asr_concurrency"] = int(req.asr_concurrency)
    if req.llm_concurrency is not None:
        prefs["llm_concurrency"] = int(req.llm_concurrency)
    if req.llm_timeout_seconds is not None:
        prefs["llm_timeout_seconds"] = int(req.llm_timeout_seconds)
    if req.asr_device is not None:
        prefs["asr_device"] = str(req.asr_device or "").strip()
    if req.asr_compute_type is not None:
        prefs["asr_compute_type"] = str(req.asr_compute_type or "").strip()

    stored = set_default_runtime_preferences(prefs)
    effective = apply_runtime_preferences(stored)
    return {
        "preferences": stored,
        "effective": effective,
    }


@app.post("/videos/import")
def import_video(req: ImportVideoRequest) -> Dict[str, Any]:
    path = req.file_path
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=400, detail="FILE_NOT_FOUND")

    duration = get_duration_seconds(path)
    file_hash = sha256_file(path)
    video = create_or_get_video(path, file_hash, duration)
    return video


@app.get("/videos/{video_id}")
def get_video_api(video_id: str) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    return video


@app.get("/videos/{video_id}/file")
def get_video_file_api(video_id: str) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    path = str(video.get("file_path") or "")
    if not path:
        raise HTTPException(status_code=404, detail="VIDEO_FILE_NOT_FOUND")

    abspath = os.path.abspath(path)
    if not os.path.exists(abspath):
        raise HTTPException(status_code=404, detail="VIDEO_FILE_NOT_FOUND")

    media_type = mimetypes.guess_type(abspath)[0] or "application/octet-stream"
    return FileResponse(
        path=abspath,
        media_type=media_type,
        headers={"Accept-Ranges": "bytes"},
    )


@app.get("/videos")
def list_videos_api(
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    return list_videos(status=status, limit=limit, offset=offset)


@app.post("/jobs/transcribe")
def create_transcribe_job(req: CreateTranscribeJobRequest) -> Dict[str, Any]:
    video = get_video(req.video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    params: Dict[str, Any] = {}
    if req.segment_seconds is not None:
        params["segment_seconds"] = int(req.segment_seconds)
    if req.overlap_seconds is not None:
        params["overlap_seconds"] = int(req.overlap_seconds)

    if req.from_scratch:
        params["from_scratch"] = True

    job = create_job(req.video_id, "transcribe", params)
    return job


@app.post("/videos/{video_id}/index")
def create_index_job(video_id: str, req: CreateIndexJobRequest) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    if not transcript_exists(video_id):
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")
    segs = load_segments(video_id, limit=1)
    if not segs:
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")

    existing = get_active_job_for_video(
        video_id=video_id,
        job_type="index",
    )
    if existing:
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "INDEXING_IN_PROGRESS",
                "job_id": existing["id"],
                "video_id": video_id,
            },
        )

    idx = get_video_index(video_id)
    current_transcript_hash = get_transcript_hash(video_id)
    if idx and str(idx.get("status") or "") == "completed":
        idx_hash = str(idx.get("transcript_hash") or "")
        if (
            idx_hash
            and current_transcript_hash
            and idx_hash == current_transcript_hash
            and not bool(req.from_scratch)
        ):
            return UTF8JSONResponse(
                status_code=200,
                content={
                    "detail": "INDEX_ALREADY_COMPLETED",
                    "video_id": video_id,
                    "index": idx,
                },
            )

    from_scratch = bool(req.from_scratch)
    if idx and str(idx.get("status") or "") == "completed":
        idx_hash = str(idx.get("transcript_hash") or "")
        if current_transcript_hash and idx_hash != current_transcript_hash:
            from_scratch = True

    params: Dict[str, Any] = {"from_scratch": from_scratch}
    if req.embed_model is not None:
        params["embed_model"] = str(req.embed_model)
    if req.embed_dim is not None:
        params["embed_dim"] = int(req.embed_dim)
    if req.target_window_seconds is not None:
        params["target_window_seconds"] = float(req.target_window_seconds)
    if req.max_window_seconds is not None:
        params["max_window_seconds"] = float(req.max_window_seconds)
    if req.min_window_seconds is not None:
        params["min_window_seconds"] = float(req.min_window_seconds)
    if req.overlap_seconds is not None:
        params["overlap_seconds"] = float(req.overlap_seconds)

    job = create_job(video_id, "index", params)
    return UTF8JSONResponse(
        status_code=202,
        content={
            "detail": "INDEXING_STARTED",
            "job_id": job["id"],
            "video_id": video_id,
        },
    )


@app.get("/videos/{video_id}/index")
def get_index_status(video_id: str) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    current_transcript_hash = get_transcript_hash(video_id)
    idx = get_video_index(video_id)
    if not idx:
        return {
            "video_id": video_id,
            "status": "not_indexed",
            "current_transcript_hash": current_transcript_hash,
            "is_stale": False,
        }

    out = dict(idx)
    out["current_transcript_hash"] = current_transcript_hash
    out["is_stale"] = False
    if str(out.get("status") or "") == "completed" and current_transcript_hash:
        idx_hash = str(out.get("transcript_hash") or "")
        if idx_hash != current_transcript_hash:
            out["is_stale"] = True
    return out


@app.post("/videos/{video_id}/summarize")
def create_summarize_job(
    video_id: str,
    req: CreateSummarizeJobRequest,
) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    if not transcript_exists(video_id):
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")
    segs = load_segments(video_id, limit=1)
    if not segs:
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")

    existing = get_active_job_for_video(
        video_id=video_id,
        job_type="summarize",
    )
    if existing:
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "SUMMARIZING_IN_PROGRESS",
                "job_id": existing["id"],
                "video_id": video_id,
            },
        )

    summary = get_video_summary(video_id)
    current_transcript_hash = get_transcript_hash(video_id)
    if summary and str(summary.get("status") or "") == "completed":
        s_hash = str(summary.get("transcript_hash") or "")
        if (
            s_hash
            and current_transcript_hash
            and s_hash == current_transcript_hash
            and not bool(req.from_scratch)
        ):
            return UTF8JSONResponse(
                status_code=200,
                content={
                    "detail": "SUMMARY_ALREADY_COMPLETED",
                    "video_id": video_id,
                    "summary": summary,
                },
            )

    from_scratch = bool(req.from_scratch)
    if summary and str(summary.get("status") or "") == "completed":
        s_hash = str(summary.get("transcript_hash") or "")
        if current_transcript_hash and s_hash != current_transcript_hash:
            from_scratch = True

    params: Dict[str, Any] = {"from_scratch": from_scratch}
    if req.target_window_seconds is not None:
        params["target_window_seconds"] = float(req.target_window_seconds)
    if req.max_window_seconds is not None:
        params["max_window_seconds"] = float(req.max_window_seconds)
    if req.min_window_seconds is not None:
        params["min_window_seconds"] = float(req.min_window_seconds)
    if req.overlap_seconds is not None:
        params["overlap_seconds"] = float(req.overlap_seconds)

    job = create_job(video_id, "summarize", params)
    return UTF8JSONResponse(
        status_code=202,
        content={
            "detail": "SUMMARIZE_STARTED",
            "job_id": job["id"],
            "video_id": video_id,
        },
    )


@app.get("/videos/{video_id}/summary")
def get_summary(video_id: str) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    current_transcript_hash = get_transcript_hash(video_id)
    summary = get_video_summary(video_id)
    if not summary:
        return {
            "video_id": video_id,
            "status": "not_summarized",
            "current_transcript_hash": current_transcript_hash,
            "is_stale": False,
        }

    out = dict(summary)
    out["current_transcript_hash"] = current_transcript_hash
    out["is_stale"] = False
    if str(out.get("status") or "") == "completed" and current_transcript_hash:
        s_hash = str(out.get("transcript_hash") or "")
        if s_hash != current_transcript_hash:
            out["is_stale"] = True

    try:
        out["segment_summaries"] = json.loads(
            str(out.get("segment_summaries_json") or "[]")
        )
    except Exception:
        out["segment_summaries"] = []

    return out


@app.get("/videos/{video_id}/outline")
def get_outline(video_id: str) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    summary = get_video_summary(video_id)
    if not summary:
        raise HTTPException(status_code=404, detail="SUMMARY_NOT_FOUND")

    out: Dict[str, Any] = {
        "video_id": video_id,
        "status": str(summary.get("status") or ""),
        "progress": float(summary.get("progress") or 0.0),
        "message": str(summary.get("message") or ""),
    }

    try:
        out["outline"] = json.loads(str(summary.get("outline_json") or "[]"))
    except Exception:
        out["outline"] = {"raw": str(summary.get("outline_json") or "")}

    return out


@app.get("/videos/{video_id}/export/markdown")
def export_summary_markdown(video_id: str) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    summary = get_video_summary(video_id)
    if not summary:
        raise HTTPException(status_code=404, detail="SUMMARY_NOT_FOUND")

    if str(summary.get("status") or "") != "completed":
        raise HTTPException(status_code=400, detail="SUMMARY_NOT_COMPLETED")

    body = str(summary.get("summary_markdown") or "")
    if not body.strip():
        raise HTTPException(status_code=404, detail="SUMMARY_EMPTY")

    return Response(content=body, media_type="text/markdown; charset=utf-8")


@app.post("/videos/{video_id}/keyframes")
def create_keyframes_job(
    video_id: str,
    req: CreateKeyframesJobRequest,
) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    existing = get_active_job_for_video(
        video_id=video_id,
        job_type="keyframes",
    )
    if existing:
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "KEYFRAMES_IN_PROGRESS",
                "job_id": existing["id"],
                "video_id": video_id,
            },
        )

    if bool(req.from_scratch):
        delete_video_keyframes_for_video(video_id)
        delete_video_keyframe_index(video_id)
        d = keyframes_dir(video_id)
        if os.path.isdir(d):
            for name in os.listdir(d):
                if not str(name).lower().endswith(".jpg"):
                    continue
                try:
                    os.remove(os.path.join(d, name))
                except Exception:
                    pass

    def _normalize_keyframes_params(obj: Dict[str, Any]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        out["mode"] = str(obj.get("mode") or "interval").strip() or "interval"

        if out["mode"] == "scene":
            if obj.get("scene_threshold") is not None:
                out["scene_threshold"] = float(obj.get("scene_threshold"))
            if obj.get("min_gap_seconds") is not None:
                out["min_gap_seconds"] = float(obj.get("min_gap_seconds"))
        else:
            if obj.get("interval_seconds") is not None:
                out["interval_seconds"] = float(obj.get("interval_seconds"))

        if obj.get("max_frames") is not None:
            out["max_frames"] = int(obj.get("max_frames"))
        if obj.get("target_width") is not None:
            out["target_width"] = int(obj.get("target_width"))
        return out

    params: Dict[str, Any] = {
        "mode": str(req.mode or "interval").strip() or "interval",
    }
    if req.interval_seconds is not None:
        params["interval_seconds"] = float(req.interval_seconds)
    if req.scene_threshold is not None:
        params["scene_threshold"] = float(req.scene_threshold)
    if req.min_gap_seconds is not None:
        params["min_gap_seconds"] = float(req.min_gap_seconds)
    if req.max_frames is not None:
        params["max_frames"] = int(req.max_frames)
    if req.target_width is not None:
        params["target_width"] = int(req.target_width)
    if bool(req.from_scratch):
        params["from_scratch"] = True

    idx = get_video_keyframe_index(video_id)
    if (
        idx
        and str(idx.get("status") or "") == "completed"
        and not bool(req.from_scratch)
    ):
        stored_params: Dict[str, Any] = {}
        try:
            stored_obj = json.loads(str(idx.get("params_json") or "{}"))
            stored_params = stored_obj if isinstance(stored_obj, dict) else {}
        except Exception:
            stored_params = {}

        if (
            _normalize_keyframes_params(stored_params)
            == _normalize_keyframes_params(params)
        ):
            return UTF8JSONResponse(
                status_code=200,
                content={
                    "detail": "KEYFRAMES_ALREADY_COMPLETED",
                    "video_id": video_id,
                    "index": idx,
                },
            )

    job = create_job(video_id, "keyframes", params)
    return UTF8JSONResponse(
        status_code=202,
        content={
            "detail": "KEYFRAMES_STARTED",
            "job_id": job["id"],
            "video_id": video_id,
        },
    )


@app.get("/videos/{video_id}/keyframes/index")
def get_keyframes_index_api(video_id: str) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    idx = get_video_keyframe_index(video_id)
    if not idx:
        return {
            "video_id": video_id,
            "status": "not_indexed",
            "progress": 0.0,
            "message": "",
        }
    return dict(idx)


@app.get("/videos/{video_id}/keyframes")
def list_keyframes_api(
    video_id: str,
    method: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    m = str(method or "").strip() or None
    res = list_video_keyframes(
        video_id=video_id,
        method=m,
        limit=limit,
        offset=offset,
    )
    items = res.get("items") or []
    for it in items:
        kid = str(it.get("id") or "")
        it["image_url"] = f"/videos/{video_id}/keyframes/{kid}/image"
    return {"total": res.get("total") or 0, "items": items}


@app.get("/videos/{video_id}/keyframes/nearest")
def nearest_keyframe_api(
    video_id: str,
    timestamp_ms: int,
    method: str = "interval",
) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    method = str(method or "").strip() or "interval"
    row = get_nearest_video_keyframe(
        video_id=video_id,
        timestamp_ms=int(timestamp_ms),
        method=method,
    )
    if not row:
        raise HTTPException(status_code=404, detail="KEYFRAME_NOT_FOUND")

    kid = str(row.get("id") or "")
    out = dict(row)
    out["image_url"] = f"/videos/{video_id}/keyframes/{kid}/image"
    return out


@app.get("/videos/{video_id}/keyframes/{keyframe_id}/image")
def get_keyframe_image_api(video_id: str, keyframe_id: str) -> Response:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    row = get_video_keyframe(keyframe_id)
    if not row:
        raise HTTPException(status_code=404, detail="KEYFRAME_NOT_FOUND")
    if str(row.get("video_id") or "") != str(video_id):
        raise HTTPException(status_code=404, detail="KEYFRAME_NOT_FOUND")

    rel = str(row.get("image_relpath") or "")
    if not rel:
        raise HTTPException(status_code=404, detail="KEYFRAME_IMAGE_NOT_FOUND")
    abspath = os.path.join(settings.data_dir, rel)
    if not os.path.exists(abspath):
        raise HTTPException(status_code=404, detail="KEYFRAME_IMAGE_NOT_FOUND")
    return FileResponse(path=abspath, media_type="image/jpeg")


@app.get("/videos/{video_id}/keyframes/aligned")
def aligned_keyframes_api(
    video_id: str,
    method: str = "interval",
    per_section: int = 2,
    min_gap_seconds: float = 2.0,
    fallback: str = "none",
) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    per_section = max(1, min(int(per_section), 10))
    method = str(method or "interval").strip() or "interval"
    if method not in ("interval", "scene"):
        raise HTTPException(
            status_code=400,
            detail="UNSUPPORTED_KEYFRAMES_METHOD",
        )

    fallback = str(fallback or "none").strip() or "none"
    if fallback not in ("none", "nearest"):
        raise HTTPException(status_code=400, detail="UNSUPPORTED_FALLBACK")

    min_gap_ms = int(round(max(0.0, float(min_gap_seconds)) * 1000.0))

    summary = get_video_summary(video_id)
    if not summary:
        raise HTTPException(status_code=404, detail="SUMMARY_NOT_FOUND")

    try:
        outline = json.loads(str(summary.get("outline_json") or "[]"))
    except Exception:
        outline = []

    frames_res = list_video_keyframes(
        video_id=video_id,
        method=method,
        limit=500,
        offset=0,
    )
    frames = frames_res.get("items") or []

    all_frames: list[Dict[str, Any]] = []
    if method == "scene" and fallback == "nearest":
        all_frames_res = list_video_keyframes(
            video_id=video_id,
            method=None,
            limit=2000,
            offset=0,
        )
        all_frames = all_frames_res.get("items") or []

    out_items = []
    for sec in outline if isinstance(outline, list) else []:
        sec_obj = sec if isinstance(sec, dict) else {}
        st = float(sec_obj.get("start_time") or 0.0)
        et = float(sec_obj.get("end_time") or 0.0)
        st_ms = int(round(st * 1000.0))
        et_ms = int(round(et * 1000.0))
        if et_ms < st_ms:
            st_ms, et_ms = et_ms, st_ms

        in_range = [
            f
            for f in frames
            if st_ms <= int(f.get("timestamp_ms") or 0) <= et_ms
        ]

        picked = []
        if in_range:
            if method == "scene":
                ranked = sorted(
                    in_range,
                    key=lambda f: float(f.get("score") or 0.0),
                    reverse=True,
                )
                sel = []
                for f in ranked:
                    if len(sel) >= per_section:
                        break
                    ts0 = int(f.get("timestamp_ms") or 0)
                    if min_gap_ms > 0:
                        too_close = any(
                            abs(ts0 - int(x.get("timestamp_ms") or 0))
                            < min_gap_ms
                            for x in sel
                        )
                        if too_close:
                            continue
                    sel.append(f)
                picked = sorted(
                    sel,
                    key=lambda f: int(f.get("timestamp_ms") or 0),
                )
            else:
                if len(in_range) <= per_section:
                    picked = in_range
                else:
                    for j in range(per_section):
                        idx = int(
                            round(
                                j
                                * (len(in_range) - 1)
                                / max(per_section - 1, 1)
                            )
                        )
                        picked.append(in_range[idx])

        if (
            method == "scene"
            and fallback == "nearest"
            and len(picked) < per_section
            and all_frames
        ):
            mid_ms = int(round((st_ms + et_ms) / 2.0))
            pool = [
                f
                for f in all_frames
                if f.get("id") is not None
            ]
            pool.sort(
                key=lambda f: abs(
                    int(f.get("timestamp_ms") or 0) - mid_ms
                )
            )
            sel2 = list(picked)
            for f in pool:
                if len(sel2) >= per_section:
                    break
                fid = str(f.get("id") or "")
                if any(str(x.get("id") or "") == fid for x in sel2):
                    continue
                ts0 = int(f.get("timestamp_ms") or 0)
                if min_gap_ms > 0:
                    too_close = any(
                        abs(ts0 - int(x.get("timestamp_ms") or 0))
                        < min_gap_ms
                        for x in sel2
                    )
                    if too_close:
                        continue
                sel2.append(f)
            picked = sorted(
                sel2,
                key=lambda f: int(f.get("timestamp_ms") or 0),
            )

        kfs = []
        for f in picked:
            kid = str(f.get("id") or "")
            sc: Any = f.get("score")
            kfs.append(
                {
                    "id": kid,
                    "timestamp_ms": int(f.get("timestamp_ms") or 0),
                    "image_url": f"/videos/{video_id}/keyframes/{kid}/image",
                    "score": float(sc) if sc is not None else None,
                }
            )

        out_items.append(
            {
                "title": sec_obj.get("title"),
                "start_time": st,
                "end_time": et,
                "keyframes": kfs,
            }
        )

    return {"video_id": video_id, "items": out_items}


@app.get("/videos/{video_id}/chunks")
def list_chunks_api(
    video_id: str,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")
    return list_chunks(video_id=video_id, limit=limit, offset=offset)


@app.get("/search")
def search_api(
    query: str,
    video_id: str,
    top_k: int = 5,
) -> Response:
    q = (query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="QUERY_REQUIRED")

    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    existing = get_active_job_for_video(
        video_id=video_id,
        job_type="index",
    )
    if existing:
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "INDEXING_IN_PROGRESS",
                "job_id": existing["id"],
                "video_id": video_id,
            },
        )

    idx = get_video_index(video_id)
    idx_meta = idx
    if idx and str(idx.get("status") or "") == "completed":
        current_transcript_hash = get_transcript_hash(video_id)
        idx_hash = str(idx.get("transcript_hash") or "")
        if (
            idx_hash
            and current_transcript_hash
            and idx_hash == current_transcript_hash
        ):
            pass
        else:
            idx = None

    if not idx or str(idx.get("status") or "") != "completed":
        if not transcript_exists(video_id):
            raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")
        segs = load_segments(video_id, limit=1)
        if not segs:
            raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")

        params: Dict[str, Any] = {"from_scratch": True}
        if idx_meta:
            params["embed_model"] = str(
                idx_meta.get("embed_model") or settings.embedding_model
            )
            params["embed_dim"] = int(
                idx_meta.get("embed_dim") or settings.embedding_dim
            )
        job = create_job(video_id, "index", params)
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "INDEXING_STARTED",
                "job_id": job["id"],
                "video_id": video_id,
            },
        )

    top_k = max(1, min(int(top_k), 20))
    embed_model = str(idx.get("embed_model") or settings.embedding_model)
    embed_dim = int(idx.get("embed_dim") or settings.embedding_dim)
    q_emb = embed_texts([q], model=embed_model, dim=embed_dim)[0]

    collection_name = chunks_collection_name(embed_model, embed_dim)

    try:
        res = query_vectors(
            collection_name=collection_name,
            query_embedding=q_emb,
            top_k=top_k,
            where={"video_id": video_id},
            create_if_missing=False,
        )
    except VectorStoreUnavailable:
        raise HTTPException(
            status_code=500,
            detail="E_VECTOR_STORE_UNAVAILABLE",
        )

    if bool(res.get("_collection_missing")):
        try:
            res = query_vectors(
                collection_name=LEGACY_COLLECTION_NAME,
                query_embedding=q_emb,
                top_k=top_k,
                where={"video_id": video_id},
                create_if_missing=False,
            )
        except VectorStoreUnavailable:
            raise HTTPException(
                status_code=500,
                detail="E_VECTOR_STORE_UNAVAILABLE",
            )

    ids = (res.get("ids") or [[]])[0]
    documents = (res.get("documents") or [[]])[0]
    metadatas = (res.get("metadatas") or [[]])[0]
    distances = (res.get("distances") or [[]])[0]

    items = []
    limit_n = min(
        len(ids),
        len(documents),
        len(metadatas),
        len(distances),
    )
    for i in range(limit_n):
        md = metadatas[i] or {}
        dist = float(distances[i])
        score = 1.0 / (1.0 + dist) if dist >= 0 else 1.0
        items.append(
            {
                "chunk_id": ids[i],
                "score": score,
                "start_time": md.get("start_time"),
                "end_time": md.get("end_time"),
                "text": documents[i],
                "metadata": md,
            }
        )

    return UTF8JSONResponse(status_code=200, content={"items": items})


def _format_seconds(seconds: Optional[float]) -> str:
    if seconds is None:
        return ""
    try:
        s = float(seconds)
    except Exception:
        return ""
    if s < 0:
        s = 0.0
    total_ms = int(round(s * 1000))
    h = total_ms // 3_600_000
    total_ms -= h * 3_600_000
    m = total_ms // 60_000
    total_ms -= m * 60_000
    sec = total_ms // 1000
    ms = total_ms - sec * 1000
    return f"{h:02d}:{m:02d}:{sec:02d}.{ms:03d}"


def _generate_answer_retrieval_only(
    *,
    query: str,
    items: list[Dict[str, Any]],
    max_snippets: int = 3,
) -> str:
    q = (query or "").strip()
    if not items:
        return f"未配置本地 LLM。未检索到与问题相关的片段：{q}"

    lines = [f"未配置本地 LLM。以下为与问题最相关的片段：{q}"]
    for it in items[: max(1, int(max_snippets))]:
        start = _format_seconds(it.get("start_time"))
        end = _format_seconds(it.get("end_time"))
        text = str(it.get("text") or "").replace("\n", " ").strip()
        if len(text) > 240:
            text = text[:240].rstrip() + "…"
        if start and end:
            lines.append(f"[{start} - {end}] {text}")
        else:
            lines.append(text)
    return "\n".join(lines).strip()


def _sse_event(event: str, data: Dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


@app.post("/chat")
def chat_api(req: ChatRequest) -> Response:
    video_id = str(req.video_id or "").strip()
    if not video_id:
        raise HTTPException(status_code=400, detail="VIDEO_ID_REQUIRED")

    q = (req.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="QUERY_REQUIRED")

    video = get_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="VIDEO_NOT_FOUND")

    existing = get_active_job_for_video(
        video_id=video_id,
        job_type="index",
    )
    if existing:
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "INDEXING_IN_PROGRESS",
                "job_id": existing["id"],
                "video_id": video_id,
            },
        )

    idx = get_video_index(video_id)
    idx_meta = idx
    if idx and str(idx.get("status") or "") == "completed":
        current_transcript_hash = get_transcript_hash(video_id)
        idx_hash = str(idx.get("transcript_hash") or "")
        if (
            idx_hash
            and current_transcript_hash
            and idx_hash == current_transcript_hash
        ):
            pass
        else:
            idx = None

    if not idx or str(idx.get("status") or "") != "completed":
        if not transcript_exists(video_id):
            raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")
        segs = load_segments(video_id, limit=1)
        if not segs:
            raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")

        params: Dict[str, Any] = {"from_scratch": True}
        if idx_meta:
            params["embed_model"] = str(
                idx_meta.get("embed_model") or settings.embedding_model
            )
            params["embed_dim"] = int(
                idx_meta.get("embed_dim") or settings.embedding_dim
            )
        job = create_job(video_id, "index", params)
        return UTF8JSONResponse(
            status_code=202,
            content={
                "detail": "INDEXING_STARTED",
                "job_id": job["id"],
                "video_id": video_id,
            },
        )

    top_k = max(1, min(int(req.top_k), 20))
    embed_model = str(idx.get("embed_model") or settings.embedding_model)
    embed_dim = int(idx.get("embed_dim") or settings.embedding_dim)
    q_emb = embed_texts([q], model=embed_model, dim=embed_dim)[0]

    collection_name = chunks_collection_name(embed_model, embed_dim)

    try:
        res = query_vectors(
            collection_name=collection_name,
            query_embedding=q_emb,
            top_k=top_k,
            where={"video_id": video_id},
            create_if_missing=False,
        )
    except VectorStoreUnavailable:
        raise HTTPException(
            status_code=500,
            detail="E_VECTOR_STORE_UNAVAILABLE",
        )

    if bool(res.get("_collection_missing")):
        try:
            res = query_vectors(
                collection_name=LEGACY_COLLECTION_NAME,
                query_embedding=q_emb,
                top_k=top_k,
                where={"video_id": video_id},
                create_if_missing=False,
            )
        except VectorStoreUnavailable:
            raise HTTPException(
                status_code=500,
                detail="E_VECTOR_STORE_UNAVAILABLE",
            )

    ids = (res.get("ids") or [[]])[0]
    documents = (res.get("documents") or [[]])[0]
    metadatas = (res.get("metadatas") or [[]])[0]
    distances = (res.get("distances") or [[]])[0]

    items: list[Dict[str, Any]] = []
    limit_n = min(
        len(ids),
        len(documents),
        len(metadatas),
        len(distances),
    )
    for i in range(limit_n):
        md = metadatas[i] or {}
        dist = float(distances[i])
        score = 1.0 / (1.0 + dist) if dist >= 0 else 1.0
        items.append(
            {
                "chunk_id": ids[i],
                "score": score,
                "start_time": md.get("start_time"),
                "end_time": md.get("end_time"),
                "text": documents[i],
                "metadata": md,
            }
        )

    stored = get_default_llm_preferences()
    provider_name = str(stored.get("provider") or "fake").strip() or "fake"
    if provider_name == "none":
        answer = _generate_answer_retrieval_only(query=q, items=items)
        if bool(req.stream):

            def gen():
                for i in range(0, len(answer), 16):
                    yield _sse_event("token", {"delta": answer[i:i + 16]})
                yield _sse_event(
                    "done",
                    {
                        "video_id": video_id,
                        "query": q,
                        "mode": "retrieval_only",
                        "answer": answer,
                        "citations": items,
                    },
                )

            return StreamingResponse(gen(), media_type="text/event-stream")

        return UTF8JSONResponse(
            status_code=200,
            content={
                "video_id": video_id,
                "query": q,
                "mode": "retrieval_only",
                "answer": answer,
                "citations": items,
            },
        )

    provider = get_provider(provider_name)
    if provider is None:
        raise HTTPException(status_code=400, detail="LLM_PROVIDER_NOT_FOUND")

    prefs = LLMPreferences(
        provider=provider_name,
        model=str(stored.get("model") or "") or None,
        temperature=float(stored.get("temperature") or 0.2),
        max_tokens=int(stored.get("max_tokens") or 512),
    )

    if bool(getattr(provider, "requires_confirm_send", False)) and not bool(
        req.confirm_send
    ):
        raise HTTPException(status_code=400, detail="CONFIRM_SEND_REQUIRED")

    messages: list[ChatMessage] = [
        {
            "role": "system",
            "content": "你是一个本地优先的视频内容整理助手。请基于给定的引用片段回答问题。",
        },
        {
            "role": "user",
            "content": (
                f"问题：{q}\n\n"
                f"引用片段（带时间戳）：\n"
                + "\n".join(
                    [
                        f"[{_format_seconds(it.get('start_time'))} - "
                        f"{_format_seconds(it.get('end_time'))}] "
                        f"{str(it.get('text') or '')}"
                        for it in items
                    ]
                )
            ),
        },
    ]

    if bool(req.stream):

        def gen():
            parts: list[str] = []
            try:
                with limit_llm():
                    for part in provider.stream_generate(
                        messages=messages,
                        prefs=prefs,
                        confirm_send=bool(req.confirm_send),
                    ):
                        parts.append(part)
                        yield _sse_event("token", {"delta": part})

                answer = "".join(parts)
                yield _sse_event(
                    "done",
                    {
                        "video_id": video_id,
                        "query": q,
                        "mode": "rag",
                        "answer": answer,
                        "citations": items,
                    },
                )
            except Exception as e:
                yield _sse_event("error", {"detail": str(e)})

        return StreamingResponse(gen(), media_type="text/event-stream")

    try:
        with limit_llm():
            answer = provider.generate(
                messages=messages,
                prefs=prefs,
                confirm_send=bool(req.confirm_send),
            )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"LLM_FAILED:{str(e)[:2000]}",
        )
    return UTF8JSONResponse(
        status_code=200,
        content={
            "video_id": video_id,
            "query": q,
            "mode": "rag",
            "answer": answer,
            "citations": items,
        },
    )


@app.get("/jobs/{job_id}")
def get_job_api(job_id: str) -> Dict[str, Any]:
    job = get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="JOB_NOT_FOUND",
        )
    return job


@app.get("/jobs")
def list_jobs_api(
    status: Optional[str] = None,
    video_id: Optional[str] = None,
    job_type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    return list_jobs(
        status=status,
        video_id=video_id,
        job_type=job_type,
        limit=limit,
        offset=offset,
    )


@app.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    request: Request,
) -> StreamingResponse:
    async def gen():
        last_updated_at: Optional[str] = None
        while True:
            if await request.is_disconnected():
                return

            job = get_job(job_id)
            if not job:
                payload: Dict[str, Any] = {
                    "type": "error",
                    "detail": "JOB_NOT_FOUND",
                }
                data = json.dumps(payload, ensure_ascii=False)
                yield f"event: error\ndata: {data}\n\n"
                return

            updated_at = str(job.get("updated_at") or "")
            if updated_at and updated_at != last_updated_at:
                last_updated_at = updated_at
                payload = {
                    "type": "job",
                    "job": job,
                }
                data = json.dumps(payload, ensure_ascii=False)
                yield f"id: {updated_at}\nevent: job\ndata: {data}\n\n"
            else:
                yield ": keep-alive\n\n"

            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.websocket("/ws/jobs/{job_id}")
async def job_ws(websocket: WebSocket, job_id: str) -> None:
    await websocket.accept()
    last_updated_at: Optional[str] = None
    try:
        while True:
            job = get_job(job_id)
            if not job:
                payload: Dict[str, Any] = {
                    "type": "error",
                    "detail": "JOB_NOT_FOUND",
                }
                await websocket.send_text(
                    json.dumps(payload, ensure_ascii=False)
                )
                return

            updated_at = str(job.get("updated_at") or "")
            if updated_at and updated_at != last_updated_at:
                last_updated_at = updated_at
                payload = {
                    "type": "job",
                    "job": job,
                }
                await websocket.send_text(
                    json.dumps(payload, ensure_ascii=False)
                )

            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=0.5)
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        return


@app.post("/jobs/{job_id}/cancel")
def cancel_job_api(job_id: str) -> Dict[str, Any]:
    job = get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="JOB_NOT_FOUND",
        )

    ok = cancel_job(job_id)
    if not ok:
        raise HTTPException(status_code=400, detail="JOB_NOT_CANCELLABLE")

    if str(job.get("job_type") or "") == "transcribe":
        set_video_status(job["video_id"], "pending")
    return get_job(job_id) or {"id": job_id}


@app.post("/jobs/{job_id}/retry")
def retry_job_api(
    job_id: str,
    req: RetryJobRequest,
) -> Dict[str, Any]:
    job = get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="JOB_NOT_FOUND",
        )

    status = str(job.get("status") or "")
    if status in ("pending", "running"):
        raise HTTPException(status_code=400, detail="JOB_NOT_RETRIABLE")

    if req.from_scratch:
        if str(job.get("job_type") or "") == "transcribe":
            delete_transcript(job["video_id"])
        elif str(job.get("job_type") or "") == "index":
            delete_chunks_for_video(job["video_id"])
            delete_video_index(job["video_id"])
            params: Dict[str, Any] = {}
            try:
                params = json.loads(job.get("params_json") or "{}")
            except Exception:
                params = {}

            embed_model = str(
                params.get("embed_model") or settings.embedding_model
            )
            embed_dim = int(
                params.get("embed_dim") or settings.embedding_dim
            )
            collection_name = chunks_collection_name(embed_model, embed_dim)
            try:
                delete_video_vectors(
                    collection_name=collection_name,
                    video_id=job["video_id"],
                )
            except VectorStoreUnavailable:
                pass

            try:
                delete_video_vectors(
                    collection_name=LEGACY_COLLECTION_NAME,
                    video_id=job["video_id"],
                )
            except VectorStoreUnavailable:
                pass
        elif str(job.get("job_type") or "") == "summarize":
            delete_video_summary(job["video_id"])
        elif str(job.get("job_type") or "") == "keyframes":
            delete_video_keyframes_for_video(job["video_id"])
            delete_video_keyframe_index(job["video_id"])
            d = keyframes_dir(job["video_id"])
            if os.path.isdir(d):
                for name in os.listdir(d):
                    if not str(name).lower().endswith(".jpg"):
                        continue
                    try:
                        os.remove(os.path.join(d, name))
                    except Exception:
                        pass

    ok = reset_job(job_id)
    if not ok:
        raise HTTPException(status_code=400, detail="JOB_RESET_FAILED")

    if str(job.get("job_type") or "") == "transcribe":
        set_video_status(job["video_id"], "pending")
    return get_job(job_id) or {"id": job_id}


@app.get("/videos/{video_id}/transcript")
def get_transcript(
    video_id: str,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    segs = load_segments(video_id, limit=limit)
    return {"video_id": video_id, "segments": segs}


@app.get("/videos/{video_id}/subtitles/{fmt}")
def export_subtitles(video_id: str, fmt: str) -> Response:
    fmt = (fmt or "").lower().strip()
    if not transcript_exists(video_id):
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")
    segs = load_segments(video_id)
    if not segs:
        raise HTTPException(status_code=404, detail="TRANSCRIPT_NOT_FOUND")

    if fmt == "srt":
        body = segments_to_srt(segs)
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
        )
    if fmt == "vtt":
        body = segments_to_vtt(segs)
        return Response(
            content=body,
            media_type="text/vtt; charset=utf-8",
        )

    raise HTTPException(status_code=400, detail="UNSUPPORTED_SUBTITLE_FORMAT")


@app.post("/summaries/cloud")
def cloud_summary(req: CloudSummaryRequest) -> Dict[str, Any]:
    if not req.confirm_send:
        raise HTTPException(status_code=400, detail="CONFIRM_SEND_REQUIRED")

    api_key = req.api_key or ""
    result = summarize(
        req.text,
        api_key=api_key,
    )

    if result == "CLOUD_SUMMARY_DISABLED":
        raise HTTPException(status_code=400, detail="CLOUD_SUMMARY_DISABLED")
    if result == "MISSING_DASHSCOPE_API_KEY":
        raise HTTPException(
            status_code=400,
            detail="MISSING_DASHSCOPE_API_KEY",
        )
    if result == "TEXT_TOO_SHORT":
        raise HTTPException(status_code=400, detail="TEXT_TOO_SHORT")

    return {"summary": result}
