from collections.abc import Callable

from fastapi import FastAPI, HTTPException

from backend.downloads import DownloadError
from backend.job_models import LinkRequest, LinkResolveRequest
from backend.links import LinkError, Links


def install_link_routes(app: FastAPI, get: Callable[[], Links]) -> None:
    @app.post("/api/links/resolve")
    async def resolve(request: LinkResolveRequest) -> dict[str, object]:
        try:
            return await get().resolve(request.url)
        except LinkError as exc:
            raise HTTPException(exc.status, exc.detail) from exc

    @app.post("/api/links")
    async def enqueue(request: LinkRequest) -> dict[str, object]:
        try:
            return get().enqueue(request)
        except LinkError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
        except DownloadError as exc:
            raise HTTPException(409, exc.detail) from exc
