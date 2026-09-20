"""Pasted links: check the site, preview what the link holds, queue the ticked entries.

The browser only ever sends the link and, later, a preview token with entry IDs. Titles, file
addresses and artwork come from the preview saved here, so a request cannot point a download
somewhere the preview did not.
"""

import asyncio
import hashlib
import json
import math
import re
import secrets
import sys
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel, Field

from backend import mixes
from backend.catalog import Result
from backend.downloads import Downloads, stop_tree
from backend.errors import error_guidance
from backend.job_models import LinkRequest, Metadata
from backend.sources import (
    LIVE_MESSAGE,
    Kind,
    Site,
    canonical,
    labels,
    match,
    match_entry,
    refusal,
    safe_art,
    unavailable,
)

PREVIEW_SECONDS = 600
MAX_PREVIEWS = 32
MAX_ENTRIES = 500
RESOLVE_SECONDS = 20
# Each resolve starts a yt-dlp child process, so only this many run at once; the rest wait.
MAX_RESOLVES = 2
# Slashes and percent signs are there for a file inside an item, as the Internet Archive names it.
ENTRY_ID = re.compile(r"[A-Za-z0-9_.:/%~-]{1,256}")
DAY = re.compile(r"\d{4}(-\d{2}-\d{2})?")


class LinkError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        self.status, self.detail = status, detail


class LinkEntry(BaseModel):
    id: str
    title: str
    artist: str = ""
    album: str = ""
    date: str = ""
    duration: float = 0
    art: str = ""
    owned: bool = False
    # `mix` and `radio` recordings land under `Mixes/`. `lands` is where, without the extension
    # (which depends on the file the site gives), and is empty for a song.
    kind: Kind = "music"
    lands: str = ""
    # A track's place on an album. Zero when the site gives none. Kept on the server only.
    track: int = Field(default=0, exclude=True)
    tracks: int = Field(default=0, exclude=True)
    # Kept on the server only. The download address never goes to the browser and back.
    url: str = Field(default="", exclude=True)
    extractor: str = Field(default="", exclude=True)
    # True for a track listed as part of an album. Its album is known, so it is never retagged.
    album_list: bool = Field(default=False, exclude=True)


@dataclass
class Preview:
    site: Site
    single: bool
    title: str
    entries: list[LinkEntry]
    truncated: bool
    # Some of the page could not be read in time, so the list is shorter than the page.
    partial: bool
    expires: float


def stable_id(text: str) -> int:
    """A positive 63 bit number that is the same for the same text on every run."""
    number = int.from_bytes(hashlib.sha256(text.encode()).digest()[:8], "big") & (2**63 - 1)
    return number or 1


def text(value: object, limit: int = 300) -> str:
    return str(value or "").strip()[:limit]


def place(value: object) -> int:
    """A track number or count from the resolver, or 0 when it is not a sensible one."""
    return value if isinstance(value, int) and 0 <= value < 10000 else 0


