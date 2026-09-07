import asyncio
import json
import time

import httpx

from backend.catalog import Album, Catalog, Track, safe_media
from backend.job_models import Metadata
from backend.library import normalize


class Enrichment:
    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.mb_lock = asyncio.Lock()
        self.mb_next = 0.0

    async def external(
        self, url: str, params: dict[str, str | int], mb: bool = False
    ) -> dict[str, object]:
        key = "metadata:" + url + json.dumps(params, sort_keys=True)
        with self.catalog.store.lock:
            row = self.catalog.store.db.execute(
                "SELECT payload FROM search_cache WHERE key=? AND expires>?", (key, time.time())
            ).fetchone()
        if row:
            cached: object = json.loads(row[0])
            if isinstance(cached, dict):
                return {str(k): v for k, v in cached.items()}
        if mb:
            async with self.mb_lock:
                await asyncio.sleep(max(0, self.mb_next - time.monotonic()))
                self.mb_next = time.monotonic() + 1.05
                response = await self.catalog.client.get(
                    url,
                    params=params,
                    headers={"User-Agent": "Musimo/0.3.0 (https://github.com/LeahyCC)"},
                    timeout=4,
                )
        else:
            response = await self.catalog.client.get(url, params=params, timeout=4)
        if response.status_code == 404:
            payload: dict[str, object] = {}
        else:
            response.raise_for_status()
            raw: object = response.json()
            if not isinstance(raw, dict):
                raise ValueError("Unexpected metadata response")
            payload = {str(k): v for k, v in raw.items()}
        with self.catalog.store.lock:
            self.catalog.store.db.execute(
                "INSERT OR REPLACE INTO search_cache VALUES (?,?,?)",
                (key, json.dumps(payload), time.time() + (7 * 86400 if mb else 86400)),
            )
            self.catalog.store.db.execute(
                "DELETE FROM search_cache WHERE key IN "
                "(SELECT key FROM search_cache ORDER BY expires DESC LIMIT -1 OFFSET 3000)"
            )
        return payload

    async def track(self, track_id: int) -> Metadata:
        raw, _ = await self.catalog.get(f"track/{track_id}", 86400)
        track = Track.model_validate(raw)
        album_raw: dict[str, object] = {}
        if track.album:
            album_raw, _ = await self.catalog.get(f"album/{track.album.id}", 86400)
        album = Album.model_validate(album_raw) if album_raw else track.album
        artists = raw.get("contributors", [])
        contributors = (
            [str(row.get("name", "")) for row in artists if isinstance(row, dict)]
            if isinstance(artists, list)
            else []
        )
        genres = album_raw.get("genres", {})
        rows = genres.get("data", []) if isinstance(genres, dict) else []
        genre = (
            "; ".join(str(row.get("name", "")) for row in rows if isinstance(row, dict))
            if isinstance(rows, list)
            else ""
        )
        disc = max(1, track.disk_number)
        album_tracks = album_raw.get("tracks", {})
        entries = album_tracks.get("data", []) if isinstance(album_tracks, dict) else []
        discs = (
            [max(1, int(row.get("disk_number") or 1)) for row in entries if isinstance(row, dict)]
            if isinstance(entries, list)
            else []
        )
        return Metadata(
            id=track.id,
            title=track.title,
            artist=track.artist.name,
            album_artist=album.artist.name if album and album.artist else track.artist.name,
            album=album.title if album else track.title,
            duration=track.duration,
            date=track.release_date or (album.release_date if album else ""),
            genre=genre,
            label=str(album_raw.get("label", "")),
            isrc=track.isrc,
            upc=str(album_raw.get("upc", "")),
            explicit=track.explicit_lyrics,
            track=max(1, track.track_position),
            tracks=discs.count(disc) or (album.nb_tracks if album else 1),
            disc=disc,
            discs=max(discs, default=disc),
            art=safe_media(album.cover_big or album.cover_medium) if album else "",
            contributors=contributors,
        )

    async def extra(self, meta: Metadata) -> list[str]:
        warnings: list[str] = []

        async def lyrics() -> None:
            try:
                raw = await self.external(
                    "https://lrclib.net/api/get",
                    params={
                        "track_name": meta.title,
                        "artist_name": meta.artist,
                        "album_name": meta.album,
                        "duration": round(meta.duration),
                    },
                )
                if not raw:
                    warnings.append("Lyrics unavailable from LRCLIB")
                    return
                if isinstance(raw, dict):
                    meta.lyrics = str(raw.get("plainLyrics") or "")
                    meta.synced_lyrics = str(raw.get("syncedLyrics") or "")
            except (httpx.HTTPError, ValueError):
                warnings.append("Lyrics lookup failed")

        async def musicbrainz() -> None:
            if not meta.isrc:
                warnings.append("No ISRC supplied; MusicBrainz identification unavailable")
                return
            try:
                raw = await self.external(
                    f"https://musicbrainz.org/ws/2/isrc/{meta.isrc}",
                    {"fmt": "json", "inc": "artists+releases"},
                    mb=True,
                )
                records = raw.get("recordings", []) if isinstance(raw, dict) else []
                matches: list[dict[str, object]] = []
                if isinstance(records, list):
                    for record in records:
                        if not isinstance(record, dict) or normalize(
                            str(record.get("title", ""))
                        ) != normalize(meta.title):
                            continue
                        credits = record.get("artist-credit", [])
                        names = (
                            [str(c.get("name", "")) for c in credits if isinstance(c, dict)]
                            if isinstance(credits, list)
                            else []
                        )
                        if normalize(meta.artist) in [normalize(name) for name in names]:
                            matches.append(record)
                if len(matches) != 1:
                    warnings.append("MusicBrainz match unavailable or ambiguous; IDs left empty")
                    return
                record = matches[0]
                meta.mb_recording = str(record.get("id", ""))
                credits = record.get("artist-credit", [])
                if isinstance(credits, list) and credits and isinstance(credits[0], dict):
                    artist = credits[0].get("artist", {})
                    if isinstance(artist, dict):
                        meta.mb_artist = str(artist.get("id", ""))
                releases = record.get("releases", [])
                matching = (
                    [
                        r
                        for r in releases
                        if isinstance(r, dict)
                        and normalize(str(r.get("title", ""))) == normalize(meta.album)
                    ]
                    if isinstance(releases, list)
                    else []
                )
                if len(matching) == 1:
                    release_id = str(matching[0].get("id", ""))
                    release = await self.external(
                        f"https://musicbrainz.org/ws/2/release/{release_id}",
                        {"fmt": "json", "inc": "recordings+release-groups"},
                        mb=True,
                    )
                    # Confirm the exact release before assigning release-track IDs.
                    media = release.get("media", [])
                    release_tracks: list[dict[str, object]] = []
                    if isinstance(media, list):
                        for medium in media:
                            rows = medium.get("tracks", []) if isinstance(medium, dict) else []
                            if isinstance(rows, list):
                                for item in rows:
                                    recording = (
                                        item.get("recording", {}) if isinstance(item, dict) else {}
                                    )
                                    if (
                                        isinstance(recording, dict)
                                        and recording.get("id") == meta.mb_recording
                                    ):
                                        release_tracks.append(item)
                    if len(release_tracks) == 1:
                        meta.mb_release = release_id
                        meta.mb_track = str(release_tracks[0].get("id", ""))
                        group = release.get("release-group", {})
                        if isinstance(group, dict):
                            meta.mb_release_group = str(group.get("id", ""))
                    else:
                        warnings.append(
                            "MusicBrainz release-track ambiguous; release IDs left empty"
                        )
                else:
                    warnings.append("MusicBrainz release edition ambiguous; release IDs left empty")
            except (httpx.HTTPError, ValueError):
                warnings.append("MusicBrainz lookup failed")

        try:
            async with asyncio.timeout(8):
                await asyncio.gather(lyrics(), musicbrainz())
        except TimeoutError:
            warnings.append("Optional metadata lookup timed out")
        return warnings
