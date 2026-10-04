import asyncio
import json
import os
import threading
import time
import unicodedata
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal, Protocol, cast

import mutagen
from mutagen.easymp4 import EasyMP4Tags
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from backend.catalog import Result
from backend.store import Store

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".flac", ".opus", ".ogg", ".wav", ".aiff", ".wma", ".webm"}
# One transaction per file made a 22k unchanged walk take minutes, and downloads waited on it.
STAMP_BATCH = 500
EasyMP4Tags.RegisterFreeformKey("isrc", "ISRC")


class AudioInfo(Protocol):
    length: float


class AudioFile(Protocol):
    info: AudioInfo

    def get(self, key: str, default: object = None) -> object: ...


def normalize(value: str) -> str:
    return " ".join(
        "".join(
            c if c.isalnum() else " " for c in unicodedata.normalize("NFKC", value).casefold()
        ).split()
    )


def tag_text(value: object) -> str:
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value) if value is not None else ""


def _folder_gone(path: Path) -> bool:
    try:
        path.stat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def tags_still_match(
    suffix: str,
    stored_mtime: int,
    stored_size: int,
    title: str,
    artist: str,
    album: str,
    mtime_ns: int,
    size: int,
) -> bool:
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
                    if event.is_directory or Path(path).suffix.lower() in AUDIO_EXTENSIONS:
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
            PollingObserver(timeout=self.poll_interval) if self.watch_mode == "poll" else Observer()
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
                if not any(part.startswith(".") for part in path.relative_to(root).parts):
                    return root
        return None

    def index_published(self, path: Path, root: Path) -> None:
        # The walk does not hold this lock. The row takes the walk's generation so
        # pruning, which does hold it, keeps a file the walk has already passed.
        with self.work_lock:
            self.index(path, root, self.generation)
        self.publish()

    def _refresh(self, paths: set[str]) -> None:
        generation = self.generation
        for raw in paths:
            path = Path(raw)
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                self._drop_removed_folder(path)
                continue
            root = self.visible_root(path)
            if root is None or path.is_symlink():
                continue
            try:
                if path.exists():
                    self.index(path, root, generation)
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

    def _known(self, root: Path) -> dict[str, tuple[int, int, str, str, str]]:
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT path, mtime_ns, size, title, artist, album FROM library_files WHERE root=?",
                (str(root),),
            ).fetchall()
        return {
            str(row[0]): (int(row[1]), int(row[2]), str(row[3]), str(row[4]), str(row[5]))
            for row in rows
        }

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
                    self.store.db.executemany(
                        "DELETE FROM library_files WHERE path=?", [(path,) for path in stale]
                    )
                    self.store.db.executemany(
                        "DELETE FROM library_fts WHERE path=?", [(path,) for path in stale]
                    )
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
        try:
            for root in self.roots:
                root_errors = 0
                batch: list[str] = []
                if not root.is_dir():
                    errors += 1
                    continue

                def walk_error(_: OSError) -> None:
                    nonlocal root_errors
                    root_errors += 1

                known = self._known(root)
                for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
                    dirs[:] = [
                        d
                        for d in dirs
                        if not d.startswith(".") and not (Path(directory) / d).is_symlink()
                    ]
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
                # Cancelled or unreadable scans must not erase files they never visited.
                if not self.cancelled.is_set() and root_errors == 0:
                    self._prune(root, generation)
                errors += root_errors
                if self.cancelled.is_set():
                    break
            self.state.update(
                status="cancelled" if self.cancelled.is_set() else "done",
                walked=walked,
                indexed=indexed,
                errors=errors,
                elapsed=round(time.monotonic() - started, 1),
                detail="Scan cancelled; previous index preserved"
                if self.cancelled.is_set()
                else "Scan complete"
                if errors == 0
                else "Scan complete with unreadable files or folders; previous entries preserved",
            )
        except Exception as exc:
            self.state.update(status="failed", detail=f"Scan failed: {type(exc).__name__}")
        self.publish()

    def index(self, path: Path, root: Path, generation: str) -> bool:
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("File escaped library root")
        stat = path.stat()
        with self.store.lock:
            old = self.store.db.execute(
                "SELECT mtime_ns,size,title,artist,album FROM library_files WHERE path=?",
                (str(path),),
            ).fetchone()
            if old and tags_still_match(
                path.suffix.lower(),
                int(old[0]),
                int(old[1]),
                str(old[2]),
                str(old[3]),
                str(old[4]),
                stat.st_mtime_ns,
                stat.st_size,
            ):
                self.store.db.execute(
                    "UPDATE library_files SET generation=? WHERE path=?", (generation, str(path))
                )
                return True
        audio = cast(AudioFile | None, mutagen.File(path, easy=True))
        if audio is None:
            raise ValueError("Unsupported or invalid audio")
        # WAV and AIFF expose native ID3 frames even when Mutagen is asked for easy tags.
        title, artist, album = (
            tag_text(audio.get(key) or audio.get(frame))
            for key, frame in (("title", "TIT2"), ("artist", "TPE1"), ("album", "TALB"))
        )
        isrc = tag_text(audio.get("isrc") or audio.get("TSRC")).upper().replace("-", "")
        mbid = tag_text(audio.get("musicbrainz_trackid") or audio.get("TXXX:MusicBrainz Track Id"))
        identifier = getattr(audio.get("UFID:http://musicbrainz.org"), "data", b"")
        if not mbid and isinstance(identifier, bytes):
            mbid = identifier.decode("ascii", errors="ignore")
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                self.store.db.execute(
                    "INSERT OR REPLACE INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        str(path),
                        str(root),
                        stat.st_mtime_ns,
                        stat.st_size,
                        generation,
                        title,
                        artist,
                        album,
                        normalize(title),
                        normalize(artist),
                        normalize(album),
                        audio.info.length,
                        isrc,
                        mbid,
                    ),
                )
                # New paths cannot have old text rows. FTS cannot index its path column,
                # so deleting before every first insert makes a cold scan quadratic.
                if old is not None:
                    self.store.db.execute("DELETE FROM library_fts WHERE path=?", (str(path),))
                self.store.db.execute(
                    "INSERT INTO library_fts VALUES (?,?,?,?)", (str(path), title, artist, album)
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
                self.store.db.execute("DELETE FROM library_files WHERE path=?", (path,))
                self.store.db.execute("DELETE FROM library_fts WHERE path=?", (path,))
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
