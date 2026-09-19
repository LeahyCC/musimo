import asyncio
from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Request

from backend.downloads import DownloadError
from backend.job_models import LinkRequest, LinkResolveRequest
from backend.links import LinkError, Links


async def until_disconnected(http: Request) -> None:
    # The body is already read, so the only message left to arrive is the disconnect. This waits
    # on it directly instead of polling `is_disconnected`, whose anyio cancel scope can swallow
    # the cancellation that stops this task.
    while (await http.receive())["type"] != "http.disconnect":
        pass


def install_link_routes(app: FastAPI, get: Callable[[], Links]) -> None:
    @app.post("/api/links/resolve")
    async def resolve(request: LinkResolveRequest, http: Request) -> dict[str, object]:
        # The lookup runs in a task so a browser that cancels can stop it. Cancelling the task
        # stops the yt-dlp child and gives its place back at once.
        lookup = asyncio.create_task(get().resolve(request.url))
        watcher = asyncio.create_task(until_disconnected(http))
        try:
            await asyncio.wait({lookup, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if not lookup.done():
                raise HTTPException(499, "The lookup was cancelled.")
            return lookup.result()
        except LinkError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
        finally:
            lookup.cancel()
            watcher.cancel()
            await asyncio.gather(lookup, watcher, return_exceptions=True)

    @app.post("/api/links")
    async def enqueue(request: LinkRequest) -> dict[str, object]:
        try:
            return get().enqueue(request)
        except LinkError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
        except DownloadError as exc:
            raise HTTPException(409, exc.detail) from exc
