"""A long hold on the store lock must not stall the event loop.

A scan or a download can hold `store.lock` for seconds. Handlers that wait for it on the
loop would freeze every request, audio streams included. These tests hold the lock from
another thread and check that a request needing no lock still answers at once.
"""

import asyncio
import tempfile
import threading
import time
import unittest
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from test_player import tag, write_wav

from backend.api.listener_api import install_listener_routes
from backend.api.player_api import install_player_routes
from backend.core.listener import bind, reset
from backend.core.store import Store
from backend.library.index import Library
from backend.library.player import Player

# How long the other thread keeps the lock if the test does not let go first.
HOLD_SECONDS = 3.0
# A loop blocked on the lock cannot answer for the whole hold. Free, it answers in
# milliseconds, so this leaves a wide margin for a slow machine.
ANSWER_SECONDS = 1.0


class LockHoldTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        music = base / "music"
        music.mkdir()
        write_wav(music / "song.wav")
        tag(music / "song.wav", title="Song", artist="Artist", album="Album", album_artist="Artist")
        self.store = Store(base / "musimo.sqlite3")
        Library(self.store, [music], asyncio.Event()).scan()
        self.song_id = str(self.store.db.execute("SELECT song_id FROM library_files").fetchone()[0])
        # Names exist, so every handler also takes the "which listener" branch of the store.
        colin = self.store.create_listener("Colin")["id"]
        self.store.create_listener("Sam")
        player = Player(self.store, [music])
        app = FastAPI()

        @app.middleware("http")
        async def as_colin(
            request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            # What the real middleware does for a named listener's routes.
            token = bind(colin)
            try:
                return await call_next(request)
            finally:
                reset(token)

        install_player_routes(app, lambda: player)
        install_listener_routes(app, lambda: self.store)

        @app.get("/ping")
        async def ping() -> dict[str, bool]:
            return {"ok": True}

        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")
        # Built once before the lock is held, as a running server has long since done.
        await player.play_queue()

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def hold_lock(self) -> tuple[threading.Event, threading.Thread]:
        """Take the store lock in a thread. The event lets it go early."""
        held = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with self.store.lock:
                held.set()
                release.wait(HOLD_SECONDS)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(held.wait(2))
        return release, thread

    async def test_requests_that_wait_for_the_lock_leave_the_loop_free(self) -> None:
        stream = f"/api/player/stream/{self.song_id}"
        release, thread = self.hold_lock()
        started = time.monotonic()
        pending: list[Awaitable[httpx.Response]] = [
            self.client.get(stream),
            self.client.get("/api/listeners"),
            self.client.post("/api/player/scrobble", json={"id": self.song_id, "submission": True}),
            self.client.post(
                "/api/library/tracks/shuffle", json={"seed": "no-such-shuffle", "limit": 5}
            ),
            self.client.put("/api/library/artists/ar-aaaaaaaaaaaaaaaa/favourite"),
            self.client.get("/api/library/playlists"),
            self.client.get("/api/library/playlists/liked"),
            self.client.post("/api/library/playlists", json={"name": "Mix", "song_ids": []}),
        ]
        waiting = [asyncio.ensure_future(call) for call in pending]
        try:
            # Let every request run into the lock before asking for a free route.
            await asyncio.sleep(0.2)
            answer = await asyncio.wait_for(self.client.get("/ping"), ANSWER_SECONDS)
            self.assertEqual(answer.status_code, 200)
            # Measured from the moment the lock was taken: a blocked loop only comes back
            # after the hold ends, which is far past this.
            self.assertLess(time.monotonic() - started, ANSWER_SECONDS)
            # The ones that need the lock are waiting for it, not lost.
            self.assertFalse(any(call.done() for call in waiting))
        finally:
            release.set()
            thread.join(5)
            # Settled even when an assertion above failed, so no request outlives the store.
            answers = await asyncio.wait_for(asyncio.gather(*waiting, return_exceptions=True), 10)
        responses = [item for item in answers if isinstance(item, httpx.Response)]
        self.assertEqual(len(responses), len(waiting), answers)
        self.assertEqual(responses[0].status_code, 200)
        self.assertEqual(responses[1].status_code, 200)
        self.assertEqual(len(responses[1].json()["items"]), 2)
        self.assertEqual(responses[2].status_code, 204)
        for response in responses:
            self.assertLess(response.status_code, 500)


if __name__ == "__main__":
    unittest.main()
