import asyncio
import os
import shutil
import struct
import tempfile
import unittest
import wave
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np
from fastapi import FastAPI

from backend.api.waveform_api import install_waveform_routes
from backend.core.store import Store
from backend.library.index import Library
from backend.library.player import Player
from backend.library.waveform import (
    CHANNELS,
    WAVEFORM_POINTS,
    LoudnessReader,
    WaveformService,
    WaveformUnavailable,
    decode_file,
    fold_loudness,
    waveform_values,
)

PEAKS = bytes(index % 256 for index in range(WAVEFORM_POINTS))


def write_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\0\0" * 800)


class FakeDecoder:
    """Stands in for ffmpeg: records what it was asked to read, and what that file held."""

    def __init__(self, work: Callable[[Path], Awaitable[None]] | None = None) -> None:
        self.work = work
        self.calls: list[Path] = []
        self.contents: list[bytes] = []
        self.running = 0
        self.busiest = 0

    async def __call__(self, source: Path) -> bytes:
        self.calls.append(source)
        self.contents.append(source.read_bytes())
        self.running += 1
        self.busiest = max(self.busiest, self.running)
        try:
            if self.work:
                await self.work(source)
            return PEAKS
        finally:
            self.running -= 1


@dataclass
class Serving:
    client: httpx.AsyncClient
    service: WaveformService
    store: Store
    ids: dict[str, str]

    async def peaks(self, name: str) -> httpx.Response:
        return await self.peaks_id(self.ids[name])

    async def peaks_id(self, song_id: str) -> httpx.Response:
        return await self.client.get(f"/api/player/waveform/{song_id}")

    def cached(self) -> int:
        return int(self.store.db.execute("SELECT count(*) FROM waveforms").fetchone()[0])


@asynccontextmanager
async def serving(
    directory: Path, names: list[str], decoder: FakeDecoder
) -> AsyncIterator[Serving]:
    """Waveforms for generated files under a temporary music root."""
    root = directory / "music"
    root.mkdir()
    for name in names:
        write_wav(root / name)
    store = Store(directory / "musimo.sqlite3")
    library = Library(store, [root], asyncio.Event())
    try:
        library.scan()
        ids: dict[str, str] = {}
        for name in names:
            row = store.db.execute(
                "SELECT song_id FROM library_files WHERE path=?", (str(root / name),)
            ).fetchone()
            if row is None:
                found = [
                    str(item["path"]) for item in store.db.execute("SELECT path FROM library_files")
                ]
                raise AssertionError(f"{root / name} was not indexed; have {found}")
            ids[name] = str(row["song_id"])
        player = Player(store, [root])
        service = WaveformService(store, player, decoder)
        app = FastAPI()
        install_waveform_routes(app, lambda: service)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            yield Serving(client, service, store, ids)
    finally:
        store.close()


class WaveformRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_file_in_the_library_is_decoded_once_then_read_from_the_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["Artist/One/01 Track.wav"], decoder) as opened:
                first = await opened.peaks("Artist/One/01 Track.wav")
                second = await opened.peaks("Artist/One/01 Track.wav")

                self.assertEqual(first.status_code, 200)
                peaks = first.json()["peaks"]
                self.assertEqual(len(peaks), WAVEFORM_POINTS)
                self.assertTrue(all(0 <= value <= 1 for value in peaks))
                self.assertEqual(peaks[255], 1.0)
                self.assertEqual(second.json(), first.json())
                self.assertEqual(len(decoder.calls), 1)
                self.assertEqual(
                    decoder.calls[0], (base / "music" / "Artist/One/01 Track.wav").resolve()
                )
                self.assertEqual(opened.cached(), 1)

    async def test_a_changed_file_is_worked_out_again_and_replaces_its_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["one.wav"], decoder) as opened:
                track = base / "music" / "one.wav"
                await opened.peaks("one.wav")
                await opened.peaks("one.wav")
                self.assertEqual(len(decoder.calls), 1)

                track.write_bytes(b"a longer second take")
                await opened.peaks("one.wav")
                self.assertEqual(len(decoder.calls), 2)

                stat = track.stat()
                os.utime(track, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
                await opened.peaks("one.wav")
                self.assertEqual(len(decoder.calls), 3)

                await opened.peaks("one.wav")
                self.assertEqual(len(decoder.calls), 3)
                self.assertEqual(opened.cached(), 1)

    async def test_a_path_outside_the_roots_is_not_decoded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["inside.wav"], decoder) as opened:
                outside = base / "elsewhere.wav"
                write_wav(outside)
                song_id = opened.ids["inside.wav"]
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 200)

                inside = base / "music" / "inside.wav"
                opened.store.db.execute(
                    "UPDATE library_files SET path=? WHERE song_id=?", (str(outside), song_id)
                )
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 404)
                opened.store.db.execute(
                    "UPDATE library_files SET path=? WHERE song_id=?", (str(inside), song_id)
                )
                opened.store.db.execute(
                    "UPDATE library_roots SET enabled=0 WHERE path=?", (str(base / "music"),)
                )
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 404)
                self.assertEqual(len(decoder.calls), 1)

    async def test_a_symlink_outside_the_roots_is_not_decoded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["inside.wav"], decoder) as opened:
                outside = base / "elsewhere.wav"
                write_wav(outside)
                inside = base / "music" / "inside.wav"
                inside.unlink()
                try:
                    inside.symlink_to(outside)
                except OSError as exc:
                    if getattr(exc, "winerror", None) == 1314:
                        self.skipTest(
                            "Windows account lacks permission to create symlinks (WinError 1314)"
                        )
                    raise
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 404)
                self.assertEqual(decoder.calls, [])

    async def test_a_decode_that_takes_too_long_is_404_and_is_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            interrupted: list[bool] = []

            async def hang(_: Path) -> None:
                try:
                    await asyncio.sleep(30)
                finally:
                    interrupted.append(True)

            decoder = FakeDecoder(hang)
            async with serving(base, ["slow.wav"], decoder) as opened:
                with patch("backend.library.waveform.DECODE_SECONDS", 0.05):
                    first = await opened.peaks("slow.wav")
                    second = await opened.peaks("slow.wav")

                self.assertEqual(first.status_code, 404)
                self.assertEqual(second.status_code, 404)
                self.assertEqual(interrupted, [True])
                self.assertEqual(len(decoder.calls), 1)
                self.assertEqual(opened.cached(), 0)
                self.assertFalse(opened.service.turn.locked())

    async def test_a_file_that_cannot_be_decoded_is_404(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()

            async def refuse(_: Path) -> None:
                raise WaveformUnavailable("ffmpeg could not decode the file")

            decoder = FakeDecoder(refuse)
            async with serving(base, ["broken.wav"], decoder) as opened:
                self.assertEqual((await opened.peaks("broken.wav")).status_code, 404)
                self.assertEqual((await opened.peaks("broken.wav")).status_code, 404)
                self.assertEqual(len(decoder.calls), 1)
                self.assertEqual(opened.cached(), 0)

    async def test_only_one_decode_runs_at_a_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            names = [f"track-{number}.wav" for number in range(5)]

            async def work(_: Path) -> None:
                await asyncio.sleep(0.01)

            decoder = FakeDecoder(work)
            async with serving(base, names, decoder) as opened:
                responses = await asyncio.gather(*(opened.peaks(name) for name in names))

                self.assertEqual([response.status_code for response in responses], [200] * 5)
                self.assertEqual(len(decoder.calls), 5)
                self.assertEqual(decoder.busiest, 1)

    async def test_the_same_track_asked_for_twice_at_once_is_decoded_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()

            async def work(_: Path) -> None:
                await asyncio.sleep(0.02)

            decoder = FakeDecoder(work)
            async with serving(base, ["one.wav"], decoder) as opened:
                first, second = await asyncio.gather(
                    opened.peaks("one.wav"), opened.peaks("one.wav")
                )

                self.assertEqual((first.status_code, second.status_code), (200, 200))
                self.assertEqual(len(decoder.calls), 1)

    async def test_a_full_line_is_told_to_try_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            started = asyncio.Event()
            gate = asyncio.Event()

            async def work(_: Path) -> None:
                started.set()
                await gate.wait()

            decoder = FakeDecoder(work)
            async with serving(base, ["a.wav", "b.wav", "c.wav"], decoder) as opened:
                with patch("backend.library.waveform.QUEUE_LIMIT", 1):
                    running = asyncio.create_task(opened.peaks("a.wav"))
                    await asyncio.wait_for(started.wait(), 5)
                    waiting = asyncio.create_task(opened.peaks("b.wav"))
                    while opened.service.waiting < 1:
                        await asyncio.sleep(0.005)

                    refused = await opened.peaks("c.wav")
                    gate.set()
                    results = await asyncio.gather(running, waiting)

                self.assertEqual(refused.status_code, 503)
                self.assertIn("Retry-After", refused.headers)
                self.assertEqual([response.status_code for response in results], [200, 200])
                self.assertEqual(len(decoder.calls), 2)

    async def test_waiting_too_long_for_a_turn_is_404(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            started = asyncio.Event()
            gate = asyncio.Event()

            async def work(_: Path) -> None:
                started.set()
                await gate.wait()

            decoder = FakeDecoder(work)
            async with serving(base, ["a.wav", "b.wav"], decoder) as opened:
                running = asyncio.create_task(opened.peaks("a.wav"))
                await asyncio.wait_for(started.wait(), 5)
                with patch("backend.library.waveform.QUEUE_WAIT_SECONDS", 0.05):
                    gave_up = await opened.peaks("b.wav")
                gate.set()

                self.assertEqual(gave_up.status_code, 404)
                self.assertEqual((await running).status_code, 200)
                self.assertEqual(opened.service.waiting, 0)
                self.assertEqual(len(decoder.calls), 1)

    async def test_an_unknown_song_and_a_bad_id_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["one.wav"], decoder) as opened:
                self.assertEqual((await opened.peaks_id("tr-0123456789abcdef")).status_code, 404)
                self.assertEqual((await opened.peaks_id("not%20an%20id")).status_code, 422)
                self.assertEqual(decoder.calls, [])


def pcm(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def loudness(whole: list[float]) -> np.ndarray:
    """Window powers with the whole song in the first channel and the bands even."""
    return np.array([[power, 1.0, 1.0, 1.0] for power in whole])


class LoudnessTests(unittest.TestCase):
    def test_reader_takes_the_mean_power_of_each_channel_across_split_reads(self) -> None:
        # Two frames of four channels to a window, then one frame left over.
        data = pcm(100, 0, 3, 0, -300, 0, 5, 2, -32768, 1, 0, 0, 0, 1, 0, 0, 40, 0, 0, 0)
        with patch("backend.library.waveform.WINDOW_SAMPLES", 2):
            reader = LoudnessReader()
            reader.feed(data[:3])
            reader.feed(data[3:19])
            reader.feed(data[19:])
            powers = reader.finish()

        self.assertEqual(powers.shape, (3, CHANNELS))
        self.assertEqual(powers[0].tolist(), [50000, 0, 17, 2])
        self.assertEqual(powers[1].tolist(), [32768**2 / 2, 1, 0, 0])
        self.assertEqual(powers[2].tolist(), [1600, 0, 0, 0])

    def test_a_loud_song_still_shows_a_breakdown_a_few_decibels_down(self) -> None:
        # Peaks would draw this solid: 3 dB is nothing on a full-scale bar.
        whole = [1e6] * 1600
        whole[400:600] = [5e5] * 200
        folded = fold_loudness(loudness(whole))

        self.assertEqual(len(folded), WAVEFORM_POINTS * CHANNELS)
        self.assertEqual(folded[0], 255)
        # 3 dB down on the 6 dB minimum range sits about halfway.
        self.assertIn(folded[250], range(125, 131))

    def test_the_quiet_end_of_a_wide_song_reaches_the_bottom(self) -> None:
        folded = fold_loudness(loudness([1e6] * 1200 + [1e3] * 400))

        self.assertEqual(folded[0], 255)
        self.assertEqual(folded[WAVEFORM_POINTS - 1], 0)

    def test_each_band_is_measured_against_its_own_loudest_point(self) -> None:
        # Bass carries a hundred times the highs' power, and still the highs reach the top where
        # they are loudest, so a bar where only hats are left can read blue.
        powers = np.array([[1e6, 1e6, 1e4, 1e2]] * 800 + [[1e6, 1e4, 1e4, 4e2]] * 800)
        values = waveform_values(fold_loudness(powers))
        bands = values["bands"]
        assert isinstance(bands, list)

        # Half the level is 128 of 255.
        self.assertEqual(bands[0], [1.0, 1.0, 0.502])
        self.assertEqual(bands[-1], [0.102, 1.0, 1.0])

    def test_a_short_track_repeats_its_windows_to_fill_the_points(self) -> None:
        folded = fold_loudness(loudness([1e4, 1e4, 1e6]))

        self.assertEqual(len(folded), WAVEFORM_POINTS * CHANNELS)
        self.assertEqual(folded[0], folded[1])
        self.assertEqual(folded[WAVEFORM_POINTS - 1], 255)

    def test_silence_stays_silent_and_no_audio_gives_nothing(self) -> None:
        silent = fold_loudness(np.zeros((3, CHANNELS)))
        self.assertEqual(silent, bytes(WAVEFORM_POINTS * CHANNELS))
        self.assertEqual(fold_loudness(np.empty((0, CHANNELS))), b"")

    def test_a_row_from_before_the_bands_answers_with_peaks_only(self) -> None:
        values = waveform_values(PEAKS)

        self.assertEqual(len(values["peaks"]), WAVEFORM_POINTS)  # type: ignore[arg-type]
        self.assertNotIn("bands", values)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
class FfmpegTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_quiet_second_then_a_loud_one_reads_quiet_then_loud(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            track = Path(directory) / "tone.wav"
            with wave.open(str(track), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(8000)
                out.writeframes(pcm(*([1000, -1000] * 4000)))
                out.writeframes(pcm(*([20000, -20000] * 4000)))

            folded = await decode_file(track)

            self.assertEqual(len(folded), WAVEFORM_POINTS * CHANNELS)
            self.assertLess(folded[100], 30)
            self.assertGreater(folded[700], 240)

    async def test_a_low_hum_then_a_hiss_reads_bass_then_highs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            track = Path(directory) / "bands.wav"
            rate = 16000
            hum = [int(12000 * np.sin(2 * np.pi * 60 * n / rate)) for n in range(rate * 2)]
            hiss = [int(12000 * np.sin(2 * np.pi * 5000 * n / rate)) for n in range(rate * 2)]
            with wave.open(str(track), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(pcm(*hum, *hiss))

            values = waveform_values(await decode_file(track))
            bands = values["bands"]
            assert isinstance(bands, list)

            bass, _, highs = bands[200]
            self.assertGreater(bass, 0.8)
            self.assertLess(highs, 0.1)
            bass, _, highs = bands[600]
            self.assertLess(bass, 0.1)
            self.assertGreater(highs, 0.8)

    async def test_a_file_that_is_not_audio_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            track = Path(directory) / "notes.flac"
            track.write_text("these are not samples", encoding="utf-8")

            with self.assertRaises(WaveformUnavailable):
                await decode_file(track)
