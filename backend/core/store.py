import json
import os
import secrets
import sqlite3
import threading
from pathlib import Path

from backend.core.models import CATALOG_ORDER, Settings, clean_arl
from backend.core.sources import source_label

RETAIN_EVENTS = 5000
SCHEMA_VERSION = 12
# Music bot proposals kept, newest first by last use, and revisions kept per proposal. They are
# suggestion state, not history: a dropped one is only a preview the client has to ask for again.
PROPOSAL_LIMIT = 20
REVISION_LIMIT = 20
# Commit receipts kept, newest first. They outlive their proposal, so a retry after the
# proposal was dropped still gets its first receipt instead of saving again.
RECEIPT_LIMIT = 200
# Recent shown-song memory: the last few presented library results, and the most ids a search
# reads from them. The same bound the browser kept in its tab before the server held it.
SHOWN_RESULTS = 3
SHOWN_IDS = 500
SHOWN_PROFILE = "default"
# Presentation keys remembered so a late duplicate is still recognised after its result has aged
# out of the last SHOWN_RESULTS. Opaque keys only, no songs.
SHOWN_ACKS = 50
# Rows that stay in the settings table but are not settings. Each is stripped before validation,
# because Settings refuses keys it does not know.
# deezer_arl held the Deezer cookie. The cookie is a file now and the row stays empty, so a
# first-start seed from MUSIMO_DEEZER_ARL does not run again after the cookie is removed.
SECRET_KEYS = frozenset({"deezer_arl"})
# soundcloud_fallback was the old SoundCloud switch. It only feeds the source_order migration.
RETIRED_KEYS = frozenset({"soundcloud_fallback"})
# Playback used to ask a separate server. The version 6 upgrade deletes these rows.
# They are not settings: Settings refuses keys it does not know, so leaving a row would
# stop the database from opening.
REMOVED_SETTING_KEYS = ("navidrome_url", "navidrome_mode", "navidrome_library_id")


def new_song_id() -> str:
    """Opaque song id: `tr-` plus 16 hex characters, inside the player's id rule."""
    return "tr-" + secrets.token_hex(8)


def note_library_change(db: sqlite3.Connection) -> None:
    """Bump the library revision. The caller holds the store lock and a write transaction."""
    db.execute("UPDATE library_revision SET value=value+1 WHERE id=1")


def drop_song_references(db: sqlite3.Connection, song_ids: list[str]) -> None:
    """Drop playlist, queue, waveform and audio profile rows for songs that just left the index.

    The caller holds the store lock and a write transaction. Positions are packed
    again so a playlist index still matches the row the browser asked to remove.
    """
    ids = [song_id for song_id in song_ids if song_id]
    if not ids:
        return
    payload = json.dumps(ids)
    playlists = [
        int(row[0])
        for row in db.execute(
            "SELECT DISTINCT playlist_id FROM playlist_songs "
            "WHERE song_id IN (SELECT value FROM json_each(?))",
            (payload,),
        )
    ]
    db.execute(
        "DELETE FROM playlist_songs WHERE song_id IN (SELECT value FROM json_each(?))",
        (payload,),
    )
    for playlist_id in playlists:
        _repack_playlist(db, playlist_id)
    db.execute(
        "DELETE FROM play_queue_songs WHERE song_id IN (SELECT value FROM json_each(?))",
        (payload,),
    )
    db.execute(
        "DELETE FROM waveforms WHERE song_id IN (SELECT value FROM json_each(?))",
        (payload,),
    )
    db.execute(
        "DELETE FROM audio_profile WHERE song_id IN (SELECT value FROM json_each(?))",
        (payload,),
    )
    db.execute(
        "DELETE FROM audio_job WHERE song_id IN (SELECT value FROM json_each(?))",
        (payload,),
    )
    _repack_queue(db)


def _repack_playlist(db: sqlite3.Connection, playlist_id: int) -> None:
    songs = [
        str(row[0])
        for row in db.execute(
            "SELECT song_id FROM playlist_songs WHERE playlist_id=? ORDER BY position",
            (playlist_id,),
        )
    ]
    db.execute("DELETE FROM playlist_songs WHERE playlist_id=?", (playlist_id,))
    db.executemany(
        "INSERT INTO playlist_songs VALUES (?,?,?)",
        [(playlist_id, index, song_id) for index, song_id in enumerate(songs)],
    )


def _repack_queue(db: sqlite3.Connection) -> None:
    songs = [
        str(row[0]) for row in db.execute("SELECT song_id FROM play_queue_songs ORDER BY position")
    ]
    current = str(db.execute("SELECT current_id FROM play_queue WHERE id=1").fetchone()[0])
    db.execute("DELETE FROM play_queue_songs")
    db.executemany(
        "INSERT INTO play_queue_songs VALUES (?,?)",
        list(enumerate(songs)),
    )
    if current not in songs:
        db.execute("UPDATE play_queue SET current_id='', position_ms=0 WHERE id=1")


def settings_only(values: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in values.items()
        if key not in SECRET_KEYS and key not in RETIRED_KEYS
    }


