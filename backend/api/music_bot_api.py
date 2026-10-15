import asyncio
from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Request

from backend.api.link_api import until_disconnected
from backend.library.music_bot import BotError, BotRequest, MusicBot, ValidateSelection


def install_music_bot_routes(app: FastAPI, get: Callable[[], MusicBot]) -> None:
    @app.get("/api/music-bot/models")
    async def models() -> dict[str, object]:
        try:
            return await get().models()
        except BotError as exc:
            raise HTTPException(exc.status, exc.detail) from exc

    @app.post("/api/music-bot/chat")
    async def chat(body: BotRequest, http: Request) -> dict[str, object]:
        task = asyncio.create_task(get().chat(body))
        disconnected = asyncio.create_task(until_disconnected(http))
        try:
            await asyncio.wait({task, disconnected}, return_when=asyncio.FIRST_COMPLETED)
            if disconnected.done():
                raise HTTPException(499, "Request cancelled. Nothing changed.")
            return task.result()
        except BotError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
        finally:
            task.cancel()
            disconnected.cancel()
            await asyncio.gather(task, disconnected, return_exceptions=True)

    @app.post("/api/music-bot/validate")
    async def validate(body: ValidateSelection) -> dict[str, object]:
        try:
            return await asyncio.to_thread(get().validate, body)
        except BotError as exc:
            raise HTTPException(exc.status, exc.detail) from exc
