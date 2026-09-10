import asyncio
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from backend.activity_api import install_activity_routes
from backend.artist_downloads import install_artist_download_routes
from backend.catalog import Catalog, CatalogError
from backend.download_api import install_download_routes
from backend.downloads import Downloads
from backend.library import Library
from backend.models import SettingsPatch
from backend.navidrome import Navidrome
from backend.player_api import install_player_routes
from backend.search_api import install_search_routes
from backend.store import LockedSetting, Store
from backend.version import VERSION

LIBRARY_ITEM = r"[A-Za-z0-9._:-]{1,200}"
LIBRARY_SPA_PATH = re.compile(
    rf"^library/(?:(?:albums|playlists)(?:/{LIBRARY_ITEM})?|tracks|"
    rf"artists(?:/{LIBRARY_ITEM}(?:/(?:albums/{LIBRARY_ITEM}|songs))?)?)$"
)


def runtime_versions() -> dict[str, str]:
    versions = {"Musimo": VERSION, "Python": platform.python_version()}
    for package in ("fastapi", "uvicorn", "yt-dlp", "yt-dlp-ejs", "bgutil-ytdlp-pot-provider"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "not installed"
    for binary in ("ffmpeg", "deno", "fpcalc"):
        try:
            result = subprocess.run(
                [binary, "-version" if binary != "deno" else "--version"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            versions[binary] = (result.stdout or result.stderr).splitlines()[0][:140]
        except (OSError, subprocess.TimeoutExpired, IndexError):
            versions[binary] = "unavailable"
    return versions


def create_app(data_dir: Path | None = None, static_dir: Path | None = None) -> FastAPI:
    data = data_dir or Path(os.getenv("MUSIMO_DATA_DIR", "/data"))
    static = static_dir or Path(os.getenv("MUSIMO_STATIC_DIR", "/app/frontend/dist"))
    started = time.monotonic()
    changed = asyncio.Event()
    probe_lock = asyncio.Lock()
    last_probe = 0.0
    navidrome_cache: dict[str, object] | None = None
    navidrome_cache_time = 0.0
    versions: dict[str, str] = {}
    store: Store
    catalog: Catalog
    library: Library
    downloads: Downloads
    navidrome: Navidrome

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal store, versions, catalog, library, downloads, navidrome
        store = Store(data / "musimo.sqlite3")
        versions = await asyncio.to_thread(runtime_versions)
        async with (
            httpx.AsyncClient(
                timeout=2.2, follow_redirects=False, headers={"User-Agent": f"Musimo/{VERSION}"}
            ) as client,
            httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5, read=30, write=5, pool=5),
                follow_redirects=False,
                headers={"User-Agent": f"Musimo/{VERSION}"},
            ) as navidrome_http,
        ):
            catalog = Catalog(store, client)
            navidrome = Navidrome(store, navidrome_http)
            roots = [
                Path(root).resolve()
                for root in os.getenv("MUSIMO_LIBRARY_ROOTS", "/music").split(os.pathsep)
                if root
            ]
            library = Library(store, roots, changed)
            library.start()
            downloads = Downloads(store, catalog, library, changed, navidrome)
            downloads.start()
            try:
                yield
            finally:
                await downloads.close()
                await library.close()
                store.close()

    app = FastAPI(title="Musimo", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    install_search_routes(app, lambda: catalog, lambda: library)
    install_activity_routes(app, lambda: store, changed.set)
    install_download_routes(app, lambda: downloads)
    install_artist_download_routes(app, lambda: downloads)
    install_player_routes(app, lambda: navidrome)

    @app.middleware("http")
    async def same_origin(request: Request, call_next: RequestResponseEndpoint) -> Response:
        # LAN applications still need CSRF protection against pages opened elsewhere in the browser.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if request.headers.get("sec-fetch-site") == "cross-site" or (
                origin is not None
                and (
                    urlsplit(origin).netloc != request.headers.get("host")
                    or urlsplit(origin).scheme != request.url.scheme
                )
            ):
                return JSONResponse(
                    {"detail": "Cross-origin writes are not allowed"}, status_code=403
                )
            if (
                request.method == "PATCH"
                and request.headers.get("content-type", "").split(";")[0] != "application/json"
            ):
                return JSONResponse({"detail": "Use application/json"}, status_code=415)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; "
            "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    async def health() -> dict[str, object]:
        store.bounds()
        return {
            "status": "ok",
            "version": VERSION,
            "uptime_seconds": round(time.monotonic() - started, 2),
            "phase": 3,
        }

    @app.get("/api/settings")
    async def settings() -> dict[str, object]:
        return store.settings()

    @app.patch("/api/settings")
    async def save_settings(patch: SettingsPatch) -> dict[str, object]:
        changes = patch.model_dump(exclude_unset=True)
        if None in changes.values():
            raise HTTPException(422, "Setting values cannot be null")
        try:
            if "destination" in changes:
                dest = str(changes["destination"])
                downloads.target(dest)
                if not os.access(dest, os.W_OK):
                    raise HTTPException(
                        422, "Destination must be writable. Read-only mounts cannot be used."
                    )
            result = store.update(changes)
        except LockedSetting as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValidationError as exc:
            raise HTTPException(422, "Invalid settings") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        changed.set()
        return result

    @app.get("/api/snapshot")
    async def snapshot() -> dict[str, object]:
        return store.snapshot()

    @app.get("/api/events")
    async def events(request: Request, after: int = Query(default=0, ge=0)) -> StreamingResponse:
        raw = request.headers.get("last-event-id", str(after))
        try:
            cursor = int(raw)
            if cursor < 0:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(400, "Invalid event cursor") from exc

        async def stream() -> AsyncIterator[str]:
            nonlocal cursor
            yield "retry: 1000\n\n"
            while not await request.is_disconnected():
                # Clear before reading rows so writes during the next await remain signalled.
                changed.clear()
                first, latest = store.bounds()
                if cursor > latest or (first > 0 and cursor < first - 1):
                    yield f"event: reset\ndata: {json.dumps({'cursor': latest})}\n\n"
                    return
                rows = store.events(cursor)
                if rows:
                    for row in rows:
                        cursor = int(str(row["id"]))
                        yield f"id: {cursor}\nevent: change\ndata: {json.dumps(row)}\n\n"
                    continue
                try:
                    await asyncio.wait_for(changed.wait(), timeout=15)
                except TimeoutError:
                    yield ": heartbeat\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-transform"},
        )

    @app.get("/api/diagnostics")
    async def diagnostics() -> dict[str, object]:
        nonlocal navidrome_cache, navidrome_cache_time
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

        # Cache Navidrome capabilities for 30 seconds to avoid repeated pings
        navidrome_result = None
        if navidrome:
            now = time.monotonic()
            if navidrome_cache is None or now - navidrome_cache_time > 30:
                navidrome_result = await navidrome.capabilities()
                navidrome_cache = navidrome_result
                navidrome_cache_time = now
            else:
                navidrome_result = navidrome_cache

        first, latest = store.bounds()
        return {
            "health": await health(),
            "versions": versions,
            "disks": disks,
            "sources": store.source_health(),
            "events": store.activity()["events"],
            "database": {
                "mode": "wal",
                "schema": 3,
                "retained_events": latest - first + 1 if first else 0,
            },
            "library": library.status(),
            "queue": downloads.controls(),
            "capabilities": {"settings": True, "events": True, "search": True, "downloads": True},
            "navidrome": navidrome_result,
            "last_download": downloads.last_terminal_job(),
        }

    @app.post("/api/diagnostics/test/destination")
    async def test_destination() -> dict[str, object]:
        settings_dict = store.settings()
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
                    payload, _ = await catalog.get("track/3135556", fresh=True)
                    if payload.get("id") != 3135556:
                        status, detail = "error", "Catalog returned an unexpected response"
            except (CatalogError, TimeoutError):
                status, detail = "error", "Catalog request failed or timed out; try again"
            result = store.record_probe(status, round((time.monotonic() - t0) * 1000, 1), detail)
            changed.set()
            return result

    @app.get("/api/diagnostics/export")
    async def export() -> JSONResponse:
        return JSONResponse(
            await diagnostics(),
            headers={"Content-Disposition": 'attachment; filename="musimo-diagnostics.json"'},
        )

    if (static / "assets").exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

    # Public files come from the build, never from a path assembled from request input.
    public_files = {
        file.name: file
        for file in (static.iterdir() if static.is_dir() else [])
        if file.is_file() and file.resolve().is_relative_to(static.resolve())
    }

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def spa(path: str) -> FileResponse:
        if candidate := public_files.get(path):
            return FileResponse(
                candidate,
                media_type="application/manifest+json"
                if candidate.suffix == ".webmanifest"
                else None,
            )
        if (
            path
            not in (
                "",
                "search",
                "library",
                "now-playing",
                "downloads",
                "settings",
                "diagnostics",
            )
            and not (path.startswith(("albums/", "artists/")) and path.split("/")[-1].isdigit())
            and not LIBRARY_SPA_PATH.fullmatch(path)
        ) or not (static / "index.html").is_file():
            raise HTTPException(404, "Not found")
        return FileResponse(static / "index.html")

    return app


app = create_app()
