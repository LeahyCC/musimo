from collections.abc import Callable

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from backend.store import Store


class ClearActivity(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    through: int = Field(ge=0)


def install_activity_routes(
    app: FastAPI, get_store: Callable[[], Store], notify: Callable[[], None]
) -> None:
    @app.get("/api/activity")
    async def activity() -> dict[str, object]:
        return get_store().activity()

    @app.delete("/api/activity")
    async def clear(request: ClearActivity) -> dict[str, object]:
        result = get_store().clear_activity(request.through)
        notify()
        return result
