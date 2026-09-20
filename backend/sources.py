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
    # False for a site whose extractor cannot read the live site today. It stays in the table, so
    # its tests and probe keep running, but it is left out of the site list and refused at resolve.
    working: bool = True
    # When set, only a page whose path fits one of these patterns is taken. Needed where one host
    # also serves video or news pages that the site's audio must never reach.
    paths: tuple[str, ...] = ()
    # What the site's pages are, for the refusal when a path does not fit `paths`.
    only: str = ""
    # Pages that are always live, so never taken and refused with the live stream message.
    live_paths: tuple[str, ...] = ()
    # Address forms that mean the same page, as (path pattern, path template) pairs. The pattern's
    # named groups fill the template. Used where the site's own page is not one yt-dlp can read.
    rewrites: tuple[tuple[str, str], ...] = ()
    # Sources whose recordings this site's pages may hand over to. NTS episodes are hosted on
    # Mixcloud or SoundCloud, so a link there passes through to their extractors.
    hops: tuple[str, ...] = ()
    # From seconds: a recording of this row longer than this is a mix, not a song. 0 means never.
    mix_after: int = 0
    # Where a mix or radio show's uploader and show name live when the site does not say. Named
    # groups `uploader` and `show` are read from the page's path, and `show` from the title.
    url_names: str = ""
    title_show: str = ""

    def owns(self, host: str) -> bool:
        if host in self.hosts:
            return True
        return any(under(host, suffix) for suffix in self.host_suffixes)

    def takes(self, path: str) -> bool:
        """Whether a page of this site at `path` may be downloaded from."""
        if any(re.fullmatch(pattern, path) for pattern in self.live_paths):
            return False
        return not self.paths or any(re.fullmatch(pattern, path) for pattern in self.paths)

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
        # A track this long is a DJ set or a show, not a song.
        mix_after=20 * 60,
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
        # yt-dlp 2026.8.19 stops with "Failed to parse JSON" on the live site (19 September 2026).
        working=False,
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
    Site(
        source="mixcloud",
        label="Mixcloud",
        kind="mix",
        extractors=("mixcloud", "mixcloud:playlist", "mixcloud:user"),
        items=("mixcloud",),
        hosts=("mixcloud.com", "www.mixcloud.com", "m.mixcloud.com"),
        art_suffixes=("mixcloud.com",),
        # Mixcloud's live pages are streams that never end. `/live/<name>` also fits the
        # extractor for one show.
        live_paths=(r"/live/.*",),
        profile_pattern=r"/[^/]+/?|/[^/]+/(?:uploads|favorites|listens|stream)/?",
        quality_note="Mixcloud streams are AAC at up to about 192 kbps, not lossless.",
    ),
    Site(
        source="nts",
        label="NTS",
        kind="radio",
        # An episode page hands over to the Mixcloud or SoundCloud copy of the show.
        extractors=("nts.live", "mixcloud", "soundcloud"),
        items=("nts.live", "mixcloud", "soundcloud"),
        hosts=("nts.live", "www.nts.live"),
        hops=("mixcloud", "soundcloud"),
        art_suffixes=("mixcloud.com", "sndcdn.com"),
        paths=(r"/shows/[^/]+/episodes/[^/]+/?",),
        only="show episode pages",
        # The two live channels.
        live_paths=(r"/[12]/?",),
        url_names=r"/shows/(?P<show>[^/]+)/",
        quality_note=(
            "NTS episodes are read from their Mixcloud or SoundCloud copy, so the audio is "
            "AAC or MP3, not lossless."
        ),
    ),
    Site(
        source="hearthis",
        label="HearThisAt",
        kind="mix",
        extractors=("HearThisAt",),
        items=("hearthisat",),
        hosts=("hearthis.at", "www.hearthis.at"),
        art_suffixes=("hearthis.at",),
        # The page names no uploader, so the name in the address stands in for it.
        url_names=r"/(?P<uploader>[^/]+)/",
        quality_note="HearThisAt plays the file the DJ uploaded, usually MP3.",
    ),
    Site(
        source="bbc",
        label="BBC Sounds",
        kind="radio",
        # Not `bbc`, `bbc.co.uk:article` or the iPlayer lists: those are news and video pages.
        extractors=("bbc.co.uk",),
        items=("bbc.co.uk",),
        hosts=("bbc.co.uk", "www.bbc.co.uk"),
        art_hosts=("ichef.bbci.co.uk",),
        paths=(
            r"/programmes/(?:[pbml][\da-z]{7}|w[\da-z]{7,14})/?",
            r"/sounds/play/[pbml][\da-z]{7}/?",
        ),
        only="programme and Sounds pages",
        # yt-dlp reads a Sounds episode from its programme page, which has the same ID.
        rewrites=((r"/sounds/play/(?P<id>[pbml][\da-z]{7})/?", "/programmes/{id}"),),
        # Audio only, so a programme that is video fails instead of saving a video file.
        audio_format="bestaudio",
        # BBC titles read "Show, Episode".
        title_show=r"(?P<show>[^,]+),\s.+",
        quality_note="BBC Sounds streams are AAC. They only play in the UK.",
    ),
    Site(
        source="tunein",
        label="TuneIn",
        kind="radio",
        extractors=("tunein:podcast", "tunein:podcast:program"),
        items=("tunein:podcast",),
        hosts=("tunein.com",),
        # A station is live, and `/radio/` is where they all are.
        paths=(r"/podcasts/.+",),
        only="podcast pages",
        live_paths=(r"/radio/.+",),
        # yt-dlp 2026.8.19 gets "HTTP Error 400" and then "Items" from TuneIn's own API for every
        # programme tried (19 September 2026).
        working=False,
        quality_note="TuneIn podcasts play the publisher's own file.",
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
LIVE_MESSAGE = "Live streams never finish, so they can't be saved."


def match(url: str) -> Site | None:
    """The site of a web address a person pasted, or None. https addresses only."""
    parts = parse(url)
    if parts is None:
        return None
    host = parts.hostname or ""
    site = next((site for site in SITES if site.owns(host)), None)
    return site if site and site.takes(parts.path) else None


def match_entry(url: str) -> Site | None:
    """The site of a list entry or a job's address: a web address, or a site's `<prefix><id>`.

    Only the server's own lists and jobs reach this. Browser input goes through `match`, which
    never accepts the bare form.
    """
    if parse(url) is not None:
        return match(url)
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


def reaches(site: Site, url: str) -> bool:
    """Whether a link that started on `site` may end at `url`: the same site or one it hops to."""
    found = match_entry(url)
    return found is not None and (found is site or found.source in site.hops)


def canonical(url: str) -> str:
    """The address yt-dlp can read for a pasted one, where a site's row says they are the same."""
    parts = parse(url)
    site = match(url)
    if parts is None or site is None:
        return url
    for pattern, template in site.rewrites:
        if found := re.fullmatch(pattern, parts.path):
            return parts._replace(path=template.format(**found.groupdict()), query="").geturl()
    return url


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
    return ", ".join(site.label for site in SITES if site.working)


def unavailable(site: Site) -> str:
    """Why a site that is in the table is not taken today."""
    return f"{site.label} links don't work right now. The tool Musimo uses can't read that site."


def refusal(url: str) -> str:
    """The plain reason a link is not accepted. Call only after `match` returned None."""
    parts = parse(url)
    host = parts.hostname if parts else None
    if host in CATALOG_HOSTS:
        return "Catalog imports are not built yet."
    owner = next((site for site in SITES if host and site.owns(host)), None)
    if parts and owner:
        if any(re.fullmatch(pattern, parts.path) for pattern in owner.live_paths):
            return LIVE_MESSAGE
        if owner.only:
            return f"Musimo only takes {owner.only} from {owner.label}."
    where = host or "this link"
    return f"Musimo can't download from {where}. It works with: {labels()}."


def safe_art(site: Site, url: str) -> str:
    parts = parse(url)
    host = parts.hostname if parts else None
    if not host:
        return ""
    ok = host in site.art_hosts or any(under(host, suffix) for suffix in site.art_suffixes)
    return url if ok else ""
