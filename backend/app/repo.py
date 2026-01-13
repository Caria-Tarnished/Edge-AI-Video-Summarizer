import json
import os
import uuid
from typing import Any, Dict, Optional

from .db import connect


def _now_sql() -> str:
    return "datetime('now')"


def create_or_get_video(
    file_path: str,
    file_hash: str,
    duration: float,
) -> Dict[str, Any]:
    title = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM videos WHERE file_hash=?",
            (file_hash,),
        ).fetchone()
        if row:
            return dict(row)

        video_id = str(uuid.uuid4())
        conn.execute(
            (
                "INSERT INTO videos ("
                "id, file_path, file_hash, title, duration, file_size, status"
                ") VALUES (?, ?, ?, ?, ?, ?, ?)"
            ),
            (
                video_id,
                file_path,
                file_hash,
                title,
                float(duration),
                int(file_size),
                "pending",
            ),
        )
        return dict(
            conn.execute(
                "SELECT * FROM videos WHERE id=?",
                (video_id,),
            ).fetchone()
        )


def get_video(video_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM videos WHERE id=?",
            (video_id,),
        ).fetchone()
        return dict(row) if row else None


def set_video_status(
    video_id: str,
    status: str,
) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE videos SET status=?, "
            "updated_at=datetime('now') "
            "WHERE id=?",
            (status, video_id),
        )


