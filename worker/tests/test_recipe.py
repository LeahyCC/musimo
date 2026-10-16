"""`tempo-energy-v1` on generated audio, and the loop around it. No downloaded music."""

import importlib.util
import math
import os
import shutil
import tempfile
import unittest
import urllib.request
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

from audio_worker.__main__ import work_once
from audio_worker.client import Client, ClientError, lease
from audio_worker.recipe import (
    RECIPE,
    SAMPLE_RATE,
    SECTION_SECONDS,
    DecodeError,
    Job,
    Result,
    analyse,
    decode_command,
    decode_section,
    job_from,
    measure_section,
    section_starts,
    skip_reason,
)

HAS_LIBROSA = importlib.util.find_spec("librosa") is not None


def write_wav(path: Path, samples: np.ndarray, rate: int = SAMPLE_RATE) -> None:
    clipped = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((clipped * 32767).astype("<i2").tobytes())


def clicks(bpm: float, seconds: float, amplitude: float = 0.5) -> np.ndarray:
    """A 1 kHz burst of 20 ms on every beat, silence between."""
    total = int(seconds * SAMPLE_RATE)
    out = np.zeros(total, dtype=np.float32)
    step = int(round(60.0 / bpm * SAMPLE_RATE))
    burst = int(0.02 * SAMPLE_RATE)
    for start in range(0, total, step):
        end = min(total, start + burst)
        out[start:end] = amplitude * np.sin(2 * np.pi * 1000 * np.arange(end - start) / SAMPLE_RATE)
    return out


def job(path: Path, **changes: object) -> Job:
    values: dict[str, object] = {
        "song_id": "tr-0123456789abcdef",
        "recipe": RECIPE,
        "lease_token": "token",
        "path": str(path),
        "size": 1,
        "mtime_ns": 2,
        "duration": 130.0,
        "genre": "Rock",
        "genres": ["Rock"],
    }
    return job_from(values | changes)


def never_decode(path: Path, start: float) -> np.ndarray:
    raise AssertionError("the file was decoded")


def never_measure(samples: np.ndarray) -> tuple[float | None, float]:
    raise AssertionError("a section was measured")


class RuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve()
        self.song = self.root / "song.wav"
        write_wav(self.song, np.zeros(SAMPLE_RATE // 10, dtype=np.float32))

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_section_starts_cover_the_span_or_refuse_a_short_file(self) -> None:
        self.assertIsNone(section_starts(9.99))
        self.assertIsNone(section_starts(math.nan))
        self.assertEqual(section_starts(10.0), [0.0, 0.0, 0.0])
        self.assertEqual(section_starts(130.0), [12.0, 60.0, 108.0])

    def test_speech_genres_are_skipped_and_music_is_not(self) -> None:
        self.assertEqual(skip_reason("Podcast", []), "spoken-word genre")
        self.assertEqual(skip_reason("Rock", ["Live", "Spoken Word"]), "spoken-word genre")
        self.assertEqual(skip_reason("", ["PODCASTS"]), "spoken-word genre")
        self.assertIsNone(skip_reason("Rock", ["Podcast Rock"]))

    def test_a_podcast_is_skipped_without_decoding(self) -> None:
        result = analyse(job(self.song, genre="Podcast"), [self.root], never_decode, never_measure)
        self.assertEqual((result.status, result.detail), ("skipped", "spoken-word genre"))
        self.assertEqual(result.payload()["dim"], 0)
        self.assertIsNone(result.payload()["vector"])

    def test_a_short_file_is_failed_without_an_invented_tempo(self) -> None:
        result = analyse(job(self.song, duration=5.0), [self.root], never_decode, never_measure)
        self.assertEqual((result.status, result.detail), ("failed", "shorter than 10 seconds"))
        self.assertIsNone(result.tempo_bpm)
        # The file as the worker saw it, not as the lease said.
        self.assertEqual(result.size, self.song.stat().st_size)

    def test_a_path_outside_the_mount_or_missing_is_failed(self) -> None:
        outside = analyse(job(self.song), [self.root / "elsewhere"], never_decode, never_measure)
        self.assertEqual(outside.status, "failed")
        self.assertIn("music mount", outside.detail)
        missing = analyse(job(self.root / "gone.wav"), [self.root], never_decode, never_measure)
        self.assertEqual(missing.status, "failed")
        self.assertIn("cannot read", missing.detail)
        other = analyse(job(self.song, recipe="other-v1"), [self.root], never_decode, never_measure)
        self.assertEqual(other.status, "failed")

    def test_done_needs_a_tempo_and_takes_the_median_and_mean(self) -> None:
        measured = {12.0: (100.0, 0.3), 60.0: (None, 0.2), 108.0: (140.0, 0.1)}
        seen: list[float] = []

        def decode(path: Path, start: float) -> np.ndarray:
            seen.append(start)
            if start == 60.0:
                raise DecodeError("ffmpeg exited 1 at 60.0 s")
            return np.full(3, start, dtype=np.float32)

        def measure(samples: np.ndarray) -> tuple[float | None, float]:
            return measured[float(samples[0])]

        result = analyse(job(self.song), [self.root], decode, measure)
        self.assertEqual(result.status, "done")
        self.assertEqual(result.tempo_bpm, 120.0)
        self.assertAlmostEqual(result.energy or 0, 0.2)
        self.assertEqual(
            result.detail, "2 of 3 sections, 2 tempo estimates; ffmpeg exited 1 at 60.0 s"
        )
        self.assertEqual(seen, [12.0, 60.0, 108.0])

        def no_tempo(samples: np.ndarray) -> tuple[float | None, float]:
            return None, 0.5

        result = analyse(job(self.song), [self.root], decode, no_tempo)
        self.assertEqual(
            (result.status, result.detail), ("failed", "no section gave a tempo estimate")
        )

        def broken(path: Path, start: float) -> np.ndarray:
            raise DecodeError("decoder exceeded 30 s")

        result = analyse(job(self.song), [self.root], broken, measure)
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.detail, "no section decoded: decoder exceeded 30 s")

    def test_a_measurement_error_is_a_failed_section_not_a_crash(self) -> None:
        def decode(path: Path, start: float) -> np.ndarray:
            return np.full(2, start, dtype=np.float32)

        def flaky(samples: np.ndarray) -> tuple[float | None, float]:
            if float(samples[0]) == 60.0:
                raise ValueError("Audio buffer is not finite everywhere")
            return 100.0, 0.2

        result = analyse(job(self.song), [self.root], decode, flaky)
        self.assertEqual((result.status, result.tempo_bpm), ("done", 100.0))
        self.assertEqual(
            result.detail,
            "2 of 3 sections, 2 tempo estimates; measure failed at 60.0 s: ValueError: "
            "Audio buffer is not finite everywhere",
        )

        def broken(samples: np.ndarray) -> tuple[float | None, float]:
            raise RuntimeError("no")

        result = analyse(job(self.song), [self.root], decode, broken)
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.detail.startswith("no section decoded: measure failed at 12.0 s"))

    def test_coinciding_starts_decode_once(self) -> None:
        count = 0

        def decode(path: Path, start: float) -> np.ndarray:
            nonlocal count
            count += 1
            return np.zeros(4, dtype=np.float32)

        measured = 0

        def measure(samples: np.ndarray) -> tuple[float | None, float]:
            nonlocal measured
            measured += 1
            return 90.0, 0.4

        result = analyse(job(self.song, duration=10.0), [self.root], decode, measure)
        self.assertEqual((count, measured), (1, 1))
        self.assertEqual((result.status, result.tempo_bpm), ("done", 90.0))
        self.assertAlmostEqual(result.energy or 0, 0.4)

    def test_the_decoder_command_pins_one_thread_and_seeks_mov_files_together(self) -> None:
        command = decode_command(Path("x.m4a"), 12.5)
        self.assertIn("-seek_streams_individually", command)
        self.assertLess(command.index("-seek_streams_individually"), command.index("-i"))
        self.assertEqual(command[command.index("-threads") + 1], "1")
        self.assertEqual(command[command.index("-ss") + 1], "12.500")
        self.assertEqual(command[command.index("-t") + 1], "10.000")
        self.assertNotIn("-seek_streams_individually", decode_command(Path("x.opus"), 0))

    def test_the_lease_payload_is_checked_before_use(self) -> None:
        for broken in [
            None,
            {"song_id": "tr-1"},
            {**job(self.song).__dict__, "genres": "Rock"},
            {**job(self.song).__dict__, "duration": "long"},
            {**job(self.song).__dict__, "path": ""},
        ]:
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                job_from(broken)
        self.assertEqual(job(self.song).genres, ("Rock",))

    def test_the_result_payload_has_no_vector_and_a_bounded_detail(self) -> None:
        result = Result("tr-0123456789abcdef", RECIPE, "t", 1, 2, "failed", detail="x" * 500)
        payload = result.payload()
        self.assertEqual(len(str(payload["detail"])), 400)
        self.assertEqual((payload["dim"], payload["vector"], payload["tempo_bpm"]), (0, None, None))


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
class FfmpegTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve()

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_a_section_is_ten_seconds_and_a_short_one_is_rejected(self) -> None:
        path = self.root / "twelve.wav"
        write_wav(path, clicks(120, 12.0))
        samples = decode_section(path, 0.0)
        self.assertEqual(len(samples), int(SECTION_SECONDS * SAMPLE_RATE))
        self.assertEqual(samples.dtype, np.float32)
        self.assertGreater(float(np.max(np.abs(samples))), 0.4)
        with self.assertRaises(DecodeError) as short:
            decode_section(path, 5.0)
        self.assertIn("short", str(short.exception))
        with self.assertRaises(DecodeError):
            decode_section(self.root / "missing.wav", 0.0)

    @unittest.skipUnless(HAS_LIBROSA, "librosa is only in the worker environment")
    def test_clicks_at_120_bpm_measure_near_120_with_their_energy(self) -> None:
        path = self.root / "clicks.wav"
        write_wav(path, clicks(120, 40.0))
        result = analyse(job(path, duration=40.0), [self.root])
        self.assertEqual(result.status, "done", result.detail)
        assert result.tempo_bpm is not None and result.energy is not None
        self.assertTrue(110 <= result.tempo_bpm <= 130, result.tempo_bpm)
        self.assertTrue(0.01 < result.energy < 0.1, result.energy)
        self.assertEqual(result.detail, "3 of 3 sections, 3 tempo estimates")

    @unittest.skipUnless(HAS_LIBROSA, "librosa is only in the worker environment")
    def test_silence_has_no_tempo_and_a_tone_keeps_its_rms(self) -> None:
        path = self.root / "silence.wav"
        write_wav(path, np.zeros(SAMPLE_RATE * 30, dtype=np.float32))
        result = analyse(job(path, duration=30.0), [self.root])
        self.assertEqual(
            (result.status, result.detail), ("failed", "no section gave a tempo estimate")
        )
        tone = (0.5 * np.sin(2 * np.pi * 440 * np.arange(SAMPLE_RATE * 10) / SAMPLE_RATE)).astype(
            np.float32
        )
        _, rms = measure_section(tone)
        self.assertAlmostEqual(rms, 0.5 / math.sqrt(2), delta=0.01)


class LoopTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve()
        self.song = self.root / "talk.wav"
        write_wav(self.song, np.zeros(SAMPLE_RATE, dtype=np.float32))

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_one_turn_leases_measures_and_reports(self) -> None:
        posted: list[tuple[str, dict[str, object]]] = []
        leased = job(self.song, genre="Podcast").__dict__ | {"genres": ["Podcast"]}

        def post(path: str, body: dict[str, object]) -> object:
            posted.append((path, body))
            return {"job": leased} if path.endswith("/lease") else {"stored": True}

        self.assertTrue(work_once(post, [self.root]))
        self.assertEqual(
            [path for path, _ in posted],
            ["/api/internal/audio/lease", "/api/internal/audio/result"],
        )
        self.assertEqual(posted[0][1], {"recipe": RECIPE})
        self.assertEqual(posted[1][1]["status"], "skipped")
        self.assertEqual(posted[1][1]["lease_token"], "token")

    def test_the_client_ignores_proxies_from_the_environment(self) -> None:
        def has_proxy(opener: urllib.request.OpenerDirector) -> bool:
            handlers: list[object] = vars(opener)["handlers"]
            return any(isinstance(h, urllib.request.ProxyHandler) for h in handlers)

        with patch.dict(os.environ, {"HTTP_PROXY": "http://proxy.example:3128"}):
            self.assertTrue(has_proxy(urllib.request.build_opener()))
            self.assertFalse(has_proxy(Client("http://musimo:8765", "token").opener))

    def test_an_empty_lease_means_nothing_to_do(self) -> None:
        self.assertFalse(work_once(lambda path, body: {"job": None}, [self.root]))
        with self.assertRaises(ClientError):
            lease(lambda path, body: [], RECIPE)
