"""Moving a finished file into the library without ever replacing one already there."""

import ctypes
import errno
import hashlib
import os
import sys
from pathlib import Path

AT_FDCWD = -100
# Linux's renameat2 flag and macOS's renamex_np flag: refuse to replace an existing target.
RENAME_NOREPLACE = 1
RENAME_EXCL = 0x4
# The rename call exists but the filesystem cannot honour the flag. On macOS ENOTSUP and
# EOPNOTSUPP are different numbers, so both are listed.
UNSUPPORTED = {errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP, errno.ENOTSUP}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def rename_no_replace(source: Path, target: Path) -> int:
    """The platform's rename that will not replace `target`: 0, or the errno it failed with."""
    libc = ctypes.CDLL(None, use_errno=True)
    old, new = os.fsencode(source), os.fsencode(target)
    if hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename.restype = ctypes.c_int
        failed = rename(AT_FDCWD, old, AT_FDCWD, new, RENAME_NOREPLACE) != 0
    elif hasattr(libc, "renamex_np"):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        failed = rename(old, new, RENAME_EXCL) != 0
    else:
        return errno.ENOSYS
    return ctypes.get_errno() if failed else 0


def publish_file(source: Path, target: Path) -> None:
    # Never replace an existing library file, including one created after the path was checked.
    if sys.platform == "win32":
        source.rename(target)
        return
    code = rename_no_replace(source, target)
    if code in UNSUPPORTED:
        # Docker Desktop mounts may reject rename flags but support atomic hard links.
        # link() fails if the destination exists. A crash before unlink is reconciled by hash.
        os.link(source, target)
        source.unlink()
    elif code:
        raise OSError(code, os.strerror(code), str(target))
