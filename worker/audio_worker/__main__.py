"""Lease, measure, report, repeat, until told to stop.

`MUSIMO_AUDIO_RECIPE` picks the recipe: `tempo-energy-v1` (librosa, one song at a time) in the
`worker/Dockerfile` image, `tempo-beat-v1` (Beat This!, several decoders and one model) in the
`worker/beat.Dockerfile` images.
"""

import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from audio_worker import beat
from audio_worker.client import Client, ClientError, lease, submit
from audio_worker.recipe import RECIPE, analyse, job_from

IDLE_SECONDS = 15.0
RETRY_SECONDS = 30.0
VERSION = "0.5.0"
CGROUP = Path("/sys/fs/cgroup")


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), message, flush=True)


def work_once(post: Callable[[str, dict[str, object]], object], roots: list[Path]) -> bool:
    """One `tempo-energy-v1` lease. Returns whether there was a song to measure."""
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


def cgroup_limits(root: Path = CGROUP) -> tuple[int | None, float | None]:
    """The container's memory cap in bytes and its CPU quota in cores, when it has them."""
    memory: int | None = None
    cpus: float | None = None
    try:
        text = (root / "memory.max").read_text().strip()
        memory = int(text) if text.isdigit() else None
    except OSError:
        pass
    try:
        quota, period = (root / "cpu.max").read_text().split()[:2]
        if quota.isdigit() and period.isdigit() and int(period):
            cpus = round(int(quota) / int(period), 2)
    except (OSError, ValueError):
        pass
    return memory, cpus


def whole_number(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return min(high, max(low, value))


def main() -> int:
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    token = os.environ.get("MUSIMO_ANALYSIS_TOKEN", "").strip()
    recipe = os.environ.get("MUSIMO_AUDIO_RECIPE", RECIPE)
    problem = ""
    if not token:
        problem = "MUSIMO_ANALYSIS_TOKEN is empty. Set the same secret for musimo and this worker."
    elif recipe not in (RECIPE, beat.RECIPE):
        problem = f"This worker measures {RECIPE} or {beat.RECIPE}, not {recipe}."
    if problem:
        # Compose restarts an exited container, so a misconfiguration would loop. Say it once
        # and wait to be stopped instead.
        print(problem + " Nothing to do until the container is restarted.", file=sys.stderr)
        stop.wait()
        return 2
    roots = [
        Path(root)
        for root in os.environ.get("MUSIMO_LIBRARY_ROOTS", "/music").split(os.pathsep)
        if root
    ]
    idle = float(os.environ.get("MUSIMO_WORKER_IDLE_SECONDS", str(IDLE_SECONDS)))
    client = Client(os.environ.get("MUSIMO_APP_URL", "http://musimo:8765"), token)
    if recipe == beat.RECIPE:
        return run_beat(client, roots, idle, stop)
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


def run_beat(client: Client, roots: list[Path], idle: float, stop: threading.Event) -> int:
    # Imported here: only the tempo-beat-v1 images have torch.
    from audio_worker.model import load_tracker
    from audio_worker.pipeline import Pipeline

    memory, cpus = cgroup_limits()
    decoders = whole_number("MUSIMO_WORKER_DECODERS", 1, 1, 16)
    threads = whole_number("MUSIMO_WORKER_THREADS", max(1, int(cpus or 1)), 1, 32)
    preference = os.environ.get("MUSIMO_WORKER_DEVICE", "auto").strip().casefold()
    if preference not in ("auto", "cuda", "cpu"):
        preference = "auto"
    started = time.monotonic()
    track, device = load_tracker(preference, threads)
    info: dict[str, object] = {
        "version": VERSION,
        "device": device.name,
        "gpu": device.gpu,
        "decoders": decoders,
        "memory_limit": memory,
        "cpus": cpus,
        "note": device.note,
    }
    log(
        f"measuring {beat.RECIPE} on {device.name}{' ' + device.gpu if device.gpu else ''}"
        f" with {decoders} decoder(s), model loaded in {time.monotonic() - started:.1f} s"
        + (f" ({device.note})" if device.note else "")
    )
    stored = Pipeline(client.post, roots, track, decoders, info, log, stop, idle=idle).run()
    log(f"stopped after {stored} results")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
