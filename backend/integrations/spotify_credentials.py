"""A Spotify developer app's client ID and secret, kept in a file on the data volume.

The secret is a credential, so it does not sit in the settings table with everything else.
Settings replies, job records, logs and diagnostics never carry it. The page only learns
that both values are saved.
"""

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING

from backend.core import secret_file
from backend.core.models import clean_spotify_token

if TYPE_CHECKING:
    from backend.core.store import Store

FILE_NAME = "spotify-app.json"
# Where this process finds the file. Set only while one is saved. Download workers do not get it.
ENV = "MUSIMO_SPOTIFY_APP_FILE"
# The settings rows that can hold a first-start seed. They stay empty, so that seed does not
# run again after Remove credentials.
ID_KEY = "spotify_client_id"
SECRET_KEY = "spotify_client_secret"


def credentials_path(data: Path) -> Path:
    return data / FILE_NAME


def saved(data: Path) -> bool:
    return secret_file.is_saved(credentials_path(data))


def publish(data: Path) -> None:
    """Point this process at the file, or at nothing once it is gone."""
    secret_file.publish(credentials_path(data), ENV)


def published() -> str:
    """The saved file's path, or "" when none is saved."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return ""
    return raw if secret_file.is_saved(Path(raw)) else ""


def read() -> tuple[str, str]:
    """The saved client ID and secret, or ("", "") when there is none or it cannot be read."""
    path = published()
    if not path:
        return "", ""
    try:
        parsed: object = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", ""
    if not isinstance(parsed, dict):
        return "", ""
    client_id, secret = parsed.get("client_id"), parsed.get("client_secret")
    if not isinstance(client_id, str) or not isinstance(secret, str):
        return "", ""
    if not client_id or not secret:
        return "", ""
    return client_id, secret


def write(data: Path, client_id: str, secret: str) -> None:
    client_id = clean_spotify_token(client_id)
    secret = clean_spotify_token(secret)
    if not client_id or not secret:
        raise ValueError("Paste the Spotify client ID and client secret together.")
    body = json.dumps({"client_id": client_id, "client_secret": secret}, separators=(",", ":"))
    secret_file.replace(credentials_path(data), body.encode())
    publish(data)


def remove(data: Path) -> None:
    secret_file.delete(credentials_path(data))
    publish(data)


def adopt(store: "Store", data: Path) -> None:
    """Move a first-start seed out of the settings table into the file, then empty the rows.

    MUSIMO_SPOTIFY_CLIENT_ID and MUSIMO_SPOTIFY_CLIENT_SECRET seed the rows on the first start.
    A file that is already there wins. The file is written before the rows are cleared, so a
    crash between the two leaves the credentials in one place or the other.
    """
    client_id = store.stored_secret(ID_KEY)
    secret = store.stored_secret(SECRET_KEY)
    if client_id and secret and not saved(data):
        write(data, client_id, secret)
    if client_id:
        store.clear_secret(ID_KEY)
    if secret:
        store.clear_secret(SECRET_KEY)
    publish(data)
