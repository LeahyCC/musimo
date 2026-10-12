import asyncio
import ctypes
import os
import signal
import sys

from backend.integrations.youtube_cookies import drop_copy


async def stop_tree(process: asyncio.subprocess.Process) -> None:
    """Stop a child started with its own process group, and everything it started.

    A stopped child cannot run its own exit cleanup, so its copy of the YouTube cookie is
    removed here. The ids are taken first: after the tree is gone they can no longer be looked up.
    """
    pids = _cookie_pids(process.pid)
    if process.returncode is None:
        await _stop_group(process)
    for pid in pids:
        drop_copy(pid)


def _cookie_pids(pid: int) -> list[int]:
    """Ids whose cookie copies belong to this process.

    On Windows a venv `python.exe` is a launcher. The interpreter that made the copy is its
    child, and the filename uses that child's id, not the one asyncio recorded.
    """
    if sys.platform != "win32":
        return [pid]
    return [pid, *_descendant_pids(pid)]


def _descendant_pids(root: int) -> list[int]:
    """Live processes that descend from `root`. Empty when the snapshot cannot be taken."""
    if sys.platform != "win32":
        return []

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_uint),
            ("cntUsage", ctypes.c_uint),
            ("th32ProcessID", ctypes.c_uint),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", ctypes.c_uint),
            ("cntThreads", ctypes.c_uint),
            ("th32ParentProcessID", ctypes.c_uint),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", ctypes.c_uint),
            ("szExeFile", ctypes.c_char * 260),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot_fn = kernel.CreateToolhelp32Snapshot
    snapshot_fn.argtypes = [ctypes.c_uint, ctypes.c_uint]
    snapshot_fn.restype = ctypes.c_void_p
    first = kernel.Process32First
    nxt = kernel.Process32Next
    first.argtypes = nxt.argtypes = [ctypes.c_void_p, ctypes.POINTER(ProcessEntry)]
    first.restype = nxt.restype = ctypes.c_int
    close = kernel.CloseHandle
    close.argtypes = [ctypes.c_void_p]
    close.restype = ctypes.c_int

    snapshot = snapshot_fn(0x00000002, 0)
    if not snapshot or snapshot == ctypes.c_void_p(-1).value:
        return []
    parents: dict[int, int] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(ProcessEntry)
        if not first(snapshot, ctypes.byref(entry)):
            return []
        while True:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            if not nxt(snapshot, ctypes.byref(entry)):
                break
    finally:
        close(snapshot)

    children: dict[int, list[int]] = {}
    for pid, parent in parents.items():
        children.setdefault(parent, []).append(pid)
    found: list[int] = []
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        if pid == root or pid in found:
            continue
        found.append(pid)
        stack.extend(children.get(pid, []))
    return found


async def _stop_group(process: asyncio.subprocess.Process) -> None:
    try:
        if sys.platform == "win32":
            # FFmpeg and the token helper are children of the worker and must stop with it.
            terminator = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await terminator.wait()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 1)
        except TimeoutError:
            if sys.platform == "win32":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
    except ProcessLookupError:
        pass
