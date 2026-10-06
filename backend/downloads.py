import asyncio
import ctypes
import errno
import hashlib
import json
import os
import random
import shutil
import signal
import sys
import time
from collections.abc import Callable, Collection
from datetime import date
from functools import partial
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from backend import deezer_cookie, mixes
from backend.catalog import Catalog, CatalogError, Result
from backend.enrichment import Enrichment
from backend.errors import BLOCKING_CODES, error_guidance, site_label
from backend.job_models import TERMINAL, Job, Metadata
from backend.job_store import Jobs
from backend.library import Library
from backend.link_tags import NOTE_PREFIX, LinkTags, tidied, wants_tidy
from backend.models import Settings
from backend.naming import Naming
from backend.navidrome import Navidrome, NavidromeError
from backend.podcasts import Podcasts
from backend.sources import Site, by_source, safe_art
from backend.store import Store
from backend.youtube_cookies import drop_copy

# YouTube lists its largest thumbnail without checking that it exists, and an older video has
# none. Each size to fall back to is on the same host, smaller than the one before it.
YOUTUBE_ART = ("maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg")
ART_HOPS = 3
ART_BYTES = 5 * 1024**2
# Shown on the card. While it is present, another run of this job loads the catalog again.
CATALOG_DETAILS_WARNING = "Catalog details unavailable"
SIDE_FAILED = "Metadata preparation failed"
# The same bound as the identity fetch. A Deezer cooldown can otherwise sit for minutes.
CATALOG_DETAILS_SECONDS = 15
# Tagging waits 60 seconds (worker.SIDE_WAIT_SECONDS). Stop sooner so job.json and side.json
# are on disk before that wait ends, and the file and the library path share one snapshot.
SIDE_BUDGET_SECONDS = 55
ENRICHMENT_MARKERS = ("Lyrics", "MusicBrainz", "Optional metadata", "No ISRC")
# A catalog payload has none of these. A refresh must not throw away a lookup that already hit.
_KEPT_FROM_LISTING = (
    "lyrics",
    "synced_lyrics",
    "mb_recording",
    "mb_track",
    "mb_release",
    "mb_release_group",
    "mb_artist",
)


def listing_metadata(track: Result, *, tracks: int = 1) -> Metadata:
    """What an album listing already knows, enough to match the recording.

    Genre, label, lyrics and MusicBrainz ids are filled while the file downloads.
    ``album_artist`` stays empty so that fill still happens; the published path uses it
    once it has arrived.
    """
    return Metadata(
        id=track.id,
        title=track.title,
        artist=track.artist,
        album=track.album or track.title,
        duration=float(track.duration),
        date=f"{track.year:04d}" if track.year else "",
        isrc=track.isrc,
        explicit=track.explicit,
        track=max(1, track.position),
        tracks=max(1, tracks),
        disc=max(1, track.disc),
        art=track.art,
    )


def catalog_details_pending(job: Job) -> bool:
    """True when a catalog song still needs genre, label and the rest of its tags."""
    if job.catalog != "deezer" or not job.meta.artist:
        return False
    if CATALOG_DETAILS_WARNING in job.warnings:
        return True
    meta = job.meta
    return not (meta.album_artist or meta.genre or meta.label or meta.upc or meta.contributors)


def enrichment_pending(job: Job) -> bool:
    """True when lyrics and MusicBrainz have not been looked up yet."""
    if job.catalog != "deezer" or not job.meta.artist:
        return False
    meta = job.meta
    if meta.lyrics or meta.synced_lyrics or meta.mb_recording:
        return False
    return not any(
        any(marker in warning for marker in ENRICHMENT_MARKERS) for warning in job.warnings
    )


def merge_catalog_tags(previous: Metadata, fresh: Metadata) -> Metadata:
    """Keep lyrics and MusicBrainz ids the catalog payload does not carry."""
    update: dict[str, str] = {}
    for name in _KEPT_FROM_LISTING:
        old = getattr(previous, name)
        if isinstance(old, str) and old and not getattr(fresh, name):
            update[name] = old
    return fresh.model_copy(update=update) if update else fresh


def drop_stale_enrichment_markers(warnings: list[str]) -> list[str]:
    """A miss from before the full tags existed must not block one lookup against them."""
    return [item for item in warnings if not any(marker in item for marker in ENRICHMENT_MARKERS)]


def side_work_pending(job: Job, folder: Path) -> bool:
    """Cover art, catalog tags or a link note still to do. The download does not wait for these."""
    cover = bool(job.meta.art) and not (folder / "cover.jpg").is_file()
    note = job.catalog == "link" and job.kind == "music" and not tidied(job)
    return cover or note or catalog_details_pending(job) or enrichment_pending(job)


def write_job_file(folder: Path, job: Job) -> None:
    temporary = folder / "job.json.tmp"
    temporary.write_text(job.model_dump_json(), encoding="utf-8")
    temporary.replace(folder / "job.json")


def mark_side_ready(folder: Path) -> None:
    """Written last, so the worker only re-reads ``job.json`` after it is complete."""
    temporary = folder / "side.json.tmp"
    temporary.write_text("{}", encoding="utf-8")
    temporary.replace(folder / "side.json")


