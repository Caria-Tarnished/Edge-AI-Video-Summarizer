import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .paths import db_path, ensure_dirs


def _has_column(conn: sqlite3.Connection, table: str, col: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


def _migrate(conn: sqlite3.Connection) -> None:
    if not _has_column(conn, "jobs", "updated_at"):
        conn.execute("ALTER TABLE jobs ADD COLUMN updated_at TEXT")
        conn.execute(
            "UPDATE jobs SET updated_at=created_at WHERE updated_at IS NULL"
        )


def init_db() -> None:
    ensure_dirs()
    with connect() as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                file_hash TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                duration REAL NOT NULL,
                file_size INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);
            CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                job_type TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL DEFAULT 0,
                message TEXT DEFAULT '',
                params_json TEXT,
                result_json TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                started_at TEXT,
                completed_at TEXT,
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_video ON jobs(video_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);

            CREATE TABLE IF NOT EXISTS video_indexes (
                video_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                progress REAL DEFAULT 0,
                message TEXT DEFAULT '',
                embed_model TEXT,
                embed_dim INTEGER,
                chunk_params_json TEXT,
                transcript_hash TEXT,
                chunk_count INTEGER DEFAULT 0,
                indexed_count INTEGER DEFAULT 0,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_video_indexes_status
                ON video_indexes(status);

            CREATE TABLE IF NOT EXISTS video_summaries (
                video_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                progress REAL DEFAULT 0,
                message TEXT DEFAULT '',
                transcript_hash TEXT,
                params_json TEXT,
                segment_summaries_json TEXT,
                summary_markdown TEXT,
                outline_json TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_video_summaries_status
                ON video_summaries(status);

            CREATE TABLE IF NOT EXISTS video_keyframe_indexes (
                video_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                progress REAL DEFAULT 0,
                message TEXT DEFAULT '',
                params_json TEXT,
                frame_count INTEGER DEFAULT 0,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_video_keyframe_indexes_status
                ON video_keyframe_indexes(status);

            CREATE TABLE IF NOT EXISTS video_keyframes (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                image_relpath TEXT NOT NULL,
                method TEXT NOT NULL,
                width INTEGER,
                height INTEGER,
                score REAL,
                metadata_json TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_video_keyframes_video_time
                ON video_keyframes(video_id, timestamp_ms);

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                text TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                UNIQUE (video_id, chunk_index)
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_video ON chunks(video_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
            CREATE INDEX IF NOT EXISTS idx_chunks_time
                ON chunks(video_id, start_time);

            CREATE TABLE IF NOT EXISTS llm_preferences (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                prefs_json TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            INSERT OR IGNORE INTO llm_preferences (id, prefs_json)
                VALUES (
                    1,
                    '{"provider":"fake","temperature":0.2,"max_tokens":512}'
                );
            """
        )
        _migrate(conn)
        conn.commit()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    ensure_dirs()
    conn = sqlite3.connect(db_path(), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
    finally:
        conn.close()
