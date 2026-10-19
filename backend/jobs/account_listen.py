"""Play a Deezer song through the saved account without writing it into the library.

The browser receives a Musimo address. The cookie stays in its file. One login is cached and
reported on the diagnostics payload, so a row does not sign in on its own. Listening files
live under the data directory, apart from downloads, and are removed with the cookie.
"""

import json
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from backend.core.store import Store
from backend.integrations import deezer_cookie
from backend.integrations.deezer_audio import (
    Account,
    DeezerAudioError,
    DeezerCookieRejected,
    DeezerNoTrack,
    account_cookie,
    fetch,
)
from backend.jobs.account_lock import AccountBusy, hold
from backend.jobs.file_command import FileCommandError, clear_attempt, prepare
from backend.jobs.tagging import probe

SONG_PREFIX = "dz-"
CACHE_DIR = "account-listen"
# A live sign-in is reused for this long. Rows read the cached diagnostics result.
LOGIN_SECONDS = 600
COMMAND_REQUIRED = "The account file command is required."
FREE_ACCOUNT = "This Deezer account cannot play a full song."
UNAVAILABLE = "This song is not available on the Deezer account."
BUSY = "The Deezer account is busy."
COOKIE_REJECTED = "Deezer did not accept the account cookie."
NO_ANSWER = "Deezer did not return the audio."

_guard = threading.Lock()
_login: tuple[str, float, bool, str] | None = None
_unavailable: set[int] = set()
# One prepare of a track at a time. Not the cookie lock: the file command must not hold that.
_track_locks: dict[int, threading.Lock] = {}


def song_id(track_id: int) -> str:
    return f"{SONG_PREFIX}{track_id}"


def track_number(value: str) -> int | None:
    if not value.startswith(SONG_PREFIX):
        return None
    rest = value[len(SONG_PREFIX) :]
    if not rest.isdigit():
        return None
    number = int(rest)
    return number if number > 0 else None


def drop_cache(data: Path) -> None:
    """Forget the listening files and the cached sign-in. Playlist rows are left as they are."""
    global _login
    root = data / CACHE_DIR
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    with _guard:
        _login = None
        _unavailable.clear()


def snapshot(store: Store, data: Path) -> dict[str, object]:
    """The cached account. Signs in once when the cookie, the switch and the command still match."""
    global _login
    settings = store.current()
    command = bool(settings.file_command.strip())
    if not settings.deezer_audio or not deezer_cookie.saved(data):
        return _state(False, "", command, data)
    stamp = _stamp(data, settings.deezer_audio, settings.file_command)
    cached = _cached_login(stamp)
    if cached is None:
        ready, detail = _sign_in()
        with _guard:
            _login = (stamp, time.monotonic(), ready, detail)
        cached = (ready, detail)
    ready, detail = cached
    return _state(ready, detail, command, data)


def prepare_track(
    store: Store, data: Path, track_id: int, facts: dict[str, object]
) -> dict[str, object]:
    """Fetch one song for listening, or say which fallback the row should use."""
    _remember(store, track_id, facts)
    state = snapshot(store, data)
    if not state["ready"]:
        play = "off"
        return {"play": play, "detail": str(state["detail"]), "url": "", "id": ""}
    library = library_song(store, track_id)
    if library:
        _remember(store, track_id, facts)
        return {"play": "library", "detail": "", "url": "", "id": library}
    if track_id in _unavailable:
        return {"play": "unavailable", "detail": UNAVAILABLE, "url": "", "id": ""}
    cached = listen_file(data, track_id)
    if cached is not None:
        _remember(store, track_id, facts)
        return {"play": "account", "detail": "", "url": _file_url(track_id), "id": ""}
    if not state["command"]:
        return {"play": "preview", "detail": COMMAND_REQUIRED, "url": "", "id": ""}
    try:
        _download(data, track_id, store.current().file_command)
    except AccountBusy:
        return {"play": "busy", "detail": BUSY, "url": "", "id": ""}
    except DeezerNoTrack:
        _block(track_id)
        return {"play": "unavailable", "detail": UNAVAILABLE, "url": "", "id": ""}
    except DeezerCookieRejected:
        drop_cache(data)
        return {"play": "off", "detail": COOKIE_REJECTED, "url": "", "id": ""}
    except FileCommandError:
        detail = COMMAND_REQUIRED if not state["command"] else "The account file command failed."
        return {"play": "preview", "detail": detail, "url": "", "id": ""}
    except DeezerAudioError as exc:
        if exc.__cause__ is None:
            _block(track_id)
            return {"play": "unavailable", "detail": UNAVAILABLE, "url": "", "id": ""}
        return {"play": "preview", "detail": NO_ANSWER, "url": "", "id": ""}
    _remember(store, track_id, facts)
    return {"play": "account", "detail": "", "url": _file_url(track_id), "id": ""}


def listen_file(data: Path, track_id: int) -> Path | None:
    """The one cached listening file, or None when the account can no longer serve it."""
    if not deezer_cookie.saved(data):
        return None
    folder = (data / CACHE_DIR / str(track_id)).resolve()
    root = (data / CACHE_DIR).resolve()
    if not folder.is_relative_to(root) or not folder.is_dir():
        return None
    files = [
        path
        for path in folder.glob("source.*")
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in _suffixes()
    ]
    if len(files) != 1:
        return None
    return files[0]


def remember_many(store: Store, rows: list[dict[str, object]]) -> None:
    for row in rows:
        raw = row.get("id")
        if not isinstance(raw, int) or isinstance(raw, bool) or raw <= 0:
            continue
        _remember(store, raw, row)


