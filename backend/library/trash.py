"""Delete moves a song's file into its root's .musimo-trash folder, keeping its relative path.

The index skips dot folders, so a file in the trash is out of the library at once. Settings shows
how much the trash holds and empties it. While a file sits in the trash, the Deezer tracks it stood
for are refused as downloads; once it is emptied (here or by hand) they can be downloaded again.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path

from backend.core.store import Store

TRASH_FOLDER = ".musimo-trash"
# With the trash_auto_empty setting on, files older than this go for good.
KEEP_DAYS = 30
# How often the server looks. A file can outstay its 30 days by up to this much.
CHECK_SECONDS = 6 * 3600


def trash_folder(root: Path) -> Path:
    return root / TRASH_FOLDER


def free_name(target: Path) -> Path:
    """The target, or "name (2).ext" and so on when an earlier delete already used it."""
    if not target.exists():
        return target
    number = 2
    while True:
        candidate = target.with_name(f"{target.stem} ({number}){target.suffix}")
        if not candidate.exists():
            return candidate
        number += 1


def move_into_trash(path: Path, root: Path) -> Path:
    """Move one file under the root's trash folder at the same relative path. Returns where."""
    target = free_name(trash_folder(root) / path.relative_to(root))
    target.parent.mkdir(parents=True, exist_ok=True)
    # Same root, so this is a rename. shutil falls back to copy and delete across mounts.
    shutil.move(path, target)
    # A move keeps the old modified time. Stamp the delete time instead, so the 30-day auto-empty
    # counts from here and covers sidecars and covers, which have no row of their own.
    os.utime(target)
    return target


def sidecars(path: Path) -> list[Path]:
    """Files beside a song that belong to it alone, such as song.lrc for song.flac."""
    try:
        return [
            item
            for item in path.parent.iterdir()
            if item != path and item.stem == path.stem and item.is_file() and not item.is_symlink()
        ]
    except OSError:
        return []


def tidy_folder(folder: Path, root: Path, audio: set[str]) -> None:
    """Once a folder holds no audio, move what is left (cover, notes) to the trash and remove it.

    Walks up towards the root, so an artist folder whose last album went is removed too.
    """
    while folder != root and folder.is_relative_to(root):
        try:
            items = list(folder.iterdir())
        except OSError:
            return
        if any(item.is_dir() or item.suffix.lower() in audio for item in items):
            return
        try:
            for item in items:
                if not item.is_symlink():
                    move_into_trash(item, root)
            folder.rmdir()
        except OSError:
            return
        folder = folder.parent


def deezer_tracks_for(db: sqlite3.Connection, paths: list[str]) -> dict[str, list[int]]:
    """The Deezer tracks each file stands for: finished downloads and holdings. Caller locks."""
    found: dict[str, set[int]] = {path: set() for path in paths}
    payload = json.dumps(paths)
    # One pass over the finished jobs for the whole delete, not one per song.
    for row in db.execute(
        "SELECT track_id, json_extract(payload,'$.final_path') path FROM jobs "
        "WHERE catalog='deezer' AND active=0 AND track_id>0 "
        "AND json_extract(payload,'$.stage')='done' "
        "AND json_extract(payload,'$.final_path') IN (SELECT value FROM json_each(?))",
        (payload,),
    ):
        found[str(row[1])].add(int(row[0]))
    for row in db.execute(
        "SELECT track_id, path FROM holdings "
        "WHERE catalog='deezer' AND path IN (SELECT value FROM json_each(?))",
        (payload,),
    ):
        found[str(row[1])].add(int(row[0]))
    return {path: sorted(ids) for path, ids in found.items()}


def record(db: sqlite3.Connection, trashed: str, original: str, root: str, ids: list[int]) -> None:
    """The caller holds the store lock and a write transaction."""
    db.execute(
        "INSERT OR REPLACE INTO library_trash VALUES (?,?,?,?,?)",
        (trashed, original, root, json.dumps(ids), datetime.now(UTC).isoformat()),
    )


