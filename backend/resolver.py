"""Read what a pasted link points at without downloading anything.

Runs as its own process, like the download worker, so yt-dlp never loads into the server and a
slow site can be stopped by ending the process. Input is one JSON object on stdin, output one
JSON line on stdout. The server checks everything printed here again before using it.
"""

import json
import queue
import re
import sys
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import islice
from typing import cast
from urllib.parse import quote, urlsplit

from backend.errors import geo_restricted
from backend.library import normalize
from backend.sources import Site, by_source, match, match_entry, reaches
from backend.worker import Downloader, base_options, emit, live, redact

# One more than the preview cap, so the server can say the list was cut short.
LIMIT = 501
# Two files of one track differ in length by an encoder's padding, not by seconds.
SAME_TRACK_SECONDS = 2
# The server gives a resolve 20 seconds and stops the process at the end of them, so the lookups
# below give up well before that and the preview still goes out.
BUDGET_SECONDS = 14
# Pages read at once, and the most a single preview will read beyond the list itself.
LOOKUP_THREADS = 4
LOOKUP_LIMIT = 40
OPEN_LIMIT = 10
# YouTube's own thumbnail names, best first. Its numbered files are small frame grabs.
YOUTUBE_ART = {"maxresdefault.jpg": 3, "sddefault.jpg": 2, "hqdefault.jpg": 1}
NUMBERED_FRAME = re.compile(r"(?:sd|hq|mq)?\d\.jpg")


def extractor_name(raw: dict[str, object], parent: dict[str, object] | None = None) -> str:
    """The extractor that produced an entry. Flat list entries only carry the class key."""
    if name := raw.get("extractor"):
        return str(name).lower()
    key = raw.get("ie_key")
    if not key:
        # An extractor that builds its own entries leaves them unnamed, so they take the list's.
        return str((parent or {}).get("extractor") or "").lower()
    from yt_dlp.extractor import get_info_extractor  # type: ignore[import-untyped]

    try:
        return str(get_info_extractor(str(key)).IE_NAME).lower()
    except (KeyError, AttributeError):
        return ""


def page_extractor(url: str) -> str:
    """The extractor yt-dlp would pick for an address, without reading the page.

    The server uses it to tell a list page from one recording when a resolve runs out of time.
    """
    from yt_dlp.extractor import gen_extractor_classes

    for extractor in gen_extractor_classes():
        if extractor.ie_key() != "Generic" and extractor.suitable(url):
            return str(extractor.IE_NAME).lower()
    return ""


def jpeg_name(name: str, bare: bool) -> bool:
    """Whether a file name says JPEG. With `bare`, a name with no extension at all may be one."""
    return name.endswith(".jpg") or (bare and bool(name) and "." not in name)


def artwork(raw: dict[str, object], bare: bool = False) -> str:
    """The best JPEG the site lists. The worker only embeds JPEG covers.

    Some sites (Mixcloud) serve a cover from an address with no file name extension. `bare` takes
    those too: the download checks the bytes are a JPEG before it embeds anything.
    """
    thumbnails = raw.get("thumbnails")
    best: tuple[tuple[int, int, int], str] | None = None
    if isinstance(thumbnails, list):
        for index, row in enumerate(thumbnails):
            if not isinstance(row, dict):
                continue
            url = str(row.get("url", ""))
            name = urlsplit(url).path.rsplit("/", 1)[-1]
            if not jpeg_name(name, bare):
                continue
            width, height = row.get("width"), row.get("height")
            area = width * height if isinstance(width, int) and isinstance(height, int) else 0
            # A named YouTube size beats any other, and a numbered frame loses to everything.
            rank = -1 if NUMBERED_FRAME.fullmatch(name) else YOUTUBE_ART.get(name, 0)
            # yt-dlp lists worst to best once it has sorted them, so a tie goes to the later one.
            key = (rank, area, index)
            if best is None or key > best[0]:
                best = (key, url)
    if best:
        return best[1]
    thumbnail = str(raw.get("thumbnail") or "")
    return thumbnail if jpeg_name(urlsplit(thumbnail).path.rsplit("/", 1)[-1], bare) else ""


def day(raw: dict[str, object]) -> str:
    """The release day, else the upload day, else the release year. Empty when none is known."""
    for key, stamped in (
        ("release_date", False),
        ("release_timestamp", True),
        ("upload_date", False),
        ("timestamp", True),
    ):
        value = raw.get(key)
        if stamped and isinstance(value, int | float) and 0 < value < 4e9:
            # yt-dlp derives the date fields only after it has processed a result, so a raw result
            # from a site that gives seconds since 1970 has to be converted here.
            return datetime.fromtimestamp(value, UTC).strftime("%Y-%m-%d")
        text = str(value or "")
        if not stamped and len(text) == 8 and text.isdigit():
            return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    year = raw.get("release_year")
    return str(year) if isinstance(year, int) and 1000 <= year <= 9999 else ""


