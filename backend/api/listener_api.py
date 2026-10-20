"""Names on this install. Creating one does not require a name already chosen."""

from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from backend.core.listener import ListenerNameError
from backend.core.store import Store


class ListenerCreate(BaseModel):
    # Long enough that our own check, not the parser, writes the 40-character message.
    name: str = Field(max_length=500)


def install_listener_routes(app: FastAPI, get: Callable[[], Store | None]) -> None:
    @app.get("/api/listeners")
    async def listeners() -> dict[str, object]:
        store = get()
        if store is None:
            raise HTTPException(503, "Not ready")
        return {"items": store.list_listeners()}

    @app.post("/api/listeners")
    async def create_listener(body: ListenerCreate) -> dict[str, str]:
        store = get()
        if store is None:
            raise HTTPException(503, "Not ready")
        try:
            return store.create_listener(body.name)
        except ListenerNameError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
