"""`tempo-beat-v1` on generated audio and a stand-in tracker, and the decoder pipeline.

The rules run anywhere with numpy. The last class runs the real Beat This! model on a click
track and needs torch, so it runs inside the worker image (see docs/testing.md).
"""

import importlib.util
import json
import shutil
import tempfile
import threading
import unittest
import wave
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from audio_worker import beat
from audio_worker.beat import (
    LONG,
    RECIPE,
    Decoded,
    analyse,
    beat_skip_reason,
    finish,
    prepare,
    reading,
    steady_bpm,
    window_rms,
    windows,
)
from audio_worker.pipeline import Pipeline
from audio_worker.recipe import SAMPLE_RATE, DecodeError, Job, Result, job_from

HAS_TORCH = importlib.util.find_spec("torch") is not None
HAS_FFMPEG = shutil.which("ffmpeg") is not None


def beats_at(bpm: float, seconds: float, start: float = 0.0) -> list[float]:
    step = 60.0 / bpm
    return [start + i * step for i in range(int(seconds / step) + 1)]


def job(path: Path, **changes: object) -> Job:
    values: dict[str, object] = {
        "song_id": "tr-0123456789abcdef",
        "recipe": RECIPE,
        "lease_token": "token",
        "path": str(path),
        "size": 1,
        "mtime_ns": 2,
        "duration": 130.0,
        "genre": "Trance",
        "genres": ["Trance"],
    }
    return job_from(values | changes)


def never_decode(path: Path, start: float, seconds: float) -> np.ndarray:
    raise AssertionError("the file was decoded")


def never_track(samples: np.ndarray) -> Sequence[float]:
    raise AssertionError("the model ran")


def marked(start: float, seconds: float, amplitude: float = 0.1) -> np.ndarray:
    """A window whose first sample says where it came from, so a stand-in tracker can tell."""
    out = np.full(int(seconds * SAMPLE_RATE), amplitude, dtype=np.float32)
    out[0] = start
    return out


class RuleTests(unittest.TestCase):
    def test_three_sections_and_a_centred_check_window(self) -> None:
        found = windows(130.0)
        self.assertEqual([w.name for w in found], ["s10", "s50", "s90", LONG])
        self.assertEqual([w.start for w in found], [12.0, 60.0, 108.0, 35.0])
        self.assertEqual([w.seconds for w in found], [10.0, 10.0, 10.0, 60.0])
        # At exactly 60 s the check window is the whole file.
        self.assertEqual(windows(60.0)[-1].start, 0.0)

    def test_podcasts_and_files_under_a_minute_are_skipped(self) -> None:
        song = Path("/music/a.flac")
        self.assertEqual(beat_skip_reason(job(song, genre="Podcast")), "spoken-word genre")
        self.assertEqual(beat_skip_reason(job(song, genres=["Spoken Word"])), "spoken-word genre")
        self.assertEqual(
            beat_skip_reason(job(song, duration=59.9)), "shorter than the 60 s check window"
        )
        self.assertIsNone(beat_skip_reason(job(song, duration=60.0)))
        # No known length is not a skip; prepare fails it once the file is found.
        self.assertIsNone(beat_skip_reason(job(song, duration=0.0)))

    def test_steady_gap_bpm(self) -> None:
        self.assertEqual(steady_bpm(beats_at(120, 10)), 120.0)
        self.assertEqual(steady_bpm(beats_at(138, 10)), 138.0)
        # Fewer than 4 beats, or fewer than 3 steady gaps, give nothing.
        self.assertIsNone(steady_bpm([0.0, 0.5, 1.0]))
        self.assertIsNone(steady_bpm([0.0, 0.5, 1.6, 3.2, 3.3]))
        # A missed beat makes one double gap, which is outside 12 percent and left out.
        missed = [b for i, b in enumerate(beats_at(120, 10)) if i != 6]
        self.assertEqual(steady_bpm(missed), 120.0)
        # The 20 ms grid the model's beats sit on averages out instead of snapping.
        grid = [round(b / 0.02) * 0.02 for b in beats_at(143, 10)]
        self.assertAlmostEqual(steady_bpm(grid) or 0, 143.0, delta=0.3)

    def test_sure_needs_two_sections_agreement_and_200_or_less(self) -> None:
        self.assertEqual(reading([128.0, 128.5, None], 127.9), beat.Reading(128.25, True, ""))
        self.assertEqual(reading([128.0, None, None], 128.0).why, "1 section")
        self.assertFalse(reading([128.0, None, None], 128.0).sure)
        self.assertEqual(reading([], None), beat.Reading(None, False, "0 sections"))
        self.assertEqual(reading([140.0, 141.0, 142.0], 70.5).why, "sections and 60 s disagree")
        self.assertEqual(reading([140.0, 141.0, 142.0], 138.9).why, "sections and 60 s disagree")
        self.assertTrue(reading([140.0, 141.0, 142.0], 139.0).sure)
        self.assertEqual(reading([236.0, 236.0], 236.0).why, "over 200 BPM")
        self.assertTrue(reading([200.0, 200.0], 200.0).sure)
        self.assertEqual(reading([128.0, 128.0], None).why, "no 60 s reading")
        # The median of the sections is the answer, not the check window.
        self.assertEqual(reading([120.0, 121.0, 125.0], 122.0).bpm, 121.0)

    def test_window_rms_is_the_mean_frame_rms(self) -> None:
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SAMPLE_RATE * 2) / SAMPLE_RATE)
        self.assertAlmostEqual(window_rms(tone.astype(np.float32)), 0.5 / np.sqrt(2), places=3)
        quiet_then_loud = np.concatenate([np.zeros(SAMPLE_RATE), np.full(SAMPLE_RATE, 0.4)])
        self.assertAlmostEqual(window_rms(quiet_then_loud.astype(np.float32)), 0.2, delta=0.01)
        self.assertAlmostEqual(window_rms(np.full(100, 0.3, dtype=np.float32)), 0.3, places=6)
        with self.assertRaises(ValueError):
            window_rms(np.zeros(0, dtype=np.float32))


class AnalyseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve()
        self.song = self.root / "song.flac"
        self.song.write_bytes(b"not really audio")
        self.decoded: list[tuple[float, float]] = []

    def tearDown(self) -> None:
        self.folder.cleanup()

    def decode(self, path: Path, start: float, seconds: float) -> np.ndarray:
        self.decoded.append((start, seconds))
        return marked(start, seconds)

    def tracker(self, tempos: dict[float, float | None]) -> beat.Tracker:
        def track(samples: np.ndarray) -> Sequence[float]:
            bpm = tempos[float(samples[0])]
            return [] if bpm is None else beats_at(bpm, len(samples) / SAMPLE_RATE)

        return track

    def test_a_sure_song_keeps_its_tempo_energy_and_sections(self) -> None:
        track = self.tracker({12.0: 128.0, 60.0: 128.4, 108.0: 127.6, 35.0: 128.1})
        result = analyse(job(self.song), [self.root], track, self.decode)
        self.assertEqual(result.status, "done")
        self.assertEqual(result.tempo_bpm, 128.0)
        # The marker sample nudges each window's first frame; every other frame is 0.1. Energy
        # takes the loudest window, the one with the biggest marker, a few thousandths up.
        self.assertAlmostEqual(result.energy or 0, 0.1, delta=0.01)
        self.assertEqual(self.decoded, [(12.0, 10.0), (60.0, 10.0), (108.0, 10.0), (35.0, 60.0)])
        detail = json.loads(result.detail)
        self.assertEqual(
            detail,
            {
                "bpm": 128.0,
                "sure": True,
                "long": 128.1,
                "sections": [[12.0, 128.0], [60.0, 128.4], [108.0, 127.6]],
                "long_start": 35.0,
                "why": "",
            },
        )
        self.assertLess(len(str(result.payload()["detail"])), 400)
        # The file as the worker found it, not as the lease said.
        self.assertEqual(result.size, self.song.stat().st_size)

    def test_an_unsure_song_is_done_with_energy_and_no_tempo(self) -> None:
        track = self.tracker({12.0: 140.0, 60.0: 141.0, 108.0: None, 35.0: 70.4})
        result = analyse(job(self.song), [self.root], track, self.decode)
        self.assertEqual((result.status, result.tempo_bpm), ("done", None))
        self.assertIsNotNone(result.energy)
        detail = json.loads(result.detail)
        self.assertEqual((detail["bpm"], detail["sure"]), (140.5, False))
        self.assertEqual(detail["why"], "sections and 60 s disagree")
        self.assertEqual(detail["sections"][2], [108.0, None])

    def test_energy_is_the_loudest_window(self) -> None:
        # A quiet intro under the first section must not pull a loud song down.
        loudness = {12.0: 0.02, 60.0: 0.3, 108.0: 0.1, 35.0: 0.2}

        def decode(path: Path, start: float, seconds: float) -> np.ndarray:
            return marked(start, seconds, loudness[start])

        track = self.tracker({12.0: 128.0, 60.0: 128.0, 108.0: 128.0, 35.0: 128.0})
        result = analyse(job(self.song), [self.root], track, decode)
        self.assertAlmostEqual(result.energy or 0, 0.3, delta=0.005)

    def test_skips_happen_before_any_decoding(self) -> None:
        for changes, reason in (
            ({"genre": "Podcasts"}, "spoken-word genre"),
            ({"duration": 45.0}, "shorter than the 60 s check window"),
        ):
            with self.subTest(changes=changes):
                result = analyse(job(self.song, **changes), [self.root], never_track, never_decode)
                self.assertEqual((result.status, result.detail), ("skipped", reason))
                self.assertIsNone(result.energy)

    def test_failures(self) -> None:
        outside = analyse(job(self.song), [self.root / "other"], never_track, never_decode)
        self.assertEqual(outside.status, "failed")
        self.assertIn("music mount", outside.detail)
        other = analyse(job(self.song, recipe="tempo-energy-v1"), [self.root], never_track)
        self.assertIn("this worker measures tempo-beat-v1", other.detail)
        unknown = analyse(job(self.song, duration=0.0), [self.root], never_track, never_decode)
        self.assertEqual(unknown.detail, "the file has no known length")

        def broken(path: Path, start: float, seconds: float) -> np.ndarray:
            raise DecodeError(f"ffmpeg exited 1 at {start:.1f} s")

        nothing = analyse(job(self.song), [self.root], never_track, broken)
        self.assertEqual(nothing.status, "failed")
        self.assertEqual(nothing.detail, "no window decoded: ffmpeg exited 1 at 12.0 s")

        def crash(samples: np.ndarray) -> Sequence[float]:
            raise RuntimeError("CUDA error: out of memory")

        crashed = analyse(job(self.song), [self.root], crash, self.decode)
        # A model failure is retried, never stored as an unsure reading.
        self.assertEqual(crashed.status, "failed")
        self.assertIn("beat tracker failed at 12.0 s: RuntimeError", crashed.detail)

    def test_a_window_that_will_not_decode_still_leaves_a_reading(self) -> None:
        def some(path: Path, start: float, seconds: float) -> np.ndarray:
            if start == 108.0:
                raise DecodeError("section at 108.0 s is 9.50 s, more than 100 ms short")
            return marked(start, seconds)

        track = self.tracker({12.0: 100.0, 60.0: 100.2, 35.0: 100.1})
        result = analyse(job(self.song), [self.root], track, some)
        self.assertEqual((result.status, result.tempo_bpm), ("done", 100.1))
        self.assertEqual(json.loads(result.detail)["why"][:23], "section at 108.0 s is 9")


class PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve()
        self.lock = threading.Lock()
        self.leases: list[dict[str, object]] = []
        self.results: list[dict[str, object]] = []
        self.jobs: list[dict[str, object]] = []
        for index in range(7):
            song = self.root / f"{index}.flac"
            song.write_bytes(b"x" * (index + 1))
            self.jobs.append(
                {
                    "song_id": f"tr-{index:016x}",
                    "recipe": RECIPE,
                    "lease_token": f"lease-{index}",
                    "path": str(song),
                    "size": index + 1,
                    "mtime_ns": song.stat().st_mtime_ns,
                    "duration": 30.0 if index == 3 else 130.0,
                    "genre": "Podcast" if index == 5 else "Rock",
                    "genres": [],
                }
            )
        self.stop = threading.Event()

    def tearDown(self) -> None:
        self.folder.cleanup()

    def post(self, path: str, body: dict[str, object]) -> object:
        with self.lock:
            if path.endswith("/lease"):
                self.leases.append(body)
                return {"job": self.jobs.pop(0) if self.jobs else None}
            self.results.append(body)
            if len(self.results) == 7:
                self.stop.set()
            return {"stored": True}

    def test_decoders_feed_one_model_and_every_result_keeps_its_lease(self) -> None:
        tracked: list[str] = []

        def track(samples: np.ndarray) -> Sequence[float]:
            tracked.append(threading.current_thread().name)
            return beats_at(120, len(samples) / SAMPLE_RATE)

        info = {"device": "cpu", "decoders": 3}
        stored = Pipeline(
            self.post,
            [self.root],
            track,
            3,
            info,
            lambda message: None,
            self.stop,
            idle=0.01,
            decode=lambda path, start, seconds: marked(start, seconds),
        ).run()
        self.assertEqual(stored, 7)
        by_id = {str(r["song_id"]): r for r in self.results}
        self.assertEqual(len(by_id), 7)
        for index in range(7):
            result = by_id[f"tr-{index:016x}"]
            self.assertEqual(result["lease_token"], f"lease-{index}")
            expected = "skipped" if index in (3, 5) else "done"
            self.assertEqual(result["status"], expected)
            if expected == "done":
                self.assertEqual(result["tempo_bpm"], 120.0)
        # Five songs, four windows each, all on the one model thread.
        self.assertEqual(len(tracked), 20)
        self.assertEqual(set(tracked), {"MainThread"})
        self.assertTrue(all(lease["worker"] == info for lease in self.leases))

    def test_a_crash_inside_finish_is_a_failed_result_not_a_dead_model(self) -> None:
        self.jobs = self.jobs[:1]
        decoded = Decoded(job_from(self.jobs[0]), 1, 2, windows(130.0))
        self.assertIsInstance(finish(decoded, never_track), Result)
        stop = self.stop

        def post(path: str, body: dict[str, object]) -> object:
            reply = self.post(path, body)
            if self.results:
                stop.set()
            return reply

        def bad_decode(path: Path, start: float, seconds: float) -> np.ndarray:
            return np.zeros(0, dtype=np.float32)

        Pipeline(
            post,
            [self.root],
            lambda samples: beats_at(120, 1),
            1,
            {},
            lambda message: None,
            stop,
            idle=0.01,
            decode=bad_decode,
        ).run()
        self.assertEqual(self.results[0]["status"], "failed")
        self.assertIn("ValueError", str(self.results[0]["detail"]))

    def test_prepare_never_runs_the_model(self) -> None:
        prepared = prepare(job_from(self.jobs[0]), [self.root], never_decode_ok)
        self.assertIsInstance(prepared, Decoded)


