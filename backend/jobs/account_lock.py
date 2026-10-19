"""One holder of the Deezer account cookie at a time.

A download and a Play both take this. Play does not wait: it says the account is busy and
leaves the other holder running. A download waits, so a Play that is already fetching is
not cut off either.
"""

import os
import sys
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, cast

from backend.integrations import deezer_cookie

_local = threading.Lock()


class AccountBusy(Exception):
    """Someone else is using the account. This caller did not interrupt them."""


def lock_path(data: Path | None = None) -> Path:
    published = os.environ.get(deezer_cookie.ENV, "").strip()
    if published:
        return Path(published).resolve().parent / "deezer-account.lock"
    if data is not None:
        return data / "deezer-account.lock"
    data_dir = os.environ.get("MUSIMO_DATA_DIR", "").strip()
    if data_dir:
        return Path(data_dir) / "deezer-account.lock"
    return Path(tempfile.gettempdir()) / "musimo-deezer-account.lock"


@contextmanager
def hold(data: Path | None = None, *, wait: bool = True) -> Iterator[None]:
    """Hold the account. `wait` false raises AccountBusy instead of queueing."""
    if wait:
        _local.acquire()
    elif not _local.acquire(blocking=False):
        raise AccountBusy("The Deezer account is busy.")
    path = lock_path(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        _lock_file(handle, block=wait)
    except OSError as exc:
        handle.close()
        _local.release()
        raise AccountBusy("The Deezer account is busy.") from exc
    try:
        yield
    finally:
        try:
            _unlock_file(handle)
        except OSError:
            pass
        handle.close()
        _local.release()


def _lock_file(handle: object, *, block: bool) -> None:
    assert hasattr(handle, "fileno") and hasattr(handle, "seek") and hasattr(handle, "write")
    file = cast(BinaryIO, handle)
    file.seek(0, os.SEEK_END)
    if file.tell() < 1:
        file.write(b"\0")
        file.flush()
    file.seek(0)
    if sys.platform == "win32":
        import msvcrt

        mode = msvcrt.LK_LOCK if block else msvcrt.LK_NBLCK
        msvcrt.locking(file.fileno(), mode, 1)
        return
    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_EX if block else fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle: object) -> None:
    assert hasattr(handle, "fileno") and hasattr(handle, "seek")
    file = cast(BinaryIO, handle)
    file.seek(0)
    if sys.platform == "win32":
        import msvcrt

        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(file.fileno(), fcntl.LOCK_UN)
