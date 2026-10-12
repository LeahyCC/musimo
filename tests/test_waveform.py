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
from fastapi import FastAPI

from backend.api.waveform_api import install_waveform_routes
from backend.core.store import Store
from backend.library.index import Library
from backend.library.player import Player
from backend.library.waveform import (
    WAVEFORM_POINTS,
    PeakReader,
    WaveformService,
    WaveformUnavailable,
    decode_file,
    fold_peaks,
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

    async def test_a_path_outside_the_roots_or_a_symlink_is_not_decoded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, ["inside.wav"], decoder) as opened:
                outside = base / "elsewhere.wav"
                write_wav(outside)
                song_id = opened.ids["inside.wav"]
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 200)

                inside = base / "music" / "inside.wav"
                inside.unlink()
                inside.symlink_to(outside)
                self.assertEqual((await opened.peaks("inside.wav")).status_code, 404)

                inside.unlink()
                write_wav(inside)
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


class PeakTests(unittest.TestCase):
    def test_reader_takes_the_loudest_sample_of_each_window_across_split_reads(self) -> None:
        data = pcm(100, -300, 20, 5, -32768, 7, 40)
        with patch("backend.library.waveform.WINDOW_SAMPLES", 2):
            reader = PeakReader()
            reader.feed(data[:3])
            reader.feed(data[3:8])
            reader.feed(data[8:])
            self.assertEqual(reader.finish(), [300, 20, 32768, 40])

    def test_folding_keeps_the_loudest_window_of_each_bucket_and_scales_to_255(self) -> None:
        peaks = [0] * 1600
        peaks[3] = 500
        peaks[1599] = 1000
        folded = fold_peaks(peaks)

        self.assertEqual(len(folded), WAVEFORM_POINTS)
        self.assertEqual(folded[1], 128)
        self.assertEqual(folded[799], 255)
        self.assertEqual(folded[0], 0)

    def test_a_short_track_repeats_its_windows_to_fill_the_points(self) -> None:
        folded = fold_peaks([10, 20, 40])

        self.assertEqual(len(folded), WAVEFORM_POINTS)
        self.assertEqual(folded[0], 64)
        self.assertEqual(folded[-1], 255)

    def test_silence_stays_silent_and_no_audio_gives_nothing(self) -> None:
        self.assertEqual(fold_peaks([0, 0, 0]), bytes(WAVEFORM_POINTS))
        self.assertEqual(fold_peaks([]), b"")


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

            self.assertEqual(len(folded), WAVEFORM_POINTS)
            self.assertLess(folded[100], 30)
            self.assertGreater(folded[700], 240)

    async def test_a_file_that_is_not_audio_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            track = Path(directory) / "notes.flac"
            track.write_text("these are not samples", encoding="utf-8")

            with self.assertRaises(WaveformUnavailable):
                await decode_file(track)
