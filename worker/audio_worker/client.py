"""The two calls the worker makes: lease a song, post its result. Standard library only."""

import json
import urllib.error
import urllib.request
from collections.abc import Callable

Poster = Callable[[str, dict[str, object]], object]


class ClientError(Exception):
    pass


class Client:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.timeout = timeout

    def post(self, path: str, body: dict[str, object]) -> object:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "musimo-audio-worker",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            # The body is the app's own wording for what was wrong. The token is never in it.
            try:
                detail = json.loads(exc.read()).get("detail", "")
            except (ValueError, AttributeError):
                detail = ""
            raise ClientError(f"{path} answered {exc.code}: {detail or exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise ClientError(f"{path} failed: {exc}") from exc


def lease(post: Poster, recipe: str) -> object:
    """The leased job as the app sent it, or None when there is nothing to do."""
    reply = post("/api/internal/audio/lease", {"recipe": recipe})
    if not isinstance(reply, dict):
        raise ClientError("lease reply is not an object")
    return reply.get("job")


def submit(post: Poster, payload: dict[str, object]) -> None:
    post("/api/internal/audio/result", payload)
