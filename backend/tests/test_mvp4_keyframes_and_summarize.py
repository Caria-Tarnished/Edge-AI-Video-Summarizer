from __future__ import annotations

from typing import Any, Dict

import json
import uuid


def _create_video(tmp_path) -> Dict[str, Any]:
    from app.hashing import sha256_file
    from app.repo import create_or_get_video

    p = tmp_path / "video.mp4"
    p.write_bytes(uuid.uuid4().hex.encode("utf-8"))
    return create_or_get_video(
        file_path=str(p),
        file_hash=sha256_file(str(p)),
        duration=10.0,
    )


def _write_transcript(video_id: str) -> None:
    from app.transcript_store import append_segments

    append_segments(
        video_id,
        [
            {
                "start": 0.0,
                "end": 1.0,
                "text": "hello world",
            }
        ],
    )


def test_summarize_video_not_found(client) -> None:
    video_id = str(uuid.uuid4())
    r = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r.status_code == 404
    assert r.json().get("detail") == "VIDEO_NOT_FOUND"


def test_summarize_requires_transcript(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r.status_code == 404
    assert r.json().get("detail") == "TRANSCRIPT_NOT_FOUND"


def test_outline_requires_summary(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.get(f"/videos/{video_id}/outline")
    assert r.status_code == 404
    assert r.json().get("detail") == "SUMMARY_NOT_FOUND"


def test_export_requires_completed_summary(client, tmp_path) -> None:
    from app.repo import upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_summary(
        video_id=video_id,
        status="running",
        progress=0.2,
        message="running",
    )

    r = client.get(f"/videos/{video_id}/export/markdown")
    assert r.status_code == 400
    assert r.json().get("detail") == "SUMMARY_NOT_COMPLETED"


def test_export_empty_returns_summary_empty(client, tmp_path) -> None:
    from app.repo import upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        summary_markdown="",
    )

    r = client.get(f"/videos/{video_id}/export/markdown")
    assert r.status_code == 404
    assert r.json().get("detail") == "SUMMARY_EMPTY"


def test_aligned_keyframes_rejects_bad_method(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.get(
        f"/videos/{video_id}/keyframes/aligned",
        params={"method": "bad"},
    )
    assert r.status_code == 400
    assert r.json().get("detail") == "UNSUPPORTED_KEYFRAMES_METHOD"


def test_aligned_keyframes_rejects_bad_fallback(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.get(
        f"/videos/{video_id}/keyframes/aligned",
        params={"method": "interval", "fallback": "bad"},
    )
    assert r.status_code == 400
    assert r.json().get("detail") == "UNSUPPORTED_FALLBACK"


def test_aligned_keyframes_requires_summary(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.get(
        f"/videos/{video_id}/keyframes/aligned",
        params={"method": "interval"},
    )
    assert r.status_code == 404
    assert r.json().get("detail") == "SUMMARY_NOT_FOUND"


def test_aligned_keyframes_scene_nearest_fallback_selects_frames(
    client,
    tmp_path,
) -> None:
    from app.repo import insert_video_keyframe, upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        outline_json=json.dumps(
            [
                {
                    "title": "sec1",
                    "start_time": 0.0,
                    "end_time": 10.0,
                }
            ],
            ensure_ascii=False,
        ),
    )

    kid1 = str(uuid.uuid4())
    kid2 = str(uuid.uuid4())
    insert_video_keyframe(
        id=kid1,
        video_id=video_id,
        timestamp_ms=1000,
        image_relpath=f"data/keyframes/{video_id}/{kid1}.jpg",
        method="interval",
        width=320,
        height=240,
        score=None,
    )
    insert_video_keyframe(
        id=kid2,
        video_id=video_id,
        timestamp_ms=6000,
        image_relpath=f"data/keyframes/{video_id}/{kid2}.jpg",
        method="interval",
        width=320,
        height=240,
        score=None,
    )

    r = client.get(
        f"/videos/{video_id}/keyframes/aligned",
        params={
            "method": "scene",
            "fallback": "nearest",
            "per_section": 2,
        },
    )
    assert r.status_code == 200
    body = r.json()
    items = body.get("items")
    assert isinstance(items, list) and len(items) == 1
    kfs = items[0].get("keyframes")
    assert isinstance(kfs, list) and len(kfs) == 2
    assert [int(x.get("timestamp_ms") or 0) for x in kfs] == [1000, 6000]


def test_keyframes_idempotent_interval_params(client, tmp_path) -> None:
    from app.repo import upsert_video_keyframe_index, upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        outline_json=json.dumps([], ensure_ascii=False),
    )

    params = {
        "mode": "interval",
        "interval_seconds": 5.0,
        "max_frames": 10,
        "target_width": 320,
    }
    upsert_video_keyframe_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        params_json=json.dumps(params, ensure_ascii=False),
        frame_count=0,
    )

    r = client.post(
        f"/videos/{video_id}/keyframes",
        json=params,
    )
    assert r.status_code == 200
    assert r.json().get("detail") == "KEYFRAMES_ALREADY_COMPLETED"


def test_keyframes_idempotent_scene_params(client, tmp_path) -> None:
    from app.repo import upsert_video_keyframe_index, upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        outline_json=json.dumps([], ensure_ascii=False),
    )

    params = {
        "mode": "scene",
        "scene_threshold": 0.3,
        "min_gap_seconds": 2.0,
        "max_frames": 10,
        "target_width": 320,
    }
    upsert_video_keyframe_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        params_json=json.dumps(params, ensure_ascii=False),
        frame_count=0,
    )

    r = client.post(
        f"/videos/{video_id}/keyframes",
        json=params,
    )
    assert r.status_code == 200
    assert r.json().get("detail") == "KEYFRAMES_ALREADY_COMPLETED"
