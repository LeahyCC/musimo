import asyncio
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException

from backend.api.player_api import checked_id
from backend.core.store import Store
from backend.library import trash
from backend.library.index import Library
from backend.library.player import Player

FAILED = {
    "read_only": "That folder is read-only, so nothing was deleted.",
    "not_found": "That file is already gone.",
}


def install_trash_routes(
    app: FastAPI,
    get_player: Callable[[], Player],
    get_library: Callable[[], Library],
    get_store: Callable[[], Store],
    roots: Callable[[], list[Path]],
) -> None:
    """Delete songs, albums and artists into the trash, and show or empty it from Settings."""

    async def delete(song_ids: list[str]) -> dict[str, object]:
        result = await asyncio.to_thread(get_library().delete_songs, song_ids)
        failed = result["failed"]
        if not result["deleted"] and isinstance(failed, list) and failed:
            # Nothing moved: say why. One reason is enough, they are nearly always the same.
            raise HTTPException(409, FAILED.get(str(failed[0]["reason"]), "Nothing was deleted."))
        return result

    @app.delete("/api/library/tracks/{song_id}")
    async def delete_track(song_id: str) -> dict[str, object]:
        return await delete([checked_id(song_id)])

    @app.delete("/api/library/albums/{album_id}")
    async def delete_album(album_id: str) -> dict[str, object]:
        return await delete(await get_player().album_song_ids(checked_id(album_id)))

    @app.delete("/api/library/artists/{artist_id}")
    async def delete_artist(artist_id: str) -> dict[str, object]:
        return await delete(await get_player().artist_song_ids(checked_id(artist_id)))

    @app.get("/api/library/trash")
    async def trash_usage() -> dict[str, object]:
        return await asyncio.to_thread(trash.usage, roots())

    @app.delete("/api/library/trash")
    async def empty_trash() -> dict[str, object]:
        return await asyncio.to_thread(trash.empty, get_store(), roots())
