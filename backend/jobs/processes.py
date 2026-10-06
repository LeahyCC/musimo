import asyncio
import os
import signal
import sys

from backend.integrations.youtube_cookies import drop_copy


async def stop_tree(process: asyncio.subprocess.Process) -> None:
    """Stop a child started with its own process group, and everything it started.

    A stopped child cannot run its own exit cleanup, so its copy of the YouTube cookie is
    removed here.
    """
    if process.returncode is None:
        await _stop_group(process)
    drop_copy(process.pid)


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