def never_decode_ok(path: Path, start: float, seconds: float) -> np.ndarray:
    return marked(start, seconds)


def write_clicks(path: Path, bpm: float, seconds: float) -> None:
    total = int(seconds * SAMPLE_RATE)
    out = np.zeros(total, dtype=np.float32)
    step = 60.0 / bpm
    burst = int(0.03 * SAMPLE_RATE)
    rng = np.random.default_rng(7)
    for index in range(int(seconds / step)):
        start = int(index * step * SAMPLE_RATE)
        end = min(total, start + burst)
        accent = 0.9 if index % 4 == 0 else 0.6
        decay = np.exp(-np.arange(end - start) / (0.006 * SAMPLE_RATE))
        out[start:end] += accent * decay * rng.standard_normal(end - start).astype(np.float32)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes((np.clip(out, -1, 1) * 32767).astype("<i2").tobytes())


@unittest.skipUnless(HAS_TORCH and HAS_FFMPEG, "needs the tempo-beat-v1 image (torch and FFmpeg)")
class RealModelTests(unittest.TestCase):
    def test_a_click_track_reads_its_tempo(self) -> None:
        from audio_worker.model import load_tracker

        track, device = load_tracker("cpu", 1)
        self.assertEqual(device.name, "cpu")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            song = root / "clicks.wav"
            write_clicks(song, 128.0, 90.0)
            result = analyse(job(song, duration=90.0), [root], track)
        self.assertEqual(result.status, "done", result.detail)
        self.assertAlmostEqual(result.tempo_bpm or 0, 128.0, delta=1.0)
        self.assertTrue(json.loads(result.detail)["sure"])


if __name__ == "__main__":
    unittest.main()
