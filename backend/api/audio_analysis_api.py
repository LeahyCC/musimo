"""The Song analysis page's routes. Same-origin like the rest of the app; the worker's own lease
routes stay separate and refuse a browser. Switching the recipe on for Octive is the existing
`audio_scalar_recipe` setting, so it is not here."""

import asyncio
from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict

from backend.core.store import LockedSetting, Store
from backend.library.audio_analysis import AudioAnalysis


class MeasureAll(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    # Without it the answer is the count, and nothing is queued.
    confirm: bool = False


class Pause(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    paused: bool


def install_audio_analysis_routes(
    app: FastAPI,
    get: Callable[[], AudioAnalysis],
    get_store: Callable[[], Store],
    notify: Callable[[], None],
) -> None:
    @app.get("/api/audio-analysis/status")
    async def status() -> dict[str, object]:
        return await asyncio.to_thread(get().status)

    @app.post("/api/audio-analysis/sample")
    async def sample() -> dict[str, object]:
        return await asyncio.to_thread(get().sample)

    @app.post("/api/audio-analysis/all")
    async def measure_all(body: MeasureAll) -> dict[str, object]:
        return await asyncio.to_thread(get().measure_all, body.confirm)

    @app.post("/api/audio-analysis/pause")
    async def pause(body: Pause) -> dict[str, object]:
        try:
            await asyncio.to_thread(get_store().update, {"audio_analysis_paused": body.paused})
        except LockedSetting as exc:
            raise HTTPException(409, str(exc)) from exc
        # Other pages hear about the settings change as they would from Settings.
        notify()
        return await asyncio.to_thread(get().status)

    @app.get("/api/audio-analysis/listen")
    async def listen() -> dict[str, object]:
        return await asyncio.to_thread(get().listen)
