import asyncio
import json
import os
import stat as filemode
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

import mutagen
from mutagen.easymp4 import EasyMP4Tags
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.api import BaseObserver
from watchdog.observers.polling import PollingEmitter

from backend.core.store import Store, drop_song_references, new_song_id, note_library_change
from backend.core.text import normalize
from backend.integrations.catalog import Result
from backend.library.player import is_cover_image, ranked_cover_names
from backend.library.tags import TAGS_VERSION, facts_for

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".flac", ".opus", ".ogg", ".wav", ".aiff", ".wma", ".webm"}
# Junk folder names, beside the dot folders already ignored. Compared case-insensitively.
JUNK_FOLDERS = {"@eadir", "#snapshot", "#recycle", "$recycle.bin"}
# One transaction per file made a 22k unchanged walk take minutes, and downloads waited on it.
STAMP_BATCH = 500
# Easy MP4 has no ISRC key until something registers it. The tag round-trip reads it that way.
EasyMP4Tags.RegisterFreeformKey("isrc", "ISRC")


class DeferredSnapshotEmitter(PollingEmitter):
    """Take the first snapshot on the watcher thread.

    `BaseThread.start` runs `on_thread_start` on the caller. For a polled mount that
    snapshot is a walk of every file, and it used to finish before the server could answer.
    """

    def on_thread_start(self) -> None:
        return

    def run(self) -> None:
        try:
            self._snapshot = self._take_snapshot()
        except OSError:
            self.stop()
            return
        super().run()


class DeferredPollingObserver(BaseObserver):
    def __init__(self, timeout: float) -> None:
        super().__init__(emitter_class=DeferredSnapshotEmitter, timeout=timeout)


def _folder_gone(path: Path) -> bool:
    try:
        path.stat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def skipped_folder(name: str) -> bool:
    return name.startswith(".") or name.casefold() in JUNK_FOLDERS


def cover_file(folder: Path, names: list[str]) -> tuple[str, int, int] | None:
    """The cover to remember for this folder.

    None means the folder has no cover. OSError means a candidate could not be read,
    and the caller should leave the stored row alone.
    """
    ranked = ranked_cover_names(names)
    if not ranked:
        return None
    last_error: OSError | None = None
    for name in ranked:
        path = folder / name
        try:
            if path.is_symlink():
                continue
            info = path.stat()
        except OSError as exc:
            last_error = exc
            continue
        if not filemode.S_ISREG(info.st_mode):
            continue
        return str(path), info.st_size, info.st_mtime_ns
    if last_error is not None:
        raise last_error
    return None


def tags_still_match(
    suffix: str,
    stored_mtime: int,
    stored_size: int,
    title: str,
    artist: str,
    album: str,
    tags_version: int,
    mtime_ns: int,
    size: int,
) -> bool:
    # A row from before the player columns exists has to be read once, or the new fields stay empty.
    if tags_version != TAGS_VERSION:
        return False
    # Earlier versions stored blank WAV/AIFF tags. Those rows have to be read again.
    if suffix in {".wav", ".aiff"} and not any((title, artist, album)):
        return False
    return stored_mtime == mtime_ns and stored_size == size


class Changes(FileSystemEventHandler):
    def __init__(self, notify: Callable[[str], None]) -> None:
        super().__init__()
        self.notify = notify

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.event_type in {"opened", "closed_no_write"}:
            return
        if not event.is_directory or event.event_type in {"created", "deleted", "moved"}:
            for raw in (event.src_path, getattr(event, "dest_path", "")):
                if isinstance(raw, (str, bytes)) and raw:
                    path = os.fsdecode(raw)
                    file = Path(path)
                    if (
                        event.is_directory
                        or file.suffix.lower() in AUDIO_EXTENSIONS
                        or is_cover_image(file)
                    ):
                        self.notify(path)


