import asyncio
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from backend.api.settings_api import public_settings
from backend.core.store import Store


def install_event_routes(
    app: FastAPI, data: Path, get_store: Callable[[], Store], changed: asyncio.Event
) -> None:
    @app.get("/api/snapshot")
    async def snapshot() -> dict[str, object]:
        store = get_store()
        return store.snapshot() | {"settings": public_settings(store, data)}

    @app.get("/api/events")
    async def events(request: Request, after: int = Query(default=0, ge=0)) -> StreamingResponse:
        store = get_store()
        raw = request.headers.get("last-event-id", str(after))
        try:
            cursor = int(raw)
            if cursor < 0:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(400, "Invalid event cursor") from exc

        async def stream() -> AsyncIterator[str]:
            nonlocal cursor
            yield "retry: 1000\n\n"
            while not await request.is_disconnected():
                # Clear before reading rows so writes during the next await remain signalled.
                changed.clear()
                first, latest = store.bounds()
                if cursor > latest or (first > 0 and cursor < first - 1):
                    yield f"event: reset\ndata: {json.dumps({'cursor': latest})}\n\n"
                    return
                rows = store.events(cursor)
                if rows:
                    for row in rows:
                        cursor = int(str(row["id"]))
                        yield f"id: {cursor}\nevent: change\ndata: {json.dumps(row)}\n\n"
                    continue
                try:
                    await asyncio.wait_for(changed.wait(), timeout=15)
                except TimeoutError:
                    yield ": heartbeat\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-transform"},
        )
