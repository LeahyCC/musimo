import asyncio
import json
import time
from collections import OrderedDict, deque
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field, ValidationError, ValidationInfo, field_validator

from backend.store import Store


class CatalogModel(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def absent_text(cls, value: object, info: ValidationInfo) -> object:
        # Deezer sometimes sends null media fields on otherwise valid search results.
        field = cls.model_fields.get(info.field_name or "")
        if value is None and field and isinstance(field.default, str):
            return field.default
        return value


class Artist(CatalogModel):
    id: int
    name: str = "Unknown artist"
    picture_medium: str = ""
    nb_fan: int = 0


class Album(CatalogModel):
    id: int
    title: str = "Unknown album"
    cover_medium: str = ""
    cover_big: str = ""
    artist: Artist | None = None
    nb_tracks: int = 0
    release_date: str = ""
    record_type: str = "album"
    explicit_lyrics: bool = False


class Track(CatalogModel):
    id: int
    title: str
    artist: Artist
    album: Album | None = None
    duration: int = 0
    rank: int = 0
    explicit_lyrics: bool = False
    preview: str = ""
    isrc: str = ""
    release_date: str = ""
    track_position: int = 0
    disk_number: int = 1


class Result(BaseModel):
    id: int
    kind: Literal["track", "album", "artist"]
    title: str
    artist: str = ""
    artist_id: int = 0
    album: str = ""
    album_id: int = 0
    art: str = ""
    duration: int = 0
    year: int | None = None
    explicit: bool = False
    preview: str = ""
    isrc: str = ""
    mbid: str = ""
    popularity: int = 0
    track_count: int = 0
    record_type: str = ""
    ownership: Literal["owned", "partial", "missing"] = "missing"
    matched_paths: list[str] = Field(default_factory=list)
    owned_count: int = 0
    coverage_verified: bool = False
    disc: int = 1
    position: int = 0


class SearchPage(BaseModel):
    items: list[Result]
    total: int
    next_index: int | None
    cached: bool


class CatalogError(Exception):
    def __init__(self, detail: str, status: int = 502) -> None:
        self.detail, self.status = detail, status


def safe_media(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ""
    host = parsed.hostname or ""
    return (
        value
        if parsed.scheme == "https"
        and (
            host.endswith(".dzcdn.net")
            or host.endswith(".mzstatic.com")
            or host == "audio-ssl.itunes.apple.com"
        )
        else ""
    )


class Catalog:
    def __init__(self, store: Store, client: httpx.AsyncClient) -> None:
        self.store, self.client = store, client
        self.memory: OrderedDict[str, tuple[float, dict[str, object]]] = OrderedDict()
        self.requests: deque[float] = deque()
        self.rate_lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(8)
        self.background_slots = asyncio.Semaphore(4)
        self.blocked_until = 0.0
        self.itunes_requests: deque[float] = deque()

    async def budget(self, itunes: bool = False, background: bool = False) -> None:
        history = self.itunes_requests if itunes else self.requests
        window, count = (60, 20) if itunes else (5, 50)
        if background and not itunes:
            count = 40
        while True:
            async with self.rate_lock:
                now = time.monotonic()
                while history and history[0] <= now - window:
                    history.popleft()
                delay = max(0, self.blocked_until - now)
                if len(history) >= count:
                    delay = max(delay, history[0] + window - now)
                if delay <= 0:
                    history.append(now)
                    return
            await asyncio.sleep(delay)

    async def get(
        self, path: str, ttl: int = 600, fresh: bool = False, background: bool = False
    ) -> tuple[dict[str, object], bool]:
        now = time.time()
        if not fresh:
            hit = self.memory.get(path)
            if hit and hit[0] > now:
                self.memory.move_to_end(path)
                return hit[1], True
            with self.store.lock:
                row = self.store.db.execute(
                    "SELECT payload,expires FROM search_cache WHERE key=? AND expires>?",
                    (path, now),
                ).fetchone()
            if row:
                parsed: object = json.loads(row["payload"])
                if isinstance(parsed, dict):
                    payload = {str(k): v for k, v in parsed.items()}
                    self.remember(path, float(row["expires"]), payload)
                    return payload, True
        try:
            async with self.slots:
                await self.budget(background=background)
                response = await self.client.get("https://api.deezer.com/" + path)
            if response.status_code == 429:
                try:
                    delay = min(300, max(1, float(response.headers.get("Retry-After", "5"))))
                except ValueError:
                    delay = 5
                self.blocked_until = time.monotonic() + delay
                raise CatalogError("Deezer is rate limited. Try again shortly.", 429)
            response.raise_for_status()
            raw: object = response.json()
            if not isinstance(raw, dict):
                raise CatalogError("Deezer returned an invalid response.")
            payload = {str(k): v for k, v in raw.items()}
            if "error" in payload:
                error = payload["error"]
                if isinstance(error, dict) and error.get("code") == 4:
                    self.blocked_until = time.monotonic() + 5
                    raise CatalogError("Deezer is rate limited. Try again shortly.", 429)
                raise CatalogError("This catalog item is unavailable.", 404)
        except httpx.TimeoutException as exc:
            raise CatalogError("Deezer timed out. Retry this search.", 504) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise CatalogError("Cannot reach the Deezer catalog. Try again.") from exc
        expires = time.time() + ttl
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                self.store.db.execute(
                    "INSERT OR REPLACE INTO search_cache VALUES (?,?,?)",
                    (path, json.dumps(payload), expires),
                )
                self.store.db.execute("DELETE FROM search_cache WHERE expires < ?", (now,))
                self.store.db.execute(
                    "DELETE FROM search_cache WHERE key IN "
                    "(SELECT key FROM search_cache ORDER BY expires DESC LIMIT -1 OFFSET 3000)"
                )
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.remember(path, expires, payload)
        return payload, False

    def remember(self, key: str, expires: float, payload: dict[str, object]) -> None:
        self.memory[key] = (expires, payload)
        self.memory.move_to_end(key)
        while len(self.memory) > 128:
            self.memory.popitem(last=False)

    def track(self, source: Track, album: Album | None = None) -> Result:
        album = album or source.album
        date = source.release_date or (album.release_date if album else "")
        return Result(
            id=source.id,
            kind="track",
            title=source.title,
            artist=source.artist.name,
            artist_id=source.artist.id,
            album=album.title if album else "",
            album_id=album.id if album else 0,
            art=safe_media(album.cover_medium) if album else "",
            duration=source.duration,
            year=int(date[:4]) if date[:4].isdigit() else None,
            explicit=source.explicit_lyrics,
            preview=safe_media(source.preview),
            isrc=source.isrc,
            popularity=source.rank,
            disc=source.disk_number,
            position=source.track_position,
        )

    def album(self, source: Album) -> Result:
        return Result(
            id=source.id,
            kind="album",
            title=source.title,
            artist=source.artist.name if source.artist else "",
            artist_id=source.artist.id if source.artist else 0,
            album=source.title,
            album_id=source.id,
            art=safe_media(source.cover_medium),
            year=int(source.release_date[:4]) if source.release_date[:4].isdigit() else None,
            explicit=source.explicit_lyrics,
            track_count=source.nb_tracks,
            record_type=source.record_type,
        )

    async def search(
        self, query: str, kind: Literal["track", "album", "artist"], index: int
    ) -> SearchPage:
        path = (
            "search/"
            + kind
            + "?"
            + str(httpx.QueryParams({"q": query, "limit": 50, "index": index}))
        )
        payload, cached = await self.get(path)
        rows = payload.get("data", [])
        if not isinstance(rows, list):
            raise CatalogError("Invalid search results")
        results: list[Result] = []
        try:
            for row in rows:
                if kind == "track":
                    results.append(self.track(Track.model_validate(row)))
                elif kind == "album":
                    results.append(self.album(Album.model_validate(row)))
                else:
                    artist = Artist.model_validate(row)
                    results.append(
                        Result(
                            id=artist.id,
                            kind="artist",
                            title=artist.name,
                            artist=artist.name,
                            artist_id=artist.id,
                            art=safe_media(artist.picture_medium),
                            popularity=artist.nb_fan,
                        )
                    )
        except ValidationError as exc:
            raise CatalogError("Deezer's result format changed.") from exc
        total = payload.get("total", len(results))
        return SearchPage(
            items=results,
            total=int(total) if isinstance(total, (int, float)) else len(results),
            next_index=index + len(rows) if payload.get("next") and rows else None,
            cached=cached,
        )

    async def album_detail(self, album_id: int, *, background: bool = False) -> dict[str, object]:
        payload, _ = await self.get(f"album/{album_id}", 86400, background=background)
        album = Album.model_validate(payload)
        tracks_payload = payload.get("tracks")
        if not isinstance(tracks_payload, dict):
            raise CatalogError("Album track list unavailable")
        rows = tracks_payload.get("data", [])
        if not isinstance(rows, list):
            raise CatalogError("Album track list unavailable")
        tracks = [self.track(Track.model_validate(row), album) for row in rows]
        # Never trust upstream next URLs as server fetch targets. Construct pagination locally.
        while len(tracks) < album.nb_tracks and len(tracks) < 1000:
            page, _ = await self.get(
                f"album/{album_id}/tracks?index={len(tracks)}&limit=100",
                86400,
                background=background,
            )
            extra = page.get("data", [])
            if not isinstance(extra, list) or not extra:
                break
            tracks.extend(self.track(Track.model_validate(row), album) for row in extra)
        return {
            "album": self.album(album).model_dump(),
            "tracks": [track.model_dump() for track in tracks],
            "label": payload.get("label", ""),
            "duration": payload.get("duration", 0),
            "complete": len(tracks) == album.nb_tracks,
        }