def opening_source(settings: Settings, paused: Collection[str], cookie: bool) -> str:
    """The first catalog row that can run. `cookie` says whether a Deezer cookie is saved.

    A paused row is not asked yet. If every row that could run is paused, name the first of
    those, so the card is not left on a source that is off or missing from the list.
    """
    waiting = ""
    held = set(paused)
    for name in settings.source_order:
        if name in settings.disabled_sources:
            continue
        if name == "deezer" and not (settings.deezer_audio and cookie):
            continue
        if name in held:
            if not waiting:
                waiting = name
            continue
        return name
    return waiting


class DownloadError(Exception):
    def __init__(
        self, code: str, detail: str, retryable: bool = False, hint: str = "", fix: str = ""
    ) -> None:
        self.code, self.detail, self.retryable = code, detail, retryable
        self.hint, self.fix = hint, fix


def art_candidates(url: str) -> list[str]:
    """The addresses to try for one cover, best first."""
    parts = urlsplit(url)
    name = parts.path.rsplit("/", 1)[-1]
    if parts.hostname != "i.ytimg.com" or name not in YOUTUBE_ART:
        return [url]
    folder = parts.path[: -len(name)]
    smaller = YOUTUBE_ART[YOUTUBE_ART.index(name) + 1 :]
    return [url, *(parts._replace(path=folder + other).geturl() for other in smaller)]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def publish_file(source: Path, target: Path) -> None:
    # Never replace an existing library file, including one created after the path was checked.
    if sys.platform == "win32":
        source.rename(target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code in {errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP}:
            # Docker Desktop mounts may reject rename flags but support atomic hard links.
            # link() fails if the destination exists. A crash before unlink is reconciled by hash.
            os.link(source, target)
            source.unlink()
            return
        raise OSError(code, os.strerror(code), str(target))


async def stop_tree(process: asyncio.subprocess.Process) -> None:
    """Stop a child started with its own process group, and everything it started.

    A stopped child cannot run its own exit cleanup, so its copy of the YouTube cookie is
    removed here. The ids are taken first: after the tree is gone they can no longer be looked up.
    """
    pids = _cookie_pids(process.pid)
    if process.returncode is None:
        await _stop_group(process)
    for pid in pids:
        drop_copy(pid)


def _cookie_pids(pid: int) -> list[int]:
    """Ids whose cookie copies belong to this process.

    On Windows a venv `python.exe` is a launcher. The interpreter that made the copy is its
    child, and the filename uses that child's id, not the one asyncio recorded.
    """
    if sys.platform != "win32":
        return [pid]
    return [pid, *_descendant_pids(pid)]


def _descendant_pids(root: int) -> list[int]:
    """Live processes that descend from `root`. Empty when the snapshot cannot be taken."""

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_uint),
            ("cntUsage", ctypes.c_uint),
            ("th32ProcessID", ctypes.c_uint),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", ctypes.c_uint),
            ("cntThreads", ctypes.c_uint),
            ("th32ParentProcessID", ctypes.c_uint),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", ctypes.c_uint),
            ("szExeFile", ctypes.c_char * 260),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot_fn = kernel.CreateToolhelp32Snapshot
    snapshot_fn.argtypes = [ctypes.c_uint, ctypes.c_uint]
    snapshot_fn.restype = ctypes.c_void_p
    first = kernel.Process32First
    nxt = kernel.Process32Next
    first.argtypes = nxt.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry)]
    first.restype = nxt.restype = ctypes.c_int
    close = kernel.CloseHandle
    close.argtypes = [ctypes.c_void_p]
    close.restype = ctypes.c_int

    snapshot = snapshot_fn(0x00000002, 0)
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        return []
    parents: dict[int, int] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(ProcessEntry)
        if not first(snapshot, ctypes.byref(entry)):
            return []
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not nxt(snapshot, ctypes.byref(entry)):
                break
    finally:
        close(snapshot)

    children: dict[int, list[int]] = {}
    for pid, parent in parents.items():
        children.setdefault(parent, []).append(pid)
    found: list[int] = []
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        if pid == root or pid in found:
            continue
        found.append(pid)
        stack.extend(children.get(pid, []))
    return found


async def _stop_group(process: asyncio.subprocess.Process) -> None:
    try:
        if sys.platform == "win32":
            # FFmpeg and the token helper are children of the worker and must stop with it.
            terminator = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await terminator.wait()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 1)
        except TimeoutError:
            if sys.platform == "win32":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
    except ProcessLookupError:
        pass


