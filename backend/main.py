import asyncio
import contextlib
import importlib.metadata
import os
import platform
import re
import subprocess
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from backend.api.activity_api import install_activity_routes
from backend.api.artist_download_api import install_artist_download_routes
from backend.api.audio_worker_api import install_audio_worker_routes
from backend.api.diagnostics_api import install_diagnostics_routes
from backend.api.download_api import install_download_routes
from backend.api.events_api import install_event_routes
from backend.api.link_api import install_link_routes
from backend.api.music_bot_api import install_music_bot_routes
from backend.api.player_api import install_player_routes
from backend.api.podcast_api import install_podcast_routes
from backend.api.search_api import install_search_routes
from backend.api.settings_api import install_settings_routes
from backend.api.waveform_api import install_waveform_routes
from backend.core.store import Store
from backend.integrations import deezer_cookie
from backend.integrations.catalog import Catalog
from backend.integrations.youtube_cookies import drop_copies as drop_youtube_cookie_copies
from backend.integrations.youtube_cookies import publish as publish_youtube_cookies
from backend.jobs.downloads import Downloads
from backend.jobs.links import Links
from backend.library.audio_profile import AudioProfiles
from backend.library.index import Library
from backend.library.music_bot import MusicBot
from backend.library.player import Player
from backend.library.waveform import WaveformService
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
    versions: dict[str, str] = {}
    store: Store
    catalog: Catalog
    library: Library
    downloads: Downloads
    links: Links
    player: Player
    waveforms: WaveformService
    music_bot: MusicBot
    profiles: AudioProfiles
    # Shared with the optional audio worker. Empty keeps its lease routes off.
    analysis_token = os.environ.get("MUSIMO_ANALYSIS_TOKEN", "")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal store, versions, catalog, library, downloads, links, player, waveforms
        nonlocal music_bot, profiles
        # Later tracks reuse the YouTube player script instead of fetching it again.
        os.environ["MUSIMO_YTDLP_CACHE"] = str(data / "ytdlp-cache")
        store = Store(data / "musimo.sqlite3")
        deezer_cookie.adopt(store, data)
        # The seed has done its job. Out of the environment, the link resolver, waveform and
        # ffmpeg children cannot inherit the cookie.
        os.environ.pop("MUSIMO_DEEZER_ARL", None)
        publish_youtube_cookies(data)
        drop_youtube_cookie_copies(data)
        versions = await asyncio.to_thread(runtime_versions)
        async with httpx.AsyncClient(
            timeout=2.2, follow_redirects=False, headers={"User-Agent": f"Musimo/{VERSION}"}
        ) as client:
            catalog = Catalog(store, client)
            roots = [
                Path(root).resolve()
                for root in os.getenv("MUSIMO_LIBRARY_ROOTS", "/music").split(os.pathsep)
                if root
            ]
            player = Player(store, roots, client)
            profiles = AudioProfiles(store)
            music_bot = MusicBot(store, player, client)
            waveforms = WaveformService(store, player)
            library = Library(store, roots, changed)
            library.start()
            downloads = Downloads(store, catalog, library, changed)
            downloads.start()
            # The first page would otherwise wait while this build reads the index.
            ready = asyncio.create_task(player.keep_ready())
            links = Links(downloads)
            try:
                yield
            finally:
                ready.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await ready
                await downloads.close()
                await library.close()
                store.close()

    app = FastAPI(title="Musimo", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    install_search_routes(app, lambda: catalog, lambda: library)
    install_activity_routes(app, lambda: store, changed.set)
    install_download_routes(app, lambda: downloads)
    install_artist_download_routes(app, lambda: downloads)
    install_player_routes(app, lambda: player)
    install_music_bot_routes(app, lambda: music_bot)
    install_audio_worker_routes(app, lambda: profiles, lambda: music_bot.busy, analysis_token)
    install_waveform_routes(app, lambda: waveforms)
    install_podcast_routes(app, lambda: downloads)
    install_link_routes(app, lambda: links)
    install_settings_routes(app, data, lambda: store, lambda: downloads, changed.set)
    install_event_routes(app, data, lambda: store, changed)
    install_diagnostics_routes(
        app,
        data,
        started,
        lambda: versions,
        lambda: store,
        lambda: catalog,
        lambda: library,
        lambda: downloads,
        lambda: player,
        changed.set,
    )

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
        # 'wasm-unsafe-eval' lets the visualizer compile its MilkDrop presets to WebAssembly. It
        # allows no JavaScript eval, and scripts still come from this origin only.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            "img-src 'self' https: data:; media-src 'self' https:; "
            "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
        )
        # Cover ids change with the image, so those responses may be cached.
        if request.url.path.startswith("/api/") and not request.url.path.startswith(
            "/api/player/art/"
        ):
            response.headers["Cache-Control"] = "no-store"
        return response

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
                "music-bot",
                "downloads",
                "settings",
                "settings/user",
                "diagnostics",
            )
            and not (
                path.startswith(("albums/", "artists/", "podcasts/"))
                and path.split("/")[-1].isdigit()
            )
            and not LIBRARY_SPA_PATH.fullmatch(path)
        ) or not (static / "index.html").is_file():
            raise HTTPException(404, "Not found")
        return FileResponse(static / "index.html")

    return app


app = create_app()
