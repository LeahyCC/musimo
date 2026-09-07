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
from functools import partial
from pathlib import Path

import httpx

from backend.catalog import Catalog, CatalogError
from backend.enrichment import Enrichment
from backend.job_models import TERMINAL, Job
from backend.job_store import Jobs
from backend.library import Library
from backend.models import Settings
from backend.naming import Naming
from backend.store import Store


class DownloadError(Exception):
    def __init__(self, code: str, detail: str, retryable: bool = False) -> None:
        self.code, self.detail, self.retryable = code, detail, retryable


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


class Downloads:
    def __init__(
        self, store: Store, catalog: Catalog, library: Library, changed: asyncio.Event
    ) -> None:
        self.store, self.catalog, self.library, self.changed = store, catalog, library, changed
        self.wake = asyncio.Event()
        self.jobs = Jobs(store, self.notify)
        self.enrichment = Enrichment(catalog)
        self.running: dict[str, asyncio.Task[None]] = {}
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.stopping = False
        self.task: asyncio.Task[None] | None = None

    def notify(self) -> None:
        self.changed.set()
        self.wake.set()

    def settings(self) -> Settings:
        with self.store.lock:
            rows = self.store.db.execute("SELECT key,value FROM settings").fetchall()
        return Settings.model_validate({row[0]: json.loads(row[1]) for row in rows})

    def controls(self) -> dict[str, bool]:
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT paused,source_paused FROM queue_control WHERE id=1"
            ).fetchone()
        return {"paused": bool(row[0]), "source_paused": bool(row[1])}

    def set_controls(self, paused: bool | None = None, source_paused: bool | None = None) -> None:
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                if paused is not None:
                    self.store.db.execute(
                        "UPDATE queue_control SET paused=? WHERE id=1", (int(paused),)
                    )
                if source_paused is not None:
                    self.store.db.execute(
                        "UPDATE queue_control SET source_paused=?,blocking_failures=0 WHERE id=1",
                        (int(source_paused),),
                    )
                self.store._event("queue.updated", self.controls())
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.notify()

    def target(self, raw: str) -> Path:
        path = Path(raw).resolve()
        if path not in self.library.roots:
            raise ValueError("Choose a configured library mount")
        return path

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
            task.cancel()
        await asyncio.gather(*list(self.running.values()), return_exceptions=True)
        if self.task:
            await self.task

    async def schedule(self) -> None:
        while not self.stopping:
            self.wake.clear()
            control = self.controls()
            delay = 60.0
            if not control["paused"] and not control["source_paused"]:
                slots = self.settings().concurrency - len(self.running)
                for job in reversed(self.jobs.list(active=True)):
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
        if self.running.get(job_id) is task:
            self.running.pop(job_id, None)
            job = self.jobs.get(job_id)
            if job.stage in {"pausing", "cancelling"}:
                if job.desired == "cancel":
                    self.cleanup(job)
                self.jobs.update(job_id, stage="cancelled" if job.desired == "cancel" else "paused")
        self.wake.set()

    def command(self, job_id: str, action: str) -> Job:
        job = self.jobs.get(job_id)
        if action == "retry":
            if job.stage not in {"failed", "cancelled"}:
                raise ValueError("Only failed or cancelled jobs can be retried")
            self.check_destination(self.target(job.target))
            return self.jobs.update(
                job_id,
                stage="queued",
                desired="run",
                attempts=0,
                retry_at=0,
                error="",
                error_code="",
                hidden=False,
            )
        if action == "resume":
            if job.stage != "paused":
                raise ValueError("Only paused jobs can be resumed")
            return self.jobs.update(job_id, stage="queued", desired="run", retry_at=0)
        if action not in {"pause", "cancel"} or job.stage in TERMINAL:
            raise ValueError("This action is not available for the job")
        active = job_id in self.running
        stage = (
            ("pausing" if action == "pause" else "cancelling")
            if active
            else ("paused" if action == "pause" else "cancelled")
        )
        result = self.jobs.update(job_id, stage=stage, desired=action, speed=0, eta=None)
        if active:
            self.running[job_id].cancel()
        elif action == "cancel":
            self.cleanup(job)
        return result

    def cleanup(self, job: Job) -> None:
        folder = self.folder(job)
        if folder.is_dir():
            shutil.rmtree(folder)

    async def stop_process(self, job_id: str) -> None:
        process = self.processes.get(job_id)
        if process is None or process.returncode is not None:
            return
        try:
            if sys.platform == "win32":
                process.terminate()
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

    async def artwork(self, job: Job, folder: Path) -> None:
        if not job.meta.art or (folder / "cover.jpg").exists():
            return
        try:
            async with self.catalog.client.stream("GET", job.meta.art, timeout=5) as response:
                response.raise_for_status()
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 5 * 1024**2:
                        raise ValueError("Cover exceeded 5 MB")
                if chunks[:3] != b"\xff\xd8\xff":
                    raise ValueError("Expected JPEG artwork")
                (folder / "cover.jpg").write_bytes(chunks)
        except (httpx.HTTPError, ValueError):
            self.jobs.update(job.id, warnings=[*job.warnings, "Cover art unavailable"])

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
            limit=131072,
        )
        self.processes[job.id] = process
        ready: Path | None = None
        info: dict[str, object] = {}
        failure: DownloadError | None = None
        tail: list[str] = []
        assert process.stdout
        async with asyncio.timeout(600):
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
                elif kind == "error":
                    failure = DownloadError(
                        str(raw.get("code", "DOWNLOAD_FAILED")),
                        str(raw.get("message", "Worker failed")),
                        raw.get("retryable") is True,
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
        credentials = os.getenv("MUSIMO_NAVIDROME_CREDENTIALS_FILE", "")
        if not credentials or not settings.navidrome_url:
            return "Navidrome API credentials are not configured; file is saved"
        try:
            raw: object = json.loads(Path(credentials).read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("Invalid credentials")
            salt = os.urandom(12).hex()
            token = hashlib.md5(
                (str(raw.get("password", "")) + salt).encode(), usedforsecurity=False
            ).hexdigest()
            relative = scan_folder.relative_to(self.target(job.target)).as_posix()
            if relative == ".":
                relative = ""
            target = f"{settings.navidrome_library_id}:{relative}"
            response = await self.catalog.client.get(
                settings.navidrome_url.rstrip("/") + "/rest/startScan",
                params={
                    "u": str(raw.get("username", "")),
                    "t": token,
                    "s": salt,
                    "v": "1.16.1",
                    "c": "Musimo",
                    "f": "json",
                    "target": target,
                },
                timeout=4,
            )
            response.raise_for_status()
            data: object = response.json()
            body = data.get("subsonic-response", {}) if isinstance(data, dict) else {}
            if not isinstance(body, dict) or body.get("status") != "ok":
                raise ValueError("Scan refused")
        except (OSError, ValueError, httpx.HTTPError):
            return "Navidrome scan failed; file is saved. Check integration settings."
        return None

    async def finish(
        self, job: Job, ready: Path | None = None, info: dict[str, object] | None = None
    ) -> None:
        root = self.target(job.target)
        folder = self.folder(job)
        if ready:
            self.jobs.update(job.id, stage="moving", progress=1, speed=0, eta=None)
            filename = Naming().path(self.settings().naming_template, job.meta, ready.suffix[1:])
            target = root / filename
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
        await asyncio.to_thread(self.library.index, target, root, self.library.generation)
        self.library.publish()
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
                stage="matching",
                attempts=job.attempts + 1,
                error_code="",
                error="",
                retryable=False,
                retry_at=0,
            )
            if not job.meta.artist:
                async with asyncio.timeout(15):
                    meta = await self.enrichment.track(job.track_id)
                    warnings = await self.enrichment.extra(meta)
                job = self.jobs.update(job_id, meta=meta.model_dump(), warnings=warnings)
            await self.artwork(job, folder)
            ready, info = await self.worker(self.jobs.get(job_id), folder)
            await self.finish(self.jobs.get(job_id), ready, info)
            self.store.record_probe(
                "healthy", 0, "Last YouTube download completed", source="youtube"
            )
            with self.store.lock:
                self.store.db.execute("UPDATE queue_control SET blocking_failures=0 WHERE id=1")
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
                    stage="queued" if self.stopping and job.desired == "run" else "paused",
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
            self.jobs.update(
                job_id,
                stage="retry_wait" if retry else "failed",
                error_code=error.code,
                error=error.detail,
                retryable=error.retryable,
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
            if error.code in {
                "SOURCE_BLOCKED",
                "POT_MISSING",
                "JS_RUNTIME_MISSING",
                "COOKIES_EXPIRED",
            }:
                with self.store.lock:
                    self.store.db.execute(
                        "UPDATE queue_control SET blocking_failures=blocking_failures+1 WHERE id=1"
                    )
                    failures = self.store.db.execute(
                        "SELECT blocking_failures FROM queue_control WHERE id=1"
                    ).fetchone()[0]
                if failures >= 3:
                    self.set_controls(source_paused=True)
                self.store.record_probe("blocked", 0, error.detail, source="youtube")
        finally:
            self.processes.pop(job_id, None)
            self.running.pop(job_id, None)
            self.wake.set()