# Same rows the queue shows, each arm on its own index: active work, finished
# siblings of an active batch, the latest 50 no-match failures, the latest 50 other
# failures, and the latest 50 other finished jobs. One OR across the payload parsed
# the whole history (about half a second at 50k jobs). A no-match album must not
# push a real failure out of that window. Each arm names its index: the app never
# runs ANALYZE, and without statistics SQLite served every arm from
# jobs_inactive_recent and parsed the whole history again.
VISIBLE_ID_SQL = """
SELECT id FROM jobs INDEXED BY jobs_active_identity WHERE active=1
UNION
SELECT j.id FROM (
    SELECT DISTINCT json_extract(payload,'$.batch_id') AS batch_id
    FROM jobs INDEXED BY jobs_active_identity
    WHERE active=1 AND json_extract(payload,'$.batch_id') != ''
) batches
CROSS JOIN jobs j INDEXED BY jobs_batch_id
    ON json_extract(j.payload,'$.batch_id') = batches.batch_id
WHERE j.active=0
UNION
SELECT id FROM (
    SELECT id FROM jobs INDEXED BY jobs_shown_nomatch
    WHERE active=0 AND json_extract(payload,'$.hidden')=0
      AND json_extract(payload,'$.stage')='failed'
      AND json_extract(payload,'$.error_code')='NO_MATCH'
    ORDER BY created_at DESC LIMIT 50
)
UNION
SELECT id FROM (
    SELECT id FROM jobs INDEXED BY jobs_shown_other_fail
    WHERE active=0 AND json_extract(payload,'$.hidden')=0
      AND json_extract(payload,'$.stage')='failed'
      AND coalesce(json_extract(payload,'$.error_code'),'')!='NO_MATCH'
    ORDER BY created_at DESC LIMIT 50
)
UNION
SELECT id FROM (
    SELECT id FROM jobs INDEXED BY jobs_shown_other
    WHERE active=0 AND json_extract(payload,'$.hidden')=0
      AND json_extract(payload,'$.stage')!='failed'
    ORDER BY created_at DESC LIMIT 50
)
"""


def seeded(default: object, raw: str) -> object:
    """An environment value in the type its setting keeps. `bool` is checked before `int`."""
    if isinstance(default, bool):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, list):
        # Comma-separated, the same form the worker reads. A plain string failed the strict
        # list setting and stopped the app from starting.
        # An empty value means the default, as it would if it were unset.
        return [part.strip() for part in raw.split(",") if part.strip()] or default
    return raw


def _shown_ids(kept: list[dict[str, object]]) -> list[str]:
    """The songs of the kept results as one list, newest first, each once, at most SHOWN_IDS."""
    ids: list[str] = []
    for entry in kept:
        found = entry["ids"]
        assert isinstance(found, list)
        ids += [str(sid) for sid in found]
    return list(dict.fromkeys(ids))[:SHOWN_IDS]