class Downloads:
    def __init__(
        self,
        store: Store,
        catalog: Catalog,
        library: Library,
        changed: asyncio.Event,
        navidrome: Navidrome | None = None,
    ) -> None:
        self.store, self.catalog, self.library, self.changed = store, catalog, library, changed
        self.navidrome_client = navidrome or Navidrome(store, catalog.client)
        self.wake = asyncio.Event()
        self.jobs = Jobs(store, self.notify)
        self.enrichment = Enrichment(catalog)
        self.link_tags = LinkTags(catalog, self.enrichment)
        self.podcasts = Podcasts(catalog)
        # The day a mix with no date of its own is filed under. A test can set it.
        self.today: Callable[[], date] = date.today
        self.running: dict[str, asyncio.Task[None]] = {}
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        # Sources already counted for a block during this run, so a search block and the
        # final error do not pause the same source twice.
        self.noted_blocks: dict[str, set[str]] = {}
        self.stopping = False
        self.task: asyncio.Task[None] | None = None
        # Tests move this so a pause between groups does not wait on the wall clock.
        self.now: Callable[[], float] = time.time

    def notify(self) -> None:
        self.changed.set()
        self.wake.set()

    def settings(self) -> Settings:
        return self.store.current()

    def child_env(self) -> dict[str, str]:
        """The worker's environment.

        The worker reads the saved cookie file, and only while that source is on. The cookie text
        itself never goes in: MUSIMO_DEEZER_ARL only seeds the first start.
        """
        settings = self.settings()
        env = dict(os.environ)
        env["MUSIMO_DISABLED_SOURCES"] = ",".join(settings.disabled_sources)
        env["MUSIMO_SOURCE_ORDER"] = ",".join(settings.source_order)
        env["MUSIMO_TRIES_PER_SOURCE"] = str(settings.tries_per_source)
        env["MUSIMO_MAX_ATTEMPTS"] = str(settings.max_attempts)
        env["MUSIMO_PAUSED_SOURCES"] = ",".join(sorted(self.paused_sources()))
        env.pop("MUSIMO_DEEZER_ARL", None)
        cookie = deezer_cookie.published()
        if settings.deezer_audio and cookie:
            env[deezer_cookie.ENV] = cookie
        else:
            env.pop(deezer_cookie.ENV, None)
        return env

    def controls(self) -> dict[str, object]:
        return self.store.controls()

    def last_terminal_job(self) -> dict[str, object] | None:
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT payload, created_at FROM jobs WHERE "
                "json_extract(payload,'$.stage') IN ('done','failed','cancelled') "
                "ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            job = Job.model_validate_json(row[0])
            return {
                "stage": job.stage,
                "error_code": job.error_code,
                "created_at": float(row[1]),
            }

    def set_controls(
        self, paused: bool | None = None, source_paused: bool | None = None, source: str = "youtube"
    ) -> None:
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                if paused is not None:
                    self.store.db.execute(
                        "UPDATE queue_control SET paused=? WHERE id=1", (int(paused),)
                    )
                if source_paused is not None:
                    self.store.db.execute(
                        "INSERT INTO source_control(source,paused,blocking_failures) "
                        "VALUES (?,?,0) ON CONFLICT(source) DO UPDATE SET "
                        "paused=excluded.paused,blocking_failures=0",
                        (source, int(source_paused)),
                    )
                self.store._event("queue.updated", self.controls())
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.notify()

    def paused_sources(self) -> set[str]:
        listed = self.controls()["paused_sources"]
        return {str(source) for source in listed} if isinstance(listed, list) else set()

    def catalog_hold(self, settings: Settings, paused: set[str]) -> str:
        """Why a catalog song cannot start, or "" when one source can run.

        A pause waits, because the banner already says so. A list that is off, or a Deezer
        row with no cookie and nothing else on, fails the job. Waiting would leave it queued
        with no reason on the card.
        """
        name = opening_source(settings, paused, bool(deezer_cookie.published()))
        if name in paused:
            return "paused"
        return "" if name else "off"

    def fail_closed(self, job: Job) -> None:
        message = "The sources for this track are turned off in Settings."
        self.jobs.update(
            job.id,
            stage="failed",
            error_code="DOWNLOAD_FAILED",
            error=message,
            error_hint=message,
            error_fix="settings:sources",
            retryable=False,
            speed=0,
            eta=None,
        )

    def note_block(self, job_id: str, source: str, detail: str) -> None:
        """Count one blocking failure for this run against the source that raised it."""
        if not source:
            return
        seen = self.noted_blocks.setdefault(job_id, set())
        if source in seen:
            return
        seen.add(source)
        with self.store.lock:
            failures = self.store.db.execute(
                "INSERT INTO source_control(source,blocking_failures) VALUES (?,1) "
                "ON CONFLICT(source) DO UPDATE SET "
                "blocking_failures=blocking_failures+1 RETURNING blocking_failures",
                (source,),
            ).fetchall()[0][0]
        if failures >= 3:
            self.set_controls(source_paused=True, source=source)
        self.store.record_probe("blocked", 0, detail, source=source)

    def target(self, raw: str) -> Path:
        # Select a trusted mount without probing a client-supplied filesystem path.
        requested = os.path.normcase(os.path.normpath(raw))
        for root in self.library.roots:
            if os.path.normcase(str(root)) == requested:
                return root
        raise ValueError("Choose a configured library mount")

    def folder(self, job: Job) -> Path:
        root = self.target(job.target)
        folder = root / ".musimo" / job.id
        if not folder.resolve().is_relative_to(root) or folder.is_symlink():
            raise DownloadError(
                "DEST_UNWRITABLE", "The staging folder escaped the selected library"
            )
        return folder

    def check_destination(self, root: Path) -> None:
        if not root.is_dir() or not os.access(root, os.W_OK):
            raise DownloadError(
                "DEST_UNWRITABLE",
                "Destination is missing or read-only. Choose a writable folder in Settings.",
            )
        if shutil.disk_usage(root).free < 128 * 1024**2:
            raise DownloadError(
                "DISK_FULL", "Less than 128 MB is free. Free space before retrying."
            )

    def start(self) -> None:
        for job in self.jobs.list(active=True):
            if job.final_path and job.artifact_hash:
                path = Path(job.final_path)
                if path.is_file() and digest(path) == job.artifact_hash:
                    self.jobs.update(job.id, stage="queued", desired="run")
        self.jobs.recover()
        for job in self.jobs.list():
            if job.stage in {"done", "cancelled"}:
                try:
                    self.cleanup(job)
                except (OSError, ValueError, DownloadError):
                    pass
        self.task = asyncio.create_task(self.schedule())

    async def close(self) -> None:
        self.stopping = True
        self.wake.set()
        for task in list(self.running.values()):
            if not task.cancelling():
                task.cancel()
        await asyncio.gather(*list(self.running.values()), return_exceptions=True)
        if self.task:
            await self.task

    def pace_room(self, settings: Settings, slots: int) -> tuple[int, float | None]:
        """Slots left in this group, and the seconds left in a pause between groups.

        A track count or a wait of 0 turns the pause off. The pause is there so a
        long queue does not keep the connection busy the whole time.
        """
        if settings.pace_tracks < 1 or settings.pace_minutes < 1:
            self._clear_pace()
            return slots, None
        started, until = self.store.pace()
        now = self.now()
        if until > now:
            return 0, max(0.01, until - now)
        if until > 0:
            self.store.set_pace(0, 0.0, announce=True)
            self.notify()
            started = 0
        # Tracks still running belong to this group, so a failure can be replaced
        # without letting the next group begin early.
        room = settings.pace_tracks - started - len(self.running)
        return min(slots, max(0, room)), None

    def _clear_pace(self) -> None:
        started, until = self.store.pace()
        if started == 0 and until == 0:
            return
        self.store.set_pace(0, 0.0, announce=until > 0)
        if until > 0:
            self.notify()

    def note_done(self) -> None:
        """Count one finished track, and begin the pause once that group is idle.

        A failure or a cancel does not count: it did not take a full download.
        The wait starts only after the tracks already going have finished, so the
        gap is a quiet connection rather than a timer running beside the last files.
        """
        settings = self.settings()
        if settings.pace_tracks < 1 or settings.pace_minutes < 1:
            return
        started, until = self.store.pace()
        now = self.now()
        if until > now:
            return
        started += 1
        if started >= settings.pace_tracks and not self.running:
            until = now + settings.pace_minutes * 60
        else:
            until = 0.0
        previous = self.store.pace()
        if (started, until) == previous:
            return
        self.store.set_pace(started, until, announce=until != previous[1])
        if until != previous[1]:
            self.notify()

    async def schedule(self) -> None:
        while not self.stopping:
            self.wake.clear()
            control = self.controls()
            paused_sources = self.paused_sources()
            delay = 60.0
            settings = self.settings()
            # A manual pause still lets a group pause count down.
            slots = 0 if control["paused"] else settings.concurrency - len(self.running)
            slots, rest = self.pace_room(settings, slots)
            if rest is not None:
                delay = min(delay, rest)
            if not control["paused"]:
                # The same for every catalog song in this pass, so it is worked out once.
                hold = self.catalog_hold(settings, paused_sources)
                for job in reversed(self.jobs.list(active=True)):
                    # A block on one site must not hold the others. A catalog song walks its list,
                    # so it starts while any row in that list can still run.
                    # Retry clears an automatic pick, so this job walks the list. A hand pick waits.
                    # `selected` is not the test: the walk stores its own pick there as it goes.
                    catalog_job = job.catalog == "deezer" and not job.hand_picked
                    if catalog_job:
                        if (
                            hold == "off"
                            and job.desired == "run"
                            and job.stage in {"queued", "retry_wait"}
                        ):
                            self.fail_closed(job)
                        if hold:
                            continue
                    elif job.source in paused_sources:
                        continue
                    if job.stage == "retry_wait" and job.retry_at > time.time():
                        delay = min(delay, max(0.01, job.retry_at - time.time()))
                    if slots <= 0:
                        break
                    if (
                        job.id not in self.running
                        and job.desired == "run"
                        and job.stage in {"queued", "retry_wait"}
                        and job.retry_at <= time.time()
                    ):
                        task = asyncio.create_task(self.run(job.id))
                        self.running[job.id] = task
                        task.add_done_callback(partial(self.completed, job.id))
                        slots -= 1
            try:
                await asyncio.wait_for(self.wake.wait(), delay)
            except TimeoutError:
                pass

    def completed(self, job_id: str, task: asyncio.Task[None]) -> None:
        finished = False
        if self.running.get(job_id) is task:
            self.running.pop(job_id, None)
            job = self.jobs.get(job_id)
            if job.stage == "done":
                finished = True
            elif job.stage in {"pausing", "cancelling"}:
                if job.desired == "cancel":
                    self.cleanup(job)
                self.jobs.update(
                    job_id,
                    stage="cancelled"
                    if job.desired == "cancel"
                    else "queued"
                    if job.desired == "run"
                    else "paused",
                )
        if finished:
            self.note_done()
        self.wake.set()

    def command(self, job_id: str, action: str) -> Job:
        job = self.jobs.get(job_id)
        if action == "dismiss":
            if job.stage not in TERMINAL:
                raise ValueError("Cancel the job before clearing it")
            return self.jobs.update(job_id, hidden=True)
        if action == "retry":
            if job.stage not in {"failed", "cancelled"}:
                raise ValueError("Only failed or cancelled jobs can be retried")
            self.check_destination(self.target(job.target))
            # An automatic match walks the list again. A recording chosen by hand stays put.
            automatic = job.catalog == "deezer" and not job.hand_picked
            restart: dict[str, object] = {}
            if automatic:
                # Show the first row that can run. The worker replaces it when that row is asked.
                restart = {
                    "selected": "",
                    "check_match": False,
                    "source": opening_source(
                        self.settings(), self.paused_sources(), bool(deezer_cookie.published())
                    ),
                    "lap": 0,
                    "laps": 0,
                }
            return self.jobs.update(
                job_id,
                stage="queued",
                desired="run",
                attempts=0,
                retry_at=0,
                error="",
                error_code="",
                hidden=False,
                **restart,
            )
        if action == "resume":
            if job.stage not in {"paused", "pausing"}:
                raise ValueError("Only paused or pausing jobs can be resumed")
            return self.jobs.update(
                job_id,
                stage="pausing" if job_id in self.running else "queued",
                desired="run",
                retry_at=0,
            )
        if action not in {"pause", "cancel"} or job.stage in TERMINAL:
            raise ValueError("This action is not available for the job")
        if action == "pause" and job.desired == "cancel":
            raise ValueError("Cancellation is already in progress")
        active = job_id in self.running
        stage = (
            ("pausing" if action == "pause" else "cancelling")
            if active
            else ("paused" if action == "pause" else "cancelled")
        )
        result = self.jobs.update(job_id, stage=stage, desired=action, speed=0, eta=None)
        if active:
            # Repeated controls change intent without cancelling the cleanup already in flight.
            task = self.running[job_id]
            if not task.cancelling():
                task.cancel()
        elif action == "cancel":
            self.cleanup(job)
        return result

    def cleanup(self, job: Job) -> None:
        folder = self.folder(job)
        if folder.is_dir():
            shutil.rmtree(folder)

    async def stop_process(self, job_id: str) -> None:
        process = self.processes.get(job_id)
        if process is not None:
            await stop_tree(process)

    async def catalog_details(self, job: Job) -> Job:
        """Full catalog tags. A miss keeps the listing and says so on the card.

        The call is bounded, so a Deezer cooldown cannot sit past the tagging wait.
        The listing's album artist is left empty: filling it from the track artist would
        file a compilation under the wrong name. Lyrics already stored are kept, and a
        miss marker is cleared so the lookup can run once against the full tags.
        """
        try:
            async with asyncio.timeout(CATALOG_DETAILS_SECONDS):
                fetched = await self.enrichment.track(job.track_id)
        except (CatalogError, TimeoutError, ValidationError):
            warnings = list(job.warnings)
            if CATALOG_DETAILS_WARNING not in warnings:
                warnings.append(CATALOG_DETAILS_WARNING)
            return self.jobs.update(job.id, warnings=warnings)
        meta = merge_catalog_tags(job.meta, fetched)
        warnings = drop_stale_enrichment_markers(
            [item for item in job.warnings if item != CATALOG_DETAILS_WARNING]
        )
        return self.jobs.update(job.id, meta=meta.model_dump(), warnings=warnings)

    async def side_metadata(self, job_id: str, folder: Path) -> None:
        """Lyrics, catalog tags and cover art, overlapping the download.

        ``side.json`` is written only after ``job.json``, and not at all when the task is
        cancelled, so a resumed job does not tag with a half-written record. The work stops
        inside the tagging wait, so a late catalog response cannot publish a different
        snapshot from the one embedded in the file.
        """
        try:
            async with asyncio.timeout(SIDE_BUDGET_SECONDS):
                job = self.jobs.get(job_id)
                if catalog_details_pending(job):
                    job = await self.catalog_details(job)
                if enrichment_pending(job):
                    warnings = await self.enrichment.extra(job.meta)
                    job = self.jobs.update(
                        job.id,
                        meta=job.meta.model_dump(),
                        warnings=[*job.warnings, *warnings],
                    )
                elif wants_tidy(job):
                    meta, note = await self.link_tags.tidy(job.meta, site_label(job.source))
                    job = self.jobs.update(job.id, meta=meta.model_dump(), notes=[*job.notes, note])
                elif job.catalog == "link" and job.kind == "music" and not tidied(job):
                    note = f"{NOTE_PREFIX} {site_label(job.source)}"
                    job = self.jobs.update(job.id, notes=[*job.notes, note])
                await self.artwork(self.jobs.get(job_id), folder)
                write_job_file(folder, self.jobs.get(job_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            try:
                job = self.jobs.get(job_id)
                if SIDE_FAILED not in job.warnings:
                    job = self.jobs.update(job_id, warnings=[*job.warnings, SIDE_FAILED])
                write_job_file(folder, job)
            except Exception:
                pass
        mark_side_ready(folder)

    async def artwork(self, job: Job, folder: Path) -> None:
        if not job.meta.art or (folder / "cover.jpg").exists():
            return
        site = by_source(job.source)
        candidates = art_candidates(job.meta.art)
        for index, url in enumerate(candidates):
            try:
                (folder / "cover.jpg").write_bytes(await self.cover(url, site))
                return
            except httpx.HTTPStatusError as exc:
                # Only "not there" moves on to a smaller size. Anything else would fail again.
                if exc.response.status_code == 404 and index + 1 < len(candidates):
                    continue
                break
            except (httpx.HTTPError, ValueError):
                break
        self.jobs.update(job.id, warnings=[*job.warnings, "Cover art unavailable"])

    async def cover(self, url: str, site: Site | None) -> bytes:
        """One JPEG cover. A redirect is followed only to another address the job's site owns."""
        for _ in range(ART_HOPS + 1):
            async with self.catalog.client.stream("GET", url, timeout=5) as response:
                if response.is_redirect:
                    moved = str(response.url.join(response.headers.get("location", "")))
                    if site is None or not safe_art(site, moved):
                        raise ValueError("Cover moved to another site")
                    url = moved
                    continue
                response.raise_for_status()
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > ART_BYTES:
                        raise ValueError("Cover exceeded 5 MB")
                if chunks[:3] != b"\xff\xd8\xff":
                    raise ValueError("Expected JPEG artwork")
                return bytes(chunks)
        raise ValueError("Cover moved too many times")

    def budget(self, job: Job) -> int:
        """Seconds one worker run may take."""
        # Episodes, mixes and radio shows can run for hours as one large file, unlike a song.
        long = job.catalog == "podcast" or job.kind in {"mix", "radio"}
        return 3600 if long else 600

    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "backend.worker",
            str(folder),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=sys.platform != "win32",
            env=self.child_env(),
            limit=131072,
        )
        self.processes[job.id] = process
        ready: Path | None = None
        info: dict[str, object] = {}
        failure: DownloadError | None = None
        tail: list[str] = []
        assert process.stdout
        async with asyncio.timeout(self.budget(job)):
            while line := await process.stdout.readline():
                try:
                    raw: object = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(raw, dict):
                    continue
                kind = raw.get("kind")
                if kind == "stage":
                    self.jobs.update(job.id, stage=raw.get("stage"), progress=0, speed=0, eta=None)
                elif kind == "progress":
                    downloaded = int(raw.get("downloaded") or 0)
                    total = int(raw.get("total") or 0)
                    self.jobs.update(
                        job.id,
                        downloaded=downloaded,
                        total=total,
                        progress=min(1, downloaded / total) if total else 0,
                        speed=float(raw.get("speed") or 0),
                        eta=raw.get("eta"),
                    )
                elif kind == "source":
                    # The source being asked now, so the card and a later block follow it.
                    source = str(raw.get("source", ""))
                    if source == "deezer" or by_source(source) is not None:
                        changes: dict[str, object] = {"source": source}
                        if raw.get("lap"):
                            changes["lap"] = int(str(raw.get("lap")))
                            changes["laps"] = int(str(raw.get("laps") or 0))
                        self.jobs.update(job.id, **changes)
                elif kind == "candidates":
                    self.jobs.update(
                        job.id,
                        candidates=raw.get("items", []),
                        selected=raw.get("selected", ""),
                        check_match=raw.get("check_match", False),
                    )
                elif kind in {"warning", "log"}:
                    tail.append(str(raw.get("message", "")))
                    tail = tail[-8:]
                elif kind == "blocked":
                    # Count the block now, so a later source that saves the song does not hide it.
                    self.note_block(
                        job.id, str(raw.get("source") or ""), str(raw.get("message") or "")
                    )
                elif kind == "error":
                    # A search can fail before a file exists. The pause belongs to that source.
                    failed = str(raw.get("source") or "")
                    if failed == "deezer" or by_source(failed) is not None:
                        self.jobs.update(job.id, source=failed)
                    failure = DownloadError(
                        str(raw.get("code", "DOWNLOAD_FAILED")),
                        str(raw.get("message", "Worker failed")),
                        raw.get("retryable") is True,
                        str(raw.get("hint", "")),
                        str(raw.get("fix", "")),
                    )
                    self.jobs.update(job.id, tool_version=str(raw.get("version", "")))
                elif kind == "ready":
                    ready = folder / str(raw.get("file", ""))
                    info = {str(key): value for key, value in raw.items()}
            await process.wait()
        if tail:
            self.jobs.update(job.id, tool_tail="\n".join(tail)[-3000:])
        if failure:
            raise failure
        if (
            process.returncode != 0
            or ready is None
            or ready.parent != folder
            or not ready.is_file()
        ):
            raise DownloadError(
                "DOWNLOAD_FAILED", "Worker stopped before producing a tagged audio file", True
            )
        return ready, info

    async def navidrome(self, job: Job, path: Path) -> str | None:
        settings = self.settings()
        if settings.navidrome_mode == "off":
            return "Navidrome integration is not configured"
        if settings.navidrome_mode == "watcher":
            return None
        scan_folder = path.parent
        if job.batch_id:
            siblings = [
                row for row in self.jobs.list() if row.batch_id == job.batch_id and row.id != job.id
            ]
            if any(row.stage not in TERMINAL for row in siblings):
                return None
            scan_folder = Path(
                os.path.commonpath(
                    [
                        str(path.parent),
                        *[str(Path(row.final_path).parent) for row in siblings if row.final_path],
                    ]
                )
            )
        try:
            relative = scan_folder.relative_to(self.target(job.target)).as_posix()
            if relative == ".":
                relative = ""
            target = f"{settings.navidrome_library_id}:{relative}"
            await self.navidrome_client.start_scan(target)
        except (OSError, ValueError, NavidromeError):
            return "Navidrome scan failed; file is saved. Check integration settings."
        return None

    def layout(self, job: Job, extension: str) -> str:
        """Where a finished file lands, relative to the chosen library root."""
        if job.catalog == "podcast":
            return Naming().podcast_path(job.meta, extension)
        if mixes.long_form(job.kind):
            return mixes.landing(job.meta, self.today(), extension)
        return Naming().path(self.settings().naming_template, job.meta, extension)

    async def finish(
        self, job: Job, ready: Path | None = None, info: dict[str, object] | None = None
    ) -> None:
        root = self.target(job.target)
        folder = self.folder(job)
        named = str((info or {}).get("artist") or "")
        if ready and named and not job.meta.artist:
            # The list gave no artist, so the file was tagged with the one its own page names. The
            # library path and the index need the same name.
            meta = job.meta.model_copy(
                update={"artist": named, "album_artist": job.meta.album_artist or named}
            )
            job = self.jobs.update(job.id, meta=meta.model_dump())
        if ready:
            self.jobs.update(job.id, stage="moving", progress=1, speed=0, eta=None)
            target = root / self.layout(job, ready.suffix[1:])
            if not target.resolve().is_relative_to(root):
                raise DownloadError("MOVE_FAILED", "Output path escaped the library root")
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target = target.with_name(f"{target.stem} [{job.id[:8]}]{target.suffix}")
            checksum = await asyncio.to_thread(digest, ready)
            details = info or {}
            job = self.jobs.update(
                job.id,
                final_path=str(target),
                artifact_hash=checksum,
                codec=str(details.get("codec", "")),
                actual_bitrate=int(str(details.get("bitrate", 0))),
                tool_version=str(details.get("version", "")),
            )
            publish_file(ready, target)
        else:
            target = Path(job.final_path)
        # An already-published file is reconciled on restart instead of downloaded again.
        self.jobs.update(job.id, stage="scanning")
        for source, destination in [
            (folder / "cover.jpg", target.parent / "cover.jpg"),
            (folder / "ready.lrc", target.with_suffix(".lrc")),
        ]:
            if source.is_file() and not destination.exists():
                try:
                    publish_file(source, destination)
                except FileExistsError:
                    pass
        await asyncio.to_thread(self.library.index_published, target, root)
        warning = await self.navidrome(job, target)
        current = self.jobs.get(job.id)
        warnings = current.warnings + ([warning] if warning else [])
        details = info or {}
        self.jobs.update(
            job.id,
            stage="done",
            desired="run",
            progress=1,
            speed=0,
            eta=None,
            warnings=warnings,
            codec=str(details.get("codec") or current.codec),
            actual_bitrate=int(str(details.get("bitrate") or current.actual_bitrate)),
            tool_version=str(details.get("version") or current.tool_version),
        )
        try:
            self.cleanup(job)
        except OSError:
            self.jobs.update(job.id, warnings=[*warnings, "Staging cleanup failed; audio is saved"])

    async def run(self, job_id: str) -> None:
        try:
            job = self.jobs.get(job_id)
            self.check_destination(self.target(job.target))
            folder = self.folder(job)
            folder.mkdir(parents=True, exist_ok=True)
            if (
                job.final_path
                and Path(job.final_path).is_file()
                and job.artifact_hash
                and await asyncio.to_thread(digest, Path(job.final_path)) == job.artifact_hash
            ):
                await self.finish(job)
                return
            job = self.jobs.update(
                job_id,
                # Podcast episodes and pasted links skip the search, so they never show it.
                stage="matching" if job.catalog == "deezer" else "downloading",
                attempts=job.attempts + 1,
                error_code="",
                error="",
                retryable=False,
                error_hint="",
                error_fix="",
                retry_at=0,
            )
            if job.catalog == "deezer" and not job.meta.artist:
                # The search needs a title and artist. Lyrics and the rest can follow.
                async with asyncio.timeout(15):
                    meta = await self.enrichment.track(job.track_id)
                job = self.jobs.update(job_id, meta=meta.model_dump())
            if (
                job.catalog == "deezer"
                and not job.hand_picked
                and self.catalog_hold(self.settings(), self.paused_sources()) == "paused"
            ):
                # A block paused the last row that could run while this job fetched its details.
                # The song waits under the pause banner, as it would have at dispatch, instead of
                # starting a worker that finds nothing to ask and fails it as turned off.
                self.jobs.update(job_id, stage="queued", attempts=max(0, job.attempts - 1))
                return
            # Optional tags and the cover run while the file downloads. Tagging waits for them.
            side: asyncio.Task[None] | None = None
            if side_work_pending(job, folder):
                (folder / "side.json").unlink(missing_ok=True)
                (folder / "wait-side").write_bytes(b"")
                side = asyncio.create_task(self.side_metadata(job.id, folder))
            try:
                ready, info = await self.worker(self.jobs.get(job_id), folder)
                if side is not None:
                    await side
                    side = None
                await self.finish(self.jobs.get(job_id), ready, info)
            finally:
                leftover = side
                side = None
                if leftover is not None:
                    if not leftover.done():
                        leftover.cancel()
                    try:
                        await leftover
                    except (Exception, asyncio.CancelledError):
                        pass
            # The worker may have matched on the backup source, so the site that just worked is
            # the job's source now, not the one it started with.
            downloaded = self.jobs.get(job_id).source
            if downloaded == "youtube":
                self.store.record_probe(
                    "healthy", 0, "Last YouTube download completed", source="youtube"
                )
            with self.store.lock:
                self.store.db.execute(
                    "UPDATE source_control SET blocking_failures=0 WHERE source=?", (downloaded,)
                )
        except asyncio.CancelledError:
            await self.stop_process(job_id)
            job = self.jobs.get(job_id)
            # Publication is the commit point. Cancellation cannot silently delete a finished file.
            if (
                job.final_path
                and Path(job.final_path).is_file()
                and job.artifact_hash
                and await asyncio.to_thread(digest, Path(job.final_path)) == job.artifact_hash
            ):
                self.jobs.update(job_id, stage="queued", desired="run")
            elif job.desired == "cancel":
                self.cleanup(job)
                self.jobs.update(job_id, stage="cancelled", speed=0, eta=None)
            else:
                self.jobs.update(
                    job_id,
                    stage="queued" if job.desired == "run" else "paused",
                    speed=0,
                    eta=None,
                )
        except Exception as exc:
            await self.stop_process(job_id)
            if isinstance(exc, DownloadError):
                error = exc
            elif isinstance(exc, CatalogError):
                error = DownloadError("CATALOG_FAILED", exc.detail, exc.status in {429, 502, 504})
            elif isinstance(exc, TimeoutError):
                error = DownloadError("TIMEOUT", "The download stage timed out", True)
            elif isinstance(exc, OSError):
                code = (
                    "DISK_FULL"
                    if exc.errno == errno.ENOSPC
                    else "DEST_UNWRITABLE"
                    if exc.errno in {errno.EACCES, errno.EROFS}
                    else "MOVE_FAILED"
                )
                error = DownloadError(
                    code, f"File operation failed: {exc.strerror or type(exc).__name__}"
                )
            else:
                error = DownloadError("INTERNAL_ERROR", f"Download failed: {type(exc).__name__}")
            job = self.jobs.get(job_id)
            settings = self.settings()
            retry = error.retryable and job.attempts < settings.max_attempts
            delay = random.uniform(
                0,
                min(
                    settings.retry_cap_seconds,
                    settings.retry_base_seconds * 2 ** max(0, job.attempts - 1),
                ),
            )
            hint = error.hint or error_guidance(error.code, site_label(job.source))[0]
            fix = error.fix or error_guidance(error.code, site_label(job.source))[1]
            self.jobs.update(
                job_id,
                stage="retry_wait" if retry else "failed",
                error_code=error.code,
                error=error.detail,
                retryable=error.retryable,
                error_hint=hint,
                error_fix=fix,
                retry_at=time.time() + delay if retry else 0,
                speed=0,
                eta=None,
            )
            if not retry and job.batch_id and settings.navidrome_mode == "api":
                published = next(
                    (
                        row
                        for row in self.jobs.list()
                        if row.batch_id == job.batch_id and row.stage == "done" and row.final_path
                    ),
                    None,
                )
                if published:
                    warning = await self.navidrome(job, Path(published.final_path))
                    if warning:
                        self.jobs.update(job.id, warnings=[*job.warnings, warning])
            # The worker names the source on the error. A block already counted this run is skipped.
            if error.code in BLOCKING_CODES:
                self.note_block(job_id, job.source, error.detail)
        finally:
            self.noted_blocks.pop(job_id, None)
            self.processes.pop(job_id, None)
            self.running.pop(job_id, None)
            self.wake.set()
