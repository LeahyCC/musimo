"""The internal lease the audio worker works through."""

import asyncio
import base64
import struct
import tempfile
import unittest
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.audio_worker_api import install_audio_worker_routes
from backend.core.audio_recipes import SCALAR_RECIPE
from backend.core.store import Store
from backend.library.audio_profile import AudioProfiles
from backend.library.index import Library
from scripts.enqueue_audio_trial import enqueue

TOKEN = "fixture-token-0123456789"


class AudioWorkerApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "musimo.sqlite3")
        library = Library(self.store, [self.music], asyncio.Event())
        for name in ("a.wav", "b.wav"):
            write_wav(self.music / name)
            tag(self.music / name, title=name, artist="Fixture", album="Lease", genres=["Rock"])
        library.scan()
        self.profiles = AudioProfiles(self.store)
        self.busy = False
        app = FastAPI()
        install_audio_worker_routes(app, lambda: self.profiles, lambda: self.busy, TOKEN)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://musimo"
        )
        self.headers = {"Authorization": f"Bearer {TOKEN}"}

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.folder.cleanup()

    async def lease(self) -> dict[str, Any]:
        response = await self.client.post(
            "/api/internal/audio/lease", json={"recipe": SCALAR_RECIPE}, headers=self.headers
        )
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()["job"]
        assert isinstance(job, dict)
        return job

    def done(self, job: dict[str, Any], **changes: object) -> dict[str, object]:
        return {
            "song_id": job["song_id"],
            "recipe": job["recipe"],
            "lease_token": job["lease_token"],
            "size": job["size"],
            "mtime_ns": job["mtime_ns"],
            "status": "done",
            "tempo_bpm": 118.5,
            "energy": 0.07,
        } | changes

    async def test_the_routes_need_the_shared_token_and_are_not_for_browsers(self) -> None:
        for headers, status in [
            ({}, 401),
            ({"Authorization": "Bearer wrong"}, 401),
            ({"Authorization": f"Basic {TOKEN}"}, 401),
            ({**self.headers, "Origin": "http://musimo"}, 404),
            ({**self.headers, "Sec-Fetch-Site": "same-origin"}, 404),
        ]:
            with self.subTest(headers=headers):
                response = await self.client.post(
                    "/api/internal/audio/lease", json={"recipe": SCALAR_RECIPE}, headers=headers
                )
                self.assertEqual(response.status_code, status)
                # The check comes before the body is read, so nothing about the route leaks.
                response = await self.client.post(
                    "/api/internal/audio/result", json={"nonsense": True}, headers=headers
                )
                self.assertEqual(response.status_code, status)
        unconfigured = FastAPI()
        install_audio_worker_routes(unconfigured, lambda: self.profiles, lambda: False, "")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=unconfigured), base_url="http://musimo"
        ) as client:
            response = await client.post(
                "/api/internal/audio/lease", json={"recipe": SCALAR_RECIPE}, headers=self.headers
            )
            self.assertEqual(response.status_code, 404)

    async def test_lease_result_and_the_checks_between_them(self) -> None:
        response = await self.client.post(
            "/api/internal/audio/lease", json={"recipe": SCALAR_RECIPE}, headers=self.headers
        )
        self.assertEqual(response.json(), {"job": None})
        response = await self.client.post(
            "/api/internal/audio/lease", json={"recipe": "nobody-v9"}, headers=self.headers
        )
        self.assertEqual(response.status_code, 422)
        enqueue(self.store, SCALAR_RECIPE, 2)
        # Analysis waits while a chat request is being resolved.
        self.busy = True
        response = await self.client.post(
            "/api/internal/audio/lease", json={"recipe": SCALAR_RECIPE}, headers=self.headers
        )
        self.assertEqual(response.json(), {"job": None})
        self.busy = False
        job = await self.lease()
        self.assertTrue(str(job["path"]).startswith(str(self.music)))
        for body, status in [
            (
                self.done(job, dim=2, vector=base64.b64encode(struct.pack("<2f", 1, 0)).decode()),
                422,
            ),
            (self.done(job, size=int(job["size"]) + 1), 409),
            (self.done(job, status="weird"), 422),
            (self.done(job, extra=1), 422),
        ]:
            with self.subTest(body=body):
                response = await self.client.post(
                    "/api/internal/audio/result", json=body, headers=self.headers
                )
                self.assertEqual(response.status_code, status, response.text)
        # The size mismatch put the song back on the queue; the old token is dead.
        response = await self.client.post(
            "/api/internal/audio/result", json=self.done(job), headers=self.headers
        )
        self.assertEqual(response.status_code, 409)
        job = await self.lease()
        response = await self.client.post(
            "/api/internal/audio/result", json=self.done(job), headers=self.headers
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"stored": True, "status": "done"})
        row = self.store.db.execute(
            "SELECT status, tempo_bpm, energy, dim, vector FROM audio_profile WHERE song_id=?",
            (job["song_id"],),
        ).fetchone()
        self.assertEqual(tuple(row), ("done", 118.5, 0.07, 0, None))
        # A second result for the same lease is rejected and changes nothing.
        response = await self.client.post(
            "/api/internal/audio/result",
            json=self.done(job, tempo_bpm=60.0),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 409)
        row = self.store.db.execute(
            "SELECT tempo_bpm FROM audio_profile WHERE song_id=?", (job["song_id"],)
        ).fetchone()
        self.assertEqual(row[0], 118.5)
        self.assertEqual(self.profiles.queued(SCALAR_RECIPE), 1)
