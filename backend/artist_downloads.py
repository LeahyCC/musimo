"""Resolve a complete artist album selection before creating any queue jobs."""

import asyncio
import uuid
from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.catalog import Album, Artist, CatalogError, Result, safe_media
from backend.downloads import Downloads, listing_metadata
from backend.job_models import Format


class ArtistBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    artist_id: int = Field(gt=0)
    album_ids: list[int] = Field(min_length=1, max_length=1000)
    all_music: bool = False
    missing_only: bool = True
    format: Format | None = None
    target: str | None = None


class ArtistDownloads:
    def __init__(self, downloads: Downloads) -> None:
        self.downloads = downloads

    async def albums(self, artist_id: int, all_music: bool = False) -> list[Album]:
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
                if all_music or album.record_type == "album":
                    albums[album.id] = album
            if not raw.get("next"):
                return list(albums.values())
            if len(entries) != 50:
                raise CatalogError("Artist album list was incomplete. Retry before downloading.")
        raise CatalogError(
            "Artist catalog is too large for one batch. Download albums individually.", 413
        )

    async def tracks(self, album: Album) -> list[Result]:
        result = await self.downloads.catalog.album_detail(album.id, background=True)
        if result.get("complete") is not True:
            raise CatalogError("Incomplete track list; retry before downloading this album")
        raw = result.get("tracks", [])
        return [Result.model_validate(row) for row in raw] if isinstance(raw, list) else []

    def describe(self, groups: list[tuple[Album, list[Result], str]]) -> list[dict[str, object]]:
        # One ownership pass for every release. Doing it per album re-ran the library
        # query, and each run used to scan the whole download history.
        tracks = [track for _, rows, _ in groups for track in rows]
        if tracks:
            self.downloads.library.annotate(tracks)
        described: list[dict[str, object]] = []
        for album, rows, error in groups:
            described.append(
                {
                    "id": album.id,
                    "title": album.title,
                    "art": safe_media(album.cover_medium),
                    "year": album.release_date[:4],
                    "tracks": [
                        {
                            "id": track.id,
                            "duration": track.duration,
                            "owned": track.ownership == "owned",
                            "identity": f"isrc:{track.isrc}" if track.isrc else f"id:{track.id}",
                        }
                        for track in rows
                    ],
                    "error": error,
                }
            )
        return described

    async def plan(self, artist_id: int, all_music: bool = False) -> dict[str, object]:
        albums = await self.albums(artist_id, all_music)
        slots = asyncio.Semaphore(4)

        async def one(album: Album) -> tuple[Album, list[Result], str]:
            async with slots:
                try:
                    return album, await self.tracks(album), ""
                except (CatalogError, TimeoutError) as exc:
                    return (
                        album,
                        [],
                        exc.detail if isinstance(exc, CatalogError) else "Album lookup timed out",
                    )

        groups = list(await asyncio.gather(*(one(album) for album in albums)))
        return {"albums": self.describe(groups)}

    async def enqueue(self, request: ArtistBatchRequest) -> dict[str, object]:
        service = self.downloads
        settings = service.settings()
        target = service.target(request.target or settings.destination)
        service.check_destination(target)
        available = {
            album.id: album for album in await self.albums(request.artist_id, request.all_music)
        }
        selected = list(dict.fromkeys(request.album_ids))
        if any(album_id not in available for album_id in selected):
            noun = "releases" if request.all_music else "albums"
            raise ValueError(f"Choose {noun} from this artist's catalog")
        # Resolve every selected album first: a failed lookup must not enqueue half a selection.
        slots = asyncio.Semaphore(4)

        async def load(album_id: int) -> tuple[Album, list[Result]]:
            async with slots:
                return available[album_id], await self.tracks(available[album_id])

        loaded = list(await asyncio.gather(*(load(album_id) for album_id in selected)))
        self.describe([(album, rows, "") for album, rows in loaded])
        identities: set[str] = set()
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
        for album, rows in loaded:
            before = len(wanted)
            for track in rows:
                identity = f"isrc:{track.isrc}" if track.isrc else f"id:{track.id}"
                if identity in identities:
                    continue
                identities.add(identity)
                if request.missing_only and track.ownership == "owned":
                    owned += 1
                elif track.id in active:
                    queued += 1
                else:
                    wanted.append(track.id)
            album_tracks[album.id] = wanted[before:]
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
        label = f"{name} · {'all music' if request.all_music else 'albums'}"
        prepared = {
            track.id: (listing_metadata(track, tracks=album.nb_tracks or len(rows)), "")
            for album, rows in loaded
            for track in rows
        }
        jobs = service.jobs.enqueue_many(
            wanted, format, str(target), batch_id, label, prepared=prepared
        )
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
    async def plan(artist_id: int, all_music: bool = False) -> dict[str, object]:
        if artist_id <= 0:
            raise HTTPException(422, "Invalid artist ID")
        try:
            async with asyncio.timeout(120):
                return await ArtistDownloads(get()).plan(artist_id, all_music)
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
