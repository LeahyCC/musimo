"""Lease, measure, report, repeat, until told to stop."""

import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from audio_worker.client import Client, ClientError, lease, submit
from audio_worker.recipe import RECIPE, analyse, job_from

IDLE_SECONDS = 15.0
RETRY_SECONDS = 30.0


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), message, flush=True)


def work_once(post: Callable[[str, dict[str, object]], object], roots: list[Path]) -> bool:
    """One lease. Returns whether there was a song to measure."""
    job_payload = lease(post, RECIPE)
    if job_payload is None:
        return False
    job = job_from(job_payload)
    started = time.monotonic()
    result = analyse(job, roots)
    submit(post, result.payload())
    log(
        f"{job.song_id} {result.status} in {time.monotonic() - started:.1f} s"
        + (f": {result.detail}" if result.detail else "")
    )
    return True


def main() -> int:
    token = os.environ.get("MUSIMO_ANALYSIS_TOKEN", "")
    if not token:
        print("MUSIMO_ANALYSIS_TOKEN is empty. Nothing to do.", file=sys.stderr)
        return 2
    recipe = os.environ.get("MUSIMO_AUDIO_RECIPE", RECIPE)
    if recipe != RECIPE:
        print(f"This worker measures {RECIPE}, not {recipe}.", file=sys.stderr)
        return 2
    roots = [
        Path(root)
        for root in os.environ.get("MUSIMO_LIBRARY_ROOTS", "/music").split(os.pathsep)
        if root
    ]
    idle = float(os.environ.get("MUSIMO_WORKER_IDLE_SECONDS", str(IDLE_SECONDS)))
    client = Client(os.environ.get("MUSIMO_APP_URL", "http://musimo:8765"), token)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    log(f"measuring {RECIPE} from {client.base_url}, music under {[str(r) for r in roots]}")
    while not stop.is_set():
        try:
            busy = work_once(client.post, roots)
        except (ClientError, ValueError) as exc:
            # The lease lapses on its own; the song comes round again.
            log(f"waiting {RETRY_SECONDS:.0f} s: {exc}")
            stop.wait(RETRY_SECONDS)
            continue
        if not busy:
            stop.wait(idle)
    log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
