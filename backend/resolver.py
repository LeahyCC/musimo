"""Read what a pasted link points at without downloading anything.

Runs as its own process, like the download worker, so yt-dlp never loads into the server and a
slow site can be stopped by ending the process. Input is one JSON object on stdin, output one
JSON line on stdout. The server checks everything printed here again before using it.
"""

import json
import re
import sys
from collections.abc import Iterable
from itertools import islice
from typing import cast
from urllib.parse import quote, urlsplit

from backend.library import normalize
from backend.sources import Site, by_source, match
from backend.worker import Downloader, base_options, emit, live, redact

# One more than the preview cap, so the server can say the list was cut short.
LIMIT = 501
# Two files of one track differ in length by an encoder's padding, not by seconds.
SAME_TRACK_SECONDS = 2
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


def artwork(raw: dict[str, object]) -> str:
    """The best JPEG the site lists. The worker only embeds JPEG covers."""
    thumbnails = raw.get("thumbnails")
    best: tuple[tuple[int, int, int], str] | None = None
    if isinstance(thumbnails, list):
        for index, row in enumerate(thumbnails):
            if not isinstance(row, dict):
                continue
            url = str(row.get("url", ""))
            name = urlsplit(url).path.rsplit("/", 1)[-1]
            if not name.endswith(".jpg"):
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
    return thumbnail if thumbnail.split("?")[0].endswith(".jpg") else ""


def day(raw: dict[str, object]) -> str:
    value = str(raw.get("release_date") or raw.get("upload_date") or "")
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    year = raw.get("release_year")
    return str(year) if isinstance(year, int) and 1000 <= year <= 9999 else ""


def creators(raw: dict[str, object]) -> str:
    listed = raw.get("creators")
    if isinstance(listed, list):
        names = [name.strip() for name in listed if isinstance(name, str) and name.strip()]
        if names:
            return ", ".join(names)
    return str(raw.get("creator") or "")


def entry(
    raw: dict[str, object], site: Site, parent: dict[str, object] | None = None
) -> dict[str, object]:
    """One preview row. `parent` is the list the row came from, if any."""
    # Anything outside a plain set of characters is percent encoded, so a file name with spaces
    # or quotes still makes a plain ID and a valid address.
    entry_id = quote(str(raw.get("id") or ""), safe="/:")
    url = str(raw.get("webpage_url") or raw.get("url") or "")
    if not url and site.entry_url and entry_id:
        url = site.entry_url.replace("{id}", entry_id)
    artist = str(raw.get("artist") or creators(raw) or "")
    album = str(raw.get("album") or "")
    date = day(raw)
    if site.album_lists:
        # An album site's list is the album: its title, creator and date belong to every track.
        # Its uploader is an account name, so it never stands in for the artist.
        if parent:
            artist = artist or creators(parent)
            album = str(parent.get("title") or album)
            date = date or day(parent)
    else:
        artist = artist or str(raw.get("uploader") or raw.get("channel") or "")
    return {
        "id": entry_id,
        "extractor": extractor_name(raw, parent),
        "url": url,
        "title": str(raw.get("track") or raw.get("title") or ""),
        "artist": artist,
        "album": album,
        "date": date,
        "duration": raw.get("duration") or 0,
        "art": artwork(raw),
        "live": live(raw),
        # Filled in by `number` when the list is an album.
        "track": 0,
        "tracks": 0,
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


def same_track(one: dict[str, object], other: dict[str, object]) -> bool:
    """Whether two list rows are one track in two formats."""
    titles = [normalize(str(row.get("track") or row.get("title") or "")) for row in (one, other)]
    if not titles[0] or titles[0] != titles[1]:
        return False
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
    for row in rows:
        twin = next((i for i, other in enumerate(kept) if same_track(other, row)), None)
        if twin is None:
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


def resolve(downloader: Downloader, site: Site, url: str) -> None:
    raw: object = None
    # Follow at most a few hops, and only while they stay on the same site.
    for _ in range(3):
        raw = downloader.extract_info(url, download=False, process=False)
        if not isinstance(raw, dict) or raw.get("_type") not in {"url", "url_transparent"}:
            break
        url = str(raw.get("url", ""))
        if match(url) is not site:
            emit("error", code="SITE_NOT_ALLOWED", message="The link led to another site")
            return
    if not isinstance(raw, dict):
        emit("error", code="FAILED", message="The site returned nothing")
        return
    if raw.get("_type") in {"playlist", "multi_video"}:
        listed = raw.get("entries") or []
        capped = islice(iter(cast(Iterable[object], listed)), LIMIT)
        rows = [row for row in capped if isinstance(row, dict)]
        if site.album_lists:
            rows = one_per_track(rows)
        entries = [entry(row, site, raw) for row in rows]
        if site.album_lists:
            number(entries, rows)
        emit("preview", single=False, title=str(raw.get("title") or ""), entries=entries)
        return
    if live(raw):
        emit("error", code="LIVE_STREAM", message="The link is a live stream")
        return
    emit("preview", single=True, title=str(raw.get("title") or ""), entries=[entry(raw, site)])


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
    options = base_options() | {
        "skip_download": True,
        "extract_flat": "in_playlist",
        "noplaylist": False,
        "playlistend": LIMIT,
        "allowed_extractors": site.allowed_extractors(),
    }
    downloader = cast(Downloader, yt_dlp.YoutubeDL(options))
    try:
        resolve(downloader, site, url)
    except Exception as exc:
        message = redact(str(exc))
        lower = message.lower()
        code = (
            "SITE_NOT_ALLOWED"
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