class ProposalGone(LookupError):
    """The proposal revision a commit was about to record is no longer stored."""


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
        if version > SCHEMA_VERSION:
            # Close first. Windows keeps the file until this connection goes.
            self.db.close()
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
            -- Stage, hidden and batch live in the payload. These keep a long history
            -- off the queue, the summary and an empty history page.
            CREATE INDEX IF NOT EXISTS jobs_batch_id
                ON jobs(json_extract(payload,'$.batch_id'));
            CREATE INDEX IF NOT EXISTS jobs_shown
                ON jobs(created_at)
                WHERE coalesce(json_extract(payload,'$.hidden'),0)=0;
            CREATE INDEX IF NOT EXISTS jobs_shown_nomatch
                ON jobs(created_at DESC)
                WHERE active=0 AND json_extract(payload,'$.hidden')=0
                  AND json_extract(payload,'$.stage')='failed'
                  AND json_extract(payload,'$.error_code')='NO_MATCH';
            CREATE INDEX IF NOT EXISTS jobs_shown_other_fail
                ON jobs(created_at DESC)
                WHERE active=0 AND json_extract(payload,'$.hidden')=0
                  AND json_extract(payload,'$.stage')='failed'
                  AND coalesce(json_extract(payload,'$.error_code'),'')!='NO_MATCH';
            CREATE INDEX IF NOT EXISTS jobs_shown_other
                ON jobs(created_at DESC)
                WHERE active=0 AND json_extract(payload,'$.hidden')=0
                  AND json_extract(payload,'$.stage')!='failed';
            CREATE INDEX IF NOT EXISTS jobs_inactive_recent
                ON jobs(created_at DESC) WHERE active=0;
            -- Covers job_summary, so it reads the index and never parses a payload. Grouping
            -- the payloads took about half a second at 52k jobs.
            CREATE INDEX IF NOT EXISTS jobs_summary ON jobs(
                json_extract(payload,'$.stage'),
                json_extract(payload,'$.error_code'),
                json_extract(payload,'$.error'),
                json_extract(payload,'$.error_hint'),
                json_extract(payload,'$.error_fix')
            ) WHERE coalesce(json_extract(payload,'$.hidden'),0)=0;
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
            CREATE TABLE IF NOT EXISTS waveforms (
                song_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                peaks BLOB NOT NULL
            );
            -- Song characteristics (docs/audio-profile-spec.md): one measured row per song and
            -- recipe, and the queue the analysis worker leases from. Created here, like the
            -- waveform cache, so dropping either is a safe reset the worker refills.
            CREATE TABLE IF NOT EXISTS audio_profile (
                song_id TEXT NOT NULL,
                recipe TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'skipped')),
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                tempo_bpm REAL,
                energy REAL,
                dim INTEGER NOT NULL DEFAULT 0,
                vector BLOB,
                detail TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (song_id, recipe)
            );
            CREATE INDEX IF NOT EXISTS audio_profile_recipe ON audio_profile(recipe, status);
            CREATE TABLE IF NOT EXISTS audio_job (
                song_id TEXT NOT NULL,
                recipe TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'leased')),
                lease_token TEXT NOT NULL DEFAULT '',
                leased_until TEXT NOT NULL DEFAULT '',
                attempts INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (song_id, recipe)
            );
            CREATE TABLE IF NOT EXISTS source_control (
                source TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
                blocking_failures INTEGER NOT NULL DEFAULT 0
            );
            -- Cover images the scan already saw. Browsing reads this instead of listing folders.
            CREATE TABLE IF NOT EXISTS library_covers (
                folder TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL
            );
            COMMIT;
        """)
        if version < 4:
            # Before version 4 every paused or failing download was YouTube, so the single
            # queue_control flag moves across as the YouTube row.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                INSERT OR IGNORE INTO source_control(source,paused,blocking_failures)
                    SELECT 'youtube',source_paused,blocking_failures FROM queue_control
                    WHERE id=1 AND (source_paused!=0 OR blocking_failures!=0);
                PRAGMA user_version=4;
                COMMIT;
            """)
        if version < 5:
            # The pause between groups of downloads. The count is how many tracks have
            # finished since the last wait, and pace_until is the unix time that wait ends.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                ALTER TABLE queue_control ADD COLUMN pace_started INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE queue_control ADD COLUMN pace_until REAL NOT NULL DEFAULT 0;
                PRAGMA user_version=5;
                COMMIT;
            """)
        if version < 6:
            # One transaction. Song ids are assigned in SQL so a path that is not valid
            # UTF-8 is never decoded. added_at comes from mtime so an existing library
            # still has a "newest" order. Waveform rows were keyed by the old playback ids.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                ALTER TABLE library_files ADD COLUMN song_id TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN added_at TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN track INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN disc INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN year INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN genre TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN genres TEXT NOT NULL DEFAULT '[]';
                ALTER TABLE library_files ADD COLUMN album_artist TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN compilation INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN replaygain_track_gain REAL;
                ALTER TABLE library_files ADD COLUMN replaygain_album_gain REAL;
                ALTER TABLE library_files ADD COLUMN replaygain_track_peak REAL;
                ALTER TABLE library_files ADD COLUMN replaygain_album_peak REAL;
                ALTER TABLE library_files ADD COLUMN suffix TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN content_type TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN bitrate INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN bit_depth INTEGER;
                ALTER TABLE library_files ADD COLUMN channels INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN has_art INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN tags_version INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN record_labels TEXT NOT NULL DEFAULT '[]';
                ALTER TABLE library_files ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE library_files ADD COLUMN last_played TEXT;
                UPDATE library_files
                    SET song_id = 'tr-' || lower(hex(randomblob(8)))
                    WHERE song_id = '';
                UPDATE library_files
                    SET song_id = 'tr-' || lower(hex(randomblob(8)))
                    WHERE song_id IN (
                        SELECT song_id FROM library_files
                        WHERE song_id != '' GROUP BY song_id HAVING count(*) > 1
                    );
                UPDATE library_files
                    SET added_at = strftime(
                        '%Y-%m-%dT%H:%M:%fZ', mtime_ns / 1000000000.0, 'unixepoch'
                    )
                    WHERE added_at = '';
                CREATE UNIQUE INDEX IF NOT EXISTS library_song_id
                    ON library_files(song_id) WHERE song_id != '';
                CREATE TABLE IF NOT EXISTS playlists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    public INTEGER NOT NULL DEFAULT 0,
                    created TEXT NOT NULL,
                    changed TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS playlist_songs (
                    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    song_id TEXT NOT NULL,
                    PRIMARY KEY (playlist_id, position)
                );
                CREATE INDEX IF NOT EXISTS playlist_songs_song ON playlist_songs(song_id);
                CREATE TABLE IF NOT EXISTS artist_favourites (
                    artist_id TEXT PRIMARY KEY,
                    starred_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS play_queue (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    current_id TEXT NOT NULL DEFAULT '',
                    position_ms INTEGER NOT NULL DEFAULT 0,
                    changed TEXT NOT NULL DEFAULT ''
                );
                INSERT OR IGNORE INTO play_queue(id) VALUES (1);
                CREATE TABLE IF NOT EXISTS play_queue_songs (
                    position INTEGER PRIMARY KEY,
                    song_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS library_revision (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    value INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO library_revision(id) VALUES (1);
                DELETE FROM waveforms;
                DELETE FROM settings WHERE key IN (
                    'navidrome_url', 'navidrome_mode', 'navidrome_library_id'
                );
                PRAGMA user_version=6;
                COMMIT;
            """)
        if version < 7:
            self.db.executescript("""
                BEGIN IMMEDIATE;
                ALTER TABLE library_files ADD COLUMN codec TEXT NOT NULL DEFAULT '';
                ALTER TABLE library_files ADD COLUMN flac_id3 INTEGER NOT NULL DEFAULT 0;
                PRAGMA user_version=7;
                COMMIT;
            """)
        if version < 8:
            self.db.executescript("""
                BEGIN IMMEDIATE;
                ALTER TABLE play_queue ADD COLUMN writer_epoch INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE play_queue ADD COLUMN write_sequence INTEGER NOT NULL DEFAULT 0;
                PRAGMA user_version=8;
                COMMIT;
            """)
        if version < 9:
            # Schema 9 is the two song characteristic tables above. They are created on every
            # start, so this only records that a version 9 build has opened the file; an older
            # build then refuses it. library_files is unchanged.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                PRAGMA user_version=9;
                COMMIT;
            """)
        if version < 10:
            # Music bot proposals: each revision's intent, seed, ordered ids, snapshot and the
            # per-song checks a commit repeats, and the receipt of each commit. Version 11
            # takes the receipts off the proposal's cascade.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS bot_proposals (
                    id TEXT PRIMARY KEY,
                    latest INTEGER NOT NULL,
                    touched INTEGER NOT NULL,
                    created TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bot_proposal_revisions (
                    proposal_id TEXT NOT NULL REFERENCES bot_proposals(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    intent TEXT NOT NULL,
                    seed INTEGER,
                    song_ids TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    checks TEXT NOT NULL,
                    totals TEXT NOT NULL,
                    created TEXT NOT NULL,
                    PRIMARY KEY (proposal_id, revision)
                );
                CREATE TABLE IF NOT EXISTS bot_receipts (
                    operation_id TEXT PRIMARY KEY,
                    proposal_id TEXT NOT NULL REFERENCES bot_proposals(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    target TEXT NOT NULL,
                    receipt TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS bot_receipts_revision
                    ON bot_receipts(proposal_id, revision, target);
                PRAGMA user_version=10;
                COMMIT;
            """)
        if version < 11:
            # Receipts in version 10 went with their proposal, so a retry after the proposal
            # was pruned could save twice. Rebuilt without the foreign key, rows and their
            # order (the rowid the receipt limit prunes by) kept.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE bot_receipts_v11 (
                    operation_id TEXT PRIMARY KEY,
                    proposal_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    target TEXT NOT NULL,
                    receipt TEXT NOT NULL
                );
                INSERT INTO bot_receipts_v11 (rowid, operation_id, proposal_id, revision, target,
                    receipt)
                    SELECT rowid, operation_id, proposal_id, revision, target, receipt
                    FROM bot_receipts ORDER BY rowid;
                DROP TABLE bot_receipts;
                ALTER TABLE bot_receipts_v11 RENAME TO bot_receipts;
                CREATE INDEX IF NOT EXISTS bot_receipts_revision
                    ON bot_receipts(proposal_id, revision, target);
                PRAGMA user_version=11;
                COMMIT;
            """)
        if version < 12:
            # Recent shown songs for the one default listener profile: suggestion memory, shared
            # by every device, never a taste score. One row holds the last few presented library
            # results and a revision that rises on every change. Created, not copied: the old
            # copy lived in a browser tab and is not carried over.
            self.db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS bot_memory (
                    profile TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL,
                    generations TEXT NOT NULL,
                    acked TEXT NOT NULL,
                    changed TEXT NOT NULL
                );
                INSERT OR IGNORE INTO bot_memory VALUES ('default', 0, '[]', '[]',
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'));
                PRAGMA user_version=12;
                COMMIT;
            """)
        self.seed()

    def paused_sources(self) -> list[str]:
        with self.lock:
            return [
                str(row[0])
                for row in self.db.execute(
                    "SELECT source FROM source_control WHERE paused!=0 ORDER BY source"
                )
            ]

    def controls(self) -> dict[str, object]:
        """Queue pause plus the sources paused by blocking errors.

        `source_paused` stays as the YouTube flag so clients from before per-source pausing
        keep reading it.
        """
        with self.lock:
            row = self.db.execute(
                "SELECT paused, pace_until FROM queue_control WHERE id=1"
            ).fetchone()
            sources = self.paused_sources()
        return {
            "paused": bool(row["paused"]),
            "source_paused": "youtube" in sources,
            "paused_sources": sources,
            # The names to show for them and for the catalog rows, so the browser does not keep a
            # table of its own. A queued card names its first catalog row before anything else
            # has loaded, and read "Youtube" without this.
            "source_labels": {
                source: source_label(source) for source in (*CATALOG_ORDER, *sources)
            },
            # Unix time the pause between groups ends. 0 means the queue is not waiting.
            "pace_until": float(row["pace_until"]),
        }

    def pace(self) -> tuple[int, float]:
        """Tracks started since the last pause, and the unix time that pause ends."""
        with self.lock:
            row = self.db.execute(
                "SELECT pace_started, pace_until FROM queue_control WHERE id=1"
            ).fetchone()
        return int(row["pace_started"]), float(row["pace_until"])

    def set_pace(self, started: int, until: float, *, announce: bool) -> None:
        """Store the pause between groups. `announce` publishes it on the queue stream."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    "UPDATE queue_control SET pace_started=?, pace_until=? WHERE id=1",
                    (started, until),
                )
                if announce:
                    self._event("queue.updated", self.controls())
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

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
                if raw is not None and not raw.strip() and isinstance(default, list):
                    # Compose passes an unset list as "". That is no choice, so nothing is locked.
                    raw = None
                values[key] = default if raw is None else seeded(default, raw)
                seeds.append(
                    (
                        key,
                        json.dumps(values[key]),
                        "default" if raw is None else env,
                        int(raw is not None),
                    )
                )
            if "deezer_arl" not in existing:
                # The account cookie can start from the environment. The app moves it into its
                # file at startup and empties this row, and Settings can replace it later.
                cookie = clean_arl(os.environ.get("MUSIMO_DEEZER_ARL", ""))
                seeds.append(("deezer_arl", json.dumps(cookie), "default", 0))
            # The old SoundCloud switch becomes a row in the order, once, when the order first
            # appears. Taking it off the list later stays off.
            if "source_order" not in existing and not os.environ.get("MUSIMO_SOURCE_ORDER"):
                raw_fallback = os.environ.get("MUSIMO_SOUNDCLOUD_FALLBACK")
                fallback = raw_fallback is not None and seeded(False, raw_fallback) is True
                if "soundcloud_fallback" in existing:
                    row = self.db.execute(
                        "SELECT value FROM settings WHERE key='soundcloud_fallback'"
                    ).fetchone()
                    fallback = json.loads(row["value"]) is True
                if fallback:
                    order = ["deezer", "youtube", "soundcloud"]
                    values["source_order"] = order
                    seeds = [
                        (
                            key,
                            json.dumps(order) if key == "source_order" else payload,
                            origin,
                            locked,
                        )
                        for key, payload, origin, locked in seeds
                    ]
            Settings.model_validate(values)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.executemany("INSERT INTO settings VALUES (?,?,?,?)", seeds)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def current(self) -> Settings:
        with self.lock:
            rows = self.db.execute("SELECT key,value FROM settings").fetchall()
        return Settings.model_validate(
            settings_only({row["key"]: json.loads(row["value"]) for row in rows})
        )

    def stored_secret(self, key: str) -> str:
        """A secret an older version kept in the settings table, or "" when the row is empty."""
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return ""
        value: object = json.loads(row["value"])
        return value.strip() if isinstance(value, str) else ""

    def clear_secret(self, key: str) -> None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    "UPDATE settings SET value=?,origin='default',locked=0 WHERE key=?",
                    (json.dumps(""), key),
                )
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
                if row["key"] not in RETIRED_KEYS
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

    def waveform(self, song_id: str, fingerprint: str) -> bytes | None:
        """Cached peaks, only while the fingerprint (file size and time) is still the file's."""
        with self.lock:
            row = self.db.execute(
                "SELECT peaks FROM waveforms WHERE song_id=? AND fingerprint=?",
                (song_id, fingerprint),
            ).fetchone()
            return bytes(row[0]) if row else None

    def save_waveform(self, song_id: str, fingerprint: str, peaks: bytes) -> None:
        # One row per song, so a changed file replaces its old peaks instead of adding to them.
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute(
                    """
                    INSERT INTO waveforms VALUES (?, ?, ?)
                    ON CONFLICT(song_id) DO UPDATE SET
                        fingerprint=excluded.fingerprint, peaks=excluded.peaks
                    """,
                    (song_id, fingerprint, peaks),
                )
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def update(self, changes: dict[str, object]) -> dict[str, object]:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                current = {
                    r["key"]: json.loads(r["value"])
                    for r in self.db.execute("SELECT * FROM settings")
                }
                Settings.model_validate(settings_only(current | changes))
                for key, value in changes.items():
                    if key in SECRET_KEYS or key in RETIRED_KEYS:
                        raise ValueError(f"{key} is not a setting")
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
                    f"WHERE id IN ({VISIBLE_ID_SQL}) ORDER BY created_at DESC"
                )
            ]
            return {
                "settings": self.settings(),
                "jobs": jobs,
                "summary": self.job_summary(),
                "cursor": self.bounds()[1],
                "controls": self.controls(),
            }

    def job_summary(self) -> dict[str, object]:
        with self.lock:
            rows = self.db.execute(
                "SELECT json_extract(payload,'$.stage') stage,"
                "json_extract(payload,'$.error_code') error_code,"
                "json_extract(payload,'$.error') error,"
                "json_extract(payload,'$.error_hint') error_hint,"
                "json_extract(payload,'$.error_fix') error_fix,"
                "count(*) amount FROM jobs INDEXED BY jobs_summary "
                "WHERE coalesce(json_extract(payload,'$.hidden'),0)=0 "
                "GROUP BY stage,error_code,error,error_hint,error_fix ORDER BY amount DESC"
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
                "hint": str(row["error_hint"] or ""),
                "fix": str(row["error_fix"] or ""),
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

    def shown_memory(self) -> tuple[int, list[str]]:
        """The memory revision and the songs a library search reads: those of the last
        SHOWN_RESULTS presented results, newest first, each once, at most SHOWN_IDS."""
        revision, _, ids = self.shown_state()
        return revision, ids

    def shown_state(self) -> tuple[int, int, list[str]]:
        """The memory revision, how many presented results are kept and the songs they give,
        read together, for the forget control to say what it holds."""
        with self.lock:
            revision, kept, _ = self._memory_row()
        return revision, len(kept), _shown_ids(kept)

    def record_shown(self, key: str, ids: list[str]) -> tuple[int, bool]:
        """Remember one presented library result, newest first. `key` names the presentation,
        so recording it again changes nothing, even after its result has aged out. The read,
        the change and the revision rise are one transaction, so overlapping writes each land
        whole and the list stays within its bounds. Returns the revision and whether anything
        was recorded."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                revision, kept, acked = self._memory_row()
                if key in acked:
                    self.db.rollback()
                    return revision, False
                newest: dict[str, object] = {"key": key, "ids": ids[:SHOWN_IDS]}
                revision = self._save_memory(
                    revision + 1, [newest, *kept][:SHOWN_RESULTS], [key, *acked][:SHOWN_ACKS]
                )
                self.db.commit()
                return revision, True
            except Exception:
                self.db.rollback()
                raise

    def forget_shown(self) -> int:
        """Empty the memory for every device. Only this row changes: play counts, likes,
        playlists and proposals are not touched. Nothing to forget leaves the revision alone.
        The presentation keys stay, so a late duplicate cannot bring a forgotten result back."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                revision, kept, acked = self._memory_row()
                if kept:
                    revision = self._save_memory(revision + 1, [], acked)
                self.db.commit()
                return revision
            except Exception:
                self.db.rollback()
                raise

    def _memory_row(self) -> tuple[int, list[dict[str, object]], list[str]]:
        row = self.db.execute(
            "SELECT revision, generations, acked FROM bot_memory WHERE profile=?",
            (SHOWN_PROFILE,),
        ).fetchone()
        # A row someone deleted by hand reads as an empty memory and is written back on the next
        # change, so a manual reset cannot leave the routes failing.
        if row is None:
            return 0, [], []
        return int(row[0]), json.loads(row[1]), json.loads(row[2])

    def _save_memory(self, revision: int, kept: list[dict[str, object]], acked: list[str]) -> int:
        self.db.execute(
            "INSERT INTO bot_memory (profile, revision, generations, acked, changed) "
            "VALUES (?,?,?,?,?) ON CONFLICT(profile) DO UPDATE SET revision=excluded.revision, "
            "generations=excluded.generations, acked=excluded.acked, changed=excluded.changed",
            (SHOWN_PROFILE, revision, json.dumps(kept), json.dumps(acked), self._timestamp()),
        )
        return revision

    def _timestamp(self) -> str:
        return str(self.db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')").fetchone()[0])

    def library_revision(self) -> int:
        with self.lock:
            row = self.db.execute("SELECT value FROM library_revision WHERE id=1").fetchone()
            return int(row[0])

    def folder_covers(self) -> dict[str, tuple[str, int, int]]:
        with self.lock:
            rows = self.db.execute(
                "SELECT folder, path, size, mtime_ns FROM library_covers"
            ).fetchall()
        return {str(row[0]): (str(row[1]), int(row[2]), int(row[3])) for row in rows}

    def folder_cover(self, folder: str) -> tuple[str, int, int] | None:
        with self.lock:
            row = self.db.execute(
                "SELECT path, size, mtime_ns FROM library_covers WHERE folder=?",
                (folder,),
            ).fetchone()
        if row is None:
            return None
        return (str(row[0]), int(row[1]), int(row[2]))

    def apply_folder_covers(
        self,
        updates: list[tuple[str, str, int, int]],
        drops: list[str],
        baseline: dict[str, tuple[str, int, int]] | None = None,
    ) -> None:
        """Write cover rows that changed, and forget folders that no longer have one.

        `baseline` is the snapshot the caller diffed against. A row written since then,
        such as a download landing while a scan walks, is left alone. An empty change
        does not bump the library revision, so an unchanged scan leaves the browse cache.
        """
        if not updates and not drops:
            return
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                changed = False
                for folder in drops:
                    row = self.db.execute(
                        "SELECT path, size, mtime_ns FROM library_covers WHERE folder=?",
                        (folder,),
                    ).fetchone()
                    if row is None:
                        continue
                    current = (str(row[0]), int(row[1]), int(row[2]))
                    if baseline is not None and baseline.get(folder) != current:
                        continue
                    self.db.execute("DELETE FROM library_covers WHERE folder=?", (folder,))
                    changed = True
                for folder, path, size, mtime_ns in updates:
                    new = (path, size, mtime_ns)
                    row = self.db.execute(
                        "SELECT path, size, mtime_ns FROM library_covers WHERE folder=?",
                        (folder,),
                    ).fetchone()
                    stored = None if row is None else (str(row[0]), int(row[1]), int(row[2]))
                    if stored == new:
                        continue
                    if (
                        baseline is not None
                        and stored is not None
                        and baseline.get(folder) != stored
                    ):
                        continue
                    self.db.execute(
                        """
                        INSERT INTO library_covers(folder, path, size, mtime_ns)
                        VALUES (?,?,?,?)
                        ON CONFLICT(folder) DO UPDATE SET
                            path=excluded.path, size=excluded.size, mtime_ns=excluded.mtime_ns
                        """,
                        (folder, path, size, mtime_ns),
                    )
                    changed = True
                if changed:
                    note_library_change(self.db)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def delete_covers_under(self, folder: str) -> None:
        child = folder + os.sep
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                cursor = self.db.execute(
                    "DELETE FROM library_covers WHERE folder=? OR substr(folder, 1, ?)=?",
                    (folder, len(child), child),
                )
                if cursor.rowcount:
                    note_library_change(self.db)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def bump_library_revision(self) -> int:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                note_library_change(self.db)
                value = int(
                    self.db.execute("SELECT value FROM library_revision WHERE id=1").fetchone()[0]
                )
                self.db.commit()
                return value
            except Exception:
                self.db.rollback()
                raise

    def _playlist(self, playlist_id: int) -> dict[str, object] | None:
        row = self.db.execute("SELECT * FROM playlists WHERE id=?", (playlist_id,)).fetchone()
        if row is None:
            return None
        songs = [
            str(item[0])
            for item in self.db.execute(
                "SELECT song_id FROM playlist_songs WHERE playlist_id=? ORDER BY position",
                (playlist_id,),
            )
        ]
        return {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "public": bool(row["public"]),
            "created": str(row["created"]),
            "changed": str(row["changed"]),
            "song_ids": songs,
        }

    def create_playlist(self, name: str, song_ids: list[str]) -> dict[str, object]:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                now = self._timestamp()
                cur = self.db.execute(
                    "INSERT INTO playlists (name, public, created, changed) VALUES (?,?,?,?)",
                    (name, 0, now, now),
                )
                playlist_id = int(cur.lastrowid or 0)
                self.db.executemany(
                    "INSERT INTO playlist_songs VALUES (?,?,?)",
                    [(playlist_id, index, song_id) for index, song_id in enumerate(song_ids)],
                )
                result = self._playlist(playlist_id)
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
        if result is None:
            raise RuntimeError("Playlist insert did not return a row")
        return result

    def playlist(self, playlist_id: int) -> dict[str, object] | None:
        with self.lock:
            return self._playlist(playlist_id)

    def list_playlists(self) -> list[dict[str, object]]:
        with self.lock:
            rows = self.db.execute(
                """
                SELECT p.id, p.name, p.public, p.created, p.changed,
                    count(s.song_id) AS song_count,
                    coalesce(sum(f.duration), 0) AS duration
                FROM playlists p
                LEFT JOIN playlist_songs s ON s.playlist_id=p.id
                LEFT JOIN library_files f ON f.song_id=s.song_id AND s.song_id!=''
                GROUP BY p.id
                ORDER BY p.id
                """
            ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "name": str(row["name"]),
                "public": bool(row["public"]),
                "created": str(row["created"]),
                "changed": str(row["changed"]),
                "song_count": int(row["song_count"]),
                "duration": float(row["duration"]),
            }
            for row in rows
        ]

    def rename_playlist(self, playlist_id: int, name: str) -> dict[str, object] | None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if self._playlist(playlist_id) is None:
                    self.db.rollback()
                    return None
                self.db.execute(
                    "UPDATE playlists SET name=?, changed=? WHERE id=?",
                    (name, self._timestamp(), playlist_id),
                )
                result = self._playlist(playlist_id)
                self.db.commit()
                return result
            except Exception:
                self.db.rollback()
                raise

    def add_playlist_song(self, playlist_id: int, song_id: str) -> dict[str, object] | None:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if self._playlist(playlist_id) is None:
                    self.db.rollback()
                    return None
                position = int(
                    self.db.execute(
                        "SELECT count(*) FROM playlist_songs WHERE playlist_id=?",
                        (playlist_id,),
                    ).fetchone()[0]
                )
                self.db.execute(
                    "INSERT INTO playlist_songs VALUES (?,?,?)",
                    (playlist_id, position, song_id),
                )
                self.db.execute(
                    "UPDATE playlists SET changed=? WHERE id=?",
                    (self._timestamp(), playlist_id),
                )
                result = self._playlist(playlist_id)
                self.db.commit()
                return result
            except Exception:
                self.db.rollback()
                raise

    def remove_playlist_song(self, playlist_id: int, index: int) -> dict[str, object] | None:
        """Remove the song at a dense index and pack the positions that follow it."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                songs = [
                    str(row[0])
                    for row in self.db.execute(
                        "SELECT song_id FROM playlist_songs WHERE playlist_id=? ORDER BY position",
                        (playlist_id,),
                    )
                ]
                if self._playlist(playlist_id) is None or index < 0 or index >= len(songs):
                    self.db.rollback()
                    return None
                del songs[index]
                self.db.execute("DELETE FROM playlist_songs WHERE playlist_id=?", (playlist_id,))
                self.db.executemany(
                    "INSERT INTO playlist_songs VALUES (?,?,?)",
                    [(playlist_id, position, song_id) for position, song_id in enumerate(songs)],
                )
                self.db.execute(
                    "UPDATE playlists SET changed=? WHERE id=?",
                    (self._timestamp(), playlist_id),
                )
                result = self._playlist(playlist_id)
                self.db.commit()
                return result
            except Exception:
                self.db.rollback()
                raise

    def delete_playlist(self, playlist_id: int) -> bool:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                cur = self.db.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))
                self.db.commit()
                return cur.rowcount > 0
            except Exception:
                self.db.rollback()
                raise

    def set_artist_favourite(self, artist_id: str, favourite: bool) -> str | None:
        """Star an artist, or clear the star. A second star keeps the original time."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if favourite:
                    self.db.execute(
                        """
                        INSERT INTO artist_favourites VALUES (?,?)
                        ON CONFLICT(artist_id) DO NOTHING
                        """,
                        (artist_id, self._timestamp()),
                    )
                    row = self.db.execute(
                        "SELECT starred_at FROM artist_favourites WHERE artist_id=?",
                        (artist_id,),
                    ).fetchone()
                    starred = str(row[0]) if row else None
                else:
                    self.db.execute("DELETE FROM artist_favourites WHERE artist_id=?", (artist_id,))
                    starred = None
                self.db.commit()
                return starred
            except Exception:
                self.db.rollback()
                raise

    def artist_favourites(self) -> dict[str, str]:
        with self.lock:
            return {
                str(row[0]): str(row[1])
                for row in self.db.execute("SELECT artist_id, starred_at FROM artist_favourites")
            }

    def record_play(self, song_id: str) -> bool:
        """Add one play. last_played only moves forward."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                now = self._timestamp()
                cur = self.db.execute(
                    """
                    UPDATE library_files
                    SET play_count=play_count+1,
                        last_played=CASE
                            WHEN last_played IS NULL OR last_played < ? THEN ?
                            ELSE last_played
                        END
                    WHERE song_id=?
                    """,
                    (now, now, song_id),
                )
                self.db.commit()
                return cur.rowcount > 0
            except Exception:
                self.db.rollback()
                raise

    def _touch(self) -> int:
        """The next use number. The newest PROPOSAL_LIMIT proposals by it are kept."""
        return int(
            self.db.execute("SELECT coalesce(max(touched), 0) + 1 FROM bot_proposals").fetchone()[0]
        )

    def save_proposal(
        self, proposal_id: str | None, base: int, row: dict[str, object]
    ) -> tuple[str, int] | None:
        """Store revision 1 of a new proposal when `proposal_id` is None, otherwise the
        revision after `base`. None when `base` is no longer the latest, so two refinements of
        one revision cannot both land. Proposals and revisions past the limits go in the same
        transaction."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                now = self._timestamp()
                revision = base + 1
                if proposal_id is None:
                    proposal_id = "pr-" + secrets.token_hex(8)
                    self.db.execute(
                        "INSERT INTO bot_proposals VALUES (?,?,?,?)",
                        (proposal_id, revision, self._touch(), now),
                    )
                elif not self.db.execute(
                    "UPDATE bot_proposals SET latest=?, touched=? WHERE id=? AND latest=?",
                    (revision, self._touch(), proposal_id, base),
                ).rowcount:
                    self.db.rollback()
                    return None
                self.db.execute(
                    "INSERT INTO bot_proposal_revisions VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        proposal_id,
                        revision,
                        json.dumps(row["intent"]),
                        row["seed"],
                        json.dumps(row["ids"]),
                        json.dumps(row["snapshot"]),
                        json.dumps(row["checks"]),
                        json.dumps(row["totals"]),
                        now,
                    ),
                )
                self.db.execute(
                    "DELETE FROM bot_proposal_revisions WHERE proposal_id=? AND revision<=?",
                    (proposal_id, revision - REVISION_LIMIT),
                )
                self.db.execute(
                    "DELETE FROM bot_proposals WHERE id NOT IN "
                    "(SELECT id FROM bot_proposals ORDER BY touched DESC LIMIT ?)",
                    (PROPOSAL_LIMIT,),
                )
                self.db.commit()
                return proposal_id, revision
            except Exception:
                self.db.rollback()
                raise

    def proposal_revision(self, proposal_id: str, revision: int | None) -> dict[str, object] | None:
        """One stored revision, the latest when `revision` is None. None for an unknown
        proposal; `revision` None in the result for a revision it does not hold."""
        with self.lock:
            head = self.db.execute(
                "SELECT latest FROM bot_proposals WHERE id=?", (proposal_id,)
            ).fetchone()
            if head is None:
                return None
            latest = int(head["latest"])
            row = self.db.execute(
                "SELECT * FROM bot_proposal_revisions WHERE proposal_id=? AND revision=?",
                (proposal_id, latest if revision is None else revision),
            ).fetchone()
        if row is None:
            return {"id": proposal_id, "latest": latest, "revision": None}
        return {
            "id": proposal_id,
            "latest": latest,
            "revision": int(row["revision"]),
            "intent": json.loads(row["intent"]),
            "seed": row["seed"],
            "ids": json.loads(row["song_ids"]),
            "snapshot": json.loads(row["snapshot"]),
            "checks": json.loads(row["checks"]),
            "totals": json.loads(row["totals"]),
            "created": str(row["created"]),
        }

    def proposal_receipt(self, operation_id: str) -> dict[str, object] | None:
        with self.lock:
            row = self.db.execute(
                "SELECT receipt FROM bot_receipts WHERE operation_id=?", (operation_id,)
            ).fetchone()
        found: dict[str, object] | None = json.loads(row[0]) if row is not None else None
        return found

    def proposal_receipts(self, proposal_id: str, revision: int, target: str) -> list[str]:
        """The operation ids that already committed this revision to this kind of target."""
        with self.lock:
            rows = self.db.execute(
                "SELECT operation_id FROM bot_receipts "
                "WHERE proposal_id=? AND revision=? AND target=? ORDER BY rowid",
                (proposal_id, revision, target),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def record_receipt(
        self, receipt: dict[str, object], playlist_name: str | None
    ) -> tuple[dict[str, object], bool]:
        """Write a commit's receipt once, and for a playlist commit the playlist in the same
        transaction. An operation id that already has a receipt gets that receipt back with
        True and nothing is written, so a retry after a lost reply never saves twice. A
        revision pruned since it was checked raises ProposalGone and writes nothing."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                found = self.db.execute(
                    "SELECT receipt FROM bot_receipts WHERE operation_id=?",
                    (receipt["operation_id"],),
                ).fetchone()
                if found is not None:
                    self.db.rollback()
                    first: dict[str, object] = json.loads(found[0])
                    return first, True
                if (
                    self.db.execute(
                        "SELECT 1 FROM bot_proposal_revisions WHERE proposal_id=? AND revision=?",
                        (receipt["proposal_id"], receipt["revision"]),
                    ).fetchone()
                    is None
                ):
                    self.db.rollback()
                    raise ProposalGone
                now = self._timestamp()
                if playlist_name is not None:
                    cur = self.db.execute(
                        "INSERT INTO playlists (name, public, created, changed) VALUES (?,?,?,?)",
                        (playlist_name, 0, now, now),
                    )
                    playlist_id = int(cur.lastrowid or 0)
                    ids = receipt["ids"]
                    assert isinstance(ids, list)
                    self.db.executemany(
                        "INSERT INTO playlist_songs VALUES (?,?,?)",
                        [(playlist_id, index, str(sid)) for index, sid in enumerate(ids)],
                    )
                    receipt = receipt | {
                        "playlist_id": f"pl-{playlist_id}",
                        "playlist_name": playlist_name,
                    }
                receipt = receipt | {"created": now}
                self.db.execute(
                    "INSERT INTO bot_receipts VALUES (?,?,?,?,?)",
                    (
                        receipt["operation_id"],
                        receipt["proposal_id"],
                        receipt["revision"],
                        receipt["target"],
                        json.dumps(receipt),
                    ),
                )
                self.db.execute(
                    "UPDATE bot_proposals SET touched=? WHERE id=?",
                    (self._touch(), receipt["proposal_id"]),
                )
                self.db.execute(
                    "DELETE FROM bot_receipts WHERE rowid NOT IN "
                    "(SELECT rowid FROM bot_receipts ORDER BY rowid DESC LIMIT ?)",
                    (RECEIPT_LIMIT,),
                )
                self.db.commit()
                return receipt, False
            except ProposalGone:
                raise
            except Exception:
                self.db.rollback()
                raise

    def begin_queue_writer(self) -> int:
        """A new browser writer invalidates delayed saves from a previous writer."""
        with self.lock, self.db:
            row = self.db.execute(
                "UPDATE play_queue SET writer_epoch=writer_epoch+1, write_sequence=0 "
                "WHERE id=1 RETURNING writer_epoch"
            ).fetchone()
            return int(row[0])

    def write_play_queue(
        self,
        song_ids: list[str],
        current: str,
        position_ms: int,
        epoch: int | None = None,
        sequence: int | None = None,
    ) -> bool:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if epoch is not None:
                    changed = self.db.execute(
                        "UPDATE play_queue SET write_sequence=? WHERE id=1 "
                        "AND writer_epoch=? AND write_sequence<?",
                        (sequence, epoch, sequence),
                    ).rowcount
                    if not changed:
                        self.db.rollback()
                        return False
                else:
                    # Older clients/imports still work, but invalidate outstanding tokened saves.
                    self.db.execute(
                        "UPDATE play_queue SET writer_epoch=writer_epoch+1, "
                        "write_sequence=0 WHERE id=1"
                    )
                self.db.execute("DELETE FROM play_queue_songs")
                self.db.executemany(
                    "INSERT INTO play_queue_songs VALUES (?,?)",
                    list(enumerate(song_ids)),
                )
                self.db.execute(
                    "UPDATE play_queue SET current_id=?, position_ms=?, changed=? WHERE id=1",
                    (current, position_ms, self._timestamp()),
                )
                self.db.commit()
                return True
            except Exception:
                self.db.rollback()
                raise

    def read_play_queue(self) -> dict[str, object]:
        """The saved queue, without songs the index no longer has.

        A missing current song is cleared. The cleaned queue is written back.
        """
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                rows = self.db.execute(
                    "SELECT song_id FROM play_queue_songs ORDER BY position"
                ).fetchall()
                header = self.db.execute(
                    "SELECT current_id, position_ms, changed FROM play_queue WHERE id=1"
                ).fetchone()
                song_ids = [str(row[0]) for row in rows]
                if song_ids:
                    present = {
                        str(row[0])
                        for row in self.db.execute(
                            "SELECT song_id FROM library_files "
                            "WHERE song_id IN (SELECT value FROM json_each(?)) AND song_id!=''",
                            (json.dumps(song_ids),),
                        )
                    }
                else:
                    present = set()
                kept = [song_id for song_id in song_ids if song_id in present]
                current = str(header["current_id"])
                position = int(header["position_ms"])
                if current not in kept:
                    current = ""
                    position = 0
                if kept != song_ids or current != str(header["current_id"]):
                    self.db.execute("DELETE FROM play_queue_songs")
                    self.db.executemany(
                        "INSERT INTO play_queue_songs VALUES (?,?)",
                        list(enumerate(kept)),
                    )
                    self.db.execute(
                        "UPDATE play_queue SET current_id=?, position_ms=? WHERE id=1",
                        (current, position),
                    )
                changed = str(header["changed"])
                self.db.commit()
                return {
                    "current": current,
                    "position": position,
                    "changed": changed,
                    "song_ids": kept,
                }
            except Exception:
                self.db.rollback()
                raise

    def close(self) -> None:
        with self.lock:
            self.db.close()
