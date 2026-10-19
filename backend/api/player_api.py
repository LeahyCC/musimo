import asyncio
import re
from collections.abc import Callable
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

from backend.core.store import Store
from backend.jobs.account_listen import listen_file, prepare_track, remember_many, track_number
from backend.library.player import (
    ALBUM_SORTS,
    ARTIST_SHOWS,
    ARTIST_SORTS,
    TRACK_SORTS,
    Player,
    PlayerError,
    PlaylistProtected,
    ShuffleExpired,
    SongMissing,
)

ITEM_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
# Musimo's own ceiling on one saved play queue. Kept from the original queue validator.
QUEUE_LIMIT = 500
TrackQuery = Annotated[str, Query(max_length=200)]
TrackSort = Annotated[str, Query(pattern=f"^({'|'.join(TRACK_SORTS)})$")]
TrackGenres = Annotated[
    list[Annotated[str, StringConstraints(max_length=120)]] | None, Query(max_length=60)
]
TrackYears = Annotated[list[int] | None, Query(max_length=200)]
AlbumSort = Annotated[str, Query(pattern=f"^({'|'.join(ALBUM_SORTS)})$")]
ArtistSort = Annotated[str, Query(pattern=f"^({'|'.join(ARTIST_SORTS)})$")]
ArtistShow = Annotated[str, Query(pattern=f"^({'|'.join(ARTIST_SHOWS)})?$")]
BYTE_RANGE = re.compile(r"^bytes=\d*-\d*$")
# The cover id changes when the image does, so a browser can keep the bytes.
ART_CACHE = "public, max-age=31536000, immutable"


