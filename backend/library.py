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
        # Docker Desktop does not forward host filesystem events. Poll slowly enough for idle use.
        self.poll_interval = max(1, float(os.getenv("MUSIMO_POLL_INTERVAL_SECONDS", "60")))
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
            if self.pending:
                paths, self.pending = self.pending, set()
                await asyncio.to_thread(self.refresh, paths)
                if any(Path(path).suffix.lower() not in AUDIO_EXTENSIONS for path in paths):
                    self.start_scan()
            if time.monotonic() > next_scan:
                self.start_scan()
                next_scan = time.monotonic() + 1800

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
        # Wait for generation pruning before adding a download that the scan may not have seen.
        with self.work_lock:
            self.index(path, root, self.generation)
        self.publish()

    def _refresh(self, paths: set[str]) -> None:
        for raw in paths:
            path = Path(raw)
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            root = self.visible_root(path)
            if root is None or path.is_symlink():
                continue
            try:
                if path.exists():
                    self.index(path, root, "watch")
                elif root.is_dir():
                    self.remove(str(path))
            except (OSError, ValueError, mutagen.MutagenError):
                # Reconciliation retries partial writes without an unbounded per-file retry loop.
                self.state["detail"] = (
                    "Some changed files are unreadable; rescan after writing finishes"
                )
        self.publish()

    def scan(self) -> None:
        # Generation pruning must not race with a watcher upsert from another worker thread.
        with self.work_lock:
            self._scan()

    def _scan(self) -> None:
        generation = uuid.uuid4().hex
        self.generation = generation
        started = time.monotonic()
        last_publish = 0.0
        walked = indexed = errors = 0
        try:
            for root in self.roots:
                root_errors = 0
                if not root.is_dir():
                    errors += 1
                    continue

                def walk_error(_: OSError) -> None:
                    nonlocal root_errors
                    root_errors += 1

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
                # Cancelled or unreadable scans must not erase files they never visited.
                if not self.cancelled.is_set() and root_errors == 0:
                    with self.store.lock:
                        stale = [
                            r[0]
                            for r in self.store.db.execute(
                                "SELECT path FROM library_files WHERE root=? AND generation!=?",
                                (str(root), generation),
                            )
                        ]
                    for path_string in stale:
                        self.remove(path_string)
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
            # Earlier versions cached blank ID3 metadata for WAV/AIFF. Repair it on rescan.
            missing_id3 = old and path.suffix.lower() in {".wav", ".aiff"} and not any(old[2:])
            if old and old[0] == stat.st_mtime_ns and old[1] == stat.st_size and not missing_id3:
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
                FROM wanted w JOIN jobs j ON j.catalog='deezer' AND j.track_id=w.id
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
