import asyncio
from collections.abc import Callable

from fastapi import FastAPI, HTTPException

from backend.core.job_models import ArtistBatchRequest
from backend.jobs.artist_downloads import ArtistDownloads
from backend.jobs.downloads import Downloads


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
