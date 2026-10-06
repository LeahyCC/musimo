import os
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.core.models import SettingsPatch
from backend.core.store import LockedSetting, Store
from backend.integrations import deezer_cookie, youtube_cookies
from backend.integrations.youtube_cookies import CookieFileError
from backend.jobs.downloads import Downloads


class YoutubeCookiesBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=262144)


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
        except LockedSetting as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValidationError as exc:
            raise HTTPException(422, "Invalid settings") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        notify()
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