class Library:
    def __init__(self, store: Store, roots: list[Path], changed: asyncio.Event) -> None:
        self.store, self.roots, self.changed = store, roots, changed
        self.loop = asyncio.get_running_loop()
        self.cancelled = threading.Event()
        self.work_lock = threading.Lock()
        self.generation = "watch"
        self.stop = asyncio.Event()
        self.task: asyncio.Task[None] | None = None
        self.background: asyncio.Task[None] | None = None
        self.watch_mode = os.getenv("MUSIMO_WATCH_MODE", "native")
        # Docker Desktop does not forward host filesystem events. Five minutes is enough
        # for a large mount. The half-hour reconcile still catches moves and deletions.
        self.poll_interval = max(1, float(os.getenv("MUSIMO_POLL_INTERVAL_SECONDS", "300")))
        self.observer = (
            DeferredPollingObserver(self.poll_interval) if self.watch_mode == "poll" else Observer()
        )
        self.pending: set[str] = set()
        self.state: dict[str, object] = {
            "status": "idle",
            "walked": 0,
            "indexed": 0,
            "errors": 0,
            "elapsed": 0,
            "detail": "Ready to scan",
        }
        with store.lock:
            store.db.execute("BEGIN IMMEDIATE")
            try:
                store.db.execute("UPDATE library_roots SET enabled=0")
                store.db.executemany(
                    "INSERT INTO library_roots VALUES (?,1) "
                    "ON CONFLICT(path) DO UPDATE SET enabled=1",
                    [(str(root),) for root in roots],
                )
                store.db.commit()
            except Exception:
                store.db.rollback()
                raise
            row = store.db.execute("SELECT payload FROM library_state WHERE id=1").fetchone()
            if row:
                old: object = json.loads(row[0])
                if isinstance(old, dict):
                    self.state.update(old)
                    if self.state["status"] == "scanning":
                        self.state.update(
                            status="interrupted",
                            detail="Previous scan was interrupted; rescan to reconcile",
                        )

    def status(self) -> dict[str, object]:
        with self.store.lock:
            count = self.store.db.execute(
                "SELECT count(*) FROM library_files f "
                "JOIN library_roots r ON f.root=r.path WHERE r.enabled=1"
            ).fetchone()[0]
        return self.state | {
            "total_files": count,
            "roots": [str(root) for root in self.roots],
            "watch_mode": self.watch_mode,
            "poll_interval_seconds": self.poll_interval if self.watch_mode == "poll" else None,
        }

    def publish(self) -> None:
        self.store.save_library_status(self.status())
        self.loop.call_soon_threadsafe(self.changed.set)

    def start(self) -> None:
        def notify(path: str) -> None:
            if self.visible_root(Path(path)) is not None:
                self.loop.call_soon_threadsafe(self.pending.add, path)

        handler = Changes(notify)
        for root in self.roots:
            if root.is_dir():
                try:
                    self.observer.schedule(handler, str(root), recursive=True)
                except OSError:
                    self.state["detail"] = (
                        "A filesystem watcher is unavailable; periodic scans remain active"
                    )
        self.observer.start()
        self.start_scan()
        self.background = asyncio.create_task(self.watch())

    async def close(self) -> None:
        self.stop.set()
        self.cancelled.set()
        self.observer.stop()
        await asyncio.to_thread(self.observer.join, 2)
        if self.background:
            await self.background
        if self.task:
            await self.task

    def start_scan(self) -> bool:
        if self.task and not self.task.done():
            return False
        self.cancelled.clear()
        self.state = {
            "status": "scanning",
            "walked": 0,
            "indexed": 0,
            "errors": 0,
            "elapsed": 0,
            "detail": "Reading library tags",
        }
        self.publish()
        self.task = asyncio.create_task(asyncio.to_thread(self.scan))
        return True

    async def watch(self) -> None:
        next_scan = time.monotonic() + 1800
        while not self.stop.is_set():
            try:
                await asyncio.wait_for(self.stop.wait(), 0.25)
                return
            except TimeoutError:
                pass
            if self.task and not self.task.done():
                continue
            # A new album folder is not a library walk. drain indexes the audio and
            # forgets files under a folder that was removed.
            await self.drain()
            if time.monotonic() > next_scan:
                self.start_scan()
                next_scan = time.monotonic() + 1800

    async def drain(self) -> None:
        if not self.pending:
            return
        paths, self.pending = self.pending, set()
        await asyncio.to_thread(self.refresh, paths)

    def refresh(self, paths: set[str]) -> None:
        with self.work_lock:
            self._refresh(paths)

    def visible_root(self, path: Path) -> Path | None:
        for root in self.roots:
            if path.is_relative_to(root):
                # Staging files must never become ownership evidence or trigger scans.
                relative = path.relative_to(root).parts
                if not any(skipped_folder(part) for part in relative):
                    return root
        return None

    def index_published(self, path: Path, root: Path) -> None:
        # The walk does not hold this lock. The row takes the walk's generation so
        # pruning, which does hold it, keeps a file the walk has already passed.
        with self.work_lock:
            self.index(path, root, self.generation)
        # The cover may have landed beside the new file. One folder, not the whole library.
        self.record_folder_cover(path.parent)
        self.publish()

    def record_folder_cover(self, folder: Path) -> None:
        """Remember this folder's cover image. Listing one folder is the point of a change event."""
        if folder.is_symlink() or self.visible_root(folder) is None:
            return
        try:
            names = [entry.name for entry in folder.iterdir()]
            chosen = cover_file(folder, names)
        except OSError:
            return
        key = str(folder)
        current = self.store.folder_cover(key)
        if chosen is None:
            if current is not None:
                self.store.apply_folder_covers([], [key])
            return
        if current != chosen:
            self.store.apply_folder_covers([(key, *chosen)], [])

    def _refresh(self, paths: set[str]) -> None:
        generation = self.generation
        for raw in paths:
            path = Path(raw)
            if is_cover_image(path):
                # The cover id is fixed until the catalog is rebuilt. A changed row
                # bumps the revision, so the immutable art cache can stay.
                if self.visible_root(path) is not None:
                    self.record_folder_cover(path.parent)
                continue
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                self._drop_removed_folder(path)
                continue
            root = self.visible_root(path)
            if root is None or path.is_symlink():
                continue
            try:
                if path.exists():
                    # An unchanged file must not list its folder. A new or retagged one
                    # may have brought a cover.jpg with it.
                    if self.index(path, root, generation):
                        self.record_folder_cover(path.parent)
                elif root.is_dir():
                    self.remove(str(path))
            except (OSError, ValueError, mutagen.MutagenError):
                # Reconciliation retries partial writes without an unbounded per-file retry loop.
                self.state["detail"] = (
                    "Some changed files are unreadable; rescan after writing finishes"
                )
        self.publish()

    def _drop_removed_folder(self, path: Path) -> None:
        # A removed folder often arrives as one event, with no event per file inside it.
        # exists() is also false when stat fails, and that must not wipe the index.
        root = self.visible_root(path)
        if root is None or path == root or not _folder_gone(path):
            return
        prefix = str(path)
        child = prefix + os.sep
        with self.store.lock:
            stale = [
                row[0]
                for row in self.store.db.execute(
                    "SELECT path FROM library_files WHERE root=? "
                    "AND (path=? OR substr(path,1,?)=?)",
                    (str(root), prefix, len(child), child),
                )
            ]
        for item in stale:
            self.remove(str(item))
        self.store.delete_covers_under(prefix)

    def _known(self, root: Path) -> dict[str, tuple[int, int, str, str, str, int]]:
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT path, mtime_ns, size, title, artist, album, tags_version "
                "FROM library_files WHERE root=?",
                (str(root),),
            ).fetchall()
        return {
            str(row[0]): (
                int(row[1]),
                int(row[2]),
                str(row[3]),
                str(row[4]),
                str(row[5]),
                int(row[6]),
            )
            for row in rows
        }

    def _holds_rows(self, root: Path) -> bool:
        with self.store.lock:
            count = self.store.db.execute(
                "SELECT count(*) FROM library_files WHERE root=?", (str(root),)
            ).fetchone()[0]
        return int(count) > 0

    def _stamp(self, generation: str, paths: list[str]) -> None:
        if not paths:
            return
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                self.store.db.executemany(
                    "UPDATE library_files SET generation=? WHERE path=?",
                    [(generation, path) for path in paths],
                )
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        paths.clear()

    def _prune(self, root: Path, generation: str) -> None:
        # Hold the lock across the snapshot and the delete, so a download indexed
        # on this generation cannot land in the snapshot and then be removed.
        with self.work_lock:
            if self.generation != generation or self.cancelled.is_set():
                return
            with self.store.lock:
                self.store.db.execute("BEGIN IMMEDIATE")
                try:
                    stale = [
                        row[0]
                        for row in self.store.db.execute(
                            "SELECT path FROM library_files WHERE root=? AND generation!=?",
                            (str(root), generation),
                        )
                    ]
                    song_ids = [
                        str(row[0])
                        for row in self.store.db.execute(
                            "SELECT song_id FROM library_files WHERE root=? AND generation!=? "
                            "AND song_id!=''",
                            (str(root), generation),
                        )
                    ]
                    self.store.db.executemany(
                        "DELETE FROM library_files WHERE path=?", [(path,) for path in stale]
                    )
                    self.store.db.executemany(
                        "DELETE FROM library_fts WHERE path=?", [(path,) for path in stale]
                    )
                    drop_song_references(self.store.db, song_ids)
                    if stale:
                        note_library_change(self.store.db)
                    self.store.db.commit()
                except Exception:
                    self.store.db.rollback()
                    raise

    def scan(self) -> None:
        self._scan()

    def _scan(self) -> None:
        generation = uuid.uuid4().hex
        with self.work_lock:
            self.generation = generation
        started = time.monotonic()
        last_publish = 0.0
        walked = indexed = errors = 0
        held_empty = False
        try:
            for root in self.roots:
                root_errors = 0
                root_audio = 0
                batch: list[str] = []
                if not root.is_dir():
                    errors += 1
                    continue

                def walk_error(_: OSError) -> None:
                    nonlocal root_errors
                    root_errors += 1

                known = self._known(root)
                # Names os.walk already listed. Remembering them here is what keeps
                # opening Tracks off this disk.
                covers = self.store.folder_covers()
                cover_updates: list[tuple[str, str, int, int]] = []
                cover_drops: list[str] = []
                for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
                    dirs[:] = [
                        d
                        for d in dirs
                        if not skipped_folder(d) and not (Path(directory) / d).is_symlink()
                    ]
                    folder = Path(directory)
                    key = str(folder)
                    try:
                        chosen = cover_file(folder, files)
                    except OSError:
                        # A failed stat is not proof the cover is gone. Leave the stored row.
                        chosen = covers.get(key)
                    current = covers.get(key)
                    if chosen is None:
                        if key in covers:
                            cover_drops.append(key)
                    elif current != chosen:
                        cover_updates.append((key, *chosen))
                    for name in files:
                        if self.cancelled.is_set():
                            break
                        path = Path(directory) / name
                        if (
                            name.startswith(".")
                            or path.suffix.lower() not in AUDIO_EXTENSIONS
                            or path.is_symlink()
                        ):
                            continue
                        walked += 1
                        root_audio += 1
                        try:
                            row = known.get(str(path))
                            stat = path.stat() if row is not None else None
                            # The walk never follows links, so an unchanged file needs no resolve.
                            if (
                                stat is not None
                                and row is not None
                                and tags_still_match(
                                    path.suffix.lower(),
                                    *row,
                                    stat.st_mtime_ns,
                                    stat.st_size,
                                )
                            ):
                                batch.append(str(path))
                                indexed += 1
                                if len(batch) >= STAMP_BATCH:
                                    self._stamp(generation, batch)
                            else:
                                indexed += int(self.index(path, root, generation))
                        except (OSError, ValueError, mutagen.MutagenError):
                            root_errors += 1
                        if time.monotonic() - last_publish >= 0.5:
                            self.state.update(
                                walked=walked,
                                indexed=indexed,
                                errors=errors + root_errors,
                                elapsed=round(time.monotonic() - started, 1),
                            )
                            self.publish()
                            last_publish = time.monotonic()
                    if self.cancelled.is_set():
                        break
                self._stamp(generation, batch)
                self.store.apply_folder_covers(cover_updates, cover_drops, covers)
                # Cancelled or unreadable scans must not erase files they never visited.
                # An empty folder is the same shape as a music disk that has not mounted yet.
                # Pruning it would drop every playlist, play count and the queue for that root.
                if not self.cancelled.is_set() and root_errors == 0:
                    if root_audio == 0 and self._holds_rows(root):
                        held_empty = True
                    else:
                        self._prune(root, generation)
                errors += root_errors
                if self.cancelled.is_set():
                    break
            if self.cancelled.is_set():
                detail = "Scan cancelled; previous index preserved"
            elif errors:
                detail = (
                    "Scan complete with unreadable files or folders; previous entries preserved"
                )
            elif held_empty:
                detail = (
                    "Scan complete. An empty music folder was left unchanged "
                    "so a missing mount does not erase the library."
                )
            else:
                detail = "Scan complete"
            self.state.update(
                status="cancelled" if self.cancelled.is_set() else "done",
                walked=walked,
                indexed=indexed,
                errors=errors,
                elapsed=round(time.monotonic() - started, 1),
                detail=detail,
            )
        except Exception as exc:
            self.state.update(status="failed", detail=f"Scan failed: {type(exc).__name__}")
        self.publish()

    def index(self, path: Path, root: Path, generation: str) -> bool:
        """Store tags for one file.

        False when the stored row still matches, so the file was not opened.
        """
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("File escaped library root")
        stat = path.stat()
        with self.store.lock:
            old = self.store.db.execute(
                "SELECT mtime_ns,size,title,artist,album,tags_version "
                "FROM library_files WHERE path=?",
                (str(path),),
            ).fetchone()
            if old and tags_still_match(
                path.suffix.lower(),
                int(old[0]),
                int(old[1]),
                str(old[2]),
                str(old[3]),
                str(old[4]),
                int(old[5]),
                stat.st_mtime_ns,
                stat.st_size,
            ):
                self.store.db.execute(
                    "UPDATE library_files SET generation=? WHERE path=?", (generation, str(path))
                )
                return False
        # One open. Easy mode would drop ReplayGain, compilation and pictures.
        audio = mutagen.File(path)
        if audio is None:
            raise ValueError("Unsupported or invalid audio")
        facts = facts_for(audio, path.suffix.lower(), stat.st_size)
        flac_id3 = False
        if path.suffix.lower() == ".flac":
            # Mutagen accepts an ID3 prefix but does not expose it in the FLAC tag object.
            with path.open("rb") as header:
                flac_id3 = header.read(3) == b"ID3"
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                # REPLACE would delete the row and drop the song id, and any playlist or
                # queue entry that points at it. A blank id is filled; an existing one stays.
                added_at = self.store.db.execute(
                    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                ).fetchone()
                self.store.db.execute(
                    """
                    INSERT INTO library_files (
                        path, root, mtime_ns, size, generation,
                        title, artist, album, title_key, artist_key, album_key,
                        duration, isrc, mbid, song_id, added_at,
                        track, disc, year, genre, genres, album_artist, compilation,
                        replaygain_track_gain, replaygain_album_gain,
                        replaygain_track_peak, replaygain_album_peak,
                        suffix, content_type, bitrate, sample_rate, bit_depth, channels,
                        has_art, tags_version, record_labels, codec, flac_id3
                    ) VALUES (
                        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                        ?,?,?,?,?,?,?,
                        ?,?,?,?,
                        ?,?,?,?,?,?,
                        ?,?,?,?,?
                    )
                    ON CONFLICT(path) DO UPDATE SET
                        root=excluded.root,
                        mtime_ns=excluded.mtime_ns,
                        size=excluded.size,
                        generation=excluded.generation,
                        title=excluded.title,
                        artist=excluded.artist,
                        album=excluded.album,
                        title_key=excluded.title_key,
                        artist_key=excluded.artist_key,
                        album_key=excluded.album_key,
                        duration=excluded.duration,
                        isrc=excluded.isrc,
                        mbid=excluded.mbid,
                        track=excluded.track,
                        disc=excluded.disc,
                        year=excluded.year,
                        genre=excluded.genre,
                        genres=excluded.genres,
                        album_artist=excluded.album_artist,
                        compilation=excluded.compilation,
                        replaygain_track_gain=excluded.replaygain_track_gain,
                        replaygain_album_gain=excluded.replaygain_album_gain,
                        replaygain_track_peak=excluded.replaygain_track_peak,
                        replaygain_album_peak=excluded.replaygain_album_peak,
                        suffix=excluded.suffix,
                        content_type=excluded.content_type,
                        bitrate=excluded.bitrate,
                        sample_rate=excluded.sample_rate,
                        bit_depth=excluded.bit_depth,
                        channels=excluded.channels,
                        has_art=excluded.has_art,
                        tags_version=excluded.tags_version,
                        record_labels=excluded.record_labels,
                        codec=excluded.codec,
                        flac_id3=excluded.flac_id3,
                        song_id=CASE
                            WHEN library_files.song_id='' THEN excluded.song_id
                            ELSE library_files.song_id
                        END,
                        added_at=CASE
                            WHEN library_files.added_at='' THEN excluded.added_at
                            ELSE library_files.added_at
                        END
                    """,
                    (
                        str(path),
                        str(root),
                        stat.st_mtime_ns,
                        stat.st_size,
                        generation,
                        facts.title,
                        facts.artist,
                        facts.album,
                        normalize(facts.title),
                        normalize(facts.artist),
                        normalize(facts.album),
                        facts.duration,
                        facts.isrc,
                        facts.mbid,
                        new_song_id(),
                        "" if added_at is None else str(added_at[0]),
                        facts.track,
                        facts.disc,
                        facts.year,
                        facts.genre,
                        facts.genres,
                        facts.album_artist,
                        facts.compilation,
                        facts.replaygain_track_gain,
                        facts.replaygain_album_gain,
                        facts.replaygain_track_peak,
                        facts.replaygain_album_peak,
                        facts.suffix,
                        facts.content_type,
                        facts.bitrate,
                        facts.sample_rate,
                        facts.bit_depth,
                        facts.channels,
                        facts.has_art,
                        TAGS_VERSION,
                        facts.record_labels,
                        facts.codec,
                        int(flac_id3),
                    ),
                )
                note_library_change(self.store.db)
                # New paths cannot have old text rows. FTS cannot index its path column,
                # so deleting before every first insert makes a cold scan quadratic.
                if old is not None:
                    self.store.db.execute("DELETE FROM library_fts WHERE path=?", (str(path),))
                self.store.db.execute(
                    "INSERT INTO library_fts VALUES (?,?,?,?)",
                    (str(path), facts.title, facts.artist, facts.album),
                )
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        return True

    def remove(self, path: str) -> None:
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.store.db.execute(
                    "SELECT song_id FROM library_files WHERE path=?", (path,)
                ).fetchone()
                self.store.db.execute("DELETE FROM library_files WHERE path=?", (path,))
                self.store.db.execute("DELETE FROM library_fts WHERE path=?", (path,))
                if row is not None:
                    drop_song_references(self.store.db, [str(row[0])])
                    note_library_change(self.store.db)
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise

    def annotate(self, results: list[Result]) -> list[Result]:
        if not results:
            return results
        for result in results:
            result.matched_paths = []
            result.ownership = "missing"
            result.owned_count = 0
            result.matched_by = ""
            result.matched_album = ""
        # One indexed SQL join for the whole result page. Filesystem access never enters search.
        # CROSS JOIN keeps each catalog id on jobs(catalog, track_id). A plain join lets
        # SQLite walk every finished download and parse its JSON, which is most of a
        # second once the history is large, and the artist download check used to pay
        # that once per album while holding the database lock.
        payload = json.dumps(
            [
                {
                    "i": i,
                    "id": r.id,
                    "isrc": r.isrc.upper().replace("-", ""),
                    "mbid": r.mbid,
                    "title": normalize(r.title),
                    "artist": normalize(r.artist),
                    "duration": r.duration,
                    "album": normalize(r.album),
                }
                for i, r in enumerate(results)
                if r.kind == "track"
            ]
        )
        with self.store.lock:
            matches = self.store.db.execute(
                """
                WITH wanted AS (
                  SELECT json_extract(value,'$.i') i,json_extract(value,'$.id') id,
                  json_extract(value,'$.isrc') isrc,
                  json_extract(value,'$.mbid') mbid,json_extract(value,'$.title') title,
                  json_extract(value,'$.artist') artist,json_extract(value,'$.duration') duration,
                  json_extract(value,'$.album') album
                  FROM json_each(?)
                )
                , matches AS (
                SELECT w.i,f.path,f.album_key,0 priority
                FROM wanted w
                CROSS JOIN jobs j INDEXED BY jobs_catalog_track
                  ON j.catalog='deezer' AND j.track_id=w.id
                 AND j.active=0 AND json_extract(j.payload,'$.stage')='done'
                JOIN library_files f ON f.path=json_extract(j.payload,'$.final_path')
                  AND (w.isrc='' OR f.isrc='' OR w.isrc=f.isrc)
                JOIN library_roots r ON r.path=f.root AND r.enabled=1
                UNION ALL
                SELECT w.i,f.path,f.album_key,1 priority
                FROM wanted w JOIN library_files f INDEXED BY library_isrc
                  ON f.isrc=w.isrc AND f.isrc!='' AND w.isrc!=''
                JOIN library_roots r ON r.path=f.root AND r.enabled=1
                UNION ALL
                SELECT w.i,f.path,f.album_key,2 priority
                FROM wanted w JOIN library_files f INDEXED BY library_mbid
                  ON f.mbid=w.mbid AND f.mbid!='' AND w.mbid!=''
                JOIN library_roots r ON r.path=f.root AND r.enabled=1
                UNION ALL
                SELECT w.i,f.path,f.album_key,3 priority
                FROM wanted w JOIN library_files f INDEXED BY library_identity ON
                  w.title!='' AND w.artist!='' AND w.duration>0 AND f.title_key=w.title
                   AND f.artist_key=w.artist AND f.duration BETWEEN w.duration-3 AND w.duration+3
                   AND (w.isrc='' OR f.isrc='' OR w.isrc=f.isrc)
                JOIN library_roots r ON r.path=f.root AND r.enabled=1
                ), ranked AS (
                  SELECT i,path,album_key,priority,
                    min(priority) OVER (PARTITION BY i) best
                  FROM matches
                ) SELECT i,path,album_key,priority FROM ranked WHERE priority=best
            """,
                (payload,),
            ).fetchall()
            priority_labels: dict[int, Literal["download", "isrc", "mbid", "tags"]] = {
                0: "download",
                1: "isrc",
                2: "mbid",
                3: "tags",
            }
            # Collect all best-priority matches per track
            track_matches: dict[int, list[tuple[str, int, str]]] = {}
            for row in matches:
                i = row["i"]
                if i not in track_matches:
                    track_matches[i] = []
                track_matches[i].append((row["path"], row["priority"], row["album_key"]))
            # Decide ownership: owned if any best match is not an edition, else edition
            for i, rows in track_matches.items():
                result = results[i]
                result.matched_by = priority_labels[rows[0][1]]
                has_exact_match = False
                edition_album_key = None
                for path, priority, album_key in rows:
                    result.matched_paths.append(path)
                    is_edition = (
                        priority == 3
                        and album_key
                        and normalize(result.album)
                        and album_key != normalize(result.album)
                    )
                    if not is_edition:
                        has_exact_match = True
                    elif not edition_album_key:
                        edition_album_key = album_key
                if has_exact_match:
                    result.ownership = "owned"
                else:
                    result.ownership = "edition"
                    if edition_album_key:
                        album_row = self.store.db.execute(
                            "SELECT album FROM library_files WHERE album_key=? LIMIT 1",
                            (edition_album_key,),
                        ).fetchone()
                        if album_row:
                            result.matched_album = album_row["album"]
            for result in results:
                if result.kind == "album":
                    rows = self.store.db.execute(
                        "SELECT DISTINCT f.title_key FROM library_files f "
                        "JOIN library_roots r ON f.root=r.path "
                        "WHERE r.enabled=1 AND f.artist_key=? AND f.album_key=?",
                        (normalize(result.artist), normalize(result.title)),
                    ).fetchall()
                    result.owned_count = min(len(rows), result.track_count)
                    if rows:
                        result.ownership = "partial"
                    # Exact album coverage is computed on the hydrated tracklist, not title counts.
        return results
