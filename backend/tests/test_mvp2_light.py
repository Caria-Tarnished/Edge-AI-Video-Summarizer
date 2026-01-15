from __future__ import annotations

from typing import Any, Dict

import os
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
        duration=1.0,
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


def test_health_ok(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


def test_index_requires_transcript(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.post(
        f"/videos/{video_id}/index",
        json={"from_scratch": False},
    )
    assert r.status_code == 404
    assert r.json().get("detail") == "TRANSCRIPT_NOT_FOUND"


def test_search_triggers_index_and_dedupes_chat(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    r1 = client.get(
        "/search",
        params={
            "video_id": video_id,
            "query": "hello",
            "top_k": 3,
        },
    )
    assert r1.status_code == 202
    job_id = r1.json().get("job_id")
    assert isinstance(job_id, str) and job_id

    r2 = client.post(
        "/chat",
        json={"video_id": video_id, "query": "hello", "top_k": 3},
    )
    assert r2.status_code == 202
    assert r2.json().get("job_id") == job_id

    r3 = client.get(
        "/search",
        params={
            "video_id": video_id,
            "query": "hello",
            "top_k": 3,
        },
    )
    assert r3.status_code == 202
    assert r3.json().get("job_id") == job_id


def test_search_and_chat_200_when_index_completed(
    client,
    tmp_path,
    monkeypatch,
) -> None:
    from app import main as main_mod
    from app.repo import upsert_video_index
    from app.repo import set_default_llm_preferences
    from app.transcript_store import get_transcript_hash

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    transcript_hash = get_transcript_hash(video_id)

    upsert_video_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        embed_model="hash",
        embed_dim=384,
        transcript_hash=transcript_hash,
        chunk_count=1,
        indexed_count=1,
    )

    def fake_query_vectors(*args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {
            "ids": [["c1"]],
            "documents": [["hello world"]],
            "metadatas": [[{"start_time": 0.0, "end_time": 1.0}]],
            "distances": [[0.0]],
        }

    monkeypatch.setattr(main_mod, "query_vectors", fake_query_vectors)

    set_default_llm_preferences({"provider": "none"})

    r1 = client.get(
        "/search",
        params={"video_id": video_id, "query": "hello", "top_k": 1},
    )
    assert r1.status_code == 200
    items = r1.json().get("items")
    assert isinstance(items, list) and len(items) == 1
    assert items[0].get("chunk_id") == "c1"

    r2 = client.post(
        "/chat",
        json={"video_id": video_id, "query": "hello", "top_k": 1},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body.get("mode") == "retrieval_only"
    citations = body.get("citations")
    assert isinstance(citations, list) and len(citations) == 1
    assert citations[0].get("chunk_id") == "c1"


def test_search_stale_index_triggers_reindex_from_scratch(
    client,
    tmp_path,
) -> None:
    from app.repo import upsert_video_index

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    upsert_video_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        embed_model="hash",
        embed_dim=384,
        transcript_hash="stale",
        chunk_count=1,
        indexed_count=1,
    )

    r = client.get(
        "/search",
        params={"video_id": video_id, "query": "hello", "top_k": 1},
    )
    assert r.status_code == 202
    assert r.json().get("detail") == "INDEXING_STARTED"
    job_id = r.json().get("job_id")
    assert isinstance(job_id, str) and job_id

    job = client.get(f"/jobs/{job_id}").json()
    params = json.loads(job.get("params_json") or "{}")
    assert params.get("from_scratch") is True


def test_summarize_requires_transcript(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r.status_code == 404
    assert r.json().get("detail") == "TRANSCRIPT_NOT_FOUND"


def test_summarize_triggers_job_and_dedupes(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    r1 = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r1.status_code == 202
    job_id = r1.json().get("job_id")
    assert isinstance(job_id, str) and job_id

    r2 = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r2.status_code == 202
    assert r2.json().get("detail") == "SUMMARIZING_IN_PROGRESS"
    assert r2.json().get("job_id") == job_id


def test_summarize_200_when_completed_and_fresh(client, tmp_path) -> None:
    from app.repo import upsert_video_summary
    from app.transcript_store import get_transcript_hash

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)
    transcript_hash = get_transcript_hash(video_id)

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        transcript_hash=transcript_hash,
        params_json=json.dumps({"from_scratch": False}, ensure_ascii=False),
        summary_markdown="# ok",
        outline_json="[]",
        segment_summaries_json="[]",
    )

    r = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r.status_code == 200
    assert r.json().get("detail") == "SUMMARY_ALREADY_COMPLETED"


def test_summarize_stale_triggers_from_scratch(client, tmp_path) -> None:
    from app.repo import upsert_video_summary

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    upsert_video_summary(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        transcript_hash="stale",
        params_json=json.dumps({"from_scratch": False}, ensure_ascii=False),
        summary_markdown="# stale",
        outline_json="[]",
        segment_summaries_json="[]",
    )

    r = client.post(
        f"/videos/{video_id}/summarize",
        json={"from_scratch": False},
    )
    assert r.status_code == 202
    job_id = r.json().get("job_id")
    assert isinstance(job_id, str) and job_id

    job = client.get(f"/jobs/{job_id}").json()
    params = json.loads(job.get("params_json") or "{}")
    assert params.get("from_scratch") is True


def test_keyframes_triggers_job_and_dedupes(client, tmp_path) -> None:
    v = _create_video(tmp_path)
    video_id = v["id"]

    r1 = client.post(
        f"/videos/{video_id}/keyframes",
        json={"from_scratch": False, "mode": "interval"},
    )
    assert r1.status_code == 202
    job_id = r1.json().get("job_id")
    assert isinstance(job_id, str) and job_id

    r2 = client.post(
        f"/videos/{video_id}/keyframes",
        json={"from_scratch": False, "mode": "interval"},
    )
    assert r2.status_code == 202
    assert r2.json().get("detail") == "KEYFRAMES_IN_PROGRESS"
    assert r2.json().get("job_id") == job_id


def test_keyframes_200_when_completed_params_match(client, tmp_path) -> None:
    from app.repo import upsert_video_keyframe_index

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_keyframe_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        params_json=json.dumps({"mode": "interval"}, ensure_ascii=False),
        frame_count=1,
    )

    r = client.post(
        f"/videos/{video_id}/keyframes",
        json={"from_scratch": False, "mode": "interval"},
    )
    assert r.status_code == 200
    assert r.json().get("detail") == "KEYFRAMES_ALREADY_COMPLETED"


def test_keyframes_completed_but_params_change_triggers_new_job(
    client,
    tmp_path,
) -> None:
    from app.repo import upsert_video_keyframe_index

    v = _create_video(tmp_path)
    video_id = v["id"]

    upsert_video_keyframe_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        message="completed",
        params_json=json.dumps({"mode": "interval"}, ensure_ascii=False),
        frame_count=1,
    )

    r = client.post(
        f"/videos/{video_id}/keyframes",
        json={
            "from_scratch": False,
            "mode": "scene",
            "scene_threshold": 0.3,
        },
    )
    assert r.status_code == 202
    assert r.json().get("detail") == "KEYFRAMES_STARTED"


def test_keyframes_from_scratch_deletes_jpg_files(client, tmp_path) -> None:
    from app.paths import keyframes_dir

    v = _create_video(tmp_path)
    video_id = v["id"]

    d = keyframes_dir(video_id)
    os.makedirs(d, exist_ok=True)
    jpg_path = os.path.join(d, "dummy.jpg")
    txt_path = os.path.join(d, "dummy.txt")
    with open(jpg_path, "wb") as f:
        f.write(b"x")
    with open(txt_path, "wb") as f:
        f.write(b"y")

    r = client.post(
        f"/videos/{video_id}/keyframes",
        json={"from_scratch": True, "mode": "interval"},
    )
    assert r.status_code == 202
    assert not os.path.exists(jpg_path)
    assert os.path.exists(txt_path)


def test_index_endpoint_is_idempotent_when_fresh(client, tmp_path) -> None:
    from app.repo import upsert_video_index
    from app.transcript_store import get_transcript_hash

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)
    transcript_hash = get_transcript_hash(video_id)

    upsert_video_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        embed_model="hash",
        embed_dim=384,
        transcript_hash=transcript_hash,
        chunk_count=1,
        indexed_count=1,
    )

    r = client.post(
        f"/videos/{video_id}/index",
        json={"from_scratch": False},
    )
    assert r.status_code == 200
    assert r.json().get("detail") == "INDEX_ALREADY_COMPLETED"