def trashed_tracks(store: Store, track_ids: list[int]) -> set[int]:
    """Which of these Deezer tracks have a file still in the trash. Rows for gone files are dropped.

    The file check runs outside the store lock.
    """
    wanted = {track_id for track_id in track_ids if track_id > 0}
    if not wanted:
        return set()
    with store.lock:
        rows = [
            (str(row[0]), {int(track) for track in json.loads(row[1])})
            for row in store.db.execute("SELECT path, track_ids FROM library_trash")
        ]
    hits = [(path, ids & wanted) for path, ids in rows if ids & wanted]
    gone = [path for path, _ids in hits if not Path(path).is_file()]
    if gone:
        forget(store, gone)
    return {track for path, ids in hits if path not in gone for track in ids}


def forget(store: Store, paths: list[str]) -> None:
    with store.lock:
        store.db.execute("BEGIN IMMEDIATE")
        try:
            store.db.execute(
                "DELETE FROM library_trash WHERE path IN (SELECT value FROM json_each(?))",
                (json.dumps(paths),),
            )
            store.db.commit()
        except Exception:
            store.db.rollback()
            raise


def folder_size(folder: Path) -> tuple[int, int]:
    """Bytes and file count under a folder. Links are not followed."""
    size = files = 0
    for parent, _dirs, names in os.walk(folder):
        for name in names:
            try:
                info = os.lstat(os.path.join(parent, name))
            except OSError:
                continue
            size += info.st_size
            files += 1
    return size, files


def usage(roots: list[Path]) -> dict[str, object]:
    """What each root's trash holds, for Settings."""
    rows: list[dict[str, object]] = []
    for root in roots:
        size, files = folder_size(trash_folder(root))
        rows.append(
            {"root": str(root), "path": str(trash_folder(root)), "size": size, "files": files}
        )
    return {
        "roots": rows,
        "size": sum(int(str(row["size"])) for row in rows),
        "files": sum(int(str(row["files"])) for row in rows),
    }


def forget_gone(store: Store) -> None:
    """Drop the rows for trashed files that are no longer there."""
    with store.lock:
        paths = [str(row[0]) for row in store.db.execute("SELECT path FROM library_trash")]
    gone = [path for path in paths if not Path(path).exists()]
    if gone:
        forget(store, gone)


def empty_older(store: Store, roots: list[Path], days: int = KEEP_DAYS) -> int:
    """Erase trash files moved there more than this many days ago, and the folders left empty.

    Returns how many files went.
    """
    cutoff = time.time() - days * 86400
    removed = 0
    for root in roots:
        folder = trash_folder(root)
        if not folder.is_dir() or folder.is_symlink():
            continue
        # Bottom up, so a folder is looked at after everything in it.
        for parent, dirs, names in os.walk(folder, topdown=False):
            for name in names:
                item = os.path.join(parent, name)
                try:
                    if os.lstat(item).st_mtime < cutoff:
                        os.unlink(item)
                        removed += 1
                except OSError:
                    continue
            for name in dirs:
                try:
                    os.rmdir(os.path.join(parent, name))
                except OSError:
                    pass
    if removed:
        forget_gone(store)
    return removed


async def keep_emptying(store: Store, roots: list[Path]) -> None:
    """While the app runs, empty old trash files every few hours if the setting is on."""
    while True:
        try:
            if store.current().trash_auto_empty:
                await asyncio.to_thread(empty_older, store, roots)
        except Exception:
            # One bad pass must not stop the next.
            logging.getLogger("uvicorn.error").exception("trash auto-empty failed")
        await asyncio.sleep(CHECK_SECONDS)


def empty(store: Store, roots: list[Path]) -> dict[str, object]:
    """Delete every root's trash for good. Whatever could not be removed is still counted after."""
    for root in roots:
        folder = trash_folder(root)
        if folder.is_dir() and not folder.is_symlink():
            shutil.rmtree(folder, ignore_errors=True)
    forget_gone(store)
    return usage(roots)
