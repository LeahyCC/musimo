"""Resolve a complete artist album selection before creating any queue jobs."""

import asyncio
import uuid
from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.catalog import Album, Artist, CatalogError, Result, safe_media
from backend.downloads import Downloads
from backend.job_models import Format


class ArtistBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    artist_id: int = Field(gt=0)
    album_ids: list[int] = Field(min_length=1, max_length=1000)
    missing_only: bool = True
    format: Format | None = None
    target: str | None = None


class ArtistDownloads:
    def __init__(self, downloads: Downloads) -> None:
        self.downloads = downloads

    async def albums(self, artist_id: int) -> list[Album]:
        catalog = self.downloads.catalog
        albums: dict[int, Album] = {}
        for index in range(0, 10000, 50):
            raw, _ = await catalog.get(
                f"artist/{artist_id}/albums?limit=50&index={index}", 86400, background=True
            )
            entries = raw.get("data", [])
            if not isinstance(entries, list):
                raise CatalogError("Artist album list unavailable")
            for entry in entries:
                album = Album.model_validate(entry)
                if album.record_type == "album":
                    albums[album.id] = album
            if not raw.get("next"):
                return list(albums.values())
            if len(entries) != 50:
                raise CatalogError("Artist album list was incomplete. Retry before downloading.")
        raise CatalogError(
            "Artist catalog is too large for one batch. Download albums individually.", 413
        )

    async def detail(self, album: Album) -> dict[str, object]:
        result = await self.downloads.catalog.album_detail(album.id, background=True)
        if result.get("complete") is not True:
            raise CatalogError("Incomplete track list; retry before downloading this album")
        raw = result.get("tracks", [])
        tracks = [Result.model_validate(row) for row in raw] if isinstance(raw, list) else []
        self.downloads.library.annotate(tracks)
        return {
            "id": album.id,
            "title": album.title,
            "art": safe_media(album.cover_medium),
            "year": album.release_date[:4],
            "tracks": [
                {"id": track.id, "duration": track.duration, "owned": track.ownership == "owned"}
                for track in tracks
            ],
            "error": "",
        }

    async def plan(self, artist_id: int) -> dict[str, object]:
        albums = await self.albums(artist_id)
        slots = asyncio.Semaphore(4)

        async def one(album: Album) -> dict[str, object]:
            async with slots:
                try:
                    return await self.detail(album)
                except (CatalogError, TimeoutError) as exc:
                    return {
                        "id": album.id,
                        "title": album.title,
                        "art": safe_media(album.cover_medium),
                        "year": album.release_date[:4],
                        "tracks": [],
                        "error": exc.detail
                        if isinstance(exc, CatalogError)
                        else "Album lookup timed out",
                    }

        return {"albums": await asyncio.gather(*(one(album) for album in albums))}

    async def enqueue(self, request: ArtistBatchRequest) -> dict[str, object]:
        service = self.downloads
        settings = service.settings()
        target = service.target(request.target or settings.destination)
        service.check_destination(target)
        available = {album.id: album for album in await self.albums(request.artist_id)}
        selected = list(dict.fromkeys(request.album_ids))
        if any(album_id not in available for album_id in selected):
            raise ValueError("Choose albums from this artist's catalog")
        # Resolve every selected album first: a failed lookup must not enqueue half a selection.
        ids: set[int] = set()
        wanted: list[int] = []
        album_tracks: dict[int, list[int]] = {}
        owned = 0
        queued = 0
        format = request.format or settings.output_format
        active = {
            job.track_id
            for job in service.jobs.list(active=True)
            if job.format == format and job.target == str(target)
        }
        for album_id in selected:
            detail = await self.detail(available[album_id])
            tracks = detail["tracks"]
            assert isinstance(tracks, list)
            before = len(wanted)
            for raw in tracks:
                assert isinstance(raw, dict)
                track_id = int(raw["id"])
                if track_id in ids:
                    continue
                ids.add(track_id)
                if request.missing_only and raw["owned"]:
                    owned += 1
                elif track_id in active:
                    queued += 1
                else:
                    wanted.append(track_id)
            album_tracks[album_id] = wanted[before:]
        person, _ = await service.catalog.get(f"artist/{request.artist_id}", 86400, background=True)
        name = Artist.model_validate(person).name
        # Recheck active work after the awaited lookups; inserting the selection is one transaction.
        active = {
            job.track_id
            for job in service.jobs.list(active=True)
            if job.format == format and job.target == str(target)
        }
        queued += sum(track_id in active for track_id in wanted)
        wanted = [track_id for track_id in wanted if track_id not in active]
        batch_id = uuid.uuid4().hex
        jobs = service.jobs.enqueue_many(wanted, format, str(target), batch_id, f"{name} · albums")
        owned += sum(job.stage == "done" for job in jobs)
        jobs = [job for job in jobs if job.stage != "done"]
        remaining = {job.track_id for job in jobs}
        albums_added = sum(bool(remaining.intersection(ids)) for ids in album_tracks.values())
        return {
            "id": batch_id,
            "jobs": [job.public() for job in jobs],
            "albums": albums_added,
            "skipped_owned": owned,
            "skipped_queued": queued,
        }


def install_artist_download_routes(app: FastAPI, get: Callable[[], Downloads]) -> None:
    @app.get("/api/artists/{artist_id}/download-plan")
    async def plan(artist_id: int) -> dict[str, object]:
        if artist_id <= 0:
            raise HTTPException(422, "Invalid artist ID")
        try:
            async with asyncio.timeout(120):
                return await ArtistDownloads(get()).plan(artist_id)
        except TimeoutError as exc:
            raise HTTPException(
                504, "Album checks timed out. Retry to continue from cached results."
            ) from exc

    @app.post("/api/artist-batches")
    async def enqueue(request: ArtistBatchRequest) -> dict[str, object]:
        try:
            async with asyncio.timeout(120):
                return await ArtistDownloads(get()).enqueue(request)
        except TimeoutError as exc:
            raise HTTPException(504, "Album checks timed out. Nothing was queued; retry.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
