"""The Deezer account cookie (arl), kept in a file on the data volume.

A cookie is a login, so it does not sit in the settings table with everything else. The worker
reads the file by path. Settings replies, job records and diagnostics never carry the text.
"""

import os
from pathlib import Path
from typing import TYPE_CHECKING

from backend.models import clean_arl
from backend.youtube_cookies import write_private

if TYPE_CHECKING:
    from backend.store import Store

FILE_NAME = "deezer-arl.txt"
# Where the worker finds the file. Set only while one is saved.
ENV = "MUSIMO_DEEZER_ARL_FILE"
# The settings row that held the cookie before the file. It stays, empty, so the first-start
# seed from MUSIMO_DEEZER_ARL does not run again after Remove cookie.
STORED_KEY = "deezer_arl"


def cookie_path(data: Path) -> Path:
    return data / FILE_NAME


def saved(data: Path) -> bool:
    path = cookie_path(data)
    return path.is_file() and not path.is_symlink()


def publish(data: Path) -> None:
    """Point the worker at the file, or at nothing once it is gone."""
    if saved(data):
        os.environ[ENV] = str(cookie_path(data))
    else:
        os.environ.pop(ENV, None)


def published() -> str:
    """The saved file's path, or "" when none is saved."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return ""
    path = Path(raw)
    return raw if path.is_file() and not path.is_symlink() else ""


def read() -> str:
    """The saved cookie, or "" when there is none or it cannot be read."""
    path = published()
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write(data: Path, value: str) -> None:
    body = clean_arl(value)
    if not body:
        raise ValueError("Paste the arl cookie from a Deezer login.")
    data.mkdir(parents=True, exist_ok=True)
    target = cookie_path(data)
    if target.is_symlink():
        target.unlink()
    temporary = target.with_name(target.name + ".part")
    temporary.unlink(missing_ok=True)
    write_private(temporary, body.encode())
    temporary.replace(target)
    publish(data)


def remove(data: Path) -> None:
    target = cookie_path(data)
    if target.is_symlink() or target.is_file():
        target.unlink()
    publish(data)


def adopt(store: "Store", data: Path) -> None:
    """Move a cookie out of the settings table into the file, then empty the row.

    Older versions kept it in the table, and MUSIMO_DEEZER_ARL seeds the row on the first start.
    A file that is already there wins. The file is written before the row is cleared, so a crash
    between the two leaves the cookie in one place or the other, never in neither.
    """
    stored = store.stored_secret(STORED_KEY)
    if stored:
        if not saved(data):
            write(data, stored)
        store.clear_secret(STORED_KEY)
    publish(data)
