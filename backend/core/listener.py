"""The name a browser is using. The id is not a secret and not a password."""

import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

HEADER = "X-Musimo-Listener"
UNCLAIMED = ""
NAME_LIMIT = 40
CHOOSE = "Choose a name."

_current: ContextVar[str] = ContextVar("musimo_listener", default=UNCLAIMED)


class ListenerNameError(ValueError):
    """A name the create sheet should keep open, with the reason."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


class ForeignListener(LookupError):
    """A proposal or receipt belongs to another name."""


def current() -> str:
    """The listener bound for this call. Empty is the unclaimed pool."""
    return _current.get()


def bind(listener_id: str) -> Token[str]:
    return _current.set(listener_id)


def reset(token: Token[str]) -> None:
    _current.reset(token)


@contextmanager
def scope(listener_id: str) -> Iterator[None]:
    token = bind(listener_id)
    try:
        yield
    finally:
        reset(token)


def clean_name(name: str) -> str:
    text = name.strip()
    if not text:
        raise ListenerNameError("Enter a name.", 422)
    if len(text) > NAME_LIMIT:
        raise ListenerNameError("Use 40 characters or fewer.", 422)
    return text


def new_listener_id() -> str:
    return "ln-" + secrets.token_hex(8)


def is_listener_route(path: str) -> bool:
    """True when the response is one person's queue, likes, counts, or bot state.

    Account play, the scan, and the library status stay with the house. A header on
    those routes is ignored because this returns false and nothing binds it.
    """
    if path.startswith(
        (
            "/api/player/account",
            "/api/player/lyrics/",
            "/api/player/stream/",
            "/api/player/art/",
            "/api/player/capabilities",
        )
    ):
        return False
    if path in {"/api/library", "/api/library/"} or path.startswith(
        ("/api/library/scan", "/api/library/cancel")
    ):
        return False
    return path.startswith(
        (
            "/api/player/queue",
            "/api/player/scrobble",
            "/api/player/song/",
            "/api/library/albums",
            "/api/library/artists",
            "/api/library/tracks",
            "/api/library/playlists",
            "/api/music-bot/",
        )
    )
