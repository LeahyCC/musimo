import os
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.core.models import SettingsPatch
from backend.core.store import SECRET_KEYS, LockedSetting, Store
from backend.integrations import deezer_cookie, spotify_credentials, youtube_cookies
from backend.integrations.youtube_cookies import CookieFileError
from backend.jobs.downloads import Downloads


class YoutubeCookiesBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=262144)


def scrub_secret_errors(errors: list[object]) -> list[object]:
    """Drop a pasted cookie or Spotify secret from a validation error. The message stays."""
    cleaned: list[object] = []
    for error in errors:
        if not isinstance(error, dict):
            cleaned.append(error)
            continue
        item = dict(error)
        loc = item.get("loc", ())
        if isinstance(loc, (list, tuple)) and any(
            isinstance(part, str) and part in SECRET_KEYS for part in loc
        ):
            item.pop("input", None)
        cleaned.append(item)
    return cleaned


def public_settings(store: Store, data: Path) -> dict[str, object]:
    """Settings as any client may see them. GET, PATCH and the snapshot all send this.

    Cookies stay on the server and the page only learns whether one is saved. There is no
    login, so whoever reaches the app reads these replies, and an account cookie is a login.
    """
    current = store.settings()
    return current | {
        # The row is kept empty. The cookie lives in its own file.
        "deezer_arl": {"value": "", "origin": "file", "locked": False},
        "deezer_cookie": {
            "value": deezer_cookie.saved(data),
            "origin": "file",
            "locked": False,
        },
        "youtube_cookies": {
            "value": youtube_cookies.saved(data),
            "origin": "file",
            "locked": False,
        },
        # The rows are kept empty. The app file holds the client ID and secret.
        "spotify_client_id": {"value": "", "origin": "file", "locked": False},
        "spotify_client_secret": {"value": "", "origin": "file", "locked": False},
        "spotify_credentials": {
            "value": spotify_credentials.saved(data),
            "origin": "file",
            "locked": False,
        },
    }


def install_settings_routes(
    app: FastAPI,
    data: Path,
    get_store: Callable[[], Store],
    get_downloads: Callable[[], Downloads],
    notify: Callable[[], None],
) -> None:
    @app.get("/api/settings")
    async def settings() -> dict[str, object]:
        return public_settings(get_store(), data)

    @app.patch("/api/settings")
    async def save_settings(patch: SettingsPatch) -> dict[str, object]:
        store = get_store()
        changes = patch.model_dump(exclude_unset=True)
        if None in changes.values():
            raise HTTPException(422, "Setting values cannot be null")
        # The cookie goes to its own file. An empty value is Remove cookie. The browser leaves
        # the key out when the box is merely empty
        # (frontend/src/features/settings/settings-patch.ts).
        cookie = changes.pop("deezer_arl", None)
        # The same rule as the cookie: both values, or neither. Empty together removes the file.
        client_id = changes.pop("spotify_client_id", None)
        client_secret = changes.pop("spotify_client_secret", None)
        if (client_id is None) != (client_secret is None):
            raise HTTPException(422, "Paste the Spotify client ID and client secret together.")
        try:
            if "destination" in changes:
                dest = str(changes["destination"])
                get_downloads().target(dest)
                if not os.access(dest, os.W_OK):
                    raise HTTPException(
                        422, "Destination must be writable. Read-only mounts cannot be used."
                    )
            if changes:
                store.update(changes)
            if isinstance(cookie, str):
                if cookie:
                    deezer_cookie.write(data, cookie)
                else:
                    deezer_cookie.remove(data)
            if isinstance(client_id, str) and isinstance(client_secret, str):
                if client_id or client_secret:
                    if not client_id or not client_secret:
                        raise HTTPException(
                            422, "Paste the Spotify client ID and client secret together."
                        )
                    spotify_credentials.write(data, client_id, client_secret)
                else:
                    spotify_credentials.remove(data)
            # A cookie-only or credential-only save changes no settings row, so nothing else
            # would tell the other pages to read Diagnostics again.
            if isinstance(cookie, str) or (
                isinstance(client_id, str) and isinstance(client_secret, str)
            ):
                store.announce_settings()
        except LockedSetting as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValidationError as exc:
            raise HTTPException(422, "Invalid settings") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        notify()
        # The queue reads these on its next pass. Wake it so a pause change is not
        # stuck behind the wait it is already in.
        if changes.keys() & {"pace_tracks", "pace_minutes"}:
            get_downloads().wake.set()
        return public_settings(store, data)

    @app.put("/api/youtube-cookies")
    async def save_youtube_cookies(body: YoutubeCookiesBody) -> dict[str, bool]:
        try:
            youtube_cookies.write(data, body.text)
        except CookieFileError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"saved": True}

    @app.delete("/api/youtube-cookies")
    async def clear_youtube_cookies() -> dict[str, bool]:
        youtube_cookies.remove(data)
        return {"saved": False}
