"""Waveform peaks for the Now Playing seek bar.

One ffmpeg decode per track, cached in SQLite until the file changes. ffmpeg reads the file from
disk when Navidrome's path for it resolves inside a library root, and otherwise a copy of
Navidrome's stream. Only one decode runs at a time, a short line waits behind it, and anything
that takes too long is given up on, so a big album cannot start twenty ffmpeg processes.
"""

import asyncio
import contextlib
import subprocess
import sys
import tempfile
from array import array
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException

from backend.navidrome import Navidrome
from backend.player_api import checked_id
from backend.store import Store

WAVEFORM_POINTS = 800
# Written into every cache key. Bump it when the way peaks are worked out changes, so rows made by
# the old rule are worked out again instead of being served.
WAVEFORM_VERSION = 1
# Peaks do not need hi-fi, and a low rate keeps the decode and the arithmetic small.
DECODE_RATE = 8000
# 12.5 ms of audio per window. The windows are folded down to WAVEFORM_POINTS at the end, so the
# result does not depend on the length Navidrome reports.
WINDOW_SAMPLES = 100
READ_BYTES = 1 << 16
# How many requests may wait behind the decode that is running, and how long each may wait.
QUEUE_LIMIT = 8
QUEUE_WAIT_SECONDS = 30.0
DECODE_SECONDS = 60.0
# A stream is copied to disk before ffmpeg reads it (some formats cannot be decoded from a pipe),
# so a runaway download is stopped here.
STREAM_LIMIT_BYTES = 512 * 1024 * 1024
# Tracks that failed to decode, remembered so a broken file is not retried on every visit.
FAILURE_MEMORY = 256


class WaveformUnavailable(Exception):
    """There are no peaks to give for this track, now or while the file is unchanged."""


class WaveformBusy(Exception):
    """The line for the decoder is full; asking again shortly is likely to work."""


Decoder = Callable[[Path], Awaitable[bytes]]


class PeakReader:
    """Folds a stream of little-endian 16-bit mono samples into one peak per fixed window."""

    def __init__(self) -> None:
        self.peaks: list[int] = []
        # The odd byte left when a read splits a sample, and the window that is still filling.
        self.split = b""
        self.open: array[int] = array("h")

    def feed(self, chunk: bytes) -> None:
        data = self.split + chunk
        whole = len(data) - len(data) % 2
        self.split = data[whole:]
        samples: array[int] = array("h")
        samples.frombytes(data[:whole])
        if sys.byteorder == "big":
            samples.byteswap()
        self.open.extend(samples)
        full = len(self.open) - len(self.open) % WINDOW_SAMPLES
        for start in range(0, full, WINDOW_SAMPLES):
            self.peaks.append(window_peak(self.open[start : start + WINDOW_SAMPLES]))
        self.open = self.open[full:]

    def finish(self) -> list[int]:
        if self.open:
            self.peaks.append(window_peak(self.open))
            self.open = array("h")
        return self.peaks


def window_peak(samples: array[int]) -> int:
    # Two scans at C speed beat abs() over every sample, and -min covers -32768.
    return max(max(samples), -min(samples))


