"""Several decoders feeding one model, for `tempo-beat-v1`.

```
decoder 1: lease -> check -> FFmpeg x4 --+
decoder 2: lease -> check -> FFmpeg x4 --+--> queue (N songs) --> model --> result
decoder N ...                          --+
```

FFmpeg was most of the time on the graphics card, so each decoder thread leases its own song
and decodes its windows while the model works on another. The queue holds at most one song per
decoder, so no song waits long against its lease. Skipped and failed songs pass through the
queue too, so every result is posted from one thread. A stop lets the decoders finish the song
they hold and the model drain the queue.
"""

import queue
import threading
import time
from collections.abc import Callable
from pathlib import Path

from audio_worker.beat import RECIPE, Decoded, Tracker, WindowDecoder, finish, prepare
from audio_worker.client import ClientError, Poster, lease, submit
from audio_worker.recipe import Result, job_from

Log = Callable[[str], None]
IDLE_SECONDS = 15.0
RETRY_SECONDS = 30.0


class Pipeline:
    def __init__(
        self,
        post: Poster,
        roots: list[Path],
        track: Tracker,
        decoders: int,
        info: dict[str, object],
        log: Log,
        stop: threading.Event,
        idle: float = IDLE_SECONDS,
        retry: float = RETRY_SECONDS,
        decode: WindowDecoder | None = None,
    ) -> None:
        self.post = post
        self.roots = roots
        self.track = track
        self.decoders = max(1, decoders)
        self.info = info
        self.log = log
        self.stop = stop
        self.idle = idle
        self.retry = retry
        self.decode = decode
        self.ready: queue.Queue[tuple[Result | Decoded, float]] = queue.Queue(self.decoders)
        self.done = 0

    def _prepare(self, payload: object) -> Result | Decoded:
        job = job_from(payload)
        if self.decode is None:
            return prepare(job, self.roots)
        return prepare(job, self.roots, self.decode)

    def decoder(self) -> None:
        while not self.stop.is_set():
            try:
                payload = lease(self.post, RECIPE, self.info)
            except ClientError as exc:
                # The app is down or refusing. The lease lapses on its own.
                self.log(f"waiting {self.retry:.0f} s: {exc}")
                self.stop.wait(self.retry)
                continue
            if payload is None:
                self.stop.wait(self.idle)
                continue
            started = time.monotonic()
            try:
                item = self._prepare(payload)
            except ValueError as exc:
                self.log(f"skipping a malformed lease: {exc}")
                continue
            # Blocks while the model is behind, which is what keeps the leases short.
            self.ready.put((item, started))

    def model(self, threads: list[threading.Thread]) -> None:
        while True:
            try:
                item, started = self.ready.get(timeout=0.5)
            except queue.Empty:
                if self.stop.is_set() and not any(thread.is_alive() for thread in threads):
                    return
                continue
            result = item if isinstance(item, Result) else self._finish(item)
            try:
                submit(self.post, result.payload())
            except ClientError as exc:
                self.log(f"{result.song_id} not stored: {exc}")
                continue
            self.done += 1
            self.log(
                f"{result.song_id} {result.status} in {time.monotonic() - started:.1f} s"
                + (f": {result.detail}" if result.status != "done" and result.detail else "")
            )

    def _finish(self, decoded: Decoded) -> Result:
        try:
            return finish(decoded, self.track, str(self.info.get("device", "")))
        except Exception as exc:  # noqa: BLE001 - one bad song must not stop the model thread
            job = decoded.job
            return Result(
                job.song_id,
                job.recipe,
                job.lease_token,
                decoded.size,
                decoded.mtime_ns,
                "failed",
                detail=f"measure failed: {type(exc).__name__}: {exc}",
            )

    def run(self) -> int:
        """Until stopped. Returns how many results were stored."""
        threads = [
            threading.Thread(target=self.decoder, name=f"decoder-{index + 1}", daemon=True)
            for index in range(self.decoders)
        ]
        for thread in threads:
            thread.start()
        self.model(threads)
        for thread in threads:
            thread.join(timeout=5)
        return self.done
