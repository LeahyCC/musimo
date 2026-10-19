"""Spotify track search through the Web API.

A developer app's client credentials authorize search. Development mode needs a Premium
owner, and search returns at most 10 tracks. preview_url is deprecated and often null;
a missing clip stays empty so the existing iTunes fallback can run. This module never
asks Spotify for a file or a full stream.
"""

import asyncio
import re
import time
from typing import TYPE_CHECKING

import httpx

from backend.integrations.catalog import CatalogError, Result, SearchPage, safe_media
from backend.integrations.spotify_credentials import read as read_credentials

if TYPE_CHECKING:
    from backend.integrations.catalog import Catalog

# The February 2026 migration guide caps this. Asking for more is refused.
PAGE_LIMIT = 10
TOKEN_URL = "https://accounts.spotify.com/api/token"
SEARCH_URL = "https://api.spotify.com/v1/search"
SPOTIFY_ID = re.compile(r"[A-Za-z0-9]{10,32}")
CREDENTIALS_PROBLEM = (
    "Spotify refused the app credentials. Check the client ID and secret in Settings. "
    "The app owner needs Spotify Premium."
)
MISSING_APP = "Add a Spotify app in Settings to search Spotify."


class SpotifyAuth:
    """An app token kept in memory. It is not a setting, a job, or a log line."""

    def __init__(self) -> None:
        self.token = ""
        self.expires_at = 0.0
        self.lock = asyncio.Lock()

    def clear(self) -> None:
        self.token = ""
        self.expires_at = 0.0

    async def bearer(self, client: httpx.AsyncClient, client_id: str, secret: str) -> str:
        async with self.lock:
            if self.token and time.monotonic() < self.expires_at:
                return self.token
            try:
                response = await client.post(
                    TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    auth=(client_id, secret),
                )
            except httpx.TimeoutException as exc:
                raise CatalogError("Spotify timed out. Retry this search.", 504) from exc
            except httpx.HTTPError as exc:
                raise CatalogError("Cannot reach Spotify. Try again.") from exc
            if response.status_code in {400, 401, 403}:
                raise CatalogError(CREDENTIALS_PROBLEM, 502)
            if response.status_code == 429:
                raise CatalogError("Spotify is rate limited. Try again shortly.", 429)
            try:
                response.raise_for_status()
                raw: object = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise CatalogError("Spotify returned an unexpected response.") from exc
            if not isinstance(raw, dict):
                raise CatalogError("Spotify returned an unexpected response.")
            token = raw.get("access_token")
            expires = raw.get("expires_in")
            if not isinstance(token, str) or not token:
                raise CatalogError("Spotify returned an unexpected response.")
            seconds = (
                expires if isinstance(expires, int) and not isinstance(expires, bool) else 3600
            )
            self.token = token
            self.expires_at = time.monotonic() + max(30, seconds - 60)
            return token


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _whole(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _year(release: object) -> int | None:
    if not isinstance(release, str) or len(release) < 4 or not release[:4].isdigit():
        return None
    return int(release[:4])


def _art(album: object) -> str:
    if not isinstance(album, dict):
        return ""
    images = album.get("images")
    if not isinstance(images, list):
        return ""
    for image in images:
        if isinstance(image, dict):
            url = safe_media(_text(image.get("url")))
            if url:
                return url
    return ""


def track_result(row: object) -> Result | None:
    """One search row in the shape the page already draws. The Deezer id stays 0."""
    if not isinstance(row, dict):
        return None
    spotify_id = _text(row.get("id"))
    title = _text(row.get("name"))
    if SPOTIFY_ID.fullmatch(spotify_id) is None or not title:
        return None
    artists = row.get("artists")
    artist = ""
    if isinstance(artists, list):
        for person in artists:
            if isinstance(person, dict) and _text(person.get("name")):
                artist = _text(person.get("name"))
                break
    album = row.get("album")
    album_name = _text(album.get("name")) if isinstance(album, dict) else ""
    release = album.get("release_date") if isinstance(album, dict) else ""
    external = row.get("external_ids")
    isrc = _text(external.get("isrc")) if isinstance(external, dict) else ""
    duration_ms = _whole(row.get("duration_ms"))
    popularity = _whole(row.get("popularity"))
    disc = _whole(row.get("disc_number"))
    position = _whole(row.get("track_number"))
    return Result(
        id=0,
        kind="track",
        title=title,
        artist=artist or "Unknown artist",
        album=album_name,
        art=_art(album),
        duration=int(round(duration_ms / 1000)) if duration_ms is not None else 0,
        year=_year(release),
        explicit=row.get("explicit") is True,
        preview=safe_media(_text(row.get("preview_url"))),
        isrc=isrc,
        popularity=popularity or 0,
        spotify_id=spotify_id,
        disc=disc if disc and disc > 0 else 1,
        position=position or 0,
    )


async def _page(client: httpx.AsyncClient, token: str, query: str, offset: int) -> httpx.Response:
    try:
        return await client.get(
            SEARCH_URL,
            params={"q": query, "type": "track", "limit": PAGE_LIMIT, "offset": offset},
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.TimeoutException as exc:
        raise CatalogError("Spotify timed out. Retry this search.", 504) from exc
    except httpx.HTTPError as exc:
        raise CatalogError("Cannot reach Spotify. Try again.") from exc


def _results(payload: object, offset: int) -> SearchPage:
    tracks = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(tracks, dict):
        raise CatalogError("Spotify's result format changed.")
    rows = tracks.get("items")
    if not isinstance(rows, list):
        raise CatalogError("Spotify's result format changed.")
    # Never draw more than the API allows, even if a response ignores the limit.
    rows = rows[:PAGE_LIMIT]
    items = [item for row in rows if (item := track_result(row)) is not None]
    total = tracks.get("total")
    total_count = total if isinstance(total, int) and not isinstance(total, bool) else len(items)
    page_count = len(rows)
    next_index = offset + page_count if page_count and offset + page_count < total_count else None
    return SearchPage(items=items, total=total_count, next_index=next_index, cached=False)


async def search_tracks(
    catalog: "Catalog",
    query: str,
    offset: int,
    timing: dict[str, float] | None = None,
) -> SearchPage:
    client_id, secret = read_credentials()
    if not client_id or not secret:
        raise CatalogError(MISSING_APP, 422)
    if timing is not None:
        timing["cache"] = 0
        timing["queue"] = 0
    started = time.perf_counter()
    token = await catalog.spotify.bearer(catalog.client, client_id, secret)
    requested = time.perf_counter()
    if timing is not None:
        timing["queue"] = (requested - started) * 1000
    response = await _page(catalog.client, token, query, offset)
    if response.status_code == 401:
        catalog.spotify.clear()
        token = await catalog.spotify.bearer(catalog.client, client_id, secret)
        response = await _page(catalog.client, token, query, offset)
    if response.status_code in {400, 401, 403}:
        raise CatalogError(CREDENTIALS_PROBLEM, 502)
    if response.status_code == 429:
        raise CatalogError("Spotify is rate limited. Try again shortly.", 429)
    try:
        response.raise_for_status()
        raw: object = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise CatalogError("Spotify returned an unexpected response.") from exc
    if timing is not None:
        timing["provider"] = (time.perf_counter() - requested) * 1000
    parsed = time.perf_counter()
    page = _results(raw, offset)
    if timing is not None:
        timing["catalog"] = (time.perf_counter() - parsed) * 1000
    return page
