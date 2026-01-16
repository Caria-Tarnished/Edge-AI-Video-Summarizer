import json
import os
import tempfile
import time
import traceback
import uuid
from dataclasses import replace
from typing import Any, Dict, List, Optional

from .asr import ASR
from .chunking_v2 import (
    segments_to_time_chunks,
    sha256_text,
)
from .embeddings import embed_texts
from .ffmpeg_util import (
    detect_scene_changes,
    extract_audio_wav,
    extract_video_frame_jpg,
    get_jpg_dimensions,
)
from .llm_provider import ChatMessage, LLMPreferences, get_provider
from .paths import keyframe_jpg_abspath, keyframe_jpg_relpath, keyframes_dir
from .repo import (
    claim_pending_job,
    delete_chunks_for_video,
    delete_video_keyframe_index,
    delete_video_keyframes_for_video,
    delete_video_summary,
    fetch_next_pending_job,
    get_default_llm_preferences,
    get_job,
    get_video,
    get_job_status,
    insert_chunk,
    insert_video_keyframe,
    set_video_status,
    update_video_keyframe_index,
    update_video_index,
    update_video_summary,
    upsert_video_index,
    upsert_video_keyframe_index,
    upsert_video_summary,
    update_job,
)
from .runtime import limit_asr, limit_llm
from .runtime import (
    get_asr_concurrency_timeout_seconds,
    get_llm_concurrency_timeout_seconds,
    refresh_runtime_preferences,
)
from .settings import settings
from .transcript_store import (
    append_segments,
    delete_transcript,
    get_transcript_hash,
    get_last_end_time,
    load_segments,
    transcript_exists,
)
from .vector_store import (
    LEGACY_COLLECTION_NAME,
    VectorStoreUnavailable,
    chunks_collection_name,
    delete_video_vectors,
    upsert_vectors,
)


class JobCancelled(Exception):
    pass


