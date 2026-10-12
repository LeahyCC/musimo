"""yt-dlp settings and the JSON line protocol the download worker and link resolver share."""

import json
import os
import re
from pathlib import Path
from typing import Protocol, cast

from backend.integrations.youtube_cookies import private_copy


class Downloader(Protocol):
    def extract_info(self, url: str, download: bool = True, process: bool = True) -> object: ...
    def process_ie_result(self, ie_result: object, download: bool = True) -> object: ...
    def close(self) -> None: ...


class Logger:
    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        emit("warning", message=redact(message))

    def error(self, message: str) -> None:
        emit("log", message=redact(message))


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"kind": kind, **values}), flush=True)


def redact(text: str) -> str:
    return re.sub(r"https?://\S+", "[URL]", text)[-3000:]


def cache_dir() -> str | bool:
    """yt-dlp's player cache, or False when this process has no data directory."""
    raw = os.getenv("MUSIMO_YTDLP_CACHE", "").strip()
    if not raw:
        return False
    try:
        Path(raw).mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return raw


def base_options() -> dict[str, object]:
    """yt-dlp settings shared by downloads and link previews. No browser input reaches these."""
    options: dict[str, object] = {
        "quiet": True,
        "no_warnings": False,
        "logger": Logger(),
        # A shared cache keeps the YouTube player script between tracks. Unset in tests.
        "cachedir": cache_dir(),
        "socket_timeout": 10,
        "retries": 0,
        "fragment_retries": 0,
        "extractor_retries": 0,
        "js_runtimes": {"deno": {}},
        "extractor_args": {"youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}},
    }
    if server_home := os.getenv("MUSIMO_POT_SERVER_HOME"):
        # Native installs can start the matching helper on demand instead of keeping a server up.
        options["extractor_args"] = {
            "youtubepot-bgutilscript": {"server_home": [server_home]},
        }
    return options


def cookie_options() -> dict[str, object]:
    """The signed-in cookies file, which lets an age-restricted video through.

    The path is the server's, never a path from the browser, and yt-dlp gets its own copy because
    it writes back to it. Asked for only when a yt-dlp client is built, so a song the Deezer
    account saves leaves no copy of the cookie on disk.
    """
    cookies = private_copy()
    return {"cookiefile": cookies} if cookies else {}


def live(info: dict[str, object]) -> bool:
    return info.get("is_live") is True or info.get("live_status") in {"is_live", "is_upcoming"}


def client(options: dict[str, object]) -> Downloader:
    """A yt-dlp client. The import waits until one is needed, so a song the Deezer account saves
    does not pay for loading yt-dlp."""
    import yt_dlp  # type: ignore[import-untyped]

    return cast(Downloader, yt_dlp.YoutubeDL(options | cookie_options()))