def people(raw: dict[str, object], *keys: str) -> str:
    """The people a result names under the first of `keys` that has any, joined by commas."""
    for key in keys:
        listed = raw.get(key)
        if isinstance(listed, list):
            found = [name.strip() for name in listed if isinstance(name, str) and name.strip()]
            if found:
                return ", ".join(found)
    return ""


def creators(raw: dict[str, object]) -> str:
    return people(raw, "creators", "artists") or str(raw.get("creator") or "")


def entry(
    raw: dict[str, object],
    site: Site,
    parent: dict[str, object] | None = None,
    album: bool = False,
) -> dict[str, object]:
    """One preview row. `parent` is the list the row came from, and `album` says it is one album."""
    # Anything outside a plain set of characters is percent encoded, so a file name with spaces
    # or quotes still makes a plain ID and a valid address.
    entry_id = quote(str(raw.get("id") or ""), safe="/:")
    url = str(raw.get("webpage_url") or raw.get("url") or "")
    if not url and site.entry_url and entry_id:
        url = site.entry_url.replace("{id}", entry_id)
    artist = str(raw.get("artist") or creators(raw) or "")
    # SoundCloud copies the set's title into every row, playlists included, so a row that says it
    # belongs to a plain playlist has no album of its own.
    title = "" if raw.get("album_type") == "playlist" else str(raw.get("album") or "")
    date = day(raw)
    bare = site.kind != "music"
    art = (
        site.art_url.replace("{item}", entry_id.split("/")[0])
        if site.art_url and entry_id
        else artwork(raw, bare)
    )
    if album and parent:
        # An album's list is the album: its title, creator, date and cover belong to every track.
        artist = artist or people(raw, "album_artists") or str(raw.get("album_artist") or "")
        artist = artist or creators(parent)
        title = str(parent.get("title") or title)
        date = date or day(parent)
        art = art or artwork(parent, bare)
    elif site.names_artist:
        artist = artist or str(raw.get("uploader") or raw.get("channel") or "")
    if site.kind != "music":
        # A mix's artist tags list the tracks played in it. Its uploader is the DJ.
        artist = str(raw.get("uploader") or raw.get("channel") or artist)
    return {
        "id": entry_id,
        "extractor": extractor_name(raw, parent),
        "url": url,
        "title": str(raw.get("track") or raw.get("title") or ""),
        "artist": artist,
        "album": title,
        # The show this recording belongs to, where the site names one itself (BBC Sounds does).
        # A mix or radio show is filed under it instead of one read from the title.
        "show": str(raw.get("series") or raw.get("playlist_title") or ""),
        "date": date,
        "duration": raw.get("duration") or 0,
        "art": art,
        "live": live(raw),
        # Set by `number` when the list is an album. `album_list` is true for a track that came
        # from one, which the server keeps to decide how the track is tagged.
        "track": 0,
        "tracks": 0,
        "album_list": album,
    }


def track_number(raw: dict[str, object]) -> int:
    value = raw.get("track_number")
    return value if isinstance(value, int) and 0 < value < 10000 else 0


def has_flac(raw: dict[str, object]) -> bool:
    formats = raw.get("formats")
    names = [str(raw.get("id") or "")]
    if isinstance(formats, list):
        names += [str(row.get("url", "")) for row in formats if isinstance(row, dict)]
    return any(name.split("?")[0].lower().endswith(".flac") for name in names)


def title_of(raw: dict[str, object]) -> str:
    return normalize(str(raw.get("track") or raw.get("title") or ""))


def alike(one: dict[str, object], other: dict[str, object]) -> bool:
    """Whether two rows with the same title are the same length and do not differ in number."""
    numbers = (track_number(one), track_number(other))
    if all(numbers) and numbers[0] != numbers[1]:
        return False
    lengths = [row.get("duration") for row in (one, other)]
    if all(isinstance(length, int | float) and length > 0 for length in lengths):
        return abs(cast(float, lengths[0]) - cast(float, lengths[1])) <= SAME_TRACK_SECONDS
    return True


