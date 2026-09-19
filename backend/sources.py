"""Sites a pasted link may download from.

Nothing outside this table reaches yt-dlp. The worker passes the same extractor names as
`allowed_extractors`, which switches off yt-dlp's generic extractor, so a link can never make
the server fetch an arbitrary address and a redirect to an unlisted site fails.
"""

import ipaddress
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import SplitResult, urlsplit

Kind = Literal["music", "mix", "radio"]


@dataclass(frozen=True)
class Site:
    source: str
    label: str
    kind: Kind
    # Every extractor a link on this site may pass through, including list pages.
    extractors: tuple[str, ...]
    # The extractors whose result is one recording. Only these are ever downloaded.
    items: tuple[str, ...]
    hosts: tuple[str, ...]
    # Artwork is fetched by the server, so its hosts are allowlisted as well.
    art_hosts: tuple[str, ...] = ()
    # Path prefixes that mean a person's or channel's page rather than one list.
    profile_paths: tuple[str, ...] = ()
    # The yt-dlp format selector for a recording from this site.
    audio_format: str = "bestaudio/best"
    # A list on this site is one album: its title names the album, its creator is the artist,
    # and its entries are the tracks, each listed once however many formats it comes in.
    album_lists: bool = False
    # Where one entry of a list lives when the list gives no address for it. `{id}` is filled in.
    entry_url: str = ""

    def is_profile(self, url: str) -> bool:
        parts = parse(url)
        return parts is not None and parts.path.startswith(self.profile_paths)

    def allowed_extractors(self) -> list[str]:
        # yt-dlp reads these as regular expressions, and the names contain ':'.
        return [re.escape(name) for name in self.extractors]


SITES: tuple[Site, ...] = (
    Site(
        source="youtube",
        label="YouTube",
        kind="music",
        extractors=("youtube", "youtube:tab", "youtube:playlist", "YoutubeYtBe"),
        items=("youtube",),
        hosts=("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"),
        art_hosts=("i.ytimg.com",),
        profile_paths=("/@", "/channel/", "/c/", "/user/"),
        audio_format="bestaudio",
    ),
    Site(
        source="archive",
        label="Internet Archive",
        kind="music",
        extractors=("archive.org",),
        items=("archive.org",),
        hosts=("archive.org", "www.archive.org"),
        art_hosts=("archive.org",),
        # FLAC when the item has it, then the formats the worker keeps, best source first.
        audio_format="best[ext=flac]/best[ext=mp3]/best[ext=ogg]/best[ext=m4a]",
        album_lists=True,
        entry_url="https://archive.org/details/{id}",
    ),
)

# Links to stores whose audio is DRM. They can only become catalog imports later.
CATALOG_HOSTS = frozenset(
    {"open.spotify.com", "play.spotify.com", "spotify.link", "music.apple.com", "itunes.apple.com"}
)


def parse(url: str) -> SplitResult | None:
    """Split an https URL without credentials or a non-default port, or return None."""
    if len(url) > 2000 or any(ord(char) < 33 for char in url):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or parts.username is not None or parts.password is not None:
        return None
    if port not in (None, 443) or not parts.hostname:
        return None
    try:
        ipaddress.ip_address(parts.hostname)
    except ValueError:
        return parts
    return None


def match(url: str) -> Site | None:
    parts = parse(url)
    if parts is None:
        return None
    host = parts.hostname
    return next((site for site in SITES if host in site.hosts), None)


def by_source(source: str) -> Site | None:
    return next((site for site in SITES if site.source == source), None)


def labels() -> str:
    return ", ".join(site.label for site in SITES)


def refusal(url: str) -> str:
    """The plain reason a link is not accepted. Call only after `match` returned None."""
    parts = parse(url)
    host = parts.hostname if parts else None
    if host in CATALOG_HOSTS:
        return "Catalog imports are not built yet."
    where = host or "this link"
    return f"Musimo can't download from {where}. It works with: {labels()}."


def safe_art(site: Site, url: str) -> str:
    parts = parse(url)
    return url if parts and parts.hostname in site.art_hosts else ""
