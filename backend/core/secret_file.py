"""A secret kept as a file on the data volume: readable only by its owner, found by path."""

import os
from pathlib import Path


def write_private(path: Path, body: bytes) -> None:
    """Write a file only its owner can read, from the first byte."""
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "wb") as file:
        file.write(body)


def is_saved(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def publish(path: Path, env: str) -> None:
    """Point child processes at the file through `env`, or at nothing once it is gone."""
    if is_saved(path):
        os.environ[env] = str(path)
    else:
        os.environ.pop(env, None)


def replace(path: Path, body: bytes) -> None:
    """Swap the whole file in at once, so a reader never sees half of one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        path.unlink()
    temporary = path.with_name(path.name + ".part")
    temporary.unlink(missing_ok=True)
    write_private(temporary, body)
    temporary.replace(path)


def delete(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
