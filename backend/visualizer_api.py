import asyncio
import gzip
import hashlib
import json
import os
import signal
import sqlite3
import sys
import time
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException

from backend.navidrome import Navidrome
from backend.player_api import checked_id


class VisualizerAnalysis:
    """One bounded worker and a private feature cache, independent of download jobs."""

    def __init__(self, root: Path, get: Callable[[], Navidrome]) -> None:
        self.root = root / "visualizer"
        self.root.mkdir(parents=True, exist_ok=True)
        for pattern in ("*.media", "*.writing"):
            for temporary in self.root.glob(pattern):
                temporary.unlink(missing_ok=True)
        self.get = get
        self.db = sqlite3.connect(self.root / "index.sqlite3")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS maps "
            "(id TEXT PRIMARY KEY, identity TEXT, state TEXT, filename TEXT, updated REAL)"
        )
        self.db.execute("UPDATE maps SET state='failed' WHERE state IN ('queued','analysing')")
        self.db.commit()
        self.queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=8)
        self.task: asyncio.Task[None] | None = None
        self.process: asyncio.subprocess.Process | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self.work())

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        self.db.close()

    def status(self, item_id: str) -> dict[str, object]:
        row = self.db.execute("SELECT state,filename FROM maps WHERE id=?", (item_id,)).fetchone()
        if not row:
            return {"status": "missing"}
        if row[0] == "ready":
            try:
                with gzip.open(self.root / row[1], "rt", encoding="utf-8") as stream:
                    data: object = json.load(stream)
                return {"status": "ready", "map": data}
            except (OSError, ValueError):
                return {"status": "failed"}
        return {"status": row[0]}

    async def request(self, item_id: str) -> dict[str, object]:
        payload = await self.get().response("getSong", {"id": item_id})
        song = payload.get("song")
        if not isinstance(song, dict):
            raise HTTPException(404, "Track is unavailable")
        duration = song.get("duration", 0)
        if isinstance(duration, (int, float)) and duration > 1800:
            return {
                "status": "failed",
                "detail": "Live visuals are available for recordings over 30 minutes",
            }
        fingerprint = json.dumps(
            [
                self.get().settings().navidrome_url,
                item_id,
                [
                    song.get(field)
                    for field in ("changed", "created", "duration", "size", "suffix", "bitRate")
                ],
                1,
            ],
            sort_keys=True,
        )
        identity = hashlib.sha256(fingerprint.encode()).hexdigest()
        row = self.db.execute(
            "SELECT identity,state,updated FROM maps WHERE id=?", (item_id,)
        ).fetchone()
        if (
            row
            and row[0] == identity
            and (
                row[1] in ("queued", "analysing")
                or (row[1] == "ready" and time.time() - row[2] < 86400)
            )
        ):
            cached = self.status(item_id)
            if cached["status"] != "failed":
                return cached
        if self.queue.full():
            raise HTTPException(429, "Song analysis is busy; live visuals remain available")
        self.db.execute(
            "INSERT OR REPLACE INTO maps VALUES (?,?,?,?,?)",
            (item_id, identity, "queued", "", time.time()),
        )
        self.db.commit()
        self.queue.put_nowait((item_id, identity))
        return {"status": "queued"}

    async def work(self) -> None:
        while True:
            item_id, identity = await self.queue.get()
            source = self.root / f"{identity}.media"
            output: Path | None = None
            try:
                self.db.execute(
                    "UPDATE maps SET state='analysing' WHERE id=? AND identity=?",
                    (item_id, identity),
                )
                self.db.commit()
                digest = hashlib.sha256(b"musimo-map-v1")
                async with asyncio.timeout(180):
                    response = await self.get().media("stream", item_id, "")
                    try:
                        size = 0
                        with source.open("wb") as stream:
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > 256 * 1024 * 1024:
                                    raise ValueError("Recording exceeds analysis size limit")
                                digest.update(chunk)
                                stream.write(chunk)
                    finally:
                        await response.aclose()
                output = self.root / f"{digest.hexdigest()}.json.gz"
                if not output.exists():
                    environment = {
                        **os.environ,
                        "NUMBA_NUM_THREADS": "1",
                        "OPENBLAS_NUM_THREADS": "1",
                        "OMP_NUM_THREADS": "1",
                        "NUMBA_CACHE_DIR": str(self.root / "numba"),
                    }
                    self.process = await asyncio.create_subprocess_exec(
                        sys.executable,
                        "-m",
                        "backend.visualizer_worker",
                        str(source),
                        str(output),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                        env=environment,
                        start_new_session=sys.platform != "win32",
                    )
                    await asyncio.wait_for(self.process.wait(), timeout=240)
                    if self.process.returncode != 0 or not output.exists():
                        raise ValueError("Could not analyse this recording")
                self.db.execute(
                    "UPDATE maps SET state='ready',filename=?,updated=? WHERE id=? AND identity=?",
                    (output.name, time.time(), item_id, identity),
                )
                self.db.commit()
                self.evict()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.db.execute(
                    "UPDATE maps SET state='failed',updated=? WHERE id=? AND identity=?",
                    (time.time(), item_id, identity),
                )
                self.db.commit()
            finally:
                if self.process and self.process.returncode is None:
                    # The worker owns FFmpeg too. Stop the whole group on container shutdown.
                    try:
                        if sys.platform == "win32":
                            cleanup = await asyncio.create_subprocess_exec(
                                "taskkill",
                                "/PID",
                                str(self.process.pid),
                                "/T",
                                "/F",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            await cleanup.wait()
                        else:
                            os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await self.process.wait()
                self.process = None
                source.unlink(missing_ok=True)
                if output:
                    output.with_suffix(".writing").unlink(missing_ok=True)
                self.queue.task_done()

    def evict(self) -> None:
        files = sorted(
            self.root.glob("*.json.gz"), key=lambda item: item.stat().st_mtime, reverse=True
        )
        size = 0
        for path in files:
            size += path.stat().st_size
            if size > 128 * 1024 * 1024:
                self.db.execute("DELETE FROM maps WHERE filename=?", (path.name,))
                path.unlink()
        self.db.commit()


def install_visualizer_routes(app: FastAPI, get: Callable[[], VisualizerAnalysis]) -> None:
    @app.post("/api/visualizer/analysis/{item_id}")
    async def request_analysis(item_id: str) -> dict[str, object]:
        return await get().request(checked_id(item_id))

    @app.get("/api/visualizer/analysis/{item_id}")
    async def analysis_status(item_id: str) -> dict[str, object]:
        return get().status(checked_id(item_id))
