"""Read what a pasted link points at without downloading anything.

Runs as its own process, like the download worker, so yt-dlp never loads into the server and a
slow site can be stopped by ending the process. Input is one JSON object on stdin, output one
JSON line on stdout. The server checks everything printed here again before using it.
"""

import json
import sys
from collections.abc import Iterable
from itertools import islice
from typing import cast

from backend.sources import Site, by_source, match
from backend.worker import Downloader, base_options, emit, live, redact

# One more than the preview cap, so the server can say the list was cut short.
LIMIT = 501


def extractor_name(raw: dict[str, object]) -> str:
    """The extractor that produced an entry. Flat list entries only carry the class key."""
    if name := raw.get("extractor"):
        return str(name).lower()
    key = raw.get("ie_key")
    if not key:
        return ""
    from yt_dlp.extractor import get_info_extractor  # type: ignore[import-untyped]

    try:
        return str(get_info_extractor(str(key)).IE_NAME).lower()
    except (KeyError, AttributeError):
        return ""


def artwork(raw: dict[str, object]) -> str:
    # yt-dlp orders thumbnails worst to best. The worker only embeds JPEG covers.
    thumbnails = raw.get("thumbnails")
    if isinstance(thumbnails, list):
        for row in reversed(thumbnails):
            url = str(row.get("url", "")) if isinstance(row, dict) else ""
            if url.split("?")[0].endswith(".jpg"):
                return url
    thumbnail = str(raw.get("thumbnail") or "")
    return thumbnail if thumbnail.split("?")[0].endswith(".jpg") else ""


def day(raw: dict[str, object]) -> str:
    value = str(raw.get("release_date") or raw.get("upload_date") or "")
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    year = raw.get("release_year")
    return str(year) if isinstance(year, int) and 1000 <= year <= 9999 else ""


def entry(raw: dict[str, object]) -> dict[str, object]:
    return {
        "id": str(raw.get("id") or ""),
        "extractor": extractor_name(raw),
        "url": str(raw.get("webpage_url") or raw.get("url") or ""),
        "title": str(raw.get("track") or raw.get("title") or ""),
        "artist": str(
            raw.get("artist")
            or raw.get("creator")
            or raw.get("uploader")
            or raw.get("channel")
            or ""
        ),
        "album": str(raw.get("album") or ""),
        "date": day(raw),
        "duration": raw.get("duration") or 0,
        "art": artwork(raw),
        "live": live(raw),
    }


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
        rows = islice(iter(cast(Iterable[object], listed)), LIMIT)
        entries = [entry(row) for row in rows if isinstance(row, dict)]
        emit("preview", single=False, title=str(raw.get("title") or ""), entries=entries)
        return
    if live(raw):
        emit("error", code="LIVE_STREAM", message="The link is a live stream")
        return
    emit("preview", single=True, title=str(raw.get("title") or ""), entries=[entry(raw)])


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
