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
    # A site that gives each artist a subdomain lists the parent here: `bandcamp.com` accepts
    # `band.bandcamp.com` but never `evilbandcamp.com` or `bandcamp.com.evil.test`.
    host_suffixes: tuple[str, ...] = ()
    # Artwork is fetched by the server, so its hosts are allowlisted as well.
    art_hosts: tuple[str, ...] = ()
    art_suffixes: tuple[str, ...] = ()
    # Path prefixes that mean a person's or channel's page rather than one list.
    profile_paths: tuple[str, ...] = ()
    # Or a pattern the whole path must fit, for sites where a profile is a bare `/name`.
    profile_pattern: str = ""
    # The yt-dlp format selector for a recording from this site.
    audio_format: str = "bestaudio/best"
    # Extractors whose list is one album: its title names the album, its creator is the artist,
    # and its entries are the tracks. A site that says otherwise about one list (SoundCloud marks
    # a plain playlist) is not an album for that list.
    album_lists: tuple[str, ...] = ()
    # Lists whose entries are lists too. Each entry is opened once, so the recordings inside show.
    expands: tuple[str, ...] = ()
    # A recording's page or its uploader names the artist. Off where neither does: the Internet
    # Archive's uploader is an email address.
    names_artist: bool = True
    # The site lists one track once per file format, so the listing keeps one of each.
    format_copies: bool = False
    # Where one entry of a list lives when the list gives no address for it. `{id}` is filled in.
    entry_url: str = ""
    # Where a list entry's cover lives when the site lists none. `{item}` is the item's first ID
    # segment.
    art_url: str = ""
    # An address of the form `<prefix><id>` that the site's extractor accepts.
    id_prefix: str = ""
    # Whether a loose recording may be retagged from the Deezer catalog. Off for a site whose
    # recordings are not studio releases.
    catalog_tidy: bool = True
    # What a person should know about the audio before queueing it. Shown on the review sheet.
    quality_note: str = ""

    def owns(self, host: str) -> bool:
        if host in self.hosts:
            return True
        return any(under(host, suffix) for suffix in self.host_suffixes)

    def is_profile(self, url: str) -> bool:
        parts = parse(url)
        if parts is None:
            return False
        if self.profile_paths and parts.path.startswith(self.profile_paths):
            return True
        pattern = self.profile_pattern
        return bool(pattern) and re.fullmatch(pattern, parts.path) is not None

    def allowed_extractors(self) -> list[str]:
        # yt-dlp reads these as regular expressions, and the names contain ':'.
        return [re.escape(name) for name in self.extractors]


def under(host: str, suffix: str) -> bool:
    """Whether `host` is a real subdomain of `suffix`: one or more whole, non-empty labels."""
    if not host.endswith("." + suffix):
        return False
    labels = host[: -len(suffix) - 1].split(".")
    return all(labels)


