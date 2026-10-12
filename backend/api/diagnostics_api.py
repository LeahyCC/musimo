import asyncio
import os
import shutil
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import cast

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from backend.core.errors import shown_health
from backend.core.sources import listed_sources
from backend.core.store import Store
from backend.integrations import deezer_cookie
from backend.integrations.catalog import Catalog, CatalogError
from backend.jobs.downloads import Downloads
from backend.library.index import Library
from backend.library.player import Player
from backend.version import VERSION


def install_diagnostics_routes(
    app: FastAPI,
    data: Path,
    started: float,
    get_versions: Callable[[], dict[str, str]],
    get_store: Callable[[], Store],
    get_catalog: Callable[[], Catalog],
    get_library: Callable[[], Library],
    get_downloads: Callable[[], Downloads],
    get_player: Callable[[], Player],
    notify: Callable[[], None],
) -> None:
    probe_lock = asyncio.Lock()
    last_probe = 0.0
    player_cache: dict[str, object] | None = None
    player_cache_time = 0.0

    @app.get("/api/health")
    async def health() -> dict[str, object]:
        get_store().bounds()
        return {
            "status": "ok",
            "version": VERSION,
            "uptime_seconds": round(time.monotonic() - started, 2),
            "phase": 3,
        }

    @app.get("/api/diagnostics")
    async def diagnostics() -> dict[str, object]:
        nonlocal player_cache, player_cache_time
        store, downloads, player = get_store(), get_downloads(), get_player()
        roots = os.getenv("MUSIMO_LIBRARY_ROOTS", "/music").split(os.pathsep)
        disks: list[dict[str, object]] = []
        for root in [str(data), *roots]:
            try:
                usage = await asyncio.to_thread(shutil.disk_usage, root)
                disks.append(
                    {
                        "path": root,
                        "free_bytes": usage.free,
                        "total_bytes": usage.total,
                        "exists": True,
                        "writable": os.access(root, os.W_OK),
                    }
                )
            except OSError:
                disks.append(
                    {
                        "path": root,
                        "exists": False,
                        "writable": False,
                        "free_bytes": None,
                        "total_bytes": None,
                    }
                )

        # Capabilities only stat the music folders. Keep the answer for 30 seconds.
        player_result = None
        if player:
            now = time.monotonic()
            if player_cache is None or now - player_cache_time > 30:
                player_result = await player.capabilities()
                player_cache = player_result
                player_cache_time = now
            else:
                player_result = player_cache

        first, latest = store.bounds()
        saved = store.current()
        return {
            "health": await health(),
            "versions": get_versions(),
            "disks": disks,
            "sources": [shown_health(row) for row in store.source_health()],
            "events": store.activity()["events"],
            "database": {
                "mode": "wal",
                "schema": 3,
                "retained_events": latest - first + 1 if first else 0,
            },
            "library": get_library().status(),
            "queue": downloads.controls(),
            "capabilities": {"settings": True, "events": True, "search": True, "downloads": True},
            "player": player_result,
            "last_download": downloads.last_terminal_job(),
            "deezer_audio": bool(saved.deezer_audio and deezer_cookie.saved(data)),
            "download_sources": listed_sources(),
        }

    @app.post("/api/diagnostics/test/destination")
    async def test_destination() -> dict[str, object]:
        settings_dict = get_store().settings()
        dest_field = cast(dict[str, object], settings_dict["destination"])
        destination = str(dest_field["value"])
        t0 = time.monotonic()
        try:
            dest_path = Path(destination)
            if not dest_path.exists():
                return {
                    "success": False,
                    "error": "Destination directory does not exist",
                    "elapsed_ms": round((time.monotonic() - t0) * 1000, 1),
                }
            test_dir = dest_path / ".musimo"
            test_dir.mkdir(parents=False, exist_ok=True)
            test_file = test_dir / f"write-test-{uuid.uuid4()}.tmp"
            await asyncio.to_thread(test_file.write_text, "test", encoding="utf-8")
            await asyncio.to_thread(test_file.unlink)
            return {
                "success": True,
                "error": None,
                "elapsed_ms": round((time.monotonic() - t0) * 1000, 1),
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "elapsed_ms": round((time.monotonic() - t0) * 1000, 1),
            }

    @app.post("/api/diagnostics/test/deezer")
    async def test_deezer() -> dict[str, object]:
        nonlocal last_probe
        async with probe_lock:
            if time.monotonic() - last_probe < 5:
                raise HTTPException(
                    429,
                    "Please wait five seconds before testing again",
                    headers={"Retry-After": "5"},
                )
            last_probe = time.monotonic()
            t0 = time.monotonic()
            status, detail = "healthy", "Keyless catalog responded"
            try:
                async with asyncio.timeout(3):
                    payload, _ = await get_catalog().get("track/3135556", fresh=True)
                    if payload.get("id") != 3135556:
                        status, detail = "error", "Catalog returned an unexpected response"
            except (CatalogError, TimeoutError):
                status, detail = "error", "Catalog request failed or timed out; try again"
            result = get_store().record_probe(
                status, round((time.monotonic() - t0) * 1000, 1), detail
            )
            notify()
            return result

    @app.get("/api/diagnostics/export")
    async def export() -> JSONResponse:
        return JSONResponse(
            await diagnostics(),
            headers={"Content-Disposition": 'attachment; filename="musimo-diagnostics.json"'},
        )
