import asyncio
import time
from collections.abc import Callable
from typing import Literal
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from backend.catalog import (
    Album,
    Artist,
    Catalog,
    CatalogError,
    Result,
    SearchPage,
    Track,
    safe_media,
)
from backend.library import Library, normalize


def install_search_routes(
    app: FastAPI, get_catalog: Callable[[], Catalog], get_library: Callable[[], Library]
) -> None:
    @app.exception_handler(CatalogError)
    async def catalog_error(_: object, exc: CatalogError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    @app.exception_handler(TimeoutError)
    async def timed_out(_: object, exc: TimeoutError) -> JSONResponse:
        return JSONResponse({"detail": "Catalog request timed out. Try again."}, status_code=504)

    @app.exception_handler(ValidationError)
    async def invalid_catalog(_: object, exc: ValidationError) -> JSONResponse:
        return JSONResponse(
            {"detail": "The catalog returned an unexpected format."}, status_code=502
        )

    @app.get("/api/search", response_model=SearchPage)
    async def search(
        response: Response,
        q: str = Query(min_length=2, max_length=200),
        kind: Literal["track", "album", "artist"] = "track",
        index: int = Query(default=0, ge=0, le=10000),
    ) -> SearchPage:
        if len(q.strip()) < 2:
            raise HTTPException(422, "Enter at least two characters")
        try:
            async with asyncio.timeout(2.5):
                timing: dict[str, float] = {}
                page = await get_catalog().search(q.strip(), kind, index, timing)
                started = time.perf_counter()
                page.items = get_library().annotate(page.items)
                timing["library"] = (time.perf_counter() - started) * 1000
                response.headers["Server-Timing"] = ", ".join(
                    f"{name};dur={timing.get(name, 0):.3f}"
                    for name in ("cache", "queue", "provider", "catalog", "library")
                )
                return page
        except TimeoutError as exc:
            raise HTTPException(504, "Search timed out. Retry this tab.") from exc

    @app.get("/api/album-years")
    async def years(ids: str = Query(max_length=1200)) -> dict[str, int | None]:
        try:
            album_ids = list(dict.fromkeys(int(value) for value in ids.split(",") if value))
        except ValueError as exc:
            raise HTTPException(422, "Invalid album IDs") from exc
        if len(album_ids) > 50 or any(value <= 0 for value in album_ids):
            raise HTTPException(422, "Choose up to 50 albums")
        result: dict[str, int | None] = {}

        async def one(album_id: int) -> None:
            try:
                async with get_catalog().background_slots:
                    payload, _ = await get_catalog().get(
                        f"album/{album_id}", 86400, background=True
                    )
                result[str(album_id)] = get_catalog().album(Album.model_validate(payload)).year
            except (CatalogError, ValidationError):
                result[str(album_id)] = None

        try:
            async with asyncio.timeout(12):
                await asyncio.gather(*(one(value) for value in album_ids))
        except TimeoutError:
            pass
        return result

    @app.get("/api/albums/{album_id}")
    async def album(album_id: int, background: bool = False) -> dict[str, object]:
        if album_id <= 0:
            raise HTTPException(422, "Invalid album ID")
        async with asyncio.timeout(15):
            if background:
                # Cards share the background budget so an album grid cannot starve search.
                async with get_catalog().background_slots:
                    detail = await get_catalog().album_detail(album_id, background=True)
            else:
                detail = await get_catalog().album_detail(album_id)
        raw_tracks = detail["tracks"]
        tracks = get_library().annotate(
            [Result.model_validate(track) for track in raw_tracks]
            if isinstance(raw_tracks, list)
            else []
        )
        item = Result.model_validate(detail["album"])
        item.owned_count = sum(track.ownership == "owned" for track in tracks)
        item.coverage_verified = detail["complete"] is True
        item.ownership = (
            "owned"
            if item.coverage_verified and tracks and item.owned_count == len(tracks)
            else "partial"
            if item.owned_count
            else "missing"
        )
        return detail | {
            "album": item.model_dump(),
            "tracks": [track.model_dump() for track in tracks],
        }

    @app.get("/api/artists/{artist_id}/top")
    async def artist_top(artist_id: int) -> dict[str, object]:
        if artist_id <= 0:
            raise HTTPException(422, "Invalid artist ID")
        catalog = get_catalog()
        async with asyncio.timeout(10):
            payload, _ = await catalog.get(f"artist/{artist_id}/top?limit=10", 3600)
        rows = payload.get("data", [])
        tracks = (
            [catalog.track(Track.model_validate(row)) for row in rows]
            if isinstance(rows, list)
            else []
        )
        return {"tracks": [track.model_dump() for track in get_library().annotate(tracks)]}

    @app.get("/api/artists/{artist_id}")
    async def artist(
        artist_id: int, index: int = Query(default=0, ge=0, le=10000)
    ) -> dict[str, object]:
        if artist_id <= 0:
            raise HTTPException(422, "Invalid artist ID")
        catalog = get_catalog()
        async with asyncio.timeout(10):
            (raw, _), (albums, _) = await asyncio.gather(
                catalog.get(f"artist/{artist_id}", 86400),
                catalog.get(f"artist/{artist_id}/albums?limit=50&index={index}", 86400),
            )
        person = Artist.model_validate(raw)
        rows = albums.get("data", [])
        items: list[Result] = []
        if isinstance(rows, list):
            for row in rows:
                source = Album.model_validate(row)
                source.artist = person
                items.append(catalog.album(source))
        return {
            "artist": {
                "id": person.id,
                "name": person.name,
                "art": safe_media(person.picture_medium),
            },
            "items": [item.model_dump() for item in get_library().annotate(items)],
            "next_index": index + len(items) if albums.get("next") and items else None,
        }

    @app.get("/api/preview/{track_id}")
    async def preview(track_id: int, fallback: bool = False) -> dict[str, str]:
        if track_id <= 0:
            raise HTTPException(422, "Invalid track ID")
        catalog = get_catalog()
        async with asyncio.timeout(8):
            payload, _ = await catalog.get(f"track/{track_id}", fresh=True)
            track = Track.model_validate(payload)
            direct = safe_media(track.preview)
            if direct and not fallback:
                return {"url": direct, "source": "Deezer"}
            await catalog.budget(itunes=True)
            try:
                response = await catalog.client.get(
                    "https://itunes.apple.com/search",
                    params={
                        "term": f"{track.artist.name} {track.title}",
                        "entity": "song",
                        "limit": 10,
                    },
                )
                response.raise_for_status()
                raw: object = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise CatalogError("Preview lookup failed. Try again.") from exc
        rows = raw.get("results", []) if isinstance(raw, dict) else []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                duration = row.get("trackTimeMillis", 0)
                if (
                    normalize(str(row.get("trackName", ""))) == normalize(track.title)
                    and normalize(str(row.get("artistName", ""))) == normalize(track.artist.name)
                    and isinstance(duration, (int, float))
                    and abs(duration / 1000 - track.duration) <= 3
                ):
                    url = safe_media(str(row.get("previewUrl", "")))
                    if url:
                        return {"url": url, "source": "iTunes"}
        return {"url": "", "source": "No preview"}

    @app.get("/api/preview/{track_id}/stream")
    async def preview_stream(track_id: int, fallback: bool = False) -> Response:
        # Web Audio silences cross-origin media without CORS, including later previews
        # on a previously connected element. Resolve IDs here instead of proxying user URLs.
        resolved = await preview(track_id, fallback)
        url = resolved["url"]
        if not url:
            raise HTTPException(404, "No preview available")
        try:
            async with (
                asyncio.timeout(25),
                httpx.AsyncClient(
                    timeout=httpx.Timeout(15, connect=5), follow_redirects=False
                ) as client,
            ):
                for _ in range(4):
                    parsed = urlsplit(url)
                    if (
                        not safe_media(url)
                        or parsed.username
                        or parsed.password
                        or parsed.port not in (None, 443)
                    ):
                        raise HTTPException(502, "Preview source is unavailable")
                    async with client.stream("GET", url) as response:
                        if response.is_redirect:
                            url = urljoin(url, response.headers.get("location", ""))
                            continue
                        response.raise_for_status()
                        mime = response.headers.get("content-type", "audio/mpeg").split(";")[0]
                        if not (mime.startswith("audio/") or mime == "application/octet-stream"):
                            raise HTTPException(502, "Preview source did not return audio")
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(content) + len(chunk) > 10 * 1024 * 1024:
                                raise HTTPException(502, "Preview is too large")
                            content.extend(chunk)
                        return Response(bytes(content), media_type=mime)
        except (httpx.HTTPError, TimeoutError, ValueError) as exc:
            raise HTTPException(502, "Preview could not be loaded") from exc
        raise HTTPException(502, "Preview source redirected too many times")

    @app.get("/api/library")
    async def library_status() -> dict[str, object]:
        return get_library().status()

    @app.post("/api/library/scan")
    async def scan() -> dict[str, object]:
        get_library().start_scan()
        return get_library().status()

    @app.post("/api/library/cancel")
    async def cancel() -> dict[str, object]:
        get_library().cancelled.set()
        return get_library().status()
