import asyncio
import json
import logging
import threading
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from backend.api.link_api import until_disconnected
from backend.library.engine import Engine, parse_intent
from backend.library.engine_contract import EngineError, ErrorField
from backend.library.music_bot import BotError, BotRequest, MusicBot, ValidateSelection
from backend.library.proposals import Cancelled, Proposals

# An intent carries at most three lists of 500 ids.
INTENT_BYTES = 262144
_CANCELLED = "Request cancelled. Nothing changed."


async def _body(http: Request) -> object:
    declared = http.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > INTENT_BYTES:
        raise EngineError("malformed_request", "The body is too large.", 413)
    body = await http.body()
    if len(body) > INTENT_BYTES:
        raise EngineError("malformed_request", "The body is too large.", 413)
    try:
        return json.loads(body)
    except (ValueError, RecursionError) as exc:
        raise EngineError("malformed_request", "The body is not valid JSON.", 400) from exc


async def _until_done[T](http: Request, work: Callable[[Callable[[], bool]], T]) -> T:
    """Run `work` in a thread and answer 499 if the client goes first. `work` gets a check
    it asks just before it writes, so a client that went away leaves nothing behind."""
    gone = threading.Event()

    async def watch() -> None:
        await until_disconnected(http)
        gone.set()

    task = asyncio.create_task(asyncio.to_thread(work, gone.is_set))
    watcher = asyncio.create_task(watch())
    try:
        await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if not task.done():
            raise HTTPException(499, _CANCELLED)
        try:
            return task.result()
        except Cancelled as exc:
            raise HTTPException(499, _CANCELLED) from exc
    finally:
        task.cancel()
        watcher.cancel()
        await asyncio.gather(task, watcher, return_exceptions=True)


async def _answer(
    action: Callable[[], Awaitable[dict[str, object]]],
) -> JSONResponse | dict[str, object]:
    """Every engine route answers in the contract's envelope, even when it fails."""
    try:
        return await action()
    except EngineError as exc:
        return JSONResponse(exc.public(), status_code=exc.status)
    except HTTPException:
        raise
    except Exception:
        logging.getLogger("uvicorn.error").exception("music-bot engine route failed")
        failed = EngineError("internal_error", "The engine failed. Nothing changed.", 500)
        return JSONResponse(failed.public(), status_code=500)


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
                raise HTTPException(499, _CANCELLED)
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

        async def run() -> dict[str, object]:
            parsed = parse_intent(await _body(http))
            return await _until_done(http, lambda _: Engine(get()).run(parsed))

        return await _answer(run)

    # Proposals: the same engine, with the result stored so it can be refined and committed.
    # Creating, refining and reading write only the proposal tables.

    @app.post("/api/music-bot/proposals", response_model=None)
    async def create_proposal(http: Request) -> JSONResponse | dict[str, object]:
        async def run() -> dict[str, object]:
            raw = await _body(http)
            return await _until_done(
                http, lambda cancelled: Proposals(get()).create(raw, cancelled)
            )

        return await _answer(run)

    @app.post("/api/music-bot/proposals/{proposal_id}/revisions", response_model=None)
    async def refine_proposal(proposal_id: str, http: Request) -> JSONResponse | dict[str, object]:
        async def run() -> dict[str, object]:
            raw = await _body(http)
            return await _until_done(
                http, lambda cancelled: Proposals(get()).refine(proposal_id, raw, cancelled)
            )

        return await _answer(run)

    @app.get("/api/music-bot/proposals/{proposal_id}", response_model=None)
    async def read_proposal(
        proposal_id: str, revision: str | None = None
    ) -> JSONResponse | dict[str, object]:
        """The latest revision, or the one named, with its full ordered list."""

        async def run() -> dict[str, object]:
            # Read here rather than by FastAPI, so a bad number gets the contract's envelope.
            if revision is not None and not (revision.isdigit() and 0 < int(revision) < 2**31):
                raise EngineError(
                    "invalid_request",
                    "revision must be a positive whole number.",
                    422,
                    [ErrorField(field="revision", message="Not a revision number")],
                )
            number = int(revision) if revision is not None else None
            return await asyncio.to_thread(Proposals(get()).read, proposal_id, number)

        return await _answer(run)

    @app.post("/api/music-bot/proposals/{proposal_id}/commit", response_model=None)
    async def commit_proposal(proposal_id: str, http: Request) -> JSONResponse | dict[str, object]:
        """Saves a playlist, or hands back the exact ids for the browser's player with a
        receipt. Never plays. The same operation id retried returns the first receipt."""

        async def run() -> dict[str, object]:
            raw = await _body(http)
            return await _until_done(
                http, lambda cancelled: Proposals(get()).commit(proposal_id, raw, cancelled)
            )

        return await _answer(run)
