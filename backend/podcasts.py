"""Podcast search and episode lists from Apple's public podcast directory.

Episodes download straight from the publisher's feed file, so there is no YouTube matching.
"""

import time
from collections import OrderedDict
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from backend.catalog import Catalog, CatalogError, safe_media
from backend.job_models import Metadata


class Podcast(BaseModel):
    id: int
    title: str
    author: str = ""
    art: str = ""
    genre: str = ""
    episode_count: int = 0
    explicit: bool = False


class Episode(BaseModel):
    id: int
    podcast_id: int
    title: str
    date: str = ""
    duration: int = 0
    art: str = ""
    description: str = ""
    url: str = ""


class PodcastDetail(BaseModel):
    podcast: Podcast
    episodes: list[Episode]


def audio_url(value: object) -> str:
    text = str(value or "")
    try:
        parsed = urlsplit(text)
    except ValueError:
        return ""
    return text if parsed.scheme in {"http", "https"} and parsed.hostname else ""


def artwork(row: dict[str, object]) -> str:
    for key in ("artworkUrl600", "artworkUrl160", "artworkUrl100"):
        if url := safe_media(str(row.get(key) or "")):
            return url
    return ""


def number(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) else 0


class Podcasts:
    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.memory: OrderedDict[str, tuple[float, list[dict[str, object]]]] = OrderedDict()

    async def get(
        self, path: str, params: dict[str, str | int], ttl: int
    ) -> list[dict[str, object]]:
        key = path + "?" + str(httpx.QueryParams(params))
        hit = self.memory.get(key)
        if hit and hit[0] > time.time():
            self.memory.move_to_end(key)
            return hit[1]
        # Apple allows about 20 calls a minute; this shares the preview fallback's budget.
        await self.catalog.budget(itunes=True)
        try:
            response = await self.catalog.client.get(
                "https://itunes.apple.com/" + path, params=params, timeout=8
            )
            response.raise_for_status()
            raw: object = response.json()
        except httpx.TimeoutException as exc:
            raise CatalogError("The podcast directory timed out. Try again.", 504) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise CatalogError("Cannot reach the podcast directory. Try again.") from exc
        rows = raw.get("results") if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            raise CatalogError("The podcast directory returned an unexpected format.")
        result = [{str(k): v for k, v in row.items()} for row in rows if isinstance(row, dict)]
        self.memory[key] = (time.time() + ttl, result)
        while len(self.memory) > 64:
            self.memory.popitem(last=False)
        return result

    def podcast(self, row: dict[str, object]) -> Podcast:
        return Podcast(
            id=number(row.get("collectionId")),
            title=str(row.get("collectionName") or "Untitled podcast"),
            author=str(row.get("artistName") or ""),
            art=artwork(row),
            genre=str(row.get("primaryGenreName") or ""),
            episode_count=number(row.get("trackCount")),
            explicit=row.get("collectionExplicitness") == "explicit",
        )

    async def search(self, query: str) -> list[Podcast]:
        rows = await self.get(
            "search", {"term": query, "media": "podcast", "entity": "podcast", "limit": 50}, 600
        )
        return [
            self.podcast(row)
            for row in rows
            if row.get("kind") == "podcast" and number(row.get("collectionId")) > 0
        ]

    async def detail(self, podcast_id: int) -> PodcastDetail:
        # Apple returns at most the latest 200 episodes, the show itself first.
        rows = await self.get(
            "lookup",
            {"id": podcast_id, "media": "podcast", "entity": "podcastEpisode", "limit": 200},
            3600,
        )
        show = next((row for row in rows if row.get("kind") == "podcast"), None)
        if show is None:
            raise CatalogError("This podcast is unavailable.", 404)
        podcast = self.podcast(show)
        episodes = [
            Episode(
                id=number(row.get("trackId")),
                podcast_id=podcast.id,
                title=str(row.get("trackName") or "Untitled episode"),
                date=str(row.get("releaseDate") or "")[:10],
                duration=number(row.get("trackTimeMillis")) // 1000,
                art=artwork(row) or podcast.art,
                description=str(row.get("shortDescription") or row.get("description") or "")[:400],
                url=audio_url(row.get("episodeUrl")),
            )
            for row in rows
            if row.get("wrapperType") == "podcastEpisode"
            and row.get("episodeContentType", "audio") == "audio"
            and number(row.get("trackId")) > 0
        ]
        return PodcastDetail(podcast=podcast, episodes=[row for row in episodes if row.url])

    def metadata(self, podcast: Podcast, episode: Episode) -> Metadata:
        show = podcast.title
        return Metadata(
            id=episode.id,
            title=episode.title,
            artist=podcast.author or show,
            album_artist=podcast.author or show,
            album=show,
            duration=episode.duration,
            date=episode.date,
            genre="Podcast",
            explicit=podcast.explicit,
            art=episode.art or podcast.art,
        )