def test_search_and_chat_fallback_to_legacy_collection_when_missing(
    client,
    tmp_path,
    monkeypatch,
) -> None:
    from app import main as main_mod
    from app.repo import upsert_video_index
    from app.repo import set_default_llm_preferences
    from app.transcript_store import get_transcript_hash
    from app.vector_store import LEGACY_COLLECTION_NAME, chunks_collection_name

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)
    transcript_hash = get_transcript_hash(video_id)

    embed_model = "hash"
    embed_dim = 384
    versioned = chunks_collection_name(embed_model, embed_dim)

    upsert_video_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        embed_model=embed_model,
        embed_dim=embed_dim,
        transcript_hash=transcript_hash,
        chunk_count=1,
        indexed_count=1,
    )

    calls: list[tuple[str, bool]] = []

    def fake_query_vectors(*args: Any, **kwargs: Any) -> Dict[str, Any]:
        name = str(kwargs.get("collection_name") or "")
        create_if_missing = bool(kwargs.get("create_if_missing", True))
        calls.append((name, create_if_missing))

        if name == versioned:
            return {
                "ids": [[]],
                "documents": [[]],
                "metadatas": [[]],
                "distances": [[]],
                "_collection_missing": True,
            }

        if name == LEGACY_COLLECTION_NAME:
            return {
                "ids": [["c1"]],
                "documents": [["hello world"]],
                "metadatas": [[{"start_time": 0.0, "end_time": 1.0}]],
                "distances": [[0.0]],
            }

        return {
            "ids": [[]],
            "documents": [[]],
            "metadatas": [[]],
            "distances": [[]],
        }

    monkeypatch.setattr(main_mod, "query_vectors", fake_query_vectors)

    set_default_llm_preferences({"provider": "none"})

    r1 = client.get(
        "/search",
        params={"video_id": video_id, "query": "hello", "top_k": 1},
    )
    assert r1.status_code == 200
    items = r1.json().get("items")
    assert (
        isinstance(items, list)
        and items
        and items[0].get("chunk_id") == "c1"
    )

    r2 = client.post(
        "/chat",
        json={"video_id": video_id, "query": "hello", "top_k": 1},
    )
    assert r2.status_code == 200
    citations = r2.json().get("citations")
    assert (
        isinstance(citations, list)
        and citations
        and citations[0].get("chunk_id") == "c1"
    )

    assert calls == [
        (versioned, False),
        (LEGACY_COLLECTION_NAME, False),
        (versioned, False),
        (LEGACY_COLLECTION_NAME, False),
    ]