def create_job(
    video_id: str,
    job_type: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    job_id = str(uuid.uuid4())
    with connect() as conn:
        conn.execute(
            (
                "INSERT INTO jobs ("
                "id, video_id, job_type, status, progress, "
                "message, params_json"
                ") VALUES (?, ?, ?, ?, ?, ?, ?)"
            ),
            (
                job_id,
                video_id,
                job_type,
                "pending",
                0.0,
                "",
                json.dumps(params, ensure_ascii=False),
            ),
        )
        row = conn.execute(
            "SELECT * FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        return dict(row)


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        return dict(row) if row else None


def fetch_next_pending_job(
    job_type: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        if job_type:
            row = conn.execute(
                "SELECT * FROM jobs WHERE status='pending' AND job_type=? "
                "ORDER BY created_at LIMIT 1",
                (job_type,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM jobs WHERE status='pending' "
                "ORDER BY created_at LIMIT 1"
            ).fetchone()
        return dict(row) if row else None


def claim_pending_job(job_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute(
            (
                "UPDATE jobs SET status='running', "
                "started_at=datetime('now') "
                ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
                "WHERE id=? AND status='pending'"
            ),
            (job_id,),
        )
        return bool(cur.rowcount)


def get_job_status(job_id: str) -> Optional[str]:
    with connect() as conn:
        row = conn.execute(
            "SELECT status FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        return str(row["status"]) if row else None


def cancel_job(job_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute(
            (
                "UPDATE jobs SET status='cancelled', "
                "message='cancelled', "
                "completed_at=datetime('now') "
                ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
                "WHERE id=? AND status IN ('pending', 'running')"
            ),
            (job_id,),
        )
        return bool(cur.rowcount)


def reset_job(job_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute(
            (
                "UPDATE jobs SET "
                "status='pending', "
                "progress=0, "
                "message='', "
                "updated_at=strftime('%Y-%m-%d %H:%M:%f','now'), "
                "params_json=params_json, "
                "result_json=NULL, "
                "error_code=NULL, "
                "error_message=NULL, "
                "started_at=NULL, "
                "completed_at=NULL "
                "WHERE id=?"
            ),
            (job_id,),
        )
        return bool(cur.rowcount)


def recover_incomplete_state() -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE jobs SET status='pending', message='recovered' "
            ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE status='running'"
        )
        conn.execute(
            "UPDATE video_indexes SET status='pending', message='recovered' "
            ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE status='running'"
        )
        conn.execute(
            "UPDATE video_summaries SET status='pending', message='recovered' "
            ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE status='running'"
        )
        conn.execute(
            "UPDATE video_keyframe_indexes SET "
            "status='pending', message='recovered' "
            ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE status='running'"
        )
        conn.execute(
            "UPDATE videos SET status='pending' "
            ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE status='processing'"
        )


def get_default_llm_preferences() -> Dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT prefs_json FROM llm_preferences WHERE id=1",
        ).fetchone()
        prefs_json = str(row["prefs_json"] or "{}") if row else "{}"

    try:
        obj = json.loads(prefs_json)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def set_default_llm_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    payload = prefs if isinstance(prefs, dict) else {}
    prefs_json = json.dumps(payload, ensure_ascii=False)
    with connect() as conn:
        conn.execute(
            (
                "UPDATE llm_preferences SET prefs_json=? "
                ", updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
                "WHERE id=1"
            ),
            (prefs_json,),
        )
    return get_default_llm_preferences()


def update_job(
    job_id: str,
    *,
    status: Optional[str] = None,
    progress: Optional[float] = None,
    message: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if status is not None:
        fields.append("status=?")
        values.append(status)
        if status == "running":
            fields.append("started_at=datetime('now')")
        if status in ("completed", "failed", "cancelled"):
            fields.append("completed_at=datetime('now')")

    if progress is not None:
        fields.append("progress=?")
        values.append(float(progress))

    if message is not None:
        fields.append("message=?")
        values.append(message)

    if result is not None:
        fields.append("result_json=?")
        values.append(json.dumps(result, ensure_ascii=False))

    if error_code is not None:
        fields.append("error_code=?")
        values.append(error_code)

    if error_message is not None:
        fields.append("error_message=?")
        values.append(error_message)

    if not fields:
        return

    fields.append("updated_at=strftime('%Y-%m-%d %H:%M:%f','now')")

    sql = "UPDATE jobs SET " + ", ".join(fields) + " WHERE id=?"
    values.append(job_id)
    with connect() as conn:
        conn.execute(sql, tuple(values))


def upsert_video_summary(
    *,
    video_id: str,
    status: str,
    progress: float = 0.0,
    message: str = "",
    transcript_hash: Optional[str] = None,
    params_json: Optional[str] = None,
    segment_summaries_json: Optional[str] = None,
    summary_markdown: Optional[str] = None,
    outline_json: Optional[str] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    with connect() as conn:
        conn.execute(
            (
                "INSERT INTO video_summaries ("
                "video_id, status, progress, message, transcript_hash, "
                "params_json, segment_summaries_json, summary_markdown, "
                "outline_json, error_code, error_message"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(video_id) DO UPDATE SET "
                "status=excluded.status, "
                "progress=excluded.progress, "
                "message=excluded.message, "
                "transcript_hash=excluded.transcript_hash, "
                "params_json=excluded.params_json, "
                "segment_summaries_json=excluded.segment_summaries_json, "
                "summary_markdown=excluded.summary_markdown, "
                "outline_json=excluded.outline_json, "
                "error_code=excluded.error_code, "
                "error_message=excluded.error_message, "
                "updated_at=strftime('%Y-%m-%d %H:%M:%f','now')"
            ),
            (
                video_id,
                status,
                float(progress),
                message,
                transcript_hash,
                params_json,
                segment_summaries_json,
                summary_markdown,
                outline_json,
                error_code,
                error_message,
            ),
        )


def get_video_summary(video_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM video_summaries WHERE video_id=?",
            (video_id,),
        ).fetchone()
        return dict(row) if row else None


def update_video_summary(
    video_id: str,
    *,
    status: Optional[str] = None,
    progress: Optional[float] = None,
    message: Optional[str] = None,
    transcript_hash: Optional[str] = None,
    params_json: Optional[str] = None,
    segment_summaries_json: Optional[str] = None,
    summary_markdown: Optional[str] = None,
    outline_json: Optional[str] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if status is not None:
        fields.append("status=?")
        values.append(status)
    if progress is not None:
        fields.append("progress=?")
        values.append(float(progress))
    if message is not None:
        fields.append("message=?")
        values.append(message)
    if transcript_hash is not None:
        fields.append("transcript_hash=?")
        values.append(transcript_hash)
    if params_json is not None:
        fields.append("params_json=?")
        values.append(params_json)
    if segment_summaries_json is not None:
        fields.append("segment_summaries_json=?")
        values.append(segment_summaries_json)
    if summary_markdown is not None:
        fields.append("summary_markdown=?")
        values.append(summary_markdown)
    if outline_json is not None:
        fields.append("outline_json=?")
        values.append(outline_json)
    if error_code is not None:
        fields.append("error_code=?")
        values.append(error_code)
    if error_message is not None:
        fields.append("error_message=?")
        values.append(error_message)

    if not fields:
        return

    fields.append("updated_at=strftime('%Y-%m-%d %H:%M:%f','now')")
    sql = (
        "UPDATE video_summaries SET "
        + ", ".join(fields)
        + " WHERE video_id=?"
    )
    values.append(video_id)
    with connect() as conn:
        conn.execute(sql, tuple(values))


def delete_video_summary(video_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM video_summaries WHERE video_id=?",
            (video_id,),
        )


def upsert_video_keyframe_index(
    *,
    video_id: str,
    status: str,
    progress: float = 0.0,
    message: str = "",
    params_json: Optional[str] = None,
    frame_count: int = 0,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    with connect() as conn:
        conn.execute(
            (
                "INSERT INTO video_keyframe_indexes ("
                "video_id, status, progress, message, params_json, "
                "frame_count, "
                "error_code, error_message"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(video_id) DO UPDATE SET "
                "status=excluded.status, "
                "progress=excluded.progress, "
                "message=excluded.message, "
                "params_json=excluded.params_json, "
                "frame_count=excluded.frame_count, "
                "error_code=excluded.error_code, "
                "error_message=excluded.error_message, "
                "updated_at=strftime('%Y-%m-%d %H:%M:%f','now')"
            ),
            (
                video_id,
                status,
                float(progress),
                message,
                params_json,
                int(frame_count),
                error_code,
                error_message,
            ),
        )


def get_video_keyframe_index(video_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM video_keyframe_indexes WHERE video_id=?",
            (video_id,),
        ).fetchone()
        return dict(row) if row else None


def update_video_keyframe_index(
    video_id: str,
    *,
    status: Optional[str] = None,
    progress: Optional[float] = None,
    message: Optional[str] = None,
    params_json: Optional[str] = None,
    frame_count: Optional[int] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if status is not None:
        fields.append("status=?")
        values.append(status)
    if progress is not None:
        fields.append("progress=?")
        values.append(float(progress))
    if message is not None:
        fields.append("message=?")
        values.append(message)
    if params_json is not None:
        fields.append("params_json=?")
        values.append(params_json)
    if frame_count is not None:
        fields.append("frame_count=?")
        values.append(int(frame_count))
    if error_code is not None:
        fields.append("error_code=?")
        values.append(error_code)
    if error_message is not None:
        fields.append("error_message=?")
        values.append(error_message)

    if not fields:
        return

    fields.append("updated_at=strftime('%Y-%m-%d %H:%M:%f','now')")
    sql = (
        "UPDATE video_keyframe_indexes SET "
        + ", ".join(fields)
        + " WHERE video_id=?"
    )
    values.append(video_id)
    with connect() as conn:
        conn.execute(sql, tuple(values))


def delete_video_keyframe_index(video_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM video_keyframe_indexes WHERE video_id=?",
            (video_id,),
        )


def insert_video_keyframe(
    *,
    id: str,
    video_id: str,
    timestamp_ms: int,
    image_relpath: str,
    method: str,
    width: Optional[int] = None,
    height: Optional[int] = None,
    score: Optional[float] = None,
    metadata_json: Optional[str] = None,
) -> None:
    with connect() as conn:
        conn.execute(
            (
                "INSERT INTO video_keyframes ("
                "id, video_id, timestamp_ms, image_relpath, method, "
                "width, height, score, metadata_json"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ),
            (
                id,
                video_id,
                int(timestamp_ms),
                image_relpath,
                method,
                int(width) if width is not None else None,
                int(height) if height is not None else None,
                float(score) if score is not None else None,
                metadata_json,
            ),
        )


def get_video_keyframe(keyframe_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM video_keyframes WHERE id=?",
            (keyframe_id,),
        ).fetchone()
        return dict(row) if row else None


def get_nearest_video_keyframe(
    *,
    video_id: str,
    timestamp_ms: int,
    method: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    where = "WHERE video_id=?"
    params: list[Any] = [video_id]
    if method:
        where += " AND method=?"
        params.append(str(method))

    ts = int(timestamp_ms)
    with connect() as conn:
        row_before = conn.execute(
            (
                f"SELECT * FROM video_keyframes {where} "
                "AND timestamp_ms<=? ORDER BY timestamp_ms DESC LIMIT 1"
            ),
            tuple(params + [ts]),
        ).fetchone()
        row_after = conn.execute(
            (
                f"SELECT * FROM video_keyframes {where} "
                "AND timestamp_ms>=? ORDER BY timestamp_ms ASC LIMIT 1"
            ),
            tuple(params + [ts]),
        ).fetchone()

    a = dict(row_before) if row_before else None
    b = dict(row_after) if row_after else None
    if a and b:
        da = abs(int(a.get("timestamp_ms") or 0) - ts)
        db = abs(int(b.get("timestamp_ms") or 0) - ts)
        return a if da <= db else b
    return a or b


def list_video_keyframes(
    *,
    video_id: str,
    method: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    where = "WHERE video_id=?"
    params: list[Any] = [video_id]
    if method:
        where += " AND method=?"
        params.append(str(method))

    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))

    with connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(1) AS c FROM video_keyframes {where}",
            tuple(params),
        ).fetchone()["c"]
        rows = conn.execute(
            (
                f"SELECT * FROM video_keyframes {where} "
                "ORDER BY timestamp_ms ASC LIMIT ? OFFSET ?"
            ),
            tuple(params + [limit, offset]),
        ).fetchall()

    return {"total": int(total), "items": [dict(r) for r in rows]}


def delete_video_keyframes_for_video(video_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM video_keyframes WHERE video_id=?",
            (video_id,),
        )


def list_videos(
    *,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    where = ""
    params = []
    if status:
        where = "WHERE status=?"
        params.append(status)

    with connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(1) AS c FROM videos {where}",
            tuple(params),
        ).fetchone()["c"]
        rows = conn.execute(
            (
                f"SELECT * FROM videos {where} "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?"
            ),
            tuple(params + [int(limit), int(offset)]),
        ).fetchall()

    return {"total": int(total), "items": [dict(r) for r in rows]}


def get_active_job_for_video(
    *,
    video_id: str,
    job_type: str,
) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            (
                "SELECT * FROM jobs WHERE video_id=? AND job_type=? "
                "AND status IN ('pending','running') "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            (video_id, job_type),
        ).fetchone()
        return dict(row) if row else None


def upsert_video_index(
    *,
    video_id: str,
    status: str,
    progress: float = 0.0,
    message: str = "",
    embed_model: Optional[str] = None,
    embed_dim: Optional[int] = None,
    chunk_params_json: Optional[str] = None,
    transcript_hash: Optional[str] = None,
    chunk_count: int = 0,
    indexed_count: int = 0,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    with connect() as conn:
        conn.execute(
            (
                "INSERT INTO video_indexes ("
                "video_id, status, progress, message, "
                "embed_model, embed_dim, chunk_params_json, transcript_hash, "
                "chunk_count, indexed_count, error_code, error_message"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(video_id) DO UPDATE SET "
                "status=excluded.status, "
                "progress=excluded.progress, "
                "message=excluded.message, "
                "embed_model=excluded.embed_model, "
                "embed_dim=excluded.embed_dim, "
                "chunk_params_json=excluded.chunk_params_json, "
                "transcript_hash=excluded.transcript_hash, "
                "chunk_count=excluded.chunk_count, "
                "indexed_count=excluded.indexed_count, "
                "error_code=excluded.error_code, "
                "error_message=excluded.error_message, "
                "updated_at=strftime('%Y-%m-%d %H:%M:%f','now')"
            ),
            (
                video_id,
                status,
                float(progress),
                message,
                embed_model,
                int(embed_dim) if embed_dim is not None else None,
                chunk_params_json,
                transcript_hash,
                int(chunk_count),
                int(indexed_count),
                error_code,
                error_message,
            ),
        )


def get_video_index(video_id: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM video_indexes WHERE video_id=?",
            (video_id,),
        ).fetchone()
        return dict(row) if row else None


def update_video_index(
    video_id: str,
    *,
    status: Optional[str] = None,
    progress: Optional[float] = None,
    message: Optional[str] = None,
    chunk_count: Optional[int] = None,
    indexed_count: Optional[int] = None,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    fields: list[str] = []
    values: list[Any] = []

    if status is not None:
        fields.append("status=?")
        values.append(status)
    if progress is not None:
        fields.append("progress=?")
        values.append(float(progress))
    if message is not None:
        fields.append("message=?")
        values.append(message)
    if chunk_count is not None:
        fields.append("chunk_count=?")
        values.append(int(chunk_count))
    if indexed_count is not None:
        fields.append("indexed_count=?")
        values.append(int(indexed_count))
    if error_code is not None:
        fields.append("error_code=?")
        values.append(error_code)
    if error_message is not None:
        fields.append("error_message=?")
        values.append(error_message)

    if not fields:
        return

    fields.append("updated_at=strftime('%Y-%m-%d %H:%M:%f','now')")
    sql = "UPDATE video_indexes SET " + ", ".join(fields) + " WHERE video_id=?"
    values.append(video_id)
    with connect() as conn:
        conn.execute(sql, tuple(values))


def delete_video_index(video_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM video_indexes WHERE video_id=?",
            (video_id,),
        )


def delete_chunks_for_video(video_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM chunks WHERE video_id=?",
            (video_id,),
        )


def insert_chunk(
    *,
    chunk_id: str,
    video_id: str,
    chunk_index: int,
    start_time: float,
    end_time: float,
    text: str,
    content_hash: str,
) -> None:
    with connect() as conn:
        conn.execute(
            (
                "INSERT OR REPLACE INTO chunks ("
                "id, video_id, chunk_index, start_time, end_time, text, "
                "content_hash"
                ") VALUES (?, ?, ?, ?, ?, ?, ?)"
            ),
            (
                chunk_id,
                video_id,
                int(chunk_index),
                float(start_time),
                float(end_time),
                text,
                content_hash,
            ),
        )


def list_chunks(
    *,
    video_id: str,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    with connect() as conn:
        total = conn.execute(
            "SELECT COUNT(1) AS c FROM chunks WHERE video_id=?",
            (video_id,),
        ).fetchone()["c"]
        rows = conn.execute(
            (
                "SELECT * FROM chunks WHERE video_id=? "
                "ORDER BY chunk_index ASC LIMIT ? OFFSET ?"
            ),
            (video_id, int(limit), int(offset)),
        ).fetchall()
    return {"total": int(total), "items": [dict(r) for r in rows]}


def list_jobs(
    *,
    status: Optional[str] = None,
    video_id: Optional[str] = None,
    job_type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    wheres = []
    params = []

    if status:
        wheres.append("status=?")
        params.append(status)
    if video_id:
        wheres.append("video_id=?")
        params.append(video_id)
    if job_type:
        wheres.append("job_type=?")
        params.append(job_type)

    where_sql = "WHERE " + " AND ".join(wheres) if wheres else ""

    with connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(1) AS c FROM jobs {where_sql}",
            tuple(params),
        ).fetchone()["c"]
        rows = conn.execute(
            (
                f"SELECT * FROM jobs {where_sql} "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?"
            ),
            tuple(params + [int(limit), int(offset)]),
        ).fetchall()

    return {"total": int(total), "items": [dict(r) for r in rows]}
