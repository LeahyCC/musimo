import asyncio
import json
from collections.abc import Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from backend.api.link_api import until_disconnected
from backend.library.engine import Engine, parse_intent
from backend.library.engine_contract import EngineError
from backend.library.music_bot import BotError, BotRequest, MusicBot, ValidateSelection

# An intent carries at most three lists of 500 ids.
INTENT_BYTES = 262144


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

    @app.get("/api/music-bot/capabilities")
    async def capabilities() -> dict[str, object]:
        return await asyncio.to_thread(Engine(get()).capabilities)

    @app.post("/api/music-bot/intent", response_model=None)
    async def intent(http: Request) -> JSONResponse | dict[str, object]:
        """The structured entry point. No model, and no write of any kind: a search is a
        preview, and an error or a cancel leaves nothing behind."""
        try:
            body = await http.body()
            if len(body) > INTENT_BYTES:
                raise EngineError("malformed_request", "The body is too large.", 413)
            try:
                raw = json.loads(body)
            except ValueError as exc:
                raise EngineError("malformed_request", "The body is not valid JSON.", 400) from exc
            parsed = parse_intent(raw)
            task = asyncio.create_task(asyncio.to_thread(Engine(get()).run, parsed))
            disconnected = asyncio.create_task(until_disconnected(http))
            try:
                await asyncio.wait({task, disconnected}, return_when=asyncio.FIRST_COMPLETED)
                if disconnected.done():
                    raise HTTPException(499, "Request cancelled. Nothing changed.")
                return task.result()
            finally:
                task.cancel()
                disconnected.cancel()
                await asyncio.gather(task, disconnected, return_exceptions=True)
        except EngineError as exc:
            return JSONResponse(exc.public(), status_code=exc.status)
