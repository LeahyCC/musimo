"""Leftover download folders under `.musimo`.

A job id is 32 hex characters. The sweep lists those directories, asks which jobs
are finished, and removes only those. A failed job's folder stays so a retry can resume.
"""

import shutil
from collections.abc import Callable
from pathlib import Path


def staging_name(name: str) -> bool:
    """A job id is 32 hex characters. Anything else under `.musimo` is left alone."""
    return len(name) == 32 and all(character in "0123456789abcdef" for character in name)


def sweep_finished_staging(
    roots: list[Path],
    ids_in_stages: Callable[[list[str], tuple[str, ...]], set[str]],
    stopping: Callable[[], bool],
) -> None:
    """Remove leftover staging for finished or cancelled jobs.

    Every id lookup finishes before the first delete, so shutdown can close the
    database while a folder is still being removed.
    """
    pending: list[tuple[Path, Path]] = []
    for root in roots:
        if stopping():
            return
        staging = root / ".musimo"
        try:
            if staging.is_symlink() or not staging.is_dir():
                continue
            names = [
                entry.name
                for entry in staging.iterdir()
                if not entry.is_symlink() and entry.is_dir() and staging_name(entry.name)
            ]
        except OSError:
            continue
        finished: set[str] = set()
        for start in range(0, len(names), 400):
            if stopping():
                return
            finished.update(ids_in_stages(names[start : start + 400], ("done", "cancelled")))
        for name in names:
            if name in finished:
                pending.append((root, staging / name))
    for root, folder in pending:
        if stopping():
            return
        try:
            if folder.is_symlink():
                continue
            # resolve() is the escape check. Remove the listed folder, not a path
            # looked up again, so a swap in between cannot point this at the library.
            if not folder.resolve().is_relative_to(root):
                continue
            shutil.rmtree(folder)
        except OSError:
            continue
