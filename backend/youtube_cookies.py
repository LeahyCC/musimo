"""A Netscape cookies.txt for YouTube, kept on the data volume.

yt-dlp reads the file by path. The text never goes into settings, job records or diagnostics.
Only YouTube and Google rows are kept, so a full browser export is not replayed to other sites.
"""

import os
from pathlib import Path

FILE_NAME = "youtube-cookies.txt"
MAX_BYTES = 256 * 1024
# YouTube's login cookies live on these hosts. Anything else in an export is dropped.
HOSTS = ("youtube.com", "youtube-nocookie.com", "youtu.be", "google.com")


class CookieFileError(ValueError):
    """The paste is not a YouTube cookies.txt file."""


def cookie_path(data: Path) -> Path:
    return data / FILE_NAME


def saved(data: Path) -> bool:
    path = cookie_path(data)
    return path.is_file() and not path.is_symlink()


def publish(data: Path) -> None:
    """Point the worker and the link preview at the file, or at nothing once it is gone."""
    if saved(data):
        os.environ["MUSIMO_YOUTUBE_COOKIES"] = str(cookie_path(data))
    else:
        os.environ.pop("MUSIMO_YOUTUBE_COOKIES", None)


def _host(domain: str) -> str:
    return domain.lstrip(".").lower()


def _kept(domain: str) -> bool:
    host = _host(domain)
    return any(host == name or host.endswith("." + name) for name in HOSTS)


def clean(text: str) -> str:
    """The YouTube and Google rows of a Netscape cookies file, or an error the UI can show."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise CookieFileError("Paste a YouTube cookies.txt file.")
    if len(text.encode()) > MAX_BYTES:
        raise CookieFileError("That cookie file is too large.")
    kept: list[str] = []
    saw_youtube = False
    for line in text.split("\n"):
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7 or not _kept(parts[0]):
            continue
        if _host(parts[0]).endswith("youtube.com") or _host(parts[0]) == "youtu.be":
            saw_youtube = True
        kept.append(line)
    if not saw_youtube:
        raise CookieFileError(
            "That file has no YouTube cookies. Export cookies.txt while signed in at youtube.com."
        )
    return "# Netscape HTTP Cookie File\n" + "\n".join(kept) + "\n"


def write(data: Path, text: str) -> None:
    body = clean(text)
    data.mkdir(parents=True, exist_ok=True)
    target = cookie_path(data)
    if target.is_symlink():
        target.unlink()
    temporary = target.with_name(target.name + ".part")
    temporary.write_text(body, encoding="utf-8")
    if os.name != "nt":
        os.chmod(temporary, 0o600)
    temporary.replace(target)
    publish(data)


def remove(data: Path) -> None:
    target = cookie_path(data)
    if target.is_symlink() or target.is_file():
        target.unlink()
    publish(data)