def test_llm_default_preferences_get_put(client) -> None:
    r1 = client.get("/llm/preferences/default")
    assert r1.status_code == 200
    prefs = r1.json().get("preferences")
    assert isinstance(prefs, dict)

    r2 = client.put(
        "/llm/preferences/default",
        json={
            "provider": "fake",
            "model": "unit-test",
            "temperature": 0.1,
            "max_tokens": 64,
        },
    )
    assert r2.status_code == 200
    prefs2 = r2.json().get("preferences")
    assert isinstance(prefs2, dict)
    assert prefs2.get("provider") == "fake"


def test_chat_sse_streaming_with_fake_provider(
    client,
    tmp_path,
    monkeypatch,
) -> None:
    from app import main as main_mod
    from app.repo import set_default_llm_preferences, upsert_video_index
    from app.transcript_store import get_transcript_hash

    v = _create_video(tmp_path)
    video_id = v["id"]
    _write_transcript(video_id)

    transcript_hash = get_transcript_hash(video_id)
    upsert_video_index(
        video_id=video_id,
        status="completed",
        progress=1.0,
        embed_model="hash",
        embed_dim=384,
        transcript_hash=transcript_hash,
        chunk_count=1,
        indexed_count=1,
    )

    def fake_query_vectors(*args: Any, **kwargs: Any) -> Dict[str, Any]:
        return {
            "ids": [["c1"]],
            "documents": [["hello world"]],
            "metadatas": [[{"start_time": 0.0, "end_time": 1.0}]],
            "distances": [[0.0]],
        }

    monkeypatch.setattr(main_mod, "query_vectors", fake_query_vectors)
    set_default_llm_preferences({"provider": "fake", "model": "unit-test"})

    r = client.post(
        "/chat",
        json={
            "video_id": video_id,
            "query": "hello",
            "top_k": 1,
            "stream": True,
        },
    )
    assert r.status_code == 200
    assert "text/event-stream" in r.headers.get("content-type", "")

    text = r.text
    assert "event: token" in text
    assert "event: done" in text
