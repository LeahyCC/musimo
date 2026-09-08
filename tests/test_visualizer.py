import asyncio
import gzip
import hashlib
import json
import math
import struct
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.navidrome import Navidrome
from backend.store import Store
from backend.visualizer_api import VisualizerAnalysis, install_visualizer_routes
from backend.visualizer_worker import analyse


class SongMapTests(unittest.TestCase):
    def test_silence_has_no_invented_beats_and_short_audio_has_a_section(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silence.wav"
            with wave.open(str(source), "wb") as stream:
                stream.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                stream.writeframes(bytes(22050 * 2 * 2))
            result = analyse(source)
        self.assertEqual(result["beats"], [])
        self.assertEqual(result["confidence"], 0)
        self.assertEqual(max(result["energy"]), 0)
        self.assertEqual(result["sections"][0]["start"], 0)
        self.assertEqual(result["sections"][-1]["end"], 2)
        json.dumps(result, allow_nan=False)

    def test_pulses_and_loudness_change_survive_offline_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "pulses.wav"
            rate = 22050
            samples = bytearray()
            for index in range(rate * 20):
                second = index / rate
                level = 0.15 if second < 10 else 0.8
                pulse = math.exp(-(second % 0.5) * 50)
                value = level * (
                    0.6 * pulse * math.sin(second * math.tau * 80)
                    + 0.15 * math.sin(second * math.tau * 440)
                )
                samples.extend(struct.pack("<h", round(value * 32767)))
            with wave.open(str(source), "wb") as stream:
                stream.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                stream.writeframes(samples)
            result = analyse(source)
        self.assertGreaterEqual(len(result["beats"]), 18)
        self.assertTrue(all(min(beat % 0.5, 0.5 - beat % 0.5) < 0.08 for beat in result["beats"]))
        hop = result["hop"]
        quiet = result["energy"][int(2 / hop) : int(8 / hop)]
        loud = result["energy"][int(12 / hop) : int(18 / hop)]
        self.assertGreater(sum(loud) / len(loud), sum(quiet) / len(quiet) * 3)
        self.assertEqual(result["sections"][0]["start"], 0)
        self.assertEqual(result["sections"][-1]["end"], 20)
        self.assertTrue(all(0 <= value <= 1 for value in result["energy"]))


class AnalysisServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.store = Store(self.root / "db.sqlite3")
        self.store.update({"navidrome_url": "http://navidrome:4533"})
        credentials = self.root / "credentials.json"
        credentials.write_text(json.dumps({"username": "test", "password": "fixture"}))
        self.environment = patch.dict(
            "os.environ", {"MUSIMO_NAVIDROME_CREDENTIALS_FILE": str(credentials)}
        )
        self.environment.start()
        self.version = 1
        self.media = b"fixture audio content"
        self.fail_stream = False

        def upstream(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/stream"):
                return httpx.Response(503 if self.fail_stream else 200, content=self.media)
            return httpx.Response(
                200,
                json={
                    "subsonic-response": {
                        "status": "ok",
                        "song": {
                            "duration": 20,
                            "size": self.version,
                            "id": request.url.params.get("id"),
                        },
                    }
                },
            )

        self.upstream = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.navidrome = Navidrome(self.store, self.upstream)
        self.service = VisualizerAnalysis(self.root, lambda: self.navidrome)
        app = FastAPI()
        install_visualizer_routes(app, lambda: self.service)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")

    async def asyncTearDown(self) -> None:
        await self.service.close()
        await self.client.aclose()
        await self.upstream.aclose()
        self.store.close()
        self.environment.stop()
        self.folder.cleanup()

    async def test_requests_deduplicate_and_changed_recording_requeues(self) -> None:
        self.assertEqual(
            (await self.client.get("/api/visualizer/analysis/track")).json()["status"], "missing"
        )
        for _ in range(3):
            self.assertEqual(
                (await self.client.post("/api/visualizer/analysis/track")).json()["status"],
                "queued",
            )
        self.assertEqual(self.service.queue.qsize(), 1)
        self.version = 2
        await self.client.post("/api/visualizer/analysis/track")
        self.assertEqual(self.service.queue.qsize(), 2)
        for index in range(6):
            await self.client.post(f"/api/visualizer/analysis/track-{index}")
        self.assertEqual(
            (await self.client.post("/api/visualizer/analysis/overflow")).status_code, 429
        )
        self.assertEqual(
            (await self.client.post("/api/visualizer/analysis/bad%3Fid")).status_code, 422
        )

    async def test_content_cache_is_reused_and_temporary_audio_is_removed(self) -> None:
        digest = hashlib.sha256(b"musimo-map-v1" + self.media).hexdigest()
        output = self.service.root / f"{digest}.json.gz"
        with gzip.open(output, "wt") as stream:
            json.dump({"version": 1, "duration": 20}, stream)
        await self.service.request("track")
        self.service.start()
        with patch("backend.visualizer_api.asyncio.create_subprocess_exec") as process:
            await asyncio.wait_for(self.service.queue.join(), timeout=5)
        process.assert_not_called()
        self.assertEqual(self.service.status("track")["status"], "ready")
        self.assertEqual(list(self.service.root.glob("*.media")), [])
        assert self.service.task is not None
        self.service.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.service.task
        output.unlink()
        self.assertEqual((await self.service.request("track"))["status"], "queued")

    async def test_stream_failure_is_retriable_and_leaves_no_source_file(self) -> None:
        self.fail_stream = True
        await self.service.request("track")
        self.service.start()
        await asyncio.wait_for(self.service.queue.join(), timeout=5)
        self.assertEqual(self.service.status("track")["status"], "failed")
        self.assertEqual(list(self.service.root.glob("*.media")), [])
        self.assertEqual((await self.service.request("track"))["status"], "queued")

    async def test_restart_recovers_interrupted_jobs(self) -> None:
        self.service.db.execute(
            "INSERT INTO maps VALUES (?,?,?,?,?)", ("lost", "digest", "analysing", "", time.time())
        )
        self.service.db.commit()
        await self.service.close()
        self.service = VisualizerAnalysis(self.root, lambda: self.navidrome)
        self.assertEqual(self.service.status("lost")["status"], "failed")
        self.assertEqual((await self.service.request("lost"))["status"], "queued")