class ShuffleWindow(BaseModel):
    seed: str = Field(min_length=8, max_length=64)
    cursor: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=200)
    skip: list[str] = Field(default_factory=list, max_length=QUEUE_LIMIT)

    @field_validator("seed")
    @classmethod
    def valid_seed(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Invalid shuffle seed")
        return value

    @field_validator("skip")
    @classmethod
    def valid_skip(cls, values: list[str]) -> list[str]:
        return [checked_id(value) for value in values]


class TrackLookup(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)

    @field_validator("ids")
    @classmethod
    def valid_ids(cls, values: list[str]) -> list[str]:
        return [checked_id(value) for value in values]


class QueueUpdate(BaseModel):
    ids: list[str] = Field(max_length=QUEUE_LIMIT)
    current: str = ""
    position: int = Field(default=0, ge=0)
    epoch: int | None = Field(default=None, ge=1, le=9007199254740991)
    sequence: int | None = Field(default=None, ge=1, le=9007199254740991)

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
        if (self.epoch is None) != (self.sequence is None):
            raise ValueError("Queue writer epoch and sequence must be supplied together")
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
        raise HTTPException(422, "Invalid item ID")
    return value


class AccountFacts(BaseModel):
    title: str = Field(default="", max_length=500)
    artist: str = Field(default="", max_length=500)
    album: str = Field(default="", max_length=500)
    duration: float = Field(default=0, ge=0, le=86400)
    art: str = Field(default="", max_length=2000)


class AccountRememberTrack(AccountFacts):
    id: int = Field(ge=1, le=2**63 - 1)


class AccountRemember(BaseModel):
    tracks: list[AccountRememberTrack] = Field(default_factory=list, max_length=QUEUE_LIMIT)


_LISTEN_TYPES = {
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}


def install_account_routes(app: FastAPI, data: Path, get_store: Callable[[], Store]) -> None:
    """Listening files for a signed-in Deezer account. The cookie never leaves the server."""

    @app.post("/api/player/account/tracks", status_code=204)
    async def remember(body: AccountRemember) -> None:
        await asyncio.to_thread(
            remember_many, get_store(), [row.model_dump() for row in body.tracks]
        )

    @app.post("/api/player/account/{song_id}")
    async def account_prepare(song_id: str, facts: AccountFacts) -> dict[str, object]:
        number = track_number(checked_id(song_id))
        if number is None:
            raise HTTPException(404, "Track not found")
        return await asyncio.to_thread(prepare_track, get_store(), data, number, facts.model_dump())

    @app.get("/api/player/account/{song_id}/file")
    async def account_file(song_id: str, request: Request) -> FileResponse:
        range_header = request.headers.get("range", "")
        if range_header and not BYTE_RANGE.fullmatch(range_header):
            raise HTTPException(416, "Only one byte range is supported")
        number = track_number(checked_id(song_id))
        if number is None or not get_store().current().deezer_audio:
            raise HTTPException(404, "Track not found")
        path = listen_file(data, number)
        if path is None:
            raise HTTPException(404, "Track not found")
        return FileResponse(path, media_type=_LISTEN_TYPES.get(path.suffix.lower(), "audio/mpeg"))


def install_player_routes(app: FastAPI, get: Callable[[], Player]) -> None:
    @app.exception_handler(PlayerError)
    async def player_error(_: Request, exc: PlayerError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(SongMissing)
    async def song_missing(_: Request, exc: SongMissing) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(ShuffleExpired)
    async def shuffle_expired(_: Request, exc: ShuffleExpired) -> JSONResponse:
        return JSONResponse(
            {"detail": str(exc), "code": "shuffle_expired"},
            status_code=404,
        )

    @app.exception_handler(PlaylistProtected)
    async def protected_playlist(_: Request, exc: PlaylistProtected) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/api/player/capabilities")
    async def capabilities() -> dict[str, object]:
        return await get().capabilities()

    @app.get("/api/library/albums")
    async def albums(
        q: TrackQuery = "",
        sort: AlbumSort = "newest",
        genre: TrackGenres = None,
        year: TrackYears = None,
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, object]:
        return await get().browse_albums(q.strip(), sort, genre or [], year or [], offset, size)

    @app.get("/api/library/artists")
    async def artists(
        q: TrackQuery = "",
        sort: ArtistSort = "name",
        genre: TrackGenres = None,
        year: TrackYears = None,
        show: ArtistShow = "",
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=100, ge=1, le=200),
    ) -> dict[str, object]:
        return await get().browse_artists(
            q.strip(), sort, genre or [], year or [], show, offset, size
        )

    @app.put("/api/library/artists/{artist_id}/favourite", status_code=204)
    async def favourite_artist(artist_id: str) -> None:
        await get().favourite_artist(checked_id(artist_id), True)

    @app.delete("/api/library/artists/{artist_id}/favourite", status_code=204)
    async def unfavourite_artist(artist_id: str) -> None:
        await get().favourite_artist(checked_id(artist_id), False)

    @app.get("/api/library/tracks")
    async def tracks(
        q: TrackQuery = "",
        sort: TrackSort = "title",
        genre: TrackGenres = None,
        year: TrackYears = None,
        offset: int = Query(default=0, ge=0),
        size: int = Query(default=100, ge=1, le=200),
    ) -> dict[str, object]:
        return await get().browse_tracks(q.strip(), sort, genre or [], year or [], offset, size)

    @app.get("/api/library/tracks/search")
    async def track_search(
        q: TrackQuery = "",
        size: int = Query(default=20, ge=1, le=50),
    ) -> dict[str, object]:
        """One upstream page, for pickers that only need a handful of matches."""
        return {"items": await get().tracks(q.strip(), 0, size)}

    @app.get("/api/library/tracks/selection")
    async def track_selection(
        q: TrackQuery = "",
        sort: TrackSort = "title",
        genre: TrackGenres = None,
        year: TrackYears = None,
        shuffle: bool = Query(default=False),
        limit: int = Query(default=QUEUE_LIMIT, ge=1, le=QUEUE_LIMIT),
    ) -> dict[str, object]:
        return await get().select_tracks(q.strip(), sort, genre or [], year or [], shuffle, limit)

    @app.post("/api/library/tracks/shuffle")
    async def shuffle_window(request: ShuffleWindow) -> dict[str, object]:
        return await get().shuffle_window(request.seed, request.cursor, request.limit, request.skip)

    @app.post("/api/library/tracks/lookup")
    async def track_lookup(request: TrackLookup) -> dict[str, object]:
        return await get().tracks_by_ids(request.ids)

    @app.get("/api/library/playlists")
    async def playlists() -> dict[str, object]:
        return {"items": await get().playlists(), "liked_id": get().liked_id()}

    @app.get("/api/library/playlists/liked")
    async def liked_playlist() -> dict[str, object]:
        return await get().linked_playlist()

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
        if not await get().save_play_queue(
            update.ids, update.current, update.position, update.epoch, update.sequence
        ):
            raise HTTPException(409, "A newer queue save or another browser replaced this writer.")

    @app.post("/api/player/queue/writer")
    async def begin_queue_writer() -> dict[str, int]:
        return {"epoch": get().store.begin_queue_writer()}

    @app.post("/api/player/scrobble", status_code=204)
    async def scrobble(update: ScrobbleUpdate) -> None:
        await get().scrobble(update.id, update.submission)

    @app.get("/api/player/lyrics/{song_id}")
    async def lyrics(song_id: str) -> dict[str, object]:
        return {"items": await get().lyrics(checked_id(song_id))}

    @app.get("/api/player/stream/{song_id}")
    async def stream(song_id: str, request: Request) -> FileResponse:
        # More than one range is refused before FileResponse, which would otherwise serve it.
        range_header = request.headers.get("range", "")
        if range_header and not BYTE_RANGE.fullmatch(range_header):
            raise HTTPException(416, "Only one byte range is supported")
        song = checked_id(song_id)
        path = get().local_file(song)
        if path is None:
            raise HTTPException(404, "Track not found")
        return FileResponse(path, media_type=get().media_type(song))

    @app.get("/api/player/art/{cover_id}")
    async def art(cover_id: str) -> Response:
        found = await get().cover(checked_id(cover_id))
        if found is None:
            raise HTTPException(404, "Cover not found")
        return Response(
            content=found.body,
            media_type=found.media_type,
            headers={"ETag": found.etag, "Cache-Control": ART_CACHE},
        )
