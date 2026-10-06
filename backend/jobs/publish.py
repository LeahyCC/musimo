"""Moving a finished file into the library without ever replacing one already there."""

import ctypes
import errno
import hashlib
import os
import sys
from pathlib import Path


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def publish_file(source: Path, target: Path) -> None:
    # Never replace an existing library file, including one created after the path was checked.
    if sys.platform == "win32":
        source.rename(target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code in {errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP}:
            # Docker Desktop mounts may reject rename flags but support atomic hard links.
            # link() fails if the destination exists. A crash before unlink is reconciled by hash.
            os.link(source, target)
            source.unlink()
            return
        raise OSError(code, os.strerror(code), str(target))
