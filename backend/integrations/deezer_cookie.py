"""The Deezer account cookie (arl), kept in a file on the data volume.

A cookie is a login, so it does not sit in the settings table with everything else. The worker
reads the file by path. Settings replies, job records and diagnostics never carry the text.
"""

import os
from pathlib import Path
from typing import TYPE_CHECKING

from backend.core import secret_file
from backend.core.models import clean_arl

if TYPE_CHECKING:
    from backend.core.store import Store

FILE_NAME = "deezer-arl.txt"
# Where the worker finds the file. Set only while one is saved.
ENV = "MUSIMO_DEEZER_ARL_FILE"
# The settings row that held the cookie before the file. It stays, empty, so the first-start
# seed from MUSIMO_DEEZER_ARL does not run again after Remove cookie.
STORED_KEY = "deezer_arl"


def cookie_path(data: Path) -> Path:
    return data / FILE_NAME


def saved(data: Path) -> bool:
    return secret_file.is_saved(cookie_path(data))


def publish(data: Path) -> None:
    """Point the worker at the file, or at nothing once it is gone."""
    secret_file.publish(cookie_path(data), ENV)


def published() -> str:
    """The saved file's path, or "" when none is saved."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return ""
    return raw if secret_file.is_saved(Path(raw)) else ""


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
    secret_file.replace(cookie_path(data), body.encode())
    publish(data)
    # A replaced cookie is a different listener. Drop the previous listening files.
    _drop_listening(data)


def remove(data: Path) -> None:
    secret_file.delete(cookie_path(data))
    publish(data)
    _drop_listening(data)


def _drop_listening(data: Path) -> None:
    from backend.jobs.account_listen import drop_cache

    drop_cache(data)


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
