"""Waveform bars for the Now Playing seek bar.

Each bar is how loud that stretch of the song is (its average power), not its single loudest
sample. A mastered song hits close to full scale nearly everywhere, so peaks drew a solid block.
The bars are then stretched to the song's own range, so a breakdown a few decibels down still
reads as a dip.

The same decode splits the song into bass, mids and highs, the way DJ software colours its
waveforms, and each point carries how much of each band it has, measured against that band's
average over the song. The seek bar mixes the three into the bar's colour.

One ffmpeg decode per track, cached in SQLite until the file changes. ffmpeg reads the file
from disk when its path resolves inside a library root. A missing file, a symlink or a path
outside the roots has no peaks. Only one decode runs at a time, a short line waits behind it,
and anything that takes too long is given up on, so a big album cannot start twenty ffmpeg
processes.
"""

import asyncio
import contextlib
import subprocess
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

from backend.core.store import Store
from backend.library.player import Player

WAVEFORM_POINTS = 800
# Written into every cache key. Bump it when the way peaks are worked out changes, so rows made by
# the old rule are worked out again instead of being served.
WAVEFORM_VERSION = 4
# High enough to keep the highs band (cymbals, hats) below its 8 kHz ceiling, and low enough that
# the decode and the arithmetic stay small.
DECODE_RATE = 16000
# 12.5 ms of audio per window. The windows are folded down to WAVEFORM_POINTS at the end, so the
# result does not depend on how long the file is.
WINDOW_SAMPLES = 200
# Where bass ends and mids start, and where mids end and highs start, roughly where DJ software
# splits its three colours. Each filter is applied twice for a steeper edge.
BASS_TOP_HZ = 200
HIGHS_FROM_HZ = 2000
# ffmpeg sends four channels: the whole song, then bass, mids and highs.
CHANNELS = 4
READ_BYTES = 1 << 18
# The bars span the song's loudest point down to its quietest 5%, but never less than this many
# decibels, so a song that is flat throughout draws flat instead of blowing noise up into hills.
MIN_RANGE_DB = 6.0
QUIET_SHARE = 0.05
# Points further than this under the loudest are near-silence (the gap before a hidden track, the
# tail of a fade). They are left out when finding the quiet end, or a long gap would stretch the
# scale so far that the music itself drew flat. They still draw, at the bottom.
MAX_RANGE_DB = 30.0
# Each band is sent against its own average, and this many times the average is the top of the
# byte. Against the band's loudest point instead, one big hit would leave the rest of the song a few
# steps of the byte and the colours would follow the rounding.
BAND_CEILING = 4.0
# How many requests may wait behind the decode that is running, and how long each may wait.
QUEUE_LIMIT = 8
QUEUE_WAIT_SECONDS = 30.0
# Four channels at 16 kHz is eight times the audio the old mono 8 kHz decode sent, so a long DJ mix
# or audiobook needs room. A four minute song takes under a second.
DECODE_SECONDS = 180.0
# Tracks that failed to decode, remembered so a broken file is not retried on every visit.
FAILURE_MEMORY = 256


class WaveformUnavailable(Exception):
    """There are no peaks to give for this track, now or while the file is unchanged."""


class WaveformBusy(Exception):
    """The line for the decoder is full; asking again shortly is likely to work."""


Decoder = Callable[[Path], Awaitable[bytes]]


Powers = npt.NDArray[np.float64]


class LoudnessReader:
    """Folds a stream of little-endian 16-bit samples, CHANNELS to a frame, into one mean power
    per channel per fixed window."""

    def __init__(self) -> None:
        self.windows: list[Powers] = []
        # The bytes left when a read splits a frame, and the frames of the window still filling.
        self.split = b""
        self.open: Powers = np.empty((0, CHANNELS))

    def feed(self, chunk: bytes) -> None:
        data = self.split + chunk
        frame = 2 * CHANNELS
        whole = len(data) - len(data) % frame
        self.split = data[whole:]
        samples = np.frombuffer(data[:whole], dtype="<i2").reshape(-1, CHANNELS)
        frames = np.concatenate((self.open, samples.astype(np.float64)))
        full = len(frames) - len(frames) % WINDOW_SAMPLES
        if full:
            squared = np.square(frames[:full]).reshape(-1, WINDOW_SAMPLES, CHANNELS)
            self.windows.append(squared.mean(axis=1))
        self.open = frames[full:]

    def finish(self) -> Powers:
        if len(self.open):
            self.windows.append(np.square(self.open).mean(axis=0, keepdims=True))
            self.open = np.empty((0, CHANNELS))
        return np.concatenate(self.windows) if self.windows else np.empty((0, CHANNELS))