def fold_peaks(peaks: list[int], points: int = WAVEFORM_POINTS) -> bytes:
    """`points` values from 0 to 255, the loudest being 255. Too few windows repeat."""
    if not peaks:
        return b""
    count = len(peaks)
    folded: list[int] = []
    for index in range(points):
        start = index * count // points
        folded.append(max(peaks[start : max(start + 1, (index + 1) * count // points)]))
    loudest = max(folded)
    if not loudest:
        return bytes(points)
    return bytes(round(value * 255 / loudest) for value in folded)


def peak_values(stored: bytes) -> list[float]:
    return [round(value / 255, 3) for value in stored]


async def decode_file(source: Path) -> bytes:
    """Peaks of the first audio stream in `source`, or WaveformUnavailable if ffmpeg cannot."""
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(DECODE_RATE),
            "-f",
            "s16le",
            "-",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            # Nothing here reads it, and it can carry a path.
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        raise WaveformUnavailable("ffmpeg could not be started") from exc
    stdout = process.stdout
    if stdout is None:
        raise WaveformUnavailable("ffmpeg gave no output")
    reader = PeakReader()
    try:
        while chunk := await stdout.read(READ_BYTES):
            reader.feed(chunk)
        code = await process.wait()
    finally:
        # A timeout or a dropped request lands here with ffmpeg still running.
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
    folded = fold_peaks(reader.finish())
    if code != 0 or not folded:
        raise WaveformUnavailable("ffmpeg could not decode the file")
    return folded


@dataclass(frozen=True)
class Source:
    """Where to read a track from, and what to key its cached peaks on."""

    fingerprint: str
    path: Path | None


class WaveformService:
    def __init__(
        self,
        store: Store,
        navidrome: Navidrome,
        roots: list[Path],
        decode: Decoder = decode_file,
    ) -> None:
        self.store = store
        self.navidrome = navidrome
        # Resolved, so the containment check below compares like with like.
        self.roots = [root.resolve() for root in roots]
        self.decode = decode
        self.turn = asyncio.Semaphore(1)
        self.waiting = 0
        self.failures: OrderedDict[str, str] = OrderedDict()

    async def peaks(self, song_id: str) -> list[float]:
        song = await self.navidrome.song(song_id)
        source = await asyncio.to_thread(self.locate, song)
        stored = self.store.waveform(song_id, source.fingerprint)
        if stored is None:
            if self.failures.get(song_id) == source.fingerprint:
                raise WaveformUnavailable("This file could not be decoded")
            stored = await self.compute(song_id, source)
        return peak_values(stored)

    def locate(self, song: dict[str, object]) -> Source:
        """The file on disk if Navidrome's path resolves inside a library root, else the stream."""
        relative = song.get("path")
        found = self.on_disk(relative) if isinstance(relative, str) and relative else None
        if found:
            return found
        # Navidrome bumps `updated` when a scan sees the file change, and size backs it up.
        stamp = f"{song.get('size', 0)}:{song.get('updated') or song.get('created') or ''}"
        return Source(f"v{WAVEFORM_VERSION}:stream:{stamp}", None)

    def on_disk(self, relative: str) -> Source | None:
        for root in self.roots:
            try:
                # A path that climbs out of the root, or a link that leads out, is not ours.
                candidate = (root / relative).resolve()
                if not candidate.is_relative_to(root) or not candidate.is_file():
                    continue
                stat = candidate.stat()
            except (OSError, ValueError):
                continue
            return Source(f"v{WAVEFORM_VERSION}:disk:{stat.st_size}:{stat.st_mtime_ns}", candidate)
        return None

    async def compute(self, song_id: str, source: Source) -> bytes:
        if self.waiting >= QUEUE_LIMIT:
            raise WaveformBusy("Waveforms are being worked out, try again shortly")
        self.waiting += 1
        try:
            async with asyncio.timeout(QUEUE_WAIT_SECONDS):
                await self.turn.acquire()
        except TimeoutError:
            raise WaveformUnavailable("Waited too long for a turn") from None
        finally:
            self.waiting -= 1
        try:
            # A request ahead in the line may have worked this track out while this one waited.
            stored = self.store.waveform(song_id, source.fingerprint)
            if stored is not None:
                return stored
            try:
                async with asyncio.timeout(DECODE_SECONDS):
                    stored = await self.run(song_id, source)
            except TimeoutError:
                self.remember_failure(song_id, source.fingerprint)
                raise WaveformUnavailable("Working out the waveform took too long") from None
            except WaveformUnavailable:
                self.remember_failure(song_id, source.fingerprint)
                raise
            self.store.save_waveform(song_id, source.fingerprint, stored)
            return stored
        finally:
            self.turn.release()

    async def run(self, song_id: str, source: Source) -> bytes:
        if source.path is not None:
            return await self.decode(source.path)
        with tempfile.TemporaryDirectory(prefix="musimo-waveform-") as directory:
            copy = Path(directory) / "stream"
            await self.download(song_id, copy)
            return await self.decode(copy)

    async def download(self, song_id: str, target: Path) -> None:
        response = await self.navidrome.media("stream", song_id)
        written = 0
        try:
            with target.open("wb") as out:
                async for chunk in response.aiter_bytes():
                    written += len(chunk)
                    if written > STREAM_LIMIT_BYTES:
                        raise WaveformUnavailable("The file is too large to work out")
                    out.write(chunk)
        finally:
            await response.aclose()

    def remember_failure(self, song_id: str, fingerprint: str) -> None:
        self.failures[song_id] = fingerprint
        self.failures.move_to_end(song_id)
        while len(self.failures) > FAILURE_MEMORY:
            self.failures.popitem(last=False)


def install_waveform_routes(app: FastAPI, get: Callable[[], WaveformService]) -> None:
    @app.get("/api/player/waveform/{song_id}")
    async def waveform(song_id: str) -> dict[str, object]:
        try:
            return {"peaks": await get().peaks(checked_id(song_id))}
        except WaveformUnavailable as exc:
            raise HTTPException(404, str(exc)) from exc
        except WaveformBusy as exc:
            raise HTTPException(503, str(exc), headers={"Retry-After": "10"}) from exc