def remembered_tracks(store: Store, song_ids: list[str]) -> dict[str, dict[str, object]]:
    wanted = [text for text in song_ids if track_number(text) is not None]
    if not wanted:
        return {}
    with store.lock:
        rows = store.db.execute(
            "SELECT song_id, title, artist, album, duration, art, deezer_id "
            "FROM account_tracks WHERE song_id IN (SELECT value FROM json_each(?))",
            (json.dumps(wanted),),
        ).fetchall()
    return {str(row["song_id"]): _track_dict(row) for row in rows}


def library_song(store: Store, track_id: int) -> str:
    """The library id of a finished Deezer download of this track, or ""."""
    with store.lock:
        row = store.db.execute(
            """
            SELECT f.song_id FROM jobs j
            JOIN library_files f ON f.path = json_extract(j.payload, '$.final_path')
            JOIN library_roots r ON r.path = f.root AND r.enabled = 1
            WHERE j.catalog = 'deezer' AND j.track_id = ? AND j.active = 0
              AND json_extract(j.payload, '$.stage') = 'done' AND f.song_id != ''
            LIMIT 1
            """,
            (track_id,),
        ).fetchone()
    return str(row[0]) if row is not None else ""


def cached_ids(data: Path) -> list[int]:
    root = data / CACHE_DIR
    if not root.is_dir():
        return []
    found: list[int] = []
    for child in root.iterdir():
        if child.is_dir() and child.name.isdigit() and listen_file(data, int(child.name)):
            found.append(int(child.name))
    return sorted(found)


def _state(ready: bool, detail: str, command: bool, data: Path) -> dict[str, object]:
    return {
        "ready": ready,
        "detail": detail,
        "command": command,
        "cached": cached_ids(data) if ready else [],
        "unavailable": sorted(_unavailable) if ready else [],
        # Changes when the cookie file is removed or replaced. Not the cookie.
        "mark": _cookie_mark(data),
    }


def _cookie_mark(data: Path) -> str:
    path = deezer_cookie.cookie_path(data)
    try:
        stat = path.stat()
    except OSError:
        return ""
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def _stamp(data: Path, audio: bool, command: str) -> str:
    mark = _cookie_mark(data) or "missing"
    return f"{mark}:{int(audio)}:{command}"


def _cached_login(stamp: str) -> tuple[bool, str] | None:
    with _guard:
        if _login is None or _login[0] != stamp:
            return None
        if time.monotonic() - _login[1] > LOGIN_SECONDS:
            return None
        return _login[2], _login[3]


def _sign_in() -> tuple[bool, str]:
    try:
        value = account_cookie()
    except DeezerCookieRejected:
        return False, COOKIE_REJECTED
    account = Account(value)
    try:
        account.login()
    except DeezerCookieRejected:
        return False, COOKIE_REJECTED
    except DeezerAudioError:
        return False, "Deezer did not answer."
    finally:
        account.close()
    if not account.full_file:
        return False, FREE_ACCOUNT
    return True, ""


def _track_lock(track_id: int) -> threading.Lock:
    with _guard:
        lock = _track_locks.get(track_id)
        if lock is None:
            lock = threading.Lock()
            _track_locks[track_id] = lock
        return lock


def _download(data: Path, track_id: int, command: str) -> Path:
    """Fetch under the cookie lock, then run the file command after that lock is free."""
    folder = data / CACHE_DIR / str(track_id)
    folder.mkdir(parents=True, exist_ok=True)
    track_lock = _track_lock(track_id)
    if not track_lock.acquire(blocking=False):
        raise AccountBusy(BUSY)
    try:
        clear_attempt(folder)
        with hold(data, wait=False):
            fetch(track_id, folder, None)
        return prepare(folder, probe, command)
    finally:
        track_lock.release()


def _remember(store: Store, track_id: int, facts: dict[str, object]) -> None:
    title = _text(facts.get("title"), "Unknown track")
    artist = _text(facts.get("artist"), "Unknown artist")
    album = _text(facts.get("album"), "")
    art = _text(facts.get("art"), "")
    if not art.startswith("https://"):
        art = ""
    duration = facts.get("duration")
    seconds = (
        float(duration)
        if isinstance(duration, (int, float)) and not isinstance(duration, bool)
        else 0
    )
    with store.lock:
        store.db.execute(
            """
            INSERT INTO account_tracks (song_id, title, artist, album, duration, art, deezer_id)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(song_id) DO UPDATE SET
              title=excluded.title, artist=excluded.artist, album=excluded.album,
              duration=excluded.duration, art=excluded.art, deezer_id=excluded.deezer_id
            """,
            (song_id(track_id), title, artist, album, seconds, art, track_id),
        )


def _block(track_id: int) -> None:
    with _guard:
        _unavailable.add(track_id)


def _file_url(track_id: int) -> str:
    return f"/api/player/account/{song_id(track_id)}/file"


def _text(value: object, default: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def _track_dict(row: sqlite3.Row) -> dict[str, object]:
    item: dict[str, object] = {
        "id": str(row["song_id"]),
        "title": str(row["title"]),
        "artist": str(row["artist"]),
        "album": str(row["album"]),
        "duration": float(row["duration"]),
        "playCount": 0,
        "origin": "deezer",
        "deezerId": int(row["deezer_id"]),
    }
    art = str(row["art"])
    if art:
        item["coverArt"] = art
    return item


def _suffixes() -> set[str]:
    from backend.jobs.file_command import audio_suffixes

    return audio_suffixes()