def one_per_track(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """List each track once, in first-seen order, keeping the FLAC copy when there is one."""
    kept: list[dict[str, object]] = []
    # Only rows with the same title can be copies, so each row meets its own title's rows and no
    # title is normalised twice.
    seen: defaultdict[str, list[int]] = defaultdict(list)
    for row in rows:
        title = title_of(row)
        twin = next((i for i in seen[title] if alike(kept[i], row)), None) if title else None
        if twin is None:
            seen[title].append(len(kept))
            kept.append(row)
        elif has_flac(row) and not has_flac(kept[twin]):
            kept[twin] = row
    return kept


def number(entries: list[dict[str, object]], rows: list[dict[str, object]]) -> None:
    """Number an album's tracks: the site's own when every track has one, else the list order."""
    given = [track_number(row) for row in rows]
    use_given = bool(given) and all(given) and len(set(given)) == len(given)
    total = max(len(entries), *given) if use_given else len(entries)
    for position, (item, own) in enumerate(zip(entries, given, strict=True), 1):
        item["track"] = own if use_given else position
        item["tracks"] = total


Lookup = Callable[[str], dict[str, object] | None]


def looked_up(lookup: Lookup, addresses: list[str], seconds: float) -> dict[str, dict[str, object]]:
    """Read several pages at once and return what came back in time.

    A page that fails or is still loading when the time is up is left out. The threads are daemons,
    so one that is still waiting on a slow site never holds the process open.
    """
    found: dict[str, dict[str, object]] = {}
    if seconds <= 0:
        return found
    waiting: queue.SimpleQueue[str] = queue.SimpleQueue()
    for address in dict.fromkeys(addresses):
        waiting.put(address)

    def work() -> None:
        while True:
            try:
                address = waiting.get_nowait()
            except queue.Empty:
                return
            # One more try after a pause: a busy site answers the first of several at once with
            # "too many requests".
            for attempt in range(2):
                try:
                    info = lookup(address)
                except Exception:
                    if attempt == 0:
                        time.sleep(1.0)
                    continue
                if isinstance(info, dict):
                    found[address] = info
                break

    threads = [threading.Thread(target=work, daemon=True) for _ in range(LOOKUP_THREADS)]
    for thread in threads:
        thread.start()
    end = time.monotonic() + seconds
    for thread in threads:
        thread.join(max(0.0, end - time.monotonic()))
    return dict(found)


def is_album(site: Site, raw: dict[str, object]) -> bool:
    """Whether a list is one album. SoundCloud says so itself: a plain playlist is not one."""
    return extractor_name(raw) in site.album_lists and raw.get("album_type") != "playlist"


def row_url(row: dict[str, object]) -> str:
    return str(row.get("webpage_url") or row.get("url") or "")


def rows_of(raw: dict[str, object]) -> list[dict[str, object]]:
    listed = raw.get("entries") or []
    capped = islice(iter(cast(Iterable[object], listed)), LIMIT)
    return [row for row in capped if isinstance(row, dict)]


@dataclass
class Group:
    """Rows that share one list, so they share what the list says about them."""

    parent: dict[str, object]
    album: bool
    rows: list[dict[str, object]] = field(default_factory=list)
    entries: list[dict[str, object]] = field(default_factory=list)


def to_open(site: Site, parent: dict[str, object], row: dict[str, object]) -> bool:
    """Whether a row of a profile is a release or playlist to open, not a recording."""
    return (
        extractor_name(parent) in site.expands
        and extractor_name(row, parent) not in site.items
        and match_entry(row_url(row)) is site
    )


def groups_of(
    site: Site,
    parent: dict[str, object],
    rows: list[dict[str, object]],
    opened: dict[str, dict[str, object]],
) -> tuple[list[Group], bool]:
    """Split a list's rows into groups, and say whether some of it had to be left out."""
    album = is_album(site, parent)
    if album and site.format_copies:
        rows = one_per_track(rows)
    groups: list[Group] = []
    left_out = False
    for row in rows:
        if to_open(site, parent, row):
            info = opened.get(row_url(row))
            if info is None:
                left_out = True
            elif info.get("_type") in {"playlist", "multi_video"}:
                groups.append(Group(info, is_album(site, info), rows_of(info)))
            else:
                groups.append(Group(parent, False, [info]))
        elif groups and groups[-1].parent is parent:
            groups[-1].rows.append(row)
        else:
            groups.append(Group(parent, album, [row]))
    return groups, left_out


def listing(
    site: Site, parent: dict[str, object], lookup: Lookup, deadline: float
) -> tuple[list[dict[str, object]], bool]:
    """The preview rows of a list, and whether some of it could not be read in time."""

    def seconds() -> float:
        # Nothing is started once the time is spent, so the whole preview stays inside its budget.
        return max(0.0, deadline - time.monotonic())

    rows = rows_of(parent)
    wanted = [row_url(row) for row in rows if to_open(site, parent, row)]
    opened = looked_up(lookup, wanted[:OPEN_LIMIT], seconds()) if wanted else {}
    groups, partial = groups_of(site, parent, rows, opened)
    for group in groups:
        group.entries = [entry(row, site, group.parent, group.album) for row in group.rows]
    # A list often names its tracks and nothing more: no title, or no artist for the album. One
    # read of each such page fills them in, within the time and page limits.
    # Only the site's own pages are read, whatever address a list gives.
    wanted = [
        str(item["url"])
        for group in groups
        for item in group.entries
        if not item["title"] and match_entry(str(item["url"])) is site
    ][:LOOKUP_LIMIT]
    for group in groups:
        first = group.entries[0] if group.entries else None
        if group.album and site.names_artist and first and not first["artist"]:
            if match_entry(str(first["url"])) is site:
                wanted.append(str(first["url"]))
    found = looked_up(lookup, wanted, seconds()) if wanted else {}
    entries: list[dict[str, object]] = []
    for group in groups:
        for index, (row, item) in enumerate(zip(group.rows, group.entries, strict=True)):
            info = found.get(str(item["url"]))
            if info and not item["title"]:
                # The page's own answer wins over what the list said, but keeps the list's address.
                merged = row | {k: v for k, v in info.items() if v not in (None, "")}
                group.rows[index] = merged
                group.entries[index] = entry(merged, site, group.parent, group.album)
        if group.album and group.entries:
            first_info = found.get(str(group.entries[0]["url"]))
            head = entry(first_info, site, group.parent, True) if first_info else {}
            # What the first track's page says about the album fills what the list left blank.
            for key in ("artist", "date", "art"):
                for item in group.entries:
                    item[key] = item[key] or head.get(key, "")
            # Numbered before any unread track is dropped, so a gap keeps its place.
            number(group.entries, group.rows)
        for item in group.entries:
            if item["title"]:
                entries.append(item)
            else:
                partial = True
    return entries, partial


def resolve(downloader: Downloader, site: Site, url: str, lookup: Lookup | None = None) -> None:
    deadline = time.monotonic() + BUDGET_SECONDS
    if lookup is None:

        def lookup(address: str) -> dict[str, object] | None:
            info = downloader.extract_info(address, download=False, process=False)
            return info if isinstance(info, dict) else None

    raw: object = None
    origin = url
    # Follow at most a few hops, and only while they stay on the same site or one it hands over to.
    for _ in range(3):
        raw = downloader.extract_info(url, download=False, process=False)
        if not isinstance(raw, dict) or raw.get("_type") not in {"url", "url_transparent"}:
            break
        url = str(raw.get("url", ""))
        if not reaches(site, url):
            emit("error", code="SITE_NOT_ALLOWED", message="The link led to another site")
            return
    if not isinstance(raw, dict):
        emit("error", code="FAILED", message="The site returned nothing")
        return
    if raw.get("_type") in {"playlist", "multi_video"}:
        entries, partial = listing(site, raw, lookup, deadline)
        emit(
            "preview",
            single=False,
            title=str(raw.get("title") or ""),
            entries=entries,
            partial=partial,
        )
        return
    if live(raw):
        emit("error", code="LIVE_STREAM", message="The link is a live stream")
        return
    item = entry(raw, site)
    if match_entry(str(item["url"])) is not site:
        # A show that lives on another site's copy (NTS on Mixcloud). The job downloads the address
        # that was pasted, and yt-dlp passes through to the copy the same way.
        item["url"] = origin
    emit("preview", single=True, title=str(raw.get("title") or ""), entries=[item])


def main() -> None:
    import yt_dlp  # type: ignore[import-untyped]

    request: object = json.loads(sys.stdin.read())
    if not isinstance(request, dict):
        emit("error", code="FAILED", message="Bad request")
        return
    url = str(request.get("url", ""))
    site = by_source(str(request.get("source", "")))
    # The server checked this already. Checking again keeps this process safe on its own.
    if site is None or match(url) is not site:
        emit("error", code="SITE_NOT_ALLOWED", message="The site is not on the list")
        return
    # Said first, before the slow read, so a resolve that runs out of time still told the server
    # what kind of page it was on.
    emit("page", extractor=page_extractor(url))
    options = base_options() | {
        "skip_download": True,
        "extract_flat": "in_playlist",
        "noplaylist": False,
        "playlistend": LIMIT,
        "allowed_extractors": site.allowed_extractors(),
    }
    downloader = cast(Downloader, yt_dlp.YoutubeDL(options))

    def lookup(address: str) -> dict[str, object] | None:
        # A downloader of its own for each page, because one is not built for several threads.
        reader = cast(Downloader, yt_dlp.YoutubeDL(options))
        try:
            info = reader.extract_info(address, download=False, process=False)
            return info if isinstance(info, dict) else None
        finally:
            reader.close()

    try:
        resolve(downloader, site, url, lookup)
    except Exception as exc:
        message = redact(str(exc))
        lower = message.lower()
        code = (
            "GEO_RESTRICTED"
            if geo_restricted(lower)
            else "SITE_NOT_ALLOWED"
            if "no suitable extractor" in lower or "unsupported url" in lower
            # YouTube refuses to read a stream that has not started yet.
            else "LIVE_STREAM"
            if "live event" in lower
            else "FAILED"
        )
        emit("error", code=code, message=message)
    finally:
        downloader.close()


if __name__ == "__main__":
    main()
