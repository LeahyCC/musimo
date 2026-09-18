import asyncio
from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Query

from backend.downloads import Downloads
from backend.job_models import EpisodeRequest, Job
from backend.podcasts import Podcast, PodcastDetail


def install_podcast_routes(app: FastAPI, get: Callable[[], Downloads]) -> None:
    @app.get("/api/podcasts", response_model=list[Podcast])
    async def search(q: str = Query(min_length=2, max_length=200)) -> list[Podcast]:
        if len(q.strip()) < 2:
            raise HTTPException(422, "Enter at least two characters")
        async with asyncio.timeout(10):
            return await get().podcasts.search(q.strip())

    @app.get("/api/podcasts/{podcast_id}", response_model=PodcastDetail)
    async def detail(podcast_id: int) -> PodcastDetail:
        if podcast_id <= 0:
            raise HTTPException(422, "Invalid podcast ID")
        async with asyncio.timeout(15):
            return await get().podcasts.detail(podcast_id)

    @app.post("/api/podcast-episodes", response_model=Job)
    async def enqueue(request: EpisodeRequest) -> Job:
        service = get()
        try:
            target = service.target(request.target or service.settings().destination)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        service.check_destination(target)
        # The episode file comes from the directory again, never from the browser.
        async with asyncio.timeout(15):
            show = await service.podcasts.detail(request.podcast_id)
        episode = next((row for row in show.episodes if row.id == request.episode_id), None)
        if episode is None:
            raise HTTPException(404, "This episode is no longer listed for the podcast")
        meta = service.podcasts.metadata(show.podcast, episode)
        return service.jobs.enqueue_many(
            [episode.id],
            "original",
            str(target),
            catalog="podcast",
            prepared={episode.id: (meta, episode.url)},
        )[0]
