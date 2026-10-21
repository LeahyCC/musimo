"""The Song analysis page's routes, and the lease behaviour they lean on: several leases at
once, pause, the worker's status and an unsure tempo-beat-v1 row."""

import asyncio
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.audio_analysis_api import install_audio_analysis_routes
from backend.api.audio_worker_api import install_audio_worker_routes
from backend.core.audio_recipes import BEAT_RECIPE, SCALAR_RECIPE
from backend.core.store import Store
from backend.library.audio_analysis import AudioAnalysis, WorkerInfo, run_rate
from backend.library.audio_profile import AudioProfiles, LeaseError, WorkerResult
from backend.library.index import Library

TOKEN = "fixture-token-0123456789"
SONGS = 14


class AudioAnalysisApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        music = root / "music"
        music.mkdir()
        self.store = Store(root / "musimo.sqlite3")
        library = Library(self.store, [music], asyncio.Event())
        for index in range(SONGS):
            path = music / f"{index:02d}.wav"
            write_wav(path)
            genre = ["Podcast"] if index == 0 else ["Rock"]
            tag(path, title=f"Song {index:02d}", artist=f"Artist {index}", genres=genre)
        library.scan()
        with self.store.lock:
            # Song 01 is the long recording; the rest are ordinary lengths. Newer files have
            # later added_at, so song 13 is the newest.
            self.store.db.execute("UPDATE library_files SET duration=200")
            self.store.db.execute("UPDATE library_files SET duration=1500 WHERE title='Song 01'")
            for index in range(SONGS):
                self.store.db.execute(
                    "UPDATE library_files SET added_at=? WHERE title=?",
                    (f"2026-10-{index + 1:02d}T00:00:00Z", f"Song {index:02d}"),
                )
            self.store.db.commit()
        self.ids = {
            str(row["title"]): str(row["song_id"])
            for row in self.store.db.execute("SELECT title, song_id FROM library_files")
        }
        self.profiles = AudioProfiles(self.store)
        self.analysis = AudioAnalysis(self.store, self.profiles, token_configured=True)
        self.notified = 0
        app = FastAPI()
        install_audio_worker_routes(
            app,
            lambda: self.profiles,
            lambda: False,
            TOKEN,
            is_paused=self.analysis.paused,
            seen=self.analysis.seen,
        )
        install_audio_analysis_routes(app, lambda: self.analysis, lambda: self.store, self.notify)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://musimo"
        )
        self.worker = {"Authorization": f"Bearer {TOKEN}"}

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.folder.cleanup()

    def notify(self) -> None:
        self.notified += 1

    async def get(self, path: str) -> dict[str, Any]:
        response = await self.client.get(f"/api/audio-analysis/{path}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        assert isinstance(body, dict)
        return body

    async def post(self, path: str, body: object = None) -> dict[str, Any]:
        response = await self.client.post(f"/api/audio-analysis/{path}", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        reply = response.json()
        assert isinstance(reply, dict)
        return reply

    async def lease(self, worker: dict[str, object] | None = None) -> dict[str, Any] | None:
        body: dict[str, object] = {"recipe": BEAT_RECIPE}
        if worker is not None:
            body["worker"] = worker
        response = await self.client.post(
            "/api/internal/audio/lease", json=body, headers=self.worker
        )
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()["job"]
        return job if isinstance(job, dict) else None

    def result(self, job: dict[str, Any], **changes: object) -> dict[str, object]:
        return {
            "song_id": job["song_id"],
            "recipe": job["recipe"],
            "lease_token": job["lease_token"],
            "size": job["size"],
            "mtime_ns": job["mtime_ns"],
            "status": "done",
            "tempo_bpm": 128.0,
            "energy": 0.05,
            "detail": json.dumps(
                {
                    "bpm": 128.0,
                    "sure": True,
                    "long": 128.1,
                    "sections": [[19.0, 128.0], [95.0, 128.0], [171.0, 128.0]],
                    "long_start": 70.0,
                    "why": "",
                }
            ),
        } | changes

    async def store_result(self, job: dict[str, Any], **changes: object) -> None:
        response = await self.client.post(
            "/api/internal/audio/result", json=self.result(job, **changes), headers=self.worker
        )
        self.assertEqual(response.status_code, 200, response.text)

    async def test_status_before_anything_ran(self) -> None:
        status = await self.get("status")
        self.assertEqual(status["recipe"], BEAT_RECIPE)
        self.assertFalse(status["active"])
        self.assertFalse(status["paused"])
        self.assertTrue(status["token_configured"])
        self.assertIsNone(status["worker"])
        self.assertEqual(
            status["counts"],
            {
                "library": SONGS,
                "done": 0,
                "unsure": 0,
                "skipped": 0,
                "failed": 0,
                "waiting": 0,
                "leased": 0,
                "lacking": SONGS,
            },
        )
        # No run on this machine yet, and no worker: the trial's rates, for both devices.
        estimate = status["estimate"]
        self.assertEqual((estimate["device"], estimate["source"]), ("cpu", "trial"))
        self.assertEqual(estimate["seconds_per_song"], 5.6)
        self.assertEqual(estimate["whole_library_seconds"], round(SONGS * 5.6))
        self.assertEqual(
            estimate["devices"]["cuda"],
            {
                "seconds_per_song": 0.6,
                "source": "trial",
                "whole_library_seconds": round(SONGS * 0.6),
            },
        )
        self.assertIsNone(status["batch"])

    async def test_the_sample_takes_the_newest_plus_a_podcast_and_a_long_recording(self) -> None:
        reply = await self.post("sample")
        # The page asks for 100; the fixture library is smaller, so every song is queued.
        self.assertEqual(reply["queued"], SONGS)
        self.store.db.execute("DELETE FROM audio_job")
        self.store.db.commit()
        added = self.profiles.enqueue_sample(BEAT_RECIPE, size=5)
        self.assertEqual(added, 5)
        queued = {str(row[0]) for row in self.store.db.execute("SELECT song_id FROM audio_job")}
        expected = {self.ids[f"Song {i:02d}"] for i in (13, 12, 11, 0, 1)}
        self.assertEqual(queued, expected)
        status = await self.get("status")
        self.assertEqual(status["batch"]["kind"], "sample")
        self.assertEqual(status["counts"]["waiting"], 5)

    async def test_measure_all_needs_confirmation(self) -> None:
        asked = await self.post("all", {})
        self.assertEqual(
            (asked["queued"], asked["lacking"], asked["needs_confirmation"]), (0, SONGS, True)
        )
        self.assertEqual(self.profiles.queued(BEAT_RECIPE), 0)
        done = await self.post("all", {"confirm": True})
        self.assertEqual((done["queued"], done["waiting"]), (SONGS, SONGS))
        self.assertFalse(done["needs_confirmation"])
        status = await self.get("status")
        self.assertEqual(status["batch"]["total"], SONGS)
        self.assertEqual(status["batch"]["measured"], 0)
        refused = await self.client.post("/api/audio-analysis/all", json={"confirm": "yes"})
        self.assertEqual(refused.status_code, 422)

    async def test_pause_holds_back_the_lease_and_the_worker_is_seen(self) -> None:
        await self.post("all", {"confirm": True})
        paused = await self.post("pause", {"paused": True})
        self.assertTrue(paused["paused"])
        self.assertEqual(self.notified, 1)
        info = {"device": "cuda", "gpu": "NVIDIA GeForce RTX 5080", "decoders": 4}
        self.assertIsNone(await self.lease(info))
        status = await self.get("status")
        worker = status["worker"]
        self.assertEqual(
            (worker["device"], worker["gpu"], worker["decoders"]), ("cuda", info["gpu"], 4)
        )
        self.assertTrue(worker["running"])
        # The page's estimate now uses the graphics card's rate.
        self.assertEqual(status["estimate"]["seconds_per_song"], 0.6)
        await self.post("pause", {"paused": False})
        self.assertIsNotNone(await self.lease(info))
        # A worker for another recipe is not this page's worker.
        self.analysis.seen(SCALAR_RECIPE, WorkerInfo(device="cpu"))
        self.assertEqual((await self.get("status"))["worker"]["device"], "cuda")
        # An old worker sends nothing about itself and still leases.
        response = await self.client.post(
            "/api/internal/audio/lease", json={"recipe": BEAT_RECIPE}, headers=self.worker
        )
        self.assertEqual(response.status_code, 200)
        bad = await self.client.post(
            "/api/internal/audio/lease",
            json={"recipe": BEAT_RECIPE, "worker": {"device": "tpu"}},
            headers=self.worker,
        )
        self.assertEqual(bad.status_code, 422)

    async def test_a_worker_not_seen_for_a_minute_is_not_running(self) -> None:
        self.analysis.seen(
            BEAT_RECIPE, WorkerInfo(device="cpu"), datetime.now(UTC) - timedelta(minutes=2)
        )
        self.assertFalse((await self.get("status"))["worker"]["running"])

    async def test_an_unsure_row_stores_energy_alone_and_counts_as_unsure(self) -> None:
        await self.post("all", {"confirm": True})
        first = await self.lease()
        second = await self.lease()
        third = await self.lease()
        assert first and second and third
        await self.store_result(first)
        await self.store_result(second, tempo_bpm=None)
        await self.store_result(third, status="skipped", tempo_bpm=None, energy=None, detail="x")
        counts = (await self.get("status"))["counts"]
        self.assertEqual(
            (counts["done"], counts["unsure"], counts["skipped"], counts["failed"]), (1, 1, 1, 0)
        )
        # The skipped song still counts as lacking: a full scan tries it again, after the rest.
        self.assertEqual(counts["lacking"], 1)
        # tempo-energy-v1 still needs both numbers.
        self.profiles.enqueue(SCALAR_RECIPE, 1)
        job = self.profiles.lease(SCALAR_RECIPE)
        assert job is not None
        with self.assertRaises(LeaseError):
            self.profiles.complete(
                WorkerResult.model_validate(
                    self.result(job, recipe=SCALAR_RECIPE, tempo_bpm=None, detail="")
                )
            )
        # Energy is needed for a done row of either.
        nothing = await self.client.post(
            "/api/internal/audio/result",
            json=self.result(await self.lease() or {}, tempo_bpm=None, energy=None),
            headers=self.worker,
        )
        self.assertEqual(nothing.status_code, 422)

    async def test_several_leases_at_once_never_share_a_song(self) -> None:
        self.profiles.enqueue(BEAT_RECIPE, None)

        def take() -> str | None:
            job = self.profiles.lease(BEAT_RECIPE)
            return None if job is None else str(job["song_id"])

        with ThreadPoolExecutor(max_workers=8) as pool:
            taken = list(pool.map(lambda _: take(), range(SONGS + 6)))
        leased = [song for song in taken if song is not None]
        self.assertEqual(len(leased), SONGS)
        self.assertEqual(len(set(leased)), SONGS)

    async def test_listen_groups_and_the_ambiguous_list(self) -> None:
        await self.post("all", {"confirm": True})
        readings = {
            # title: (tempo or None for unsure, energy)
            "Song 02": (180.0, 0.010),  # fast but quiet: ambiguous
            "Song 03": (70.0, 0.200),  # slow but loud: ambiguous
            "Song 04": (128.0, 0.050),
            "Song 05": (None, 0.060),  # unsure: ambiguous, first
            "Song 06": (95.0, 0.020),
            "Song 07": (140.0, 0.120),
        }
        by_id = {self.ids[title]: value for title, value in readings.items()}
        while (job := await self.lease()) is not None:
            if job["song_id"] in by_id:
                bpm, energy = by_id[job["song_id"]]
                await self.store_result(job, tempo_bpm=bpm, energy=energy)
        listen = await self.get("listen")
        self.assertEqual(listen["measured"], 6)
        groups = listen["groups"]

        def titles(name: str) -> list[str]:
            return [song["title"] for song in groups[name]]

        self.assertEqual(titles("fastest")[:2], ["Song 02", "Song 07"])
        self.assertEqual(titles("slowest")[0], "Song 03")
        self.assertNotIn("Song 05", titles("fastest") + titles("slowest"))
        self.assertEqual(titles("loudest")[0], "Song 03")
        self.assertEqual(titles("quietest")[0], "Song 02")
        self.assertEqual(titles("ambiguous"), ["Song 05", "Song 03", "Song 02"])
        self.assertEqual(listen["ambiguous_total"], 3)
        unsure = groups["ambiguous"][0]
        self.assertEqual((unsure["bpm"], unsure["reading"], unsure["sure"]), (None, 128.0, False))
        self.assertEqual(unsure["sections"], [19.0, 95.0, 171.0])
        self.assertIn(unsure["band"], {"low", "medium", "high"})

    async def test_each_device_is_timed_from_its_own_last_run(self) -> None:
        now = datetime.now(UTC)
        with self.store.lock:
            for index in range(20):
                # A graphics card run, one song every half second, ten minutes ago, then a CPU
                # run of three songs (too few to time) just now.
                device, at = ("cuda", now - timedelta(minutes=10, seconds=index / 2))
                if index < 3:
                    device, at = "cpu", now - timedelta(seconds=index * 5)
                self.store.db.execute(
                    "INSERT INTO audio_profile VALUES (?,?,'done',1,1,120,0.1,0,NULL,?,?)",
                    (
                        f"tr-{index:016x}",
                        BEAT_RECIPE,
                        json.dumps({"device": device}),
                        at.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                    ),
                )
            self.store.db.commit()
        estimate = (await self.get("status"))["estimate"]
        self.assertEqual(estimate["devices"]["cuda"]["source"], "measured")
        self.assertAlmostEqual(estimate["devices"]["cuda"]["seconds_per_song"], 0.5, places=2)
        self.assertEqual(estimate["devices"]["cpu"]["source"], "trial")
        # The CPU measured last, so with no worker seen it is the device in use.
        self.assertEqual(estimate["device"], "cpu")


class RunRateTests(unittest.TestCase):
    def test_the_last_run_sets_the_rate(self) -> None:
        now = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
        run = [now - timedelta(seconds=2 * i) for i in range(30)]
        older = [now - timedelta(hours=3, seconds=i) for i in range(50)]
        rate, rows, going = run_rate(run + older, now)
        self.assertEqual(rows, 30)
        self.assertAlmostEqual(rate or 0, 0.5)
        self.assertTrue(going)
        self.assertEqual(run_rate(run[:5], now)[0], None)
        self.assertFalse(run_rate(run, now + timedelta(minutes=10))[2])
        self.assertEqual(run_rate([], now), (None, 0, False))


if __name__ == "__main__":
    unittest.main()
