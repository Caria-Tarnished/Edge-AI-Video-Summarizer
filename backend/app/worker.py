import json
import os
import tempfile
import time
import traceback
from typing import Any, Dict

from .asr import ASR
from .chunking_v2 import (
    segments_to_time_chunks,
    sha256_text,
)
from .embeddings import embed_texts
from .ffmpeg_util import extract_audio_wav
from .repo import (
    claim_pending_job,
    delete_chunks_for_video,
    fetch_next_pending_job,
    get_job,
    get_video,
    get_job_status,
    insert_chunk,
    set_video_status,
    update_video_index,
    upsert_video_index,
    update_job,
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
        while not self._stop:
            job = fetch_next_pending_job()
            if not job:
                time.sleep(0.5)
                continue

            job_id = job["id"]
            video_id = job["video_id"]
            job_type = str(job.get("job_type") or "")

            if not claim_pending_job(job_id):
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
                    continue

                detail = str(e)
                update_job(
                    job_id,
                    status="failed",
                    progress=0.0,
                    message="failed",
                    error_code=(
                        "E_ASR_FAILED"
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

        collection_name = chunks_collection_name(embed_model, embed_dim)

        if bool(params.get("from_scratch")):
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

        embeddings = embed_texts(
            texts_for_embed,
            model=embed_model,
            dim=embed_dim,
        )

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
