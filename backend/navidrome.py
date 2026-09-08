import asyncio
import hashlib
import json
import os
import re
import secrets
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import cast

import httpx

from backend.models import Settings
from backend.store import Store


class NavidromeError(RuntimeError):
    pass


LRC_LINE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")
LIKED_PLAYLIST_KEY = "liked"
LIKED_PLAYLIST_NAME = "Liked"


def lyric_lines(synced: str, plain: str) -> tuple[list[dict[str, object]], bool]:
    lines: list[dict[str, object]] = []
    for raw in synced.splitlines():
        match = LRC_LINE.match(raw)
        if not match:
            continue
        start = round((int(match.group(1)) * 60 + float(match.group(2))) * 1000)
        lines.append({"start": start, "value": match.group(3).strip()})
    if lines:
        return lines, True
    return [{"value": line} for line in plain.splitlines() if line.strip()], False


class Navidrome:
    def __init__(self, store: Store, client: httpx.AsyncClient) -> None:
        self.store = store
        self.client = client

    def settings(self) -> Settings:
        with self.store.lock:
            rows = self.store.db.execute("SELECT key,value FROM settings").fetchall()
        return Settings.model_validate({row[0]: json.loads(row[1]) for row in rows})

    def configured(self) -> bool:
        return bool(
            self.settings().navidrome_url and os.getenv("MUSIMO_NAVIDROME_CREDENTIALS_FILE")
        )

    def auth(self) -> dict[str, str]:
        credentials = os.getenv("MUSIMO_NAVIDROME_CREDENTIALS_FILE", "")
        if not credentials:
            raise NavidromeError("Navidrome credentials are not configured")
        try:
            raw: object = json.loads(Path(credentials).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise NavidromeError("Navidrome credentials cannot be read") from exc
        if not isinstance(raw, dict):
            raise NavidromeError("Navidrome credentials are invalid")
        username, password = raw.get("username"), raw.get("password")
        if (
            not isinstance(username, str)
            or not username
            or not isinstance(password, str)
            or not password
        ):
            raise NavidromeError("Navidrome credentials are invalid")
        salt = secrets.token_hex(12)
        # Subsonic specifies MD5(password + salt) for its wire token, not password storage.
        # codeql[py/weak-sensitive-data-hashing]
        token = hashlib.md5((password + salt).encode(), usedforsecurity=False).hexdigest()
        return {"u": username, "t": token, "s": salt, "v": "1.16.1", "c": "Musimo", "f": "json"}

    def url(self, endpoint: str) -> str:
        base = self.settings().navidrome_url.rstrip("/")
        if not base:
            raise NavidromeError("Navidrome is not configured")
        return f"{base}/rest/{endpoint}"

    async def response(
        self,
        endpoint: str,
        params: Mapping[str, str | int | bool]
        | Sequence[tuple[str, str | int | bool]]
        | None = None,
    ) -> dict[str, object]:
        request_params: list[tuple[str, str | int | float | bool | None]] = list(
            self.auth().items()
        )
        request_params.extend(params.items() if isinstance(params, Mapping) else params or [])
        try:
            response = await self.client.get(self.url(endpoint), params=request_params)
            response.raise_for_status()
            payload: object = response.json()
        except NavidromeError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise NavidromeError("Navidrome did not return a usable response") from exc
        if not isinstance(payload, dict):
            raise NavidromeError("Navidrome returned an invalid response")
        body = payload.get("subsonic-response")
        if not isinstance(body, dict):
            raise NavidromeError("Navidrome returned an invalid response")
        if body.get("status") != "ok":
            error = body.get("error")
            detail = error.get("message") if isinstance(error, dict) else None
            raise NavidromeError(str(detail or "Navidrome refused the request"))
        return cast(dict[str, object], body)

    async def capabilities(self) -> dict[str, object]:
        if not self.configured():
            detail = (
                "Add a Navidrome address in Settings to enable library playback"
                if not self.settings().navidrome_url
                else "Mount a Navidrome credentials file to enable library playback"
            )
            return {
                "configured": False,
                "available": False,
                "version": "",
                "extensions": [],
                "sonic_similarity": False,
                "detail": detail,
            }
        try:
            ping = await self.response("ping")
        except NavidromeError:
            return {
                "configured": True,
                "available": False,
                "version": "",
                "extensions": [],
                "sonic_similarity": False,
                "detail": "Navidrome could not be reached or authenticated",
            }
        extensions: list[str] = []
        try:
            result = await self.response("getOpenSubsonicExtensions")
            raw = result.get("openSubsonicExtensions", [])
            if isinstance(raw, list):
                extensions = [
                    str(item["name"])
                    for item in raw
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                ]
        except NavidromeError:
            pass
        return {
            "configured": True,
            "available": True,
            "version": str(ping.get("serverVersion") or ping.get("version") or ""),
            "extensions": extensions,
            "sonic_similarity": any(name.casefold() == "sonicsimilarity" for name in extensions),
            "detail": "Navidrome is ready",
        }

    async def media(self, endpoint: str, item_id: str, range_header: str = "") -> httpx.Response:
        request = self.client.build_request(
            "GET", self.url(endpoint), params={**self.auth(), "id": item_id}
        )
        if range_header:
            request.headers["Range"] = range_header
        try:
            response = await self.client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise NavidromeError("Navidrome media could not be reached") from exc
        if response.status_code not in {200, 206}:
            await response.aclose()
            raise NavidromeError("Navidrome refused the media request")
        return response

    async def start_scan(self, target: str) -> None:
        await self.response("startScan", {"target": target})

    async def albums(
        self, sort: str, query: str, offset: int, size: int
    ) -> list[dict[str, object]]:
        if query:
            body = await self.response(
                "search3",
                {
                    "query": query,
                    "artistCount": 0,
                    "albumCount": size,
                    "albumOffset": offset,
                    "songCount": 0,
                },
            )
            container = body.get("searchResult3")
            items = container.get("album", []) if isinstance(container, dict) else []
            return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]
        body = await self.response("getAlbumList2", {"type": sort, "offset": offset, "size": size})
        container = body.get("albumList2")
        items = container.get("album", []) if isinstance(container, dict) else []
        return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]

    async def artists(self, query: str, offset: int, size: int) -> list[dict[str, object]]:
        if query:
            body = await self.response(
                "search3",
                {
                    "query": query,
                    "artistCount": size,
                    "artistOffset": offset,
                    "albumCount": 0,
                    "songCount": 0,
                },
            )
            container = body.get("searchResult3")
            items = container.get("artist", []) if isinstance(container, dict) else []
            return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]
        body = await self.response("getArtists")
        container = body.get("artists")
        indexes = container.get("index", []) if isinstance(container, dict) else []
        artists = [
            cast(dict[str, object], artist)
            for index in indexes
            if isinstance(index, dict)
            for artist in index.get("artist", [])
            if isinstance(artist, dict)
        ]
        return artists[offset : offset + size]

    async def tracks(self, query: str, offset: int, size: int) -> list[dict[str, object]]:
        body = await self.response(
            "search3",
            {
                "query": query,
                "artistCount": 0,
                "albumCount": 0,
                "songCount": size,
                "songOffset": offset,
            },
        )
        container = body.get("searchResult3")
        items = container.get("song", []) if isinstance(container, dict) else []
        return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]

    async def playlists(self) -> list[dict[str, object]]:
        body = await self.response("getPlaylists")
        container = body.get("playlists")
        items = container.get("playlist", []) if isinstance(container, dict) else []
        return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]

    async def linked_playlist(self) -> dict[str, object]:
        playlist_id = self.store.linked_playlist(LIKED_PLAYLIST_KEY)
        if playlist_id:
            try:
                return await self.playlist(playlist_id)
            except NavidromeError:
                self.store.clear_linked_playlist(LIKED_PLAYLIST_KEY)

        for playlist in await self.playlists():
            playlist_id = playlist.get("id")
            if (
                str(playlist.get("name", "")) == LIKED_PLAYLIST_NAME
                and isinstance(playlist_id, str)
            ):
                self.store.set_linked_playlist(LIKED_PLAYLIST_KEY, playlist_id)
                return await self.playlist(playlist_id)

        playlist = await self.create_playlist(LIKED_PLAYLIST_NAME, [])
        playlist_id = playlist.get("id")
        if isinstance(playlist_id, str) and playlist_id:
            self.store.set_linked_playlist(LIKED_PLAYLIST_KEY, playlist_id)
        return playlist

    async def album(self, album_id: str) -> dict[str, object]:
        body = await self.response("getAlbum", {"id": album_id})
        album = body.get("album")
        if not isinstance(album, dict):
            raise NavidromeError("Navidrome did not return the album")
        return cast(dict[str, object], album)

    async def artist(self, artist_id: str) -> dict[str, object]:
        body = await self.response("getArtist", {"id": artist_id})
        artist = body.get("artist")
        if not isinstance(artist, dict):
            raise NavidromeError("Navidrome did not return the artist")
        return cast(dict[str, object], artist)

    async def artist_tracks(self, artist_id: str) -> list[dict[str, object]]:
        artist = await self.artist(artist_id)
        albums = artist.get("album", [])
        if not isinstance(albums, list):
            return []
        limit = asyncio.Semaphore(6)

        async def songs(album: object) -> list[dict[str, object]]:
            if not isinstance(album, dict) or not album.get("id"):
                return []
            # Bound the fan-out so a large discography cannot flood Navidrome.
            async with limit:
                detail = await self.album(str(album["id"]))
            rows = detail.get("song", [])
            return (
                [cast(dict[str, object], row) for row in rows if isinstance(row, dict)]
                if isinstance(rows, list)
                else []
            )

        seen: set[str] = set()
        tracks: list[dict[str, object]] = []
        for rows in await asyncio.gather(*(songs(album) for album in albums)):
            for track in rows:
                track_id = str(track.get("id", ""))
                if track_id and track_id not in seen:
                    seen.add(track_id)
                    tracks.append(track)
        return tracks

    async def playlist(self, playlist_id: str) -> dict[str, object]:
        body = await self.response("getPlaylist", {"id": playlist_id})
        playlist = body.get("playlist")
        if not isinstance(playlist, dict):
            raise NavidromeError("Navidrome did not return the playlist")
        return cast(dict[str, object], playlist)

    async def create_playlist(self, name: str, song_ids: list[str]) -> dict[str, object]:
        params: list[tuple[str, str]] = [("name", name)]
        params.extend(("songId", song_id) for song_id in song_ids)
        body = await self.response("createPlaylist", params)
        playlist = body.get("playlist")
        if not isinstance(playlist, dict):
            raise NavidromeError("Navidrome did not return the created playlist")
        return cast(dict[str, object], playlist)

    async def update_playlist(self, playlist_id: str, name: str) -> dict[str, object]:
        await self.response("updatePlaylist", {"playlistId": playlist_id, "name": name})
        return await self.playlist(playlist_id)

    async def add_playlist_song(self, playlist_id: str, song_id: str) -> dict[str, object]:
        await self.response("updatePlaylist", {"playlistId": playlist_id, "songIdToAdd": song_id})
        return await self.playlist(playlist_id)

    async def remove_playlist_song(self, playlist_id: str, song_index: int) -> dict[str, object]:
        await self.response(
            "updatePlaylist",
            {"playlistId": playlist_id, "songIndexToRemove": song_index},
        )
        return await self.playlist(playlist_id)

    async def delete_playlist(self, playlist_id: str) -> None:
        await self.response("deletePlaylist", {"id": playlist_id})

    async def song(self, song_id: str) -> dict[str, object]:
        body = await self.response("getSong", {"id": song_id})
        song = body.get("song")
        if not isinstance(song, dict):
            raise NavidromeError("Navidrome did not return the song")
        return cast(dict[str, object], song)

    async def play_queue(self) -> dict[str, object]:
        body = await self.response("getPlayQueue")
        queue = body.get("playQueue")
        return cast(dict[str, object], queue) if isinstance(queue, dict) else {"entry": []}

    async def save_play_queue(self, ids: list[str], current: str, position: int) -> None:
        params: list[tuple[str, str | int]] = [("id", item_id) for item_id in ids]
        params.extend((("current", current), ("position", position)))
        await self.response("savePlayQueue", params)

    async def lyrics(self, song_id: str) -> list[dict[str, object]]:
        try:
            body = await self.response("getLyricsBySongId", {"id": song_id})
            container = body.get("lyricsList")
            items = container.get("structuredLyrics", []) if isinstance(container, dict) else []
            existing = [cast(dict[str, object], item) for item in items if isinstance(item, dict)]
            if any(item.get("line") for item in existing):
                return existing
        except NavidromeError:
            existing = []

        song = await self.song(song_id)
        raw_duration = song.get("duration", 0)
        duration = round(float(raw_duration)) if isinstance(raw_duration, (int, float, str)) else 0
        try:
            response = await self.client.get(
                "https://lrclib.net/api/get",
                params={
                    "track_name": str(song.get("title", "")),
                    "artist_name": str(song.get("artist", "")),
                    "album_name": str(song.get("album", "")),
                    "duration": duration,
                },
                timeout=4,
            )
            if response.status_code == 404:
                return existing
            response.raise_for_status()
            raw: object = response.json()
        except (httpx.HTTPError, ValueError, TypeError):
            return existing
        if not isinstance(raw, dict):
            return existing
        lines, synced = lyric_lines(
            str(raw.get("syncedLyrics") or ""), str(raw.get("plainLyrics") or "")
        )
        if not lines:
            return existing
        return [
            {
                "displayArtist": str(song.get("artist", "")),
                "displayTitle": str(song.get("title", "")),
                "synced": synced,
                "line": lines,
            }
        ]

    async def scrobble(self, song_id: str, submission: bool) -> None:
        await self.response("scrobble", {"id": song_id, "submission": submission})

    async def sonic_similar(self, song_id: str, count: int) -> list[dict[str, object]]:
        try:
            body = await self.response("getSonicSimilarTracks", {"id": song_id, "count": count})
        except NavidromeError as exc:
            if "AudioMuse-AI returned status 503" in str(exc):
                raise NavidromeError(
                    "AudioMuse is still analysing the library or building its "
                    "similarity index. Try again later."
                ) from exc
            raise
        items = body.get("sonicMatch", [])
        if not isinstance(items, list):
            return []
        return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]

    async def sonic_path(
        self, start_song_id: str, end_song_id: str, count: int
    ) -> list[dict[str, object]]:
        body = await self.response(
            "findSonicPath",
            {"startSongId": start_song_id, "endSongId": end_song_id, "count": count},
        )
        items = body.get("sonicMatch", [])
        if not isinstance(items, list):
            return []
        return [cast(dict[str, object], item) for item in items if isinstance(item, dict)]
