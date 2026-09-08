import re
from collections.abc import AsyncIterator, Callable

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from backend.navidrome import Navidrome, NavidromeError

ITEM_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
BYTE_RANGE = re.compile(r"^bytes=\d*-\d*$")
MEDIA_HEADERS = {
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
}


class QueueUpdate(BaseModel):
    ids: list[str] = Field(max_length=500)
    current: str = ""
    position: int = Field(default=0, ge=0)

    @field_validator("ids")
    @classmethod
    def valid_ids(cls, values: list[str]) -> list[str]:
        return [checked_id(value) for value in values]

    @field_validator("current")
    @classmethod
    def valid_current(cls, value: str) -> str:
        return checked_id(value) if value else value

    @model_validator(mode="after")
    def current_is_queued(self) -> "QueueUpdate":
        if self.current and self.current not in self.ids:
            raise ValueError("Current track must be in the queue")
        return self


class ScrobbleUpdate(BaseModel):
    id: str
    submission: bool

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return checked_id(value)


class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    song_ids: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("name")
    @classmethod
    def non_blank_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Playlist name cannot be blank")
        return value

    @field_validator("song_ids")
    @classmethod
    def valid_song_ids(cls, values: list[str]) -> list[str]:
        return [checked_id(value) for value in values]


class PlaylistUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def non_blank_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Playlist name cannot be blank")
        return value


class PlaylistSongUpdate(BaseModel):
    song_id_to_add: str | None = None
    song_index_to_remove: int | None = Field(default=None, ge=0)

    @field_validator("song_id_to_add")
    @classmethod
    def valid_song_id(cls, value: str | None) -> str | None:
        return checked_id(value) if value is not None else value

    @model_validator(mode="after")
    def exactly_one_change(self) -> "PlaylistSongUpdate":
        if (self.song_id_to_add is None) == (self.song_index_to_remove is None):
            raise ValueError("Provide either song_id_to_add or song_index_to_remove")
        return self


def checked_id(value: str) -> str:
    if not ITEM_ID.fullmatch(value):
        raise HTTPException(422, "Invalid Navidrome item ID")
    return value


def install_player_routes(app: FastAPI, get: Callable[[], Navidrome]) -> None:
    @app.exception_handler(NavidromeError)
    async def navidrome_error(_: Request, exc: NavidromeError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.get("/api/player/capabilities")
    async def capabilities() -> dict[str, object]:
        return await get().capabilities()

    @app.get("/api/library/albums")
    async def albums(
        sort: str = Query(
            default="newest",
            pattern="^(newest|recent|frequent|random|alphabeticalByName)$",
        ),
        q: str = Query(default="", max_length=200),
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, object]:
        items = await get().albums(sort, q.strip(), offset, size)
        return {"items": items, "next_offset": offset + size if len(items) == size else None}

    @app.get("/api/library/artists")
    async def artists(
        q: str = Query(default="", max_length=200),
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=100, ge=1, le=200),
    ) -> dict[str, object]:
        items = await get().artists(q.strip(), offset, size)
        return {"items": items, "next_offset": offset + size if len(items) == size else None}

    @app.get("/api/library/tracks")
    async def tracks(
        q: str = Query(default="", max_length=200),
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=100, ge=1, le=200),
    ) -> dict[str, object]:
        items = await get().tracks(q, offset, size)
        return {"items": items, "next_offset": offset + size if len(items) == size else None}

    @app.get("/api/library/playlists")
    async def playlists() -> dict[str, object]:
        return {"items": await get().playlists()}

    @app.get("/api/library/playlists/{playlist_id}")
    async def playlist(playlist_id: str) -> dict[str, object]:
        return await get().playlist(checked_id(playlist_id))

    @app.post("/api/library/playlists")
    async def create_playlist(request: PlaylistCreate) -> dict[str, object]:
        return await get().create_playlist(request.name.strip(), request.song_ids)

    @app.patch("/api/library/playlists/{playlist_id}")
    async def update_playlist(playlist_id: str, request: PlaylistUpdate) -> dict[str, object]:
        return await get().update_playlist(checked_id(playlist_id), request.name.strip())

    @app.post("/api/library/playlists/{playlist_id}/songs")
    async def update_playlist_songs(
        playlist_id: str, request: PlaylistSongUpdate
    ) -> dict[str, object]:
        checked_playlist_id = checked_id(playlist_id)
        if request.song_id_to_add is not None:
            return await get().add_playlist_song(checked_playlist_id, request.song_id_to_add)
        return await get().remove_playlist_song(
            checked_playlist_id, request.song_index_to_remove or 0
        )

    @app.delete("/api/library/playlists/{playlist_id}", status_code=204)
    async def delete_playlist(playlist_id: str) -> None:
        await get().delete_playlist(checked_id(playlist_id))

    @app.get("/api/library/albums/{album_id}")
    async def album(album_id: str) -> dict[str, object]:
        return await get().album(checked_id(album_id))

    @app.get("/api/library/artists/{artist_id}")
    async def artist(artist_id: str) -> dict[str, object]:
        return await get().artist(checked_id(artist_id))

    @app.get("/api/library/artists/{artist_id}/tracks")
    async def artist_tracks(artist_id: str) -> dict[str, object]:
        return {"items": await get().artist_tracks(checked_id(artist_id))}

    @app.get("/api/player/song/{song_id}")
    async def song(song_id: str) -> dict[str, object]:
        return await get().song(checked_id(song_id))

    @app.get("/api/player/queue")
    async def play_queue() -> dict[str, object]:
        return await get().play_queue()

    @app.put("/api/player/queue", status_code=204)
    async def save_play_queue(update: QueueUpdate) -> None:
        await get().save_play_queue(update.ids, update.current, update.position)

    @app.post("/api/player/scrobble", status_code=204)
    async def scrobble(update: ScrobbleUpdate) -> None:
        await get().scrobble(update.id, update.submission)

    @app.get("/api/player/lyrics/{song_id}")
    async def lyrics(song_id: str) -> dict[str, object]:
        return {"items": await get().lyrics(checked_id(song_id))}

    @app.get("/api/player/radio/{song_id}")
    async def radio(
        song_id: str, count: int = Query(default=30, ge=1, le=100)
    ) -> dict[str, object]:
        return {"items": await get().sonic_similar(checked_id(song_id), count)}

    @app.get("/api/player/path")
    async def sonic_path(
        start: str, end: str, count: int = Query(default=20, ge=1, le=100)
    ) -> dict[str, object]:
        return {"items": await get().sonic_path(checked_id(start), checked_id(end), count)}

    async def media_response(endpoint: str, item_id: str, range_header: str) -> StreamingResponse:
        if range_header and not BYTE_RANGE.fullmatch(range_header):
            raise HTTPException(416, "Only one byte range is supported")
        response = await get().media(endpoint, checked_id(item_id), range_header)

        async def content() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()

        headers = {
            name: value for name, value in response.headers.items() if name.lower() in MEDIA_HEADERS
        }
        return StreamingResponse(content(), status_code=response.status_code, headers=headers)

    @app.get("/api/player/stream/{song_id}")
    async def stream(song_id: str, request: Request) -> StreamingResponse:
        return await media_response("stream", song_id, request.headers.get("range", ""))

    @app.get("/api/player/art/{cover_id}")
    async def art(cover_id: str, request: Request) -> StreamingResponse:
        return await media_response("getCoverArt", cover_id, request.headers.get("range", ""))
