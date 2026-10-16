"""The lease the audio worker works through. Not a browser route.

Both routes need the bearer token the app and the worker share. With no token configured they
answer 404 before reading the body. A request a browser made (it carries an Origin or
Sec-Fetch-Site header) gets the same 404, whatever token it sends.
"""

import asyncio
import secrets
from collections.abc import Callable

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from backend.core.audio_recipes import recipe_for
from backend.library.audio_profile import AudioProfiles, LeaseError, WorkerResult


class LeaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    recipe: str = Field(min_length=1, max_length=80)


def install_audio_worker_routes(
    app: FastAPI,
    get_profiles: Callable[[], AudioProfiles],
    is_busy: Callable[[], bool],
    token: str,
) -> None:
    def authorised(request: Request) -> None:
        if (
            not token
            or request.headers.get("origin") is not None
            or request.headers.get("sec-fetch-site") is not None
        ):
            raise HTTPException(404, "Not found")
        scheme, _, given = request.headers.get("authorization", "").partition(" ")
        if scheme.casefold() != "bearer" or not secrets.compare_digest(
            given.strip().encode(), token.encode()
        ):
            raise HTTPException(401, "The analysis token does not match")

    @app.post("/api/internal/audio/lease", dependencies=[Depends(authorised)])
    async def lease(body: LeaseRequest) -> dict[str, object]:
        if recipe_for(body.recipe) is None:
            raise HTTPException(422, "Unknown recipe")
        # A chat request is resolving. Analysis waits so the two do not contend.
        if is_busy():
            return {"job": None}
        try:
            return {"job": await asyncio.to_thread(get_profiles().lease, body.recipe)}
        except LeaseError as exc:
            raise HTTPException(exc.status, exc.detail) from exc

    @app.post("/api/internal/audio/result", dependencies=[Depends(authorised)])
    async def result(body: WorkerResult) -> dict[str, object]:
        try:
            await asyncio.to_thread(get_profiles().complete, body)
        except LeaseError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
        return {"stored": True, "status": body.status}