class Links:
    def __init__(self, downloads: Downloads, clock: Callable[[], float] = time.monotonic) -> None:
        self.downloads, self.clock = downloads, clock
        self.previews: OrderedDict[str, Preview] = OrderedDict()
        self.resolving = asyncio.Semaphore(MAX_RESOLVES)

    async def extract(self, url: str, site: Site) -> dict[str, object]:
        """Run the resolver in its own process group and read its one answer."""
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "backend.resolver",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=sys.platform != "win32",
        )
        request = json.dumps({"url": url, "source": site.source}).encode()
        try:
            async with asyncio.timeout(RESOLVE_SECONDS):
                output, _ = await process.communicate(request)
        except TimeoutError as exc:
            raise LinkError(504, f"{site.label} took too long to answer. Try again.") from exc
        finally:
            await stop_tree(process)
        for line in reversed(output.decode(errors="replace").splitlines()):
            try:
                raw: object = json.loads(line)
            except ValueError:
                continue
            if isinstance(raw, dict) and raw.get("kind") in {"preview", "error"}:
                return {str(key): value for key, value in raw.items()}
        raise LinkError(502, f"Musimo could not read this {site.label} link. Try again.")

    def entry(self, site: Site, raw: object) -> LinkEntry | None:
        """One resolver row, kept only if it is a single recording on the same site."""
        if not isinstance(raw, dict) or raw.get("live") is True:
            return None
        entry_id, url = str(raw.get("id", "")), str(raw.get("url", ""))
        extractor = str(raw.get("extractor", "")).lower()
        if not ENTRY_ID.fullmatch(entry_id) or extractor not in site.items:
            return None
        if match_entry(url) is not site:
            return None
        duration = raw.get("duration")
        seconds = float(duration) if isinstance(duration, int | float) else 0.0
        length = seconds if math.isfinite(seconds) and 0 <= seconds < 86400 * 7 else 0
        date = text(raw.get("date"), 10)
        return LinkEntry(
            id=entry_id,
            title=text(raw.get("title")) or entry_id,
            artist=text(raw.get("artist")),
            album=text(raw.get("album")),
            date=date if DAY.fullmatch(date) else "",
            duration=length,
            kind=mixes.kind_of(site, length),
            art=safe_art(site, str(raw.get("art", ""))),
            track=place(raw.get("track")),
            tracks=place(raw.get("tracks")),
            url=url,
            extractor=extractor,
            album_list=raw.get("album_list") is True,
        )

    def owned(self, entries: list[LinkEntry]) -> None:
        # Only tag matching is possible for a site's own IDs, so owned means title, artist and
        # length already match a file in the library.
        results = [
            Result(
                id=0,
                kind="track",
                title=row.title,
                artist=row.artist,
                album=row.album,
                duration=round(row.duration),
            )
            for row in entries
        ]
        self.downloads.library.annotate(results)
        for row, result in zip(entries, results, strict=True):
            row.owned = result.ownership in {"owned", "edition"}

    def prune(self) -> None:
        now = self.clock()
        for token in [token for token, row in self.previews.items() if row.expires <= now]:
            del self.previews[token]
        while len(self.previews) >= MAX_PREVIEWS:
            self.previews.popitem(last=False)

    async def resolve(self, url: str) -> dict[str, object]:
        url = url.strip()
        site = match(url)
        if site is None:
            raise LinkError(422, refusal(url))
        if not site.working:
            raise LinkError(422, unavailable(site))
        async with self.resolving:
            raw = await self.extract(canonical(url), site)
        if raw.get("kind") == "error":
            code = raw.get("code")
            if code == "LIVE_STREAM":
                raise LinkError(422, LIVE_MESSAGE)
            if code == "GEO_RESTRICTED":
                raise LinkError(422, error_guidance("GEO_RESTRICTED", site.label)[0])
            if code == "SITE_NOT_ALLOWED":
                raise LinkError(
                    422, f"The link led away from {site.label}. Musimo works with: {labels()}."
                )
            raise LinkError(
                422, f"Musimo could not read this {site.label} link. Check it opens in a browser."
            )
        listed = raw.get("entries")
        rows = listed if isinstance(listed, list) else []
        entries: list[LinkEntry] = []
        seen: set[str] = set()
        for row in rows[:MAX_ENTRIES]:
            item = self.entry(site, row)
            if item and item.id not in seen:
                seen.add(item.id)
                entries.append(item)
        single = raw.get("single") is True
        if not entries:
            live_only = bool(rows) and all(
                isinstance(row, dict) and row.get("live") is True for row in rows
            )
            raise LinkError(
                422, LIVE_MESSAGE if live_only else "There is nothing to download at this link."
            )
        for row in entries:
            if mixes.long_form(row.kind):
                # What the file will be tagged with, so the sheet and the ownership check show it.
                meta = self.metadata(site, row)
                row.artist, row.album = meta.artist, meta.album
                row.lands = mixes.landing(meta, self.downloads.today())
        self.owned(entries)
        self.prune()
        token = secrets.token_urlsafe(24)
        preview = Preview(
            site=site,
            single=single,
            title=text(raw.get("title")) or entries[0].title,
            entries=entries,
            truncated=len(rows) > MAX_ENTRIES,
            partial=raw.get("partial") is True,
            expires=self.clock() + PREVIEW_SECONDS,
        )
        self.previews[token] = preview
        return {
            "token": token,
            "site": site.label,
            "source": site.source,
            "kind": site.kind,
            "single": single,
            # A profile is a person's whole catalog, so the review sheet starts with nothing ticked.
            "profile": not single and site.is_profile(url),
            "title": preview.title,
            "truncated": preview.truncated,
            "partial": preview.partial,
            # What to know about the audio before queueing it, from the site's own row.
            "quality_note": site.quality_note,
            "expires_in": PREVIEW_SECONDS,
            "entries": [row.model_dump() for row in entries],
        }

    def metadata(self, site: Site, row: LinkEntry) -> Metadata:
        meta = Metadata(
            id=stable_id(f"{row.extractor}:{row.id}"),
            title=row.title,
            artist=row.artist,
            album_artist=row.artist,
            # A lone recording with no album is filed as its own single.
            album=row.album or row.title,
            date=row.date,
            duration=row.duration,
            art=row.art,
            track=row.track or 1,
            tracks=max(row.tracks, row.track, 1),
        )
        if mixes.long_form(row.kind):
            return mixes.retag(meta, site, row.kind, row.url, row.album_list)
        return meta

    def enqueue(self, request: LinkRequest) -> dict[str, object]:
        preview = self.previews.get(request.token)
        if preview is None or preview.expires <= self.clock():
            self.previews.pop(request.token, None)
            raise LinkError(404, "This link preview has expired. Paste the link again.")
        available = {row.id: row for row in preview.entries}
        wanted = list(dict.fromkeys(request.entry_ids))
        if any(entry_id not in available for entry_id in wanted):
            raise LinkError(422, "Choose entries from this link's preview.")
        service = self.downloads
        settings = service.settings()
        try:
            target = service.target(request.target or settings.destination)
        except ValueError as exc:
            raise LinkError(422, str(exc)) from exc
        service.check_destination(target)
        site = preview.site
        prepared: dict[int, tuple[Metadata, str]] = {}
        untidied: set[int] = set()
        kinds: dict[int, Kind] = {}
        for entry_id in wanted:
            row = available[entry_id]
            track_id = stable_id(f"{row.extractor}:{row.id}")
            kinds[track_id] = row.kind
            # An album track already has its album, and a site such as the Internet Archive holds
            # recordings that a catalog hit would file under the wrong release.
            if row.album_list or not site.catalog_tidy:
                untidied.add(track_id)
            prepared[track_id] = (self.metadata(site, row), row.url)
        grouped = len(prepared) > 1
        batch_id = uuid.uuid4().hex if grouped else ""
        jobs = service.jobs.enqueue_many(
            list(prepared),
            request.format or settings.output_format,
            str(target),
            batch_id,
            f"{preview.title} · {site.label}" if grouped else "",
            catalog="link",
            prepared=prepared,
            source=site.source,
            kind=site.kind,
            kinds=kinds,
            untidied=frozenset(untidied),
        )
        done = sum(job.stage == "done" for job in jobs)
        return {
            "id": batch_id,
            "jobs": [job.public() for job in jobs if job.stage != "done"],
            "skipped_done": done,
        }