# Some sites offer a free download in a lossless format the worker cannot keep in a tagged file
# (ALAC, WAV, AIFF), and yt-dlp would rank it first. This takes the best of everything else. The
# `?` keeps formats whose codec the site does not say, and `best` covers a site that does not mark
# its formats as audio only.
KEPT_AUDIO = (
    "bestaudio[acodec!=?alac][acodec!=?wav][acodec!=?aiff]"
    "/best[acodec!=?alac][acodec!=?wav][acodec!=?aiff]"
)

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
        # An item's image is served from a storage host of the Archive after a redirect.
        art_suffixes=("archive.org",),
        # FLAC when the item has it, then the formats the worker keeps, best source first.
        audio_format="best[ext=flac]/best[ext=mp3]/best[ext=ogg]/best[ext=m4a]",
        album_lists=("archive.org",),
        format_copies=True,
        names_artist=False,
        entry_url="https://archive.org/details/{id}",
        art_url="https://archive.org/services/img/{item}",
        # Live shows and old transfers are not studio releases, and a catalog hit would file
        # one under the studio album of the same name.
        catalog_tidy=False,
    ),
    Site(
        source="bandcamp",
        label="Bandcamp",
        kind="music",
        extractors=("Bandcamp", "Bandcamp:album", "Bandcamp:user"),
        items=("bandcamp",),
        hosts=("bandcamp.com",),
        host_suffixes=("bandcamp.com",),
        art_suffixes=("bcbits.com",),
        # An artist's own page: the bare subdomain or its /music list.
        profile_pattern=r"/?(?:music/?)?",
        audio_format=KEPT_AUDIO,
        album_lists=("bandcamp:album",),
        expands=("bandcamp:user",),
        quality_note=(
            "Bandcamp streams are 128 kbps MP3. When the artist offers a free download you "
            "get that file instead, often lossless. Otherwise, buying the album there gets "
            "you lossless."
        ),
    ),
    Site(
        source="soundcloud",
        label="SoundCloud",
        kind="music",
        extractors=(
            "soundcloud",
            "soundcloud:set",
            "soundcloud:playlist",
            "soundcloud:user",
        ),
        items=("soundcloud",),
        hosts=(
            "soundcloud.com",
            "www.soundcloud.com",
            "m.soundcloud.com",
            # Where a list entry with no page of its own is addressed.
            "api.soundcloud.com",
            "api-v2.soundcloud.com",
        ),
        art_suffixes=("sndcdn.com",),
        audio_format=KEPT_AUDIO,
        profile_pattern=(
            r"/[^/]+/?|/[^/]+/(?:tracks|albums|sets|reposts|likes|spotlight|comments)/?"
        ),
        album_lists=("soundcloud:set", "soundcloud:playlist"),
        expands=("soundcloud:user",),
        quality_note=(
            "SoundCloud free streams are 160 kbps AAC or 128 kbps MP3. "
            "A download button on the track gives you the artist's own file."
        ),
    ),
    Site(
        source="audiomack",
        label="Audiomack",
        kind="music",
        extractors=("audiomack", "audiomack:album"),
        items=("audiomack",),
        hosts=("audiomack.com", "www.audiomack.com"),
        art_hosts=("assets.audiomack.com",),
        audio_format=KEPT_AUDIO,
        album_lists=("audiomack:album",),
        quality_note=(
            "Audiomack does not say what quality its streams are. Expect a standard "
            "stream, not lossless."
        ),
    ),
    Site(
        source="audius",
        label="Audius",
        kind="music",
        extractors=("Audius", "audius:track", "audius:playlist", "audius:artist"),
        items=("audius", "audius:track"),
        hosts=("audius.co", "www.audius.co"),
        profile_pattern=r"/[^/]+/?",
        audio_format=KEPT_AUDIO,
        id_prefix="audius:",
        quality_note="Audius streams are 320 kbps MP3.",
    ),
    Site(
        source="jamendo",
        label="Jamendo",
        kind="music",
        extractors=("Jamendo", "JamendoAlbum"),
        items=("jamendo",),
        hosts=("jamendo.com", "www.jamendo.com"),
        art_suffixes=("jamendo.com",),
        audio_format=KEPT_AUDIO,
        album_lists=("jamendoalbum",),
        quality_note=(
            "Jamendo serves MP3, Ogg and FLAC, and Musimo takes the best one it is given."
        ),
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


ADDRESS_ID = re.compile(r"[A-Za-z0-9]{1,40}")


def match(url: str) -> Site | None:
    parts = parse(url)
    if parts is None:
        # A list entry may be addressed as `<prefix><id>`, which is not a web address.
        return next(
            (
                site
                for site in SITES
                if site.id_prefix
                and url.startswith(site.id_prefix)
                and ADDRESS_ID.fullmatch(url[len(site.id_prefix) :])
            ),
            None,
        )
    host = parts.hostname or ""
    return next((site for site in SITES if site.owns(host)), None)


def by_source(source: str) -> Site | None:
    return next((site for site in SITES if site.source == source), None)


# Sources that are not a link site, and so are not in the table.
OTHER_LABELS = {"podcast": "Podcasts"}


def source_label(source: str) -> str:
    """The name to show for a job's source. The browser does not keep a table of its own."""
    site = by_source(source)
    if site:
        return site.label
    return OTHER_LABELS.get(source) or source.capitalize()


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
    host = parts.hostname if parts else None
    if not host:
        return ""
    ok = host in site.art_hosts or any(under(host, suffix) for suffix in site.art_suffixes)
    return url if ok else ""
