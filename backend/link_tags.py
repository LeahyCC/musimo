"""Tidy the tags of a pasted music link against the Deezer catalog.

A link job starts with the tags its site gave it. When the catalog has the same recording with
high confidence, the job takes the catalog's full tags, so the file lands in the normal library
layout and the ownership badges recognise it. Anything less than confident keeps the site's tags.
"""

import asyncio
import re

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

# Words an uploader adds to a title to say what kind of upload it is. None of them changes the
# music. Version words such as live, remix and acoustic are deliberately absent: they do.
DECORATION = (
    r"official|music|video|audio|lyrics?|visuali[sz]er|full|song|with|hd|hq|4k|8k|1080p|720p"
)
BRACKETED = re.compile(rf"\s*[(\[]\s*(?:(?:{DECORATION})\s*)+[)\]]", re.IGNORECASE)
# Decoration hanging off the end of a title: after a bar, after a dash that says "official"
# (a bare "Artist - Video" is a real song title), or a bare quality tag.
TRAILING = re.compile(
    rf"(?:\s+\|\s*(?:(?:{DECORATION})\s*)+"
    rf"|\s+[-\u2013\u2014]\s*official\s+(?:(?:{DECORATION})\s*)+"
    r"|\s+(?:hd|hq|4k|8k|1080p|720p))\s*$",
    re.IGNORECASE,
)
# "Artist - Title", with a hyphen or an en or em dash set off by spaces.
ARTIST_TITLE = re.compile(r"^(?P<artist>.+?)\s+[-\u2013\u2014]\s+(?P<title>.+)$")
# YouTube names a label's artist channel "<name>VEVO" and an auto-generated one "<name> - Topic".
CHANNEL_SUFFIX = re.compile(r"\s*(?:-\s*Topic|VEVO)\s*$", re.IGNORECASE)


def tidied(job: Job) -> bool:
    # Jobs stored before `notes` existed kept this note in `warnings`.
    return any(note.startswith(NOTE_PREFIX) for note in [*job.notes, *job.warnings])


def undecorated(title: str) -> str:
    """The title without upload decoration such as "(Official Video)" or "4K"."""
    while True:
        plainer = TRAILING.sub("", BRACKETED.sub("", title)).strip()
        if plainer == title:
            return title
        title = plainer


def cleaned(meta: Metadata) -> Metadata:
    """The pasted side as a catalog would spell it. Version words stay, so a remix stays one."""
    title = undecorated(meta.title)
    artist = CHANNEL_SUFFIX.sub("", meta.artist).strip()
    if split := ARTIST_TITLE.match(title):
        # "Artist - Title" names the artist better than the channel that uploaded it.
        artist, title = split["artist"].strip(), split["title"].strip()
    return meta.model_copy(update={"artist": artist, "title": title})


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

    async def search(self, wanted: Metadata) -> Result | None:
        """The best confident catalog hit for one spelling of the recording."""
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
        return best[1] if best else None

    async def lookup(self, meta: Metadata) -> Metadata | None:
        # The cleaned spelling goes first because the raw one of an ordinary upload finds nothing.
        # Both are held to the same bar, so the second try can only find what the first missed.
        # The raw spelling still drops YouTube's " - Topic", which is not decoration.
        raw = meta.model_copy(update={"artist": meta.artist.removesuffix(" - Topic").strip()})
        spellings = [cleaned(meta)]
        if raw != spellings[0]:
            spellings.append(raw)
        for wanted in spellings:
            if hit := await self.search(wanted):
                full = await self.enrichment.track(hit.id)
                # A catalog cover that failed the media check should not throw away the site's own.
                full.art = full.art or meta.art
                return full
        return None

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
