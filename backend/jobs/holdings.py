"""A holding points one Deezer track at a file this install already has.

The file stays where it is. Nothing here copies, moves, or retags it.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
from pathlib import Path

from pydantic import ValidationError

from backend.core.job_models import Job
from backend.core.store import Store

UNCERTAIN = frozenset({"isrc", "mbid", "tags"})


def new_holding_id() -> str:
    return "hd-" + secrets.token_hex(8)


def holding_public(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "catalog": row["catalog"],
        "track_id": row["track_id"],
        "song_id": row["song_id"],
        "path": row["path"],
        "reason": row["reason"],
        "created": row["created"],
    }


def root_containing(path: str, roots: list[str]) -> str | None:
    """The enabled root that contains this regular file, if it is not a link."""
    file = Path(path)
    if file.is_symlink() or not file.is_file():
        return None
    try:
        resolved = file.resolve()
    except OSError:
        return None
    for root in roots:
        try:
            if resolved.is_relative_to(Path(root).resolve()):
                return root
        except (OSError, ValueError):
            continue
    return None


def path_is_regular_in_root(path: str, root: str) -> bool:
    return root_containing(path, [root]) is not None


def catalog_candidates(
    db: sqlite3.Connection, track_ids: list[int]
) -> dict[int, list[tuple[str, str, str, str]]]:
    """Done Deezer rows for these tracks, newest first. No file check.

    Each value is payload, song id, path, and root. The caller holds the store lock.
    Whether the file is still there is checked later, outside the lock.
    """
    ids = [track_id for track_id in track_ids if track_id > 0]
    if not ids:
        return {}
    rows = db.execute(
        """
        SELECT j.track_id, j.payload, f.song_id, f.path, f.root
        FROM jobs j
        JOIN library_files f ON f.path = json_extract(j.payload, '$.final_path')
        JOIN library_roots r ON r.path = f.root AND r.enabled = 1
        WHERE j.catalog = 'deezer'
          AND j.track_id IN (SELECT value FROM json_each(?))
          AND j.active = 0
          AND json_extract(j.payload, '$.stage') = 'done'
          AND f.song_id != ''
        ORDER BY j.created_at DESC
        """,
        (json.dumps(ids),),
    ).fetchall()
    grouped: dict[int, list[tuple[str, str, str, str]]] = {}
    for row in rows:
        grouped.setdefault(int(row["track_id"]), []).append(
            (str(row["payload"]), str(row["song_id"]), str(row["path"]), str(row["root"]))
        )
    return grouped


def first_regular(
    rows: list[tuple[str, str, str, str]],
) -> tuple[Job, str, str, str] | None:
    """The newest candidate that is still a regular file in its root.

    Call this outside the store lock. A slow disk must not sit inside a write transaction.
    """
    for payload, song_id, path, root in rows:
        if not path_is_regular_in_root(path, root):
            continue
        try:
            job = Job.model_validate_json(payload)
        except ValidationError:
            continue
        return job, song_id, path, root
    return None


def certain_catalog_match(db: sqlite3.Connection, track_id: int) -> tuple[Job, str, str] | None:
    """Latest done Deezer job whose file is still a regular indexed file in an enabled root.

    Format and destination are ignored. This stats the file, so the caller must not be
    inside a write transaction.
    """
    found = first_regular(catalog_candidates(db, [track_id]).get(track_id, []))
    if found is None:
        return None
    job, song_id, path, _root = found
    return job, song_id, path


class HoldingMismatch(Exception):
    """This track is already held by a different song."""


def ensure_holding(
    db: sqlite3.Connection, catalog: str, track_id: int, song_id: str, path: str, reason: str
) -> sqlite3.Row:
    """Insert a holding, or return the one already stored for this catalog and track.

    A second insert is not an error. The caller holds a write transaction.
    """
    db.execute(
        """
        INSERT INTO holdings (id, catalog, track_id, song_id, path, reason, created)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT (catalog, track_id) DO NOTHING
        """,
        (new_holding_id(), catalog, track_id, song_id, path, reason),
    )
    row = db.execute(
        "SELECT id, catalog, track_id, song_id, path, reason, created FROM holdings "
        "WHERE catalog=? AND track_id=?",
        (catalog, track_id),
    ).fetchone()
    if not isinstance(row, sqlite3.Row):
        raise RuntimeError("holding was not stored")
    return row


def save_holding(
    store: Store, track_id: int, song_id: str, path: str, reason: str
) -> dict[str, object]:
    """Store a holding, or return the row when it is already this song.

    A different song already stored for the track is left as it is. The check sits in this
    transaction so a choice that lost the race cannot come back as success.
    """
    with store.lock:
        store.db.execute("BEGIN IMMEDIATE")
        try:
            row = ensure_holding(store.db, "deezer", track_id, song_id, path, reason)
            if str(row["song_id"]) != song_id:
                raise HoldingMismatch
            store.db.commit()
        except Exception:
            store.db.rollback()
            raise
    return holding_public(row)


def indexed_holding(db: sqlite3.Connection, track_id: int) -> sqlite3.Row | None:
    """A holding whose song is still indexed at that path in an enabled root. No stat."""
    found = db.execute(
        """
        SELECT h.id, h.catalog, h.track_id, h.song_id, h.path, h.reason, h.created, f.root
        FROM holdings h
        JOIN library_files f ON f.song_id = h.song_id AND f.path = h.path
        JOIN library_roots r ON r.path = f.root AND r.enabled = 1
        WHERE h.catalog = 'deezer' AND h.track_id = ?
        """,
        (track_id,),
    ).fetchone()
    return found if isinstance(found, sqlite3.Row) else None


def indexed_song(db: sqlite3.Connection, song_id: str) -> sqlite3.Row | None:
    found = db.execute(
        """
        SELECT f.path, f.root, f.song_id
        FROM library_files f
        JOIN library_roots r ON r.path = f.root AND r.enabled = 1
        WHERE f.song_id = ?
        """,
        (song_id,),
    ).fetchone()
    return found if isinstance(found, sqlite3.Row) else None


def byte_matches(db: sqlite3.Connection, checksum: str, job_id: str) -> list[sqlite3.Row]:
    """Other done Deezer jobs with this stored hash, oldest first.

    Files with no stored hash are not read. The caller confirms the file is still there.
    """
    return db.execute(
        """
        SELECT j.payload,
          (SELECT f.song_id FROM library_files f
           JOIN library_roots r ON r.path = f.root AND r.enabled = 1
           WHERE f.path = json_extract(j.payload, '$.final_path') AND f.song_id != ''
           LIMIT 1) AS song_id
        FROM jobs j
        WHERE j.catalog = 'deezer' AND j.id != ? AND j.active = 0
          AND json_extract(j.payload, '$.stage') = 'done'
          AND json_extract(j.payload, '$.artifact_hash') = ?
          AND coalesce(json_extract(j.payload, '$.final_path'), '') != ''
        ORDER BY j.created_at ASC
        """,
        (job_id, checksum),
    ).fetchall()


def _holding_rows(db: sqlite3.Connection, track_ids: list[int]) -> list[sqlite3.Row]:
    return db.execute(
        """
        SELECT h.id, h.track_id, h.song_id, h.path, f.root
        FROM holdings h
        LEFT JOIN library_files f ON f.song_id = h.song_id AND f.path = h.path
        LEFT JOIN library_roots r ON r.path = f.root AND r.enabled = 1
        WHERE h.catalog = 'deezer' AND h.track_id IN (SELECT value FROM json_each(?))
        """,
        (json.dumps(track_ids),),
    ).fetchall()


def _classify_holdings(
    rows: list[sqlite3.Row],
) -> tuple[dict[int, tuple[str, str]], list[str]]:
    """Split rows into live tracks and stale holding ids.

    This stats the files, so call it outside the lock.
    """
    live: dict[int, tuple[str, str]] = {}
    stale: list[str] = []
    for row in rows:
        root = row["root"]
        path = str(row["path"])
        song_id = str(row["song_id"] or "")
        if root and song_id and path_is_regular_in_root(path, str(root)):
            live[int(row["track_id"])] = (song_id, path)
        else:
            stale.append(str(row["id"]))
    return live, stale


def _drop_stale_holdings(
    db: sqlite3.Connection, stale_ids: list[str], live: dict[int, tuple[str, str]]
) -> None:
    """Delete holdings that are still not regular files.

    The caller holds the store lock. Only these ids are statted again, because a file that
    came back between the outside check and the delete must be kept. A delete does not bump
    the library revision.
    """
    rows = db.execute(
        """
        SELECT h.id, h.track_id, h.song_id, h.path, f.root
        FROM holdings h
        LEFT JOIN library_files f ON f.song_id = h.song_id AND f.path = h.path
        LEFT JOIN library_roots r ON r.path = f.root AND r.enabled = 1
        WHERE h.id IN (SELECT value FROM json_each(?))
        """,
        (json.dumps(stale_ids),),
    ).fetchall()
    still: list[str] = []
    for row in rows:
        root = row["root"]
        path = str(row["path"])
        song_id = str(row["song_id"] or "")
        if root and song_id and path_is_regular_in_root(path, str(root)):
            live[int(row["track_id"])] = (song_id, path)
        else:
            still.append(str(row["id"]))
    if not still:
        return
    started = not db.in_transaction
    if started:
        db.execute("BEGIN IMMEDIATE")
    try:
        db.execute(
            "DELETE FROM holdings WHERE id IN (SELECT value FROM json_each(?))",
            (json.dumps(still),),
        )
        if started:
            db.commit()
    except Exception:
        if started:
            db.rollback()
        raise


def refresh_holdings(store: Store, track_ids: list[int]) -> dict[int, tuple[str, str]]:
    """Live holdings for these Deezer tracks. A stale row is deleted and not returned.

    The file check happens outside the store lock. The read and the delete take the lock
    only around the database work.
    """
    ids = [track_id for track_id in track_ids if track_id > 0]
    if not ids:
        return {}
    with store.lock:
        rows = _holding_rows(store.db, ids)
    live, stale = _classify_holdings(rows)
    if stale:
        with store.lock:
            _drop_stale_holdings(store.db, stale, live)
    return live


def batch_skip(matched_by: str, certain: bool) -> str | None:
    """'owned' or 'choice' when a batch must not enqueue this track."""
    if matched_by == "holding" or certain:
        return "owned"
    if matched_by in UNCERTAIN:
        return "choice"
    return None
