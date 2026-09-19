import asyncio
import json
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

from backend.navidrome import Navidrome
from backend.player_api import install_player_routes
from backend.store import Store
from backend.waveform import (
    WAVEFORM_POINTS,
    PeakReader,
    WaveformService,
    WaveformUnavailable,
    decode_file,
    fold_peaks,
    install_waveform_routes,
)

PEAKS = bytes(index % 256 for index in range(WAVEFORM_POINTS))
STREAM_BYTES = b"audio from navidrome"


def subsonic(**payload: object) -> httpx.Response:
    return httpx.Response(200, json={"subsonic-response": {"status": "ok", **payload}})


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
    streamed: list[str]

    async def peaks(self, song_id: str) -> httpx.Response:
        return await self.client.get(f"/api/player/waveform/{song_id}")

    def cached(self) -> int:
        return int(self.store.db.execute("SELECT count(*) FROM waveforms").fetchone()[0])


@asynccontextmanager
async def serving(
    directory: Path,
    songs: dict[str, dict[str, object]],
    decoder: FakeDecoder,
    roots: list[Path],
) -> AsyncIterator[Serving]:
    """The waveform route in front of a mocked Navidrome that knows `songs`."""
    store = Store(directory / "musimo.sqlite3")
    store.update({"navidrome_url": "http://navidrome:4533"})
    credentials = directory / "navidrome.json"
    credentials.write_text(
        json.dumps({"username": "listener", "password": "private password"}), encoding="utf-8"
    )
    streamed: list[str] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        song_id = request.url.params.get("id", "")
        if request.url.path.endswith("/getSong") and song_id in songs:
            return subsonic(song={"id": song_id, **songs[song_id]})
        if request.url.path.endswith("/stream"):
            streamed.append(song_id)
            return httpx.Response(200, content=STREAM_BYTES, headers={"Content-Type": "audio/mpeg"})
        return httpx.Response(404)

    try:
        with patch.dict("os.environ", {"MUSIMO_NAVIDROME_CREDENTIALS_FILE": str(credentials)}):
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(upstream)
            ) as upstream_client:
                navidrome = Navidrome(store, upstream_client)
                service = WaveformService(store, navidrome, roots, decoder)
                app = FastAPI()
                install_player_routes(app, lambda: navidrome)
                install_waveform_routes(app, lambda: service)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as client:
                    yield Serving(client, service, store, streamed)
    finally:
        store.close()


def library_with(base: Path, *names: str) -> Path:
    library = base / "music"
    for name in names:
        (library / name).parent.mkdir(parents=True, exist_ok=True)
        (library / name).write_bytes(b"first")
    return library


class WaveformRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_file_in_the_library_is_decoded_once_then_read_from_the_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "Artist/One/01 Track.flac")
            decoder = FakeDecoder()
            songs: dict[str, dict[str, object]] = {"song-1": {"path": "Artist/One/01 Track.flac"}}
            async with serving(base, songs, decoder, [library]) as s:
                first = await s.peaks("song-1")
                second = await s.peaks("song-1")

                self.assertEqual(first.status_code, 200)
                peaks = first.json()["peaks"]
                self.assertEqual(len(peaks), WAVEFORM_POINTS)
                self.assertTrue(all(0 <= value <= 1 for value in peaks))
                self.assertEqual(peaks[255], 1.0)
                self.assertEqual(second.json(), first.json())
                # Read from where it lies, never through Navidrome.
                self.assertEqual(decoder.calls, [library / "Artist/One/01 Track.flac"])
                self.assertEqual(s.streamed, [])
                self.assertEqual(s.cached(), 1)

    async def test_a_changed_file_is_worked_out_again_and_replaces_its_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "one.flac")
            track = library / "one.flac"
            decoder = FakeDecoder()
            songs: dict[str, dict[str, object]] = {"song-1": {"path": "one.flac"}}
            async with serving(base, songs, decoder, [library]) as s:
                await s.peaks("song-1")
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 1)

                # A different size is a different file.
                track.write_bytes(b"a longer second take")
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 2)

                # So is the same size with a later modified time.
                stat = track.stat()
                os.utime(track, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 3)

                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 3)
                self.assertEqual(s.cached(), 1)

    async def test_a_path_outside_every_root_is_read_from_the_stream_instead(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "inside.flac")
            (base / "elsewhere.flac").write_bytes(b"not part of the library")
            decoder = FakeDecoder()
            songs: dict[str, dict[str, object]] = {
                # Climbs out of the root to a file that exists, which must not be read.
                "song-1": {"path": "../elsewhere.flac", "size": 20, "updated": "2026-01-01"},
                "song-2": {"path": "Not/On/Disk.flac", "size": 20, "updated": "2026-01-01"},
                "song-3": {"size": 20, "updated": "2026-01-01"},
            }
            async with serving(base, songs, decoder, [library]) as s:
                for song_id in songs:
                    self.assertEqual((await s.peaks(song_id)).status_code, 200)

                self.assertEqual(s.streamed, ["song-1", "song-2", "song-3"])
                # ffmpeg was handed a copy of the stream, which is gone once it is done with it.
                self.assertEqual(decoder.contents, [STREAM_BYTES] * 3)
                for copy in decoder.calls:
                    self.assertNotEqual(copy.parent, base)
                    self.assertFalse(copy.exists())

    async def test_a_stream_is_worked_out_again_when_navidrome_says_it_changed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            songs: dict[str, dict[str, object]] = {
                "song-1": {"size": 20, "updated": "2026-01-01T00:00:00Z"}
            }
            async with serving(base, songs, decoder, []) as s:
                await s.peaks("song-1")
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 1)

                songs["song-1"]["updated"] = "2026-02-01T00:00:00Z"
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 2)

                songs["song-1"]["size"] = 21
                await s.peaks("song-1")
                self.assertEqual(len(decoder.calls), 3)
                self.assertEqual(s.cached(), 1)

    async def test_a_decode_that_takes_too_long_is_404_and_is_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "slow.flac")
            interrupted: list[bool] = []

            async def hang(_: Path) -> None:
                try:
                    await asyncio.sleep(30)
                finally:
                    interrupted.append(True)

            decoder = FakeDecoder(hang)
            songs: dict[str, dict[str, object]] = {"song-1": {"path": "slow.flac"}}
            async with serving(base, songs, decoder, [library]) as s:
                with patch("backend.waveform.DECODE_SECONDS", 0.05):
                    first = await s.peaks("song-1")
                    second = await s.peaks("song-1")

                self.assertEqual(first.status_code, 404)
                self.assertEqual(second.status_code, 404)
                # The decode was stopped, and a file that timed out is not tried again unchanged.
                self.assertEqual(interrupted, [True])
                self.assertEqual(len(decoder.calls), 1)
                self.assertEqual(s.cached(), 0)
                # The turn was handed back, so the next track is not stuck behind this one.
                self.assertFalse(s.service.turn.locked())

    async def test_a_file_that_cannot_be_decoded_is_404(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "broken.flac")

            async def refuse(_: Path) -> None:
                raise WaveformUnavailable("ffmpeg could not decode the file")

            decoder = FakeDecoder(refuse)
            songs: dict[str, dict[str, object]] = {"song-1": {"path": "broken.flac"}}
            async with serving(base, songs, decoder, [library]) as s:
                self.assertEqual((await s.peaks("song-1")).status_code, 404)
                self.assertEqual((await s.peaks("song-1")).status_code, 404)
                self.assertEqual(len(decoder.calls), 1)
                self.assertEqual(s.cached(), 0)

    async def test_a_stream_over_the_limit_is_404_without_a_decode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            songs: dict[str, dict[str, object]] = {"song-1": {"size": 20}}
            async with serving(base, songs, decoder, []) as s:
                with patch("backend.waveform.STREAM_LIMIT_BYTES", 4):
                    response = await s.peaks("song-1")

                self.assertEqual(response.status_code, 404)
                self.assertEqual(decoder.calls, [])

    async def test_only_one_decode_runs_at_a_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            names = [f"track-{number}.flac" for number in range(5)]
            library = library_with(base, *names)

            async def work(_: Path) -> None:
                await asyncio.sleep(0.01)

            decoder = FakeDecoder(work)
            songs: dict[str, dict[str, object]] = {
                f"song-{number}": {"path": name} for number, name in enumerate(names)
            }
            async with serving(base, songs, decoder, [library]) as s:
                responses = await asyncio.gather(*(s.peaks(song_id) for song_id in songs))

                self.assertEqual([response.status_code for response in responses], [200] * 5)
                self.assertEqual(len(decoder.calls), 5)
                self.assertEqual(decoder.busiest, 1)

    async def test_the_same_track_asked_for_twice_at_once_is_decoded_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "one.flac")

            async def work(_: Path) -> None:
                await asyncio.sleep(0.02)

            decoder = FakeDecoder(work)
            songs: dict[str, dict[str, object]] = {"song-1": {"path": "one.flac"}}
            async with serving(base, songs, decoder, [library]) as s:
                first, second = await asyncio.gather(s.peaks("song-1"), s.peaks("song-1"))

                self.assertEqual((first.status_code, second.status_code), (200, 200))
                self.assertEqual(len(decoder.calls), 1)

    async def test_a_full_line_is_told_to_try_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "a.flac", "b.flac", "c.flac")
            started = asyncio.Event()
            gate = asyncio.Event()

            async def work(_: Path) -> None:
                started.set()
                await gate.wait()

            decoder = FakeDecoder(work)
            songs: dict[str, dict[str, object]] = {
                "song-a": {"path": "a.flac"},
                "song-b": {"path": "b.flac"},
                "song-c": {"path": "c.flac"},
            }
            async with serving(base, songs, decoder, [library]) as s:
                with patch("backend.waveform.QUEUE_LIMIT", 1):
                    running = asyncio.create_task(s.peaks("song-a"))
                    await asyncio.wait_for(started.wait(), 5)
                    waiting = asyncio.create_task(s.peaks("song-b"))
                    while s.service.waiting < 1:
                        await asyncio.sleep(0.005)

                    refused = await s.peaks("song-c")
                    gate.set()
                    results = await asyncio.gather(running, waiting)

                self.assertEqual(refused.status_code, 503)
                self.assertIn("Retry-After", refused.headers)
                self.assertEqual([response.status_code for response in results], [200, 200])
                self.assertEqual(len(decoder.calls), 2)

    async def test_waiting_too_long_for_a_turn_is_404(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            library = library_with(base, "a.flac", "b.flac")
            started = asyncio.Event()
            gate = asyncio.Event()

            async def work(_: Path) -> None:
                started.set()
                await gate.wait()

            decoder = FakeDecoder(work)
            songs: dict[str, dict[str, object]] = {
                "song-a": {"path": "a.flac"},
                "song-b": {"path": "b.flac"},
            }
            async with serving(base, songs, decoder, [library]) as s:
                running = asyncio.create_task(s.peaks("song-a"))
                await asyncio.wait_for(started.wait(), 5)
                with patch("backend.waveform.QUEUE_WAIT_SECONDS", 0.05):
                    gave_up = await s.peaks("song-b")
                gate.set()

                self.assertEqual(gave_up.status_code, 404)
                self.assertEqual((await running).status_code, 200)
                self.assertEqual(s.service.waiting, 0)
                # It never got as far as decoding, so it may simply ask again.
                self.assertEqual(len(decoder.calls), 1)

    async def test_an_unknown_song_and_a_bad_id_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            decoder = FakeDecoder()
            async with serving(base, {}, decoder, []) as s:
                self.assertEqual((await s.peaks("no-such-song")).status_code, 503)
                self.assertEqual((await s.peaks("not%20an%20id")).status_code, 422)
                self.assertEqual(decoder.calls, [])


def pcm(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


class PeakTests(unittest.TestCase):
    def test_reader_takes_the_loudest_sample_of_each_window_across_split_reads(self) -> None:
        data = pcm(100, -300, 20, 5, -32768, 7, 40)
        with patch("backend.waveform.WINDOW_SAMPLES", 2):
            reader = PeakReader()
            # Split inside a sample, and inside a window.
            reader.feed(data[:3])
            reader.feed(data[3:8])
            reader.feed(data[8:])
            # The last window holds one sample and still counts.
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