class JobWorker:
    def __init__(self) -> None:
        self._stop = False
        self._asr = ASR()
        self._last_runtime_refresh_ts = 0.0

    def _maybe_refresh_runtime_preferences(self) -> None:
        now = time.monotonic()
        if now - float(self._last_runtime_refresh_ts) < 2.0:
            return
        self._last_runtime_refresh_ts = now
        try:
            refresh_runtime_preferences()
        except Exception:
            pass

    def _ensure_same_run(self, job_id: str, started_at: str) -> Dict[str, Any]:
        job = get_job(job_id)
        if not job:
            raise RuntimeError(f"job not found: {job_id}")

        if str(job.get("status") or "") != "running":
            raise JobCancelled()

        if str(job.get("started_at") or "") != str(started_at or ""):
            raise JobCancelled()

        return job

    def stop(self) -> None:
        self._stop = True

    def run_forever(self) -> None:
        self._maybe_refresh_runtime_preferences()
        while not self._stop:
            self._maybe_refresh_runtime_preferences()
            job = fetch_next_pending_job()
            if not job:
                time.sleep(0.5)
                continue

            job_id = job["id"]
            video_id = job["video_id"]
            job_type = str(job.get("job_type") or "")

            self._maybe_refresh_runtime_preferences()

            if not claim_pending_job(job_id, job_type):
                continue

            claimed = get_job(job_id) or {}
            claimed_started_at = str(claimed.get("started_at") or "")
            if not claimed_started_at:
                update_job(
                    job_id,
                    status="failed",
                    progress=0.0,
                    message="failed",
                    error_code="E_INTERNAL",
                    error_message="job claimed but started_at missing",
                )
                if job_type == "transcribe":
                    set_video_status(video_id, "error")
                continue

            self._maybe_refresh_runtime_preferences()

            update_job(
                job_id,
                progress=0.0,
                message="starting",
            )
            if job_type == "transcribe":
                set_video_status(video_id, "processing")

            try:
                if job_type == "transcribe":
                    self._run_transcribe(job, claimed_started_at)
                elif job_type == "index":
                    self._run_index(job, claimed_started_at)
                elif job_type == "keyframes":
                    self._run_keyframes(job, claimed_started_at)
                elif job_type == "summarize":
                    self._run_summarize(job, claimed_started_at)
                else:
                    raise RuntimeError(f"unsupported job_type: {job_type}")

                status = get_job_status(job_id)
                if status != "running":
                    if job_type == "transcribe":
                        set_video_status(video_id, "pending")
                    continue

                update_job(
                    job_id,
                    status="completed",
                    progress=1.0,
                    message="completed",
                )
                if job_type == "transcribe":
                    set_video_status(video_id, "complete")
            except JobCancelled:
                if job_type == "transcribe":
                    set_video_status(video_id, "pending")
                elif job_type == "index":
                    update_video_index(
                        video_id,
                        status="cancelled",
                        message="cancelled",
                    )
                elif job_type == "keyframes":
                    update_video_keyframe_index(
                        video_id,
                        status="cancelled",
                        message="cancelled",
                    )
                elif job_type == "summarize":
                    update_video_summary(
                        video_id,
                        status="cancelled",
                        message="cancelled",
                    )
            except Exception as e:
                if get_job_status(job_id) == "cancelled":
                    if job_type == "transcribe":
                        set_video_status(video_id, "pending")
                    elif job_type == "index":
                        update_video_index(
                            video_id,
                            status="cancelled",
                            message="cancelled",
                        )
                    elif job_type == "keyframes":
                        update_video_keyframe_index(
                            video_id,
                            status="cancelled",
                            message="cancelled",
                        )
                    elif job_type == "summarize":
                        update_video_summary(
                            video_id,
                            status="cancelled",
                            message="cancelled",
                        )
                    continue

                detail = str(e)
                timeout_err = detail in (
                    "ASR_CONCURRENCY_TIMEOUT",
                    "LLM_CONCURRENCY_TIMEOUT",
                )
                update_job(
                    job_id,
                    status="failed",
                    progress=0.0,
                    message="failed",
                    error_code=(
                        "E_CONCURRENCY_TIMEOUT"
                        if timeout_err
                        else "E_ASR_FAILED"
                        if job_type == "transcribe"
                        else "E_JOB_FAILED"
                    ),
                    error_message=detail[:2000],
                    result={"trace": traceback.format_exc()[:4000]},
                )
                if job_type == "transcribe":
                    set_video_status(video_id, "error")
                elif job_type == "index":
                    update_video_index(
                        video_id,
                        status="failed",
                        progress=0.0,
                        message="failed",
                        error_code="E_JOB_FAILED",
                        error_message=detail[:2000],
                    )
                elif job_type == "keyframes":
                    update_video_keyframe_index(
                        video_id,
                        status="failed",
                        progress=0.0,
                        message="failed",
                        error_code="E_JOB_FAILED",
                        error_message=detail[:2000],
                    )
                elif job_type == "summarize":
                    update_video_summary(
                        video_id,
                        status="failed",
                        progress=0.0,
                        message="failed",
                        error_code="E_JOB_FAILED",
                        error_message=detail[:2000],
                    )

    def _run_keyframes(
        self,
        job: Dict[str, Any],
        claimed_started_at: str,
    ) -> None:
        job_id = job["id"]
        video_id = job["video_id"]

        video = get_video(video_id)
        if not video:
            raise RuntimeError(f"video not found: {video_id}")

        media_path = str(video.get("file_path") or "")
        duration = float(video.get("duration") or 0.0)

        params: Dict[str, Any] = {}
        try:
            params = json.loads(job.get("params_json") or "{}")
        except Exception:
            params = {}

        mode = str(params.get("mode") or "interval").strip() or "interval"
        if mode not in ("interval", "scene"):
            raise RuntimeError("UNSUPPORTED_KEYFRAMES_MODE")

        interval_s = float(params.get("interval_seconds") or 10.0)
        if interval_s <= 0:
            interval_s = 10.0

        scene_threshold = float(params.get("scene_threshold") or 0.3)
        if scene_threshold <= 0:
            scene_threshold = 0.3
        if scene_threshold > 1.0:
            scene_threshold = 1.0

        min_gap_s = float(params.get("min_gap_seconds") or 2.0)
        if min_gap_s < 0:
            min_gap_s = 0.0

        max_frames = int(params.get("max_frames") or 200)
        max_frames = max(1, min(max_frames, 500))

        target_width: Any = params.get("target_width")
        target_width_i = (
            int(target_width)
            if target_width is not None
            else None
        )
        if target_width_i is not None and target_width_i <= 0:
            target_width_i = None

        if bool(params.get("from_scratch")):
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

        params_json = json.dumps(params, ensure_ascii=False)
        upsert_video_keyframe_index(
            video_id=video_id,
            status="running",
            progress=0.0,
            message="starting",
            params_json=params_json,
            frame_count=0,
        )
        update_job(job_id, progress=0.0, message="starting")

        if duration <= 0:
            raise RuntimeError("E_VIDEO_DURATION_INVALID")

        times: list[tuple[float, Optional[float]]] = []
        if mode == "interval":
            t = 0.0
            while t < duration and len(times) < max_frames:
                times.append((float(t), None))
                t += interval_s
        else:
            cands = detect_scene_changes(
                media_path,
                scene_threshold=scene_threshold,
            )
            ranked = sorted(cands, key=lambda x: float(x[1]), reverse=True)
            picked: list[tuple[float, float]] = []
            for ts, sc in ranked:
                if len(picked) >= max_frames:
                    break
                if ts < 0 or ts > duration:
                    continue
                if min_gap_s > 0:
                    too_close = any(abs(ts - p[0]) < min_gap_s for p in picked)
                    if too_close:
                        continue
                picked.append((float(ts), float(sc)))
            picked.sort(key=lambda x: float(x[0]))
            times = [(float(ts), float(sc)) for ts, sc in picked]

        if not times:
            times = [(0.0, None)]

        n = len(times)
        for i, (ts, score) in enumerate(times, start=1):
            if self._stop:
                raise RuntimeError("worker stopped")
            self._ensure_same_run(job_id, claimed_started_at)

            p = min(0.99, float(i - 1) / max(n, 1))
            if mode == "scene" and score is not None:
                msg = f"frame {i}/{n} score={float(score):.3f}"
            else:
                msg = f"frame {i}/{n}"
            update_job(job_id, progress=p, message=msg)
            update_video_keyframe_index(
                video_id,
                status="running",
                progress=p,
                message=msg,
                params_json=params_json,
                frame_count=i - 1,
            )

            keyframe_id = str(uuid.uuid4())
            jpg_relpath = keyframe_jpg_relpath(video_id, keyframe_id)
            jpg_abspath = keyframe_jpg_abspath(video_id, keyframe_id)
            extract_video_frame_jpg(
                media_path,
                jpg_abspath,
                timestamp_seconds=float(ts),
                target_width=target_width_i,
            )

            width_i: Any = None
            height_i: Any = None
            try:
                w, h = get_jpg_dimensions(jpg_abspath)
                width_i = int(w)
                height_i = int(h)
            except Exception:
                width_i = None
                height_i = None

            insert_video_keyframe(
                id=keyframe_id,
                video_id=video_id,
                timestamp_ms=int(round(float(ts) * 1000.0)),
                image_relpath=jpg_relpath,
                method=mode,
                width=width_i,
                height=height_i,
                score=float(score) if score is not None else None,
            )

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, progress=0.99, message="finalizing")
        update_video_keyframe_index(
            video_id,
            status="completed",
            progress=1.0,
            message="completed",
            params_json=params_json,
            frame_count=n,
        )

    def _run_transcribe(
        self,
        job: Dict[str, Any],
        claimed_started_at: str,
    ) -> None:
        job_id = job["id"]
        video_id = job["video_id"]

        video = get_video(video_id)
        if not video:
            raise RuntimeError(f"video not found: {video_id}")

        media_path = video["file_path"]
        duration = float(video["duration"])

        params = {}
        try:
            params = json.loads(job.get("params_json") or "{}")
        except Exception:
            params = {}

        if bool(params.get("from_scratch")):
            delete_transcript(video_id)

        segment_s = int(
            params.get("segment_seconds") or settings.segment_seconds
        )
        overlap_s = int(
            params.get("overlap_seconds") or settings.overlap_seconds
        )

        last_end = float(get_last_end_time(video_id))
        resume_from = last_end
        start = max(0.0, last_end - float(overlap_s)) if last_end > 0 else 0.0

        chunk_index = 0
        while start < duration:
            if self._stop:
                raise RuntimeError("worker stopped")

            self._ensure_same_run(job_id, claimed_started_at)

            chunk_index += 1
            chunk_dur = min(float(segment_s), duration - start)

            self._ensure_same_run(job_id, claimed_started_at)
            update_job(
                job_id,
                progress=min(0.999, start / max(duration, 1e-6)),
                message=(
                    f"extract_audio chunk={chunk_index} "
                    f"start={start:.1f}s"
                ),
            )

            with tempfile.TemporaryDirectory(prefix="edge_video_asr_") as td:
                self._ensure_same_run(job_id, claimed_started_at)
                wav_path = os.path.join(td, "chunk.wav")
                extract_audio_wav(
                    media_path,
                    wav_path,
                    start_seconds=float(start),
                    duration_seconds=float(chunk_dur),
                )

                self._ensure_same_run(job_id, claimed_started_at)
                update_job(
                    job_id,
                    progress=min(0.999, start / max(duration, 1e-6)),
                    message=f"transcribe chunk={chunk_index}",
                )

                self._ensure_same_run(job_id, claimed_started_at)

                with limit_asr(
                    timeout_seconds=get_asr_concurrency_timeout_seconds()
                ):
                    segments, info = self._asr.transcribe_wav(wav_path)

                self._ensure_same_run(job_id, claimed_started_at)

                out = []
                for seg in segments:
                    abs_start = float(start) + float(seg.start)
                    abs_end = float(start) + float(seg.end)
                    if abs_end <= resume_from:
                        continue
                    out.append(
                        {
                            "start": abs_start,
                            "end": abs_end,
                            "text": (seg.text or "").strip(),
                            "language": getattr(info, "language", None),
                        }
                    )

                if out:
                    append_segments(video_id, out)

            start = float(start) + float(chunk_dur)
            self._ensure_same_run(job_id, claimed_started_at)
            update_job(
                job_id,
                progress=min(0.999, start / max(duration, 1e-6)),
                message=f"chunk_done chunk={chunk_index}",
            )

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, message="finalizing")

    def _run_index(
        self,
        job: Dict[str, Any],
        claimed_started_at: str,
    ) -> None:
        job_id = job["id"]
        video_id = job["video_id"]

        video = get_video(video_id)
        if not video:
            raise RuntimeError(f"video not found: {video_id}")

        params: Dict[str, Any] = {}
        try:
            params = json.loads(job.get("params_json") or "{}")
        except Exception:
            params = {}

        embed_model = str(
            params.get("embed_model") or settings.embedding_model
        )
        embed_dim = int(params.get("embed_dim") or settings.embedding_dim)

        target_window = float(
            params.get("target_window_seconds")
            or settings.index_target_window_seconds
        )
        max_window = float(
            params.get("max_window_seconds")
            or settings.index_max_window_seconds
        )
        min_window = float(
            params.get("min_window_seconds")
            or settings.index_min_window_seconds
        )
        overlap_s = float(
            params.get("overlap_seconds")
            or settings.index_overlap_seconds
        )

        chunk_params = {
            "target_window_seconds": target_window,
            "max_window_seconds": max_window,
            "min_window_seconds": min_window,
            "overlap_seconds": overlap_s,
        }
        chunk_params_json = json.dumps(chunk_params, ensure_ascii=False)

        from_scratch = bool(params.get("from_scratch"))
        collection_name = chunks_collection_name(embed_model, embed_dim)

        if from_scratch:
            delete_chunks_for_video(video_id)
            try:
                delete_video_vectors(
                    collection_name=collection_name,
                    video_id=video_id,
                )
            except VectorStoreUnavailable:
                pass

            try:
                delete_video_vectors(
                    collection_name=LEGACY_COLLECTION_NAME,
                    video_id=video_id,
                )
            except VectorStoreUnavailable:
                pass

        if not transcript_exists(video_id):
            upsert_video_index(
                video_id=video_id,
                status="failed",
                progress=0.0,
                message="failed",
                embed_model=embed_model,
                embed_dim=embed_dim,
                chunk_params_json=chunk_params_json,
                error_code="TRANSCRIPT_NOT_FOUND",
                error_message="transcript missing",
            )
            update_job(
                job_id,
                status="failed",
                progress=0.0,
                message="failed",
                error_code="TRANSCRIPT_NOT_FOUND",
                error_message="transcript missing",
            )
            return

        segs = load_segments(video_id)
        if not segs:
            upsert_video_index(
                video_id=video_id,
                status="failed",
                progress=0.0,
                message="failed",
                embed_model=embed_model,
                embed_dim=embed_dim,
                chunk_params_json=chunk_params_json,
                error_code="TRANSCRIPT_NOT_FOUND",
                error_message="transcript empty",
            )
            update_job(
                job_id,
                status="failed",
                progress=0.0,
                message="failed",
                error_code="TRANSCRIPT_NOT_FOUND",
                error_message="transcript empty",
            )
            return

        self._ensure_same_run(job_id, claimed_started_at)
        transcript_hash = get_transcript_hash(video_id)

        upsert_video_index(
            video_id=video_id,
            status="running",
            progress=0.0,
            message="chunking",
            embed_model=embed_model,
            embed_dim=embed_dim,
            chunk_params_json=chunk_params_json,
            transcript_hash=transcript_hash,
            chunk_count=0,
            indexed_count=0,
        )

        update_job(job_id, progress=0.0, message="chunking")

        chunks = segments_to_time_chunks(
            segs,
            target_window_seconds=target_window,
            max_window_seconds=max_window,
            min_window_seconds=min_window,
            overlap_seconds=overlap_s,
        )

        if not chunks:
            upsert_video_index(
                video_id=video_id,
                status="failed",
                progress=0.0,
                message="failed",
                embed_model=embed_model,
                embed_dim=embed_dim,
                chunk_params_json=chunk_params_json,
                transcript_hash=transcript_hash,
                error_code="E_CHUNKING_FAILED",
                error_message="no chunks generated",
            )
            update_job(
                job_id,
                status="failed",
                progress=0.0,
                message="failed",
                error_code="E_CHUNKING_FAILED",
                error_message="no chunks generated",
            )
            return

        ids = []
        documents = []
        metadatas = []
        texts_for_embed = []

        for idx, ch in enumerate(chunks, start=1):
            self._ensure_same_run(job_id, claimed_started_at)

            start_time = float(ch["start_time"])
            end_time = float(ch["end_time"])
            text = str(ch["text"] or "").strip()
            if not text:
                continue

            chunk_id = f"{video_id}:{idx}"
            content_hash = sha256_text(text)

            insert_chunk(
                chunk_id=chunk_id,
                video_id=video_id,
                chunk_index=int(idx),
                start_time=start_time,
                end_time=end_time,
                text=text,
                content_hash=content_hash,
            )

            ids.append(chunk_id)
            documents.append(text)
            texts_for_embed.append(text)
            metadatas.append(
                {
                    "video_id": video_id,
                    "chunk_index": int(idx),
                    "start_time": start_time,
                    "end_time": end_time,
                    "content_hash": content_hash,
                    "embed_model": embed_model,
                }
            )

            if idx % 20 == 0:
                p = min(0.25, float(idx) / max(len(chunks), 1) * 0.25)
                update_job(
                    job_id,
                    progress=p,
                    message=f"chunking {idx}/{len(chunks)}",
                )
                upsert_video_index(
                    video_id=video_id,
                    status="running",
                    progress=p,
                    message=f"chunking {idx}/{len(chunks)}",
                    embed_model=embed_model,
                    embed_dim=embed_dim,
                    chunk_params_json=chunk_params_json,
                    transcript_hash=transcript_hash,
                    chunk_count=len(ids),
                    indexed_count=0,
                )

        if not ids:
            upsert_video_index(
                video_id=video_id,
                status="failed",
                progress=0.0,
                message="failed",
                embed_model=embed_model,
                embed_dim=embed_dim,
                chunk_params_json=json.dumps(chunk_params, ensure_ascii=False),
                transcript_hash=transcript_hash,
                error_code="E_CHUNKING_FAILED",
                error_message="all chunks empty",
            )
            update_job(
                job_id,
                status="failed",
                progress=0.0,
                message="failed",
                error_code="E_CHUNKING_FAILED",
                error_message="all chunks empty",
            )
            return

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, progress=0.3, message=f"embedding 0/{len(ids)}")
        upsert_video_index(
            video_id=video_id,
            status="running",
            progress=0.3,
            message=f"embedding 0/{len(ids)}",
            embed_model=embed_model,
            embed_dim=embed_dim,
            chunk_params_json=chunk_params_json,
            transcript_hash=transcript_hash,
            chunk_count=len(ids),
            indexed_count=0,
        )

        try:
            embeddings = embed_texts(
                texts_for_embed,
                model=embed_model,
                dim=embed_dim,
            )
        except Exception as e:
            if str(embed_model or "").lower().startswith("fastembed"):
                embed_model = "hash"
                collection_name = chunks_collection_name(
                    embed_model,
                    embed_dim,
                )
                for md in metadatas:
                    try:
                        md["embed_model"] = embed_model
                    except Exception:
                        pass

                if from_scratch:
                    try:
                        delete_video_vectors(
                            collection_name=collection_name,
                            video_id=video_id,
                        )
                    except VectorStoreUnavailable:
                        pass

                update_job(
                    job_id,
                    progress=0.3,
                    message=f"embedding_fallback_hash 0/{len(ids)}",
                )
                upsert_video_index(
                    video_id=video_id,
                    status="running",
                    progress=0.3,
                    message=f"embedding_fallback_hash 0/{len(ids)}",
                    embed_model=embed_model,
                    embed_dim=embed_dim,
                    chunk_params_json=chunk_params_json,
                    transcript_hash=transcript_hash,
                    chunk_count=len(ids),
                    indexed_count=0,
                )

                embeddings = embed_texts(
                    texts_for_embed,
                    model=embed_model,
                    dim=embed_dim,
                )
            else:
                raise e

        try:
            upsert_vectors(
                collection_name=collection_name,
                ids=ids,
                documents=documents,
                embeddings=embeddings,
                metadatas=metadatas,
            )
        except VectorStoreUnavailable as e:
            upsert_video_index(
                video_id=video_id,
                status="failed",
                progress=0.0,
                message="failed",
                embed_model=embed_model,
                embed_dim=embed_dim,
                chunk_params_json=chunk_params_json,
                transcript_hash=transcript_hash,
                error_code="E_VECTOR_STORE_UNAVAILABLE",
                error_message=str(e)[:2000],
            )
            update_job(
                job_id,
                status="failed",
                progress=0.0,
                message="failed",
                error_code="E_VECTOR_STORE_UNAVAILABLE",
                error_message=str(e)[:2000],
            )
            return

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, progress=0.99, message="finalizing")
        upsert_video_index(
            video_id=video_id,
            status="completed",
            progress=1.0,
            message="completed",
            embed_model=embed_model,
            embed_dim=embed_dim,
            chunk_params_json=chunk_params_json,
            transcript_hash=transcript_hash,
            chunk_count=len(ids),
            indexed_count=len(ids),
        )

    def _run_summarize(
        self,
        job: Dict[str, Any],
        claimed_started_at: str,
    ) -> None:
        def _extract_json_text(s: str) -> str:
            s = str(s or "").strip()
            if not s:
                return ""

            if "```" in s:
                parts = s.split("```")
                if len(parts) >= 3:
                    s2 = parts[1]
                    s2 = s2.lstrip()
                    if s2.lower().startswith("json"):
                        s2 = s2[4:]
                    return s2.strip()

            lbr = s.find("[")
            rbr = s.rfind("]")
            if lbr != -1 and rbr != -1 and rbr > lbr:
                return s[lbr:rbr + 1].strip()

            lcb = s.find("{")
            rcb = s.rfind("}")
            if lcb != -1 and rcb != -1 and rcb > lcb:
                return s[lcb:rcb + 1].strip()

            return s

        def _parse_jsonish(s: str) -> Any:
            s = _extract_json_text(s)
            if not s:
                return []
            try:
                obj = json.loads(s)
            except Exception:
                return {"raw": str(s)}

            if isinstance(obj, str):
                s2 = obj.strip()
                try:
                    return json.loads(s2)
                except Exception:
                    return {"raw": str(obj)}
            return obj

        def _looks_like_zh(s: str) -> bool:
            s2 = str(s or "")
            for ch in s2[:400]:
                if "\u4e00" <= ch <= "\u9fff":
                    return True
            return False

        def _normalize_output_language(v: str, hint_text: str = "") -> str:
            lang = str(v or "").strip().lower() or "zh"
            if lang not in ("zh", "en", "auto"):
                lang = "zh"
            if lang == "auto":
                return "zh" if _looks_like_zh(hint_text) else "en"
            return lang

        job_id = job["id"]
        video_id = job["video_id"]

        video = get_video(video_id)
        if not video:
            raise RuntimeError(f"video not found: {video_id}")

        params: Dict[str, Any] = {}
        try:
            params = json.loads(job.get("params_json") or "{}")
        except Exception:
            params = {}

        if not transcript_exists(video_id):
            raise RuntimeError("TRANSCRIPT_NOT_FOUND")
        segs = load_segments(video_id)
        if not segs:
            raise RuntimeError("TRANSCRIPT_NOT_FOUND")

        stored = get_default_llm_preferences()
        provider_name = str(stored.get("provider") or "fake").strip() or "fake"
        if provider_name == "none":
            raise RuntimeError("LLM_PROVIDER_NONE")
        provider = get_provider(provider_name)
        if provider is None:
            raise RuntimeError("LLM_PROVIDER_NOT_FOUND")
        if bool(getattr(provider, "requires_confirm_send", False)):
            raise RuntimeError("CONFIRM_SEND_REQUIRED")

        prefs = LLMPreferences(
            provider=provider_name,
            model=str(stored.get("model") or "") or None,
            temperature=float(stored.get("temperature") or 0.2),
            max_tokens=int(stored.get("max_tokens") or 512),
        )

        reduce_prefs = replace(
            prefs,
            max_tokens=max(
                prefs.max_tokens,
                int(params.get("reduce_max_tokens") or 2048),
            ),
        )
        outline_prefs = replace(
            prefs,
            max_tokens=max(
                prefs.max_tokens,
                int(params.get("outline_max_tokens") or 2048),
            ),
        )

        transcript_hash = get_transcript_hash(video_id)
        from_scratch = bool(params.get("from_scratch"))
        if from_scratch:
            delete_video_summary(video_id)

        chunk_params = {
            "target_window_seconds": float(
                params.get("target_window_seconds") or 120.0
            ),
            "max_window_seconds": float(
                params.get("max_window_seconds") or 180.0
            ),
            "min_window_seconds": float(
                params.get("min_window_seconds") or 60.0
            ),
            "overlap_seconds": float(
                params.get("overlap_seconds") or 10.0
            ),
        }
        chunks = segments_to_time_chunks(segs, **chunk_params)
        if not chunks:
            raise RuntimeError("NO_TEXT")

        output_language = _normalize_output_language(
            str(stored.get("output_language") or "zh"),
            hint_text=str(chunks[0].get("text") or ""),
        )

        params_json = json.dumps(params, ensure_ascii=False)
        upsert_video_summary(
            video_id=video_id,
            status="running",
            progress=0.0,
            message="starting",
            transcript_hash=transcript_hash,
            params_json=params_json,
            segment_summaries_json=None,
            summary_markdown=None,
            outline_json=None,
        )

        segment_summaries: list[Dict[str, Any]] = []
        n = len(chunks)
        for i, ch in enumerate(chunks):
            if self._stop:
                raise RuntimeError("worker stopped")

            self._ensure_same_run(job_id, claimed_started_at)

            start_time = float(ch.get("start_time") or 0.0)
            end_time = float(ch.get("end_time") or 0.0)
            text = str(ch.get("text") or "").strip()
            if not text:
                continue

            if output_language == "zh":
                seg_system = (
                    "\u4f60\u662f\u4e00\u4e2a\u89c6\u9891\u5185\u5bb9"
                    "\u6574\u7406\u52a9\u624b\u3002"
                    "\u4f60\u9700\u8981\u5bf9\u89c6\u9891\u8f6c\u5199"
                    "\u7247\u6bb5\u8fdb\u884c\u7b80\u8981\u603b\u7ed3"
                    "\uff0c\u8981\u6c42\u7b80\u6d01\uff0c\u4fdd\u7559"
                    "\u5173\u952e\u4e8b\u5b9e\u3002"
                    "\u8bf7\u7528\u4e2d\u6587\u8f93\u51fa\u3002"
                )
                seg_user = (
                    "\u65f6\u95f4\u8303\u56f4\uff1a"
                    + f"{start_time:.2f}-{end_time:.2f} \u79d2\n\n"
                    "\u8f6c\u5199\uff1a\n"
                    f"{text[:12000]}\n\n"
                    "\u4efb\u52a1\uff1a\u7528\u8981\u70b9"
                    "\uff08bullet points\uff09\u5199\u4e00\u6bb5"
                    "\u7b80\u77ed\u603b\u7ed3\u3002"
                )
            else:
                seg_system = (
                    "You summarize transcript segments. "
                    "Be concise and keep key facts. Write in English."
                )
                seg_user = (
                    "Time range: "
                    + f"{start_time:.2f}-{end_time:.2f} seconds\n\n"
                    "Transcript:\n"
                    f"{text[:12000]}\n\n"
                    "Task: write a short bullet-point summary."
                )

            messages: List[ChatMessage] = [
                {
                    "role": "system",
                    "content": seg_system,
                },
                {
                    "role": "user",
                    "content": seg_user,
                },
            ]
            with limit_llm(
                timeout_seconds=get_llm_concurrency_timeout_seconds()
            ):
                part = provider.generate(
                    messages=messages,
                    prefs=prefs,
                    confirm_send=False,
                )
            segment_summaries.append(
                {
                    "start_time": start_time,
                    "end_time": end_time,
                    "summary": (part or "").strip(),
                }
            )

            progress = 0.05 + 0.7 * (float(i + 1) / float(max(1, n)))
            update_job(job_id, progress=progress, message="summarizing")
            update_video_summary(
                video_id,
                status="running",
                progress=progress,
                message="summarizing",
                segment_summaries_json=json.dumps(
                    segment_summaries,
                    ensure_ascii=False,
                ),
                transcript_hash=transcript_hash,
                params_json=params_json,
            )

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, progress=0.8, message="reducing")
        update_video_summary(
            video_id,
            status="running",
            progress=0.8,
            message="reducing",
        )

        reduce_input = json.dumps(segment_summaries, ensure_ascii=False)

        if output_language == "zh":
            reduce_system = (
                "\u4f60\u9700\u8981\u7f16\u5199\u4e00\u4efd"
                "\u7ed3\u6784\u5316\u7684\u89c6\u9891\u603b\u7ed3"
                "\uff08Markdown\uff09\u3002"
                "\u8bf7\u7528\u4e2d\u6587\u8f93\u51fa\u3002"
            )
            reduce_user = (
                "\u7ed9\u5b9a\u5e26\u65f6\u95f4\u6233\u7684"
                "\u7247\u6bb5\u603b\u7ed3\uff08JSON\uff09\uff0c"
                "\u8bf7\u5199\u51fa\u4e00\u4efd Markdown \u683c\u5f0f"
                "\u7684\u89c6\u9891\u603b\u7ed3\uff0c\u5c3d\u91cf"
                "\u4fdd\u7559\u5173\u952e\u65f6\u95f4\u70b9\u3002\n\n"
                f"Input JSON:\n{reduce_input[:18000]}"
            )
        else:
            reduce_system = "You write a structured video summary."
            reduce_user = (
                "Given segment summaries with timestamps (JSON), "
                "write a Markdown summary with key timestamps.\n\n"
                f"Input JSON:\n{reduce_input[:18000]}"
            )

        messages_reduce: List[ChatMessage] = [
            {
                "role": "system",
                "content": reduce_system,
            },
            {
                "role": "user",
                "content": reduce_user,
            },
        ]
        with limit_llm(timeout_seconds=get_llm_concurrency_timeout_seconds()):
            summary_md = provider.generate(
                messages=messages_reduce,
                prefs=reduce_prefs,
                confirm_send=False,
            )

        self._ensure_same_run(
            job_id,
            claimed_started_at,
        )
        update_job(job_id, progress=0.9, message="outline")

        if output_language == "zh":
            outline_system = (
                "\u4f60\u53ea\u8f93\u51fa JSON\uff0c\u4e0d\u8981"
                "\u8f93\u51fa\u5176\u4ed6\u5185\u5bb9\u3002"
            )
            outline_user = (
                "\u4ece\u7247\u6bb5\u603b\u7ed3 JSON \u751f\u6210"
                "\u89c6\u9891\u5927\u7eb2\uff0c\u8f93\u51fa\u4e00\u4e2a"
                " JSON \u6570\u7ec4\u3002"
                "\u6bcf\u4e2a\u6761\u76ee\u5305\u542b\uff1atitle, start_time, "
                "end_time, bullets\uff08\u5b57\u7b26\u4e32"
                "\u6570\u7ec4\uff09\u3002"
                "\u5b57\u6bb5\u540d\u56fa\u5b9a\u4e3a\u8fd9\u4e9b\uff0c"
                "\u4f46 title/bullets \u7684\u5185\u5bb9"
                "\u8bf7\u7528\u4e2d\u6587\u3002"
                "\u53ea\u8f93\u51fa JSON\u3002\n\n"
                f"Input JSON:\n{reduce_input[:18000]}"
            )
        else:
            outline_system = "You produce JSON only."
            outline_user = (
                "From the segment summaries JSON, generate an outline "
                "as a JSON array. Each item: title, start_time, end_time, "
                "bullets (array of strings). Output JSON only.\n\n"
                f"Input JSON:\n{reduce_input[:18000]}"
            )

        messages_outline: List[ChatMessage] = [
            {
                "role": "system",
                "content": outline_system,
            },
            {
                "role": "user",
                "content": outline_user,
            },
        ]
        with limit_llm(timeout_seconds=get_llm_concurrency_timeout_seconds()):
            outline_raw = provider.generate(
                messages=messages_outline,
                prefs=outline_prefs,
                confirm_send=False,
            )

        outline_obj = _parse_jsonish(outline_raw)
        if isinstance(outline_obj, dict) and "raw" in outline_obj:
            raw_text = str(outline_obj.get("raw") or "")
            if output_language == "zh":
                fix_system = (
                    "\u4f60\u53ea\u8f93\u51fa\u6709\u6548\u7684 JSON\uff0c"
                    "\u4e0d\u8981\u8f93\u51fa\u5176\u4ed6\u5185\u5bb9\u3002"
                )
                fix_user = (
                    "\u8bf7\u5c06\u4ee5\u4e0b\u5185\u5bb9\u4fee\u6b63\u4e3a"
                    "\u6709\u6548\u7684 JSON \u6570\u7ec4\u5927\u7eb2\u3002"
                    "\u53ea\u8f93\u51fa JSON\u3002\n\n"
                    + raw_text[:12000]
                )
            else:
                fix_system = "You output valid JSON only."
                fix_user = (
                    "Fix the following into a valid JSON array outline. "
                    "Output JSON only.\n\n"
                    + raw_text[:12000]
                )
            messages_fix: List[ChatMessage] = [
                {
                    "role": "system",
                    "content": fix_system,
                },
                {
                    "role": "user",
                    "content": fix_user,
                },
            ]
            with limit_llm(
                timeout_seconds=get_llm_concurrency_timeout_seconds()
            ):
                fixed_raw = provider.generate(
                    messages=messages_fix,
                    prefs=outline_prefs,
                    confirm_send=False,
                )
            fixed_obj = _parse_jsonish(fixed_raw)
            if not (isinstance(fixed_obj, dict) and "raw" in fixed_obj):
                outline_obj = fixed_obj
        outline_json = json.dumps(outline_obj, ensure_ascii=False)

        self._ensure_same_run(job_id, claimed_started_at)
        update_job(job_id, progress=0.99, message="finalizing")
        update_video_summary(
            video_id,
            status="completed",
            progress=1.0,
            message="completed",
            transcript_hash=transcript_hash,
            params_json=params_json,
            segment_summaries_json=json.dumps(
                segment_summaries,
                ensure_ascii=False,
            ),
            summary_markdown=str(summary_md or ""),
            outline_json=outline_json,
        )
