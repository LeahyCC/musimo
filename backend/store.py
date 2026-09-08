import json
import os
import sqlite3
import threading
from pathlib import Path

from backend.models import Settings

RETAIN_EVENTS = 5000


class LockedSetting(ValueError):
    pass


class Store:
    def __init__(self, path: Path) -> None:
        self.lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA foreign_keys=ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > 3:
            raise RuntimeError("Database is newer than this application; do not downgrade in place")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL,
                origin TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS job_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS sources_health (
                source TEXT PRIMARY KEY, status TEXT NOT NULL,
                latency_ms REAL, detail TEXT NOT NULL, checked_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity_state (
                id INTEGER PRIMARY KEY CHECK(id=1), cleared_through INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO activity_state(id) VALUES (1);
        """)
        self.db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS search_cache (
                key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_roots (
                path TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS library_files (
                path TEXT PRIMARY KEY, root TEXT NOT NULL REFERENCES library_roots(path),
                mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, generation TEXT NOT NULL,
                title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
                title_key TEXT NOT NULL, artist_key TEXT NOT NULL, album_key TEXT NOT NULL,
                duration REAL NOT NULL, isrc TEXT NOT NULL, mbid TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_isrc ON library_files(isrc) WHERE isrc != '';
            CREATE INDEX IF NOT EXISTS library_mbid ON library_files(mbid) WHERE mbid != '';
            CREATE INDEX IF NOT EXISTS library_identity
                ON library_files(artist_key,title_key,duration);
            CREATE INDEX IF NOT EXISTS library_album ON library_files(artist_key,album_key);
            CREATE INDEX IF NOT EXISTS library_root ON library_files(root,generation);
            CREATE VIRTUAL TABLE IF NOT EXISTS library_fts
                USING fts5(path UNINDEXED,title,artist,album);
            CREATE TABLE IF NOT EXISTS library_state
                (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, catalog TEXT NOT NULL, track_id INTEGER NOT NULL,
                format TEXT NOT NULL, bitrate INTEGER NOT NULL, target TEXT NOT NULL,
                active INTEGER NOT NULL, created_at REAL NOT NULL, payload TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_identity
                ON jobs(catalog,track_id,format,bitrate,target) WHERE active=1;
            CREATE INDEX IF NOT EXISTS jobs_catalog_track ON jobs(catalog,track_id);
            CREATE TABLE IF NOT EXISTS queue_control (
                id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
                source_paused INTEGER NOT NULL DEFAULT 0,
                blocking_failures INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO queue_control(id) VALUES (1);
            CREATE TABLE IF NOT EXISTS linked_playlists (
                key TEXT PRIMARY KEY,
                playlist_id TEXT NOT NULL
            );
            PRAGMA user_version=3;
            COMMIT;
        """)
        self.seed()

    def save_library_status(self, payload: dict[str, object]) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    "INSERT OR REPLACE INTO library_state VALUES (1,?)", (json.dumps(payload),)
                )
                self._event("library.updated", payload)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def seed(self) -> None:
        with self.lock:
            existing = {row["key"] for row in self.db.execute("SELECT key FROM settings")}
            values = Settings().model_dump()
            seeds: list[tuple[str, str, str, int]] = []
            # Environment values only seed missing keys, so restarts cannot overwrite UI choices.
            for key, default in values.items():
                if key in existing:
                    continue
                env = f"MUSIMO_{key.upper()}"
                raw = os.environ.get(env)
                value: object = int(raw) if raw is not None and isinstance(default, int) else raw
                values[key] = default if raw is None else value
                seeds.append(
                    (
                        key,
                        json.dumps(values[key]),
                        env if raw is not None else "default",
                        int(raw is not None),
                    )
                )
            Settings.model_validate(values)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.executemany("INSERT INTO settings VALUES (?,?,?,?)", seeds)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def settings(self) -> dict[str, object]:
        with self.lock:
            return {
                row["key"]: {
                    "value": json.loads(row["value"]),
                    "origin": row["origin"],
                    "locked": bool(row["locked"]),
                }
                for row in self.db.execute("SELECT * FROM settings ORDER BY key")
            }

    def _event(self, kind: str, payload: object) -> int:
        cur = self.db.execute(
            "INSERT INTO job_events (kind,payload) VALUES (?,?)", (kind, json.dumps(payload))
        )
        event_id = int(cur.lastrowid or 0)
        self.db.execute("DELETE FROM job_events WHERE id <= ?", (event_id - RETAIN_EVENTS,))
        return event_id

    def linked_playlist(self, key: str) -> str | None:
        with self.lock:
            row = self.db.execute(
                "SELECT playlist_id FROM linked_playlists WHERE key=?", (key,)
            ).fetchone()
            return str(row[0]) if row else None

    def set_linked_playlist(self, key: str, playlist_id: str) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    """
                    INSERT INTO linked_playlists VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET playlist_id=excluded.playlist_id
                    """,
                    (key, playlist_id),
                )
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def clear_linked_playlist(self, key: str) -> None:
        with self.lock:
            self.db.execute("DELETE FROM linked_playlists WHERE key=?", (key,))

    def update(self, changes: dict[str, object]) -> dict[str, object]:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                current = {
                    r["key"]: json.loads(r["value"])
                    for r in self.db.execute("SELECT * FROM settings")
                }
                Settings.model_validate(current | changes)
                for key, value in changes.items():
                    row = self.db.execute(
                        "SELECT locked FROM settings WHERE key=?", (key,)
                    ).fetchone()
                    if row is None or row["locked"]:
                        raise LockedSetting(f"{key} is locked by its bootstrap environment")
                    self.db.execute(
                        "UPDATE settings SET value=?,origin='database' WHERE key=?",
                        (json.dumps(value), key),
                    )
                result = self.settings()
                if changes:
                    self._event("settings.updated", result)
                self.db.commit()
                return result
            except Exception:
                self.db.rollback()
                raise

    def snapshot(self) -> dict[str, object]:
        # Keep cursor and state in one critical section: a new subscriber must not miss a write.
        with self.lock:
            jobs = [
                json.loads(row[0])
                for row in self.db.execute(
                    "SELECT json_remove(payload,'$.meta.lyrics','$.meta.synced_lyrics') FROM jobs "
                    "WHERE active=1 OR json_extract(payload,'$.batch_id') IN "
                    "(SELECT json_extract(payload,'$.batch_id') FROM jobs WHERE active=1 "
                    "AND json_extract(payload,'$.batch_id')!='') "
                    "OR id IN (SELECT id FROM jobs WHERE active=0 "
                    "AND json_extract(payload,'$.hidden')=0 "
                    "AND json_extract(payload,'$.stage')='failed' "
                    "ORDER BY created_at DESC LIMIT 50) "
                    "OR id IN (SELECT id FROM jobs WHERE active=0 "
                    "AND json_extract(payload,'$.hidden')=0 "
                    "AND json_extract(payload,'$.stage')!='failed' "
                    "ORDER BY created_at DESC LIMIT 50) "
                    "ORDER BY created_at DESC"
                )
            ]
            control = self.db.execute(
                "SELECT paused,source_paused FROM queue_control WHERE id=1"
            ).fetchone()
            return {
                "settings": self.settings(),
                "jobs": jobs,
                "summary": self.job_summary(),
                "cursor": self.bounds()[1],
                "controls": {"paused": bool(control[0]), "source_paused": bool(control[1])},
            }

    def job_summary(self) -> dict[str, object]:
        with self.lock:
            rows = self.db.execute(
                "SELECT json_extract(payload,'$.stage') stage,"
                "json_extract(payload,'$.error_code') error_code,"
                "json_extract(payload,'$.error') error,count(*) amount FROM jobs "
                "WHERE coalesce(json_extract(payload,'$.hidden'),0)=0 "
                "GROUP BY stage,error_code,error ORDER BY amount DESC"
            ).fetchall()
        active = sum(
            int(row["amount"])
            for row in rows
            if row["stage"] not in {"done", "failed", "cancelled"}
        )
        failures = [
            {
                "code": str(row["error_code"] or ""),
                "message": str(row["error"] or ""),
                "count": int(row["amount"]),
            }
            for row in rows
            if row["stage"] == "failed"
        ]
        return {
            "active": active,
            "failed": sum(int(row["amount"]) for row in rows if row["stage"] == "failed"),
            "failure_reasons": failures,
        }

    def bounds(self) -> tuple[int, int]:
        with self.lock:
            row = self.db.execute(
                "SELECT coalesce(min(id),0),coalesce(max(id),0) FROM job_events"
            ).fetchone()
            return int(row[0]), int(row[1])

    def events(self, after: int, limit: int = 500) -> list[dict[str, object]]:
        with self.lock:
            return [
                {
                    "id": r["id"],
                    "kind": r["kind"],
                    "payload": json.loads(r["payload"]),
                    "created_at": r["created_at"],
                }
                for r in self.db.execute(
                    "SELECT * FROM job_events WHERE id>? ORDER BY id LIMIT ?", (after, limit)
                )
            ]

    def source_health(self) -> list[dict[str, object]]:
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM sources_health")]

    def activity(self) -> dict[str, object]:
        with self.lock:
            cutoff = self.db.execute(
                "SELECT cleared_through FROM activity_state WHERE id=1"
            ).fetchone()[0]
            rows = self.db.execute(
                "SELECT * FROM job_events WHERE id>? AND kind!='activity.cleared' "
                "ORDER BY id DESC LIMIT 100",
                (cutoff,),
            ).fetchall()
            count = self.db.execute(
                "SELECT count(*) FROM job_events WHERE id>? AND kind!='activity.cleared'", (cutoff,)
            ).fetchone()[0]
            return {
                "events": [
                    {
                        "id": row["id"],
                        "kind": row["kind"],
                        "created_at": row["created_at"],
                        "payload": json.loads(row["payload"]),
                    }
                    for row in rows
                ],
                "count": count,
                "cursor": self.bounds()[1],
            }

    def clear_activity(self, through: int) -> dict[str, object]:
        # Keep replay events intact for connected tabs. A durable cutoff clears only the feed
        # the user saw; events arriving after their snapshot remain visible.
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                cutoff = min(through, self.bounds()[1])
                self.db.execute(
                    "UPDATE activity_state SET cleared_through=max(cleared_through,?) WHERE id=1",
                    (cutoff,),
                )
                self._event("activity.cleared", {"through": cutoff})
                self.db.commit()
                return self.activity()
            except Exception:
                self.db.rollback()
                raise

    def record_probe(
        self, status: str, latency: float, detail: str, source: str = "deezer"
    ) -> dict[str, object]:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    """
                    INSERT INTO sources_health VALUES
                    (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    ON CONFLICT(source) DO UPDATE SET status=excluded.status,
                    latency_ms=excluded.latency_ms,detail=excluded.detail,checked_at=excluded.checked_at
                """,
                    (source, status, latency, detail),
                )
                result = next(row for row in self.source_health() if row["source"] == source)
                self._event("source.updated", result)
                self.db.commit()
                return result
            except Exception:
                self.db.rollback()
                raise

    def close(self) -> None:
        with self.lock:
            self.db.close()