def fold_windows(powers: Powers, points: int = WAVEFORM_POINTS) -> Powers:
    """The mean power of each of `points` even runs of windows. Too few windows repeat."""
    count = len(powers)
    index = np.arange(points)
    starts = index * count // points
    ends = np.maximum(starts + 1, (index + 1) * count // points)
    running = np.concatenate((np.zeros((1, powers.shape[1])), np.cumsum(powers, axis=0)))
    folded: Powers = (running[ends] - running[starts]) / (ends - starts)[:, None]
    return folded


def loudness_levels(folded: Powers) -> bytes:
    """One value from 0 to 255 per point: the loudest is 255 and the song's quiet end is 0.

    Points are in decibels, so they follow how loud a section sounds. The scale runs from the
    loudest point down to the quietest QUIET_SHARE of points, or MIN_RANGE_DB, whichever is wider.
    Points more than MAX_RANGE_DB down do not count towards the quiet end. Silence is 0."""
    heard = folded > 0
    if not heard.any():
        return bytes(len(folded))
    levels = 10 * np.log10(np.where(heard, folded, 1))
    ranked = np.sort(levels[heard])
    top = ranked[-1]
    music = ranked[ranked >= top - MAX_RANGE_DB]
    span = max(MIN_RANGE_DB, top - music[int(len(music) * QUIET_SHARE)])
    scaled = np.clip((levels - (top - span)) / span, 0, 1)
    return bytes(np.where(heard, np.round(scaled * 255), 0).astype(np.uint8))


def band_levels(folded: Powers) -> bytes:
    """One value from 0 to 255 per point: the band's level against its own average, with 255 at
    BAND_CEILING times the average and anything louder held there.

    Bass carries far more power than highs in nearly every song, and most songs keep all three
    bands busy, so each band is measured against its own usual level. Then the band that is above
    its usual level is the one that shows, or every bar would come out the bass colour or grey.
    Amplitude, not power, so a band at half the level reads as half and not a quarter."""
    amplitude = np.sqrt(folded)
    usual = amplitude.mean()
    if usual <= 0:
        return bytes(len(folded))
    scaled = np.clip(amplitude / (usual * BAND_CEILING), 0, 1)
    return bytes(np.round(scaled * 255).astype(np.uint8))


def fold_loudness(powers: Powers, points: int = WAVEFORM_POINTS) -> bytes:
    """What the cache stores: `points` bar heights, then `points` each of bass, mids and highs.
    No audio gives nothing."""
    if not len(powers):
        return b""
    folded = fold_windows(powers, points)
    return loudness_levels(folded[:, 0]) + b"".join(
        band_levels(folded[:, band]) for band in range(1, CHANNELS)
    )


def waveform_values(stored: bytes) -> dict[str, object]:
    """The route's answer: bar heights from 0 to 1, and the bands as one [bass, mids, highs]
    per point. The version in the cache key means every row served is a whole one."""
    points = WAVEFORM_POINTS
    bands = [stored[points * band : points * (band + 1)] for band in range(1, CHANNELS)]
    return {
        "peaks": [round(value / 255, 3) for value in stored[:points]],
        "bands": [[round(value / 255, 3) for value in point] for point in zip(*bands, strict=True)],
    }


async def decode_file(source: Path) -> bytes:
    """Heights and bands of the first audio stream in `source`, or WaveformUnavailable if ffmpeg
    cannot. The song is folded to mono and split into the whole, bass, mids and highs inside
    ffmpeg, which sends them as four channels of one stream."""
    bass = f"lowpass=f={BASS_TOP_HZ},lowpass=f={BASS_TOP_HZ}"
    mids = (
        f"highpass=f={BASS_TOP_HZ},highpass=f={BASS_TOP_HZ},"
        f"lowpass=f={HIGHS_FROM_HZ},lowpass=f={HIGHS_FROM_HZ}"
    )
    highs = f"highpass=f={HIGHS_FROM_HZ},highpass=f={HIGHS_FROM_HZ}"
    graph = (
        f"[0:a:0]aformat=sample_rates={DECODE_RATE}:channel_layouts=mono,asplit=4[whole][b][m][h];"
        f"[b]{bass}[bass];[m]{mids}[mids];[h]{highs}[highs];"
        # join, not amerge: amerge cannot settle a layout for four mono inputs on some files.
        "[whole][bass][mids][highs]join=inputs=4:channel_layout=4.0:"
        "map=0.0-FL|1.0-FR|2.0-FC|3.0-BC[out]"
    )
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(source),
            "-filter_complex",
            graph,
            "-map",
            "[out]",
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
    reader = LoudnessReader()
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
    folded = fold_loudness(reader.finish())
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
        player: Player,
        decode: Decoder = decode_file,
    ) -> None:
        self.store = store
        self.player = player
        self.decode = decode
        self.turn = asyncio.Semaphore(1)
        self.waiting = 0
        self.failures: OrderedDict[str, str] = OrderedDict()

    async def peaks(self, song_id: str) -> dict[str, object]:
        source = await asyncio.to_thread(self.locate, song_id)
        if source is None:
            raise WaveformUnavailable("This track is not in the library")
        stored = self.store.waveform(song_id, source.fingerprint)
        if stored is None:
            if self.failures.get(song_id) == source.fingerprint:
                raise WaveformUnavailable("This file could not be decoded")
            stored = await self.compute(song_id, source)
        return waveform_values(stored)

    def locate(self, song_id: str) -> Source | None:
        """The file when it is inside a library root. A symlink or an outside path is refused."""
        path = self.player.local_file(song_id)
        if path is None:
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        return Source(f"v{WAVEFORM_VERSION}:disk:{stat.st_size}:{stat.st_mtime_ns}", path)

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

    async def run(self, _song_id: str, source: Source) -> bytes:
        path = source.path
        if path is None:
            raise WaveformUnavailable("This track is not in the library")
        return await self.decode(path)

    def remember_failure(self, song_id: str, fingerprint: str) -> None:
        self.failures[song_id] = fingerprint
        self.failures.move_to_end(song_id)
        while len(self.failures) > FAILURE_MEMORY:
            self.failures.popitem(last=False)
