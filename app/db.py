from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    cache_file TEXT,
    start_time TEXT,
    sport TEXT,
    name TEXT,
    duration_s REAL,
    distance_m REAL,
    n_points INTEGER,
    coarse_gap_m REAL DEFAULT 0,
    has_gps INTEGER DEFAULT 0,
    has_speed INTEGER DEFAULT 0,
    has_hr INTEGER DEFAULT 0,
    has_cadence INTEGER DEFAULT 0,
    has_power INTEGER DEFAULT 0,
    has_altitude INTEGER DEFAULT 0,
    has_temp INTEGER DEFAULT 0,
    min_lat REAL,
    max_lat REAL,
    min_lon REAL,
    max_lon REAL,
    indexed_at TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS coarse_points (
    id INTEGER PRIMARY KEY,
    activity_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coarse_activity ON coarse_points(activity_id);

CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    activity_id INTEGER NOT NULL,
    start_idx INTEGER NOT NULL,
    end_idx INTEGER NOT NULL,
    length_m REAL,
    created_at TEXT,
    params TEXT
);

CREATE TABLE IF NOT EXISTS segment_matches (
    segment_id INTEGER NOT NULL,
    activity_id INTEGER NOT NULL,
    pass_start_idx INTEGER,
    pass_end_idx INTEGER,
    duration_s REAL,
    distance_m REAL,
    avg_speed_mps REAL,
    avg_hr REAL,
    coverage REAL,
    d_start_m REAL,
    d_end_m REAL,
    is_best INTEGER DEFAULT 0,
    computed_at TEXT,
    PRIMARY KEY (segment_id, activity_id, pass_start_idx)
);

CREATE TABLE IF NOT EXISTS garmin_sync (
    garmin_id INTEGER PRIMARY KEY,
    name TEXT,
    start_time TEXT,
    sport TEXT,
    has_gps INTEGER DEFAULT 1,
    file_path TEXT,
    status TEXT,
    error TEXT,
    synced_at TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT
);
"""


def connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(config.DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        try:
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS coarse_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon)"
            )
        except sqlite3.OperationalError:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS coarse_rtree (id INTEGER PRIMARY KEY, min_lat REAL, max_lat REAL, min_lon REAL, max_lon REAL)"
            )


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def load_preferences() -> dict:
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM preferences").fetchall()
    out = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except ValueError:
            continue
    return out


def save_preferences(values: dict) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db() as conn:
        for key, value in values.items():
            conn.execute(
                """
                INSERT INTO preferences(key, value, updated_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (str(key), json.dumps(value), now),
            )
