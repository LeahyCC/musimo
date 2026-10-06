"""A Netscape cookies.txt for YouTube, kept on the data volume.

yt-dlp reads the file by path. The text never goes into settings, job records or diagnostics.
Only YouTube and Google rows are kept, so a full browser export is not replayed to other sites.
"""

import atexit
import os
from pathlib import Path

FILE_NAME = "youtube-cookies.txt"
MAX_BYTES = 256 * 1024
# YouTube's login cookies live on these hosts. Anything else in an export is dropped.
HOSTS = ("youtube.com", "youtube-nocookie.com", "youtu.be", "google.com")
# Exporters write an HttpOnly cookie as "#HttpOnly_<domain>". It is a row, not a comment, and
# YouTube's sign-in cookies are HttpOnly. yt-dlp reads the prefix.
HTTPONLY = "#HttpOnly_"
# yt-dlp refuses a row with any other field count, and its warning prints the whole row.
FIELDS = 7
# The copies this process made, so later yt-dlp clients share one and keep its write-back.
_made: set[Path] = set()


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


def copy_path(saved_file: Path, pid: int) -> Path:
    """Where process `pid` keeps its copy of the saved file."""
    return saved_file.with_name(f"{saved_file.stem}.{pid}{saved_file.suffix}")


def drop_copy(pid: int) -> None:
    """Remove the copy a stopped process made. SIGTERM and SIGKILL skip its own atexit."""
    source = os.getenv("MUSIMO_YOUTUBE_COOKIES", "").strip()
    if not source:
        # Remove cookie already cleared every copy.
        return
    copy = copy_path(Path(source), pid)
    if copy.is_file() and not copy.is_symlink():
        try:
            copy.unlink(missing_ok=True)
        except OSError:
            # Windows refuses to delete a file another process holds open. It goes later.
            pass


def drop_copies(data: Path) -> None:
    """Remove the per-process copies, including those a stopped worker left behind.

    A running worker loses nothing it needs: yt-dlp read its copy when it started, and it skips a
    cookie file it cannot find.
    """
    for copy in data.glob(f"{Path(FILE_NAME).stem}.*{Path(FILE_NAME).suffix}"):
        if copy.name != FILE_NAME and copy.is_file() and not copy.is_symlink():
            try:
                copy.unlink(missing_ok=True)
            except OSError:
                # Windows refuses to delete a file another process holds open. It goes later.
                pass


def _host(domain: str) -> str:
    return domain.lstrip(".").lower()


def _kept(domain: str) -> bool:
    host = _host(domain)
    return any(host == name or host.endswith("." + name) for name in HOSTS)


def _youtube(domain: str) -> bool:
    host = _host(domain)
    return host in {"youtube.com", "youtu.be"} or host.endswith(".youtube.com")


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
        row = line.removeprefix(HTTPONLY)
        if not row or row.startswith("#"):
            continue
        parts = row.split("\t")
        if len(parts) != FIELDS or not _kept(parts[0]):
            continue
        if _youtube(parts[0]):
            saw_youtube = True
        kept.append(line)
    if not saw_youtube:
        raise CookieFileError(
            "That file has no YouTube cookies. Export cookies.txt while signed in at youtube.com."
        )
    return "# Netscape HTTP Cookie File\n" + "\n".join(kept) + "\n"


def write_private(path: Path, body: bytes) -> None:
    """Write a file only its owner can read, from the first byte."""
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "wb") as file:
        file.write(body)


def write(data: Path, text: str) -> None:
    body = clean(text)
    data.mkdir(parents=True, exist_ok=True)
    target = cookie_path(data)
    if target.is_symlink():
        target.unlink()
    temporary = target.with_name(target.name + ".part")
    temporary.unlink(missing_ok=True)
    write_private(temporary, body.encode())
    temporary.replace(target)
    drop_copies(data)
    publish(data)


def remove(data: Path) -> None:
    target = cookie_path(data)
    if target.is_symlink() or target.is_file():
        target.unlink()
    drop_copies(data)
    publish(data)


def private_copy() -> str:
    """A copy of the saved file for this process to hand to yt-dlp, or "" when none is saved.

    yt-dlp writes its cookie jar back to `cookiefile` when it closes. Given the saved file, a job
    that was already running would put back cookies someone had just replaced or removed in
    Settings. A copy keeps that write inside this process. It sits beside the saved file on the
    data volume: a job's staging folder is in the music library, which may be shared. The copy
    goes when the process exits. The server removes the copy of a process it had to stop, and the
    next start removes any left after a crash.
    """
    source = os.getenv("MUSIMO_YOUTUBE_COOKIES", "").strip()
    path = Path(source) if source else None
    if path is None or not path.is_file() or path.is_symlink():
        return ""
    copy = copy_path(path, os.getpid())
    if copy in _made and copy.is_file():
        return str(copy)
    copy.unlink(missing_ok=True)
    write_private(copy, path.read_bytes())
    if copy not in _made:
        _made.add(copy)
        atexit.register(copy.unlink, missing_ok=True)
    return str(copy)
