"""Tidy the tags of a pasted music link against the Deezer catalog.

A link job starts with the tags its site gave it. When the catalog has the same recording with
high confidence, the job takes the catalog's full tags, so the file lands in the normal library
layout and the ownership badges recognise it. Anything less than confident keeps the site's tags.
"""

import asyncio

import httpx
from pydantic import ValidationError

from backend.catalog import Catalog, CatalogError, Result
from backend.enrichment import BUDGET_SECONDS, Enrichment
from backend.job_models import Job, Metadata
from backend.library import normalize
from backend.matching import Matcher, Score

# Stricter than the matcher's own bar for a YouTube candidate: a wrong hit here rewrites tags.
TITLE_BAR = 0.9
ARTIST_BAR = 0.9
# Every note starts with this, which also tells a retried job that it has already been tidied.
NOTE_PREFIX = "Tagged from"
CATALOG_NOTE = f"{NOTE_PREFIX} the Deezer catalog"


def tidied(job: Job) -> bool:
    return any(note.startswith(NOTE_PREFIX) for note in job.warnings)


class LinkTags:
    def __init__(self, catalog: Catalog, enrichment: Enrichment) -> None:
        self.catalog, self.enrichment, self.matcher = catalog, enrichment, Matcher()

    def confidence(self, meta: Metadata, hit: Result) -> Score | None:
        """The score of a catalog result if it is the same recording, else None.

        `meta` must carry a length: without one the matcher skips its length check.
        """
        score = self.matcher.score(meta, hit.title, hit.artist, hit.duration)
        if score is None or score.version_mismatch or score.version_missing:
            return None
        if score.title < TITLE_BAR or score.artist_ratio < ARTIST_BAR:
            return None
        return score

    async def lookup(self, meta: Metadata) -> Metadata | None:
        # YouTube's auto-generated channels name the artist "<name> - Topic".
        wanted = meta.model_copy(update={"artist": meta.artist.removesuffix(" - Topic").strip()})
        # Nothing to search with, or nothing to check a hit's length against: skip the request.
        if not normalize(wanted.artist) or not normalize(wanted.title) or wanted.duration <= 0:
            return None
        unquoted = str.maketrans("", "", '"')
        artist, title = wanted.artist.translate(unquoted), wanted.title.translate(unquoted)
        page = await self.catalog.search(f'artist:"{artist}" track:"{title}"', "track", 0)
        best: tuple[float, Result] | None = None
        for hit in page.items:
            score = self.confidence(wanted, hit)
            if score and (best is None or score.total > best[0]):
                best = (score.total, hit)
        if best is None:
            return None
        full = await self.enrichment.track(best[1].id)
        # A catalog cover that failed the media check should not throw away the site's own.
        full.art = full.art or meta.art
        return full

    async def tidy(self, meta: Metadata, site: str) -> tuple[Metadata, str]:
        """The tags to use and the note that says where they came from. Never raises."""
        found: Metadata | None = None
        failed = False
        try:
            async with asyncio.timeout(BUDGET_SECONDS):
                found = await self.lookup(meta)
        except (TimeoutError, CatalogError, httpx.HTTPError, ValidationError, ValueError):
            failed = True
        if found:
            return found, CATALOG_NOTE
        note = f"{NOTE_PREFIX} {site}, " + (
            "the catalog lookup failed" if failed else "no catalog match"
        )
        # A single with no album is filed as an album named after it, so say so.
        if not meta.album or normalize(meta.album) == normalize(meta.title):
            note += ". It is filed as its own album named after the track"
        return meta, note
