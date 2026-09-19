"""Each download source pauses on its own and names itself in hints."""

import asyncio
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path

import httpx
from fastapi import FastAPI

from backend.catalog import Catalog
from backend.download_api import install_download_routes
from backend.downloads import DownloadError, Downloads
from backend.errors import error_guidance, site_label
from backend.job_models import Candidate, Job, Metadata, valid_candidate_id
from backend.library import Library
from backend.store import Store


class BlockedYouTube(Downloads):
    """YouTube refuses every request; any other source fails in an ordinary way."""

    def __init__(self, store: Store, catalog: Catalog, library: Library) -> None:
        super().__init__(store, catalog, library, asyncio.Event())
        self.ran: list[str] = []

    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        self.ran.append(job.id)
        if job.source == "youtube":
            raise DownloadError("SOURCE_BLOCKED", "HTTP 403")
        raise DownloadError("DOWNLOAD_FAILED", "Host went away")


async def until(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(3):
        while not check():
            await asyncio.sleep(0.01)


class SourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "test.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.temporary.cleanup()

    def test_stored_jobs_without_a_source_take_it_from_their_catalog(self) -> None:
        base = {
            "id": "old",
            "track_id": 1,
            "target": "/music",
            "created_at": 0,
            "updated_at": 0,
            "meta": {"id": 1},
        }
        self.assertEqual(Job.model_validate(base).source, "youtube")
        self.assertEqual(Job.model_validate({**base, "catalog": "podcast"}).source, "podcast")
        self.assertEqual(Job.model_validate({**base, "source": "bandcamp"}).source, "bandcamp")
        old = Candidate.model_validate({"id": "abcdefghijk", "title": "Song"})
        self.assertEqual((old.source, old.url), ("youtube", ""))

    def test_candidate_ids_are_checked_by_their_own_source(self) -> None:
        self.assertTrue(valid_candidate_id("youtube", "abcdefghijk"))
        self.assertFalse(valid_candidate_id("youtube", "abcdefghij"))
        self.assertFalse(valid_candidate_id("youtube", "https://untrusted.test"))
        self.assertFalse(valid_candidate_id("unknown", "abcdefghijk"))

    def test_hints_name_the_site(self) -> None:
        self.assertEqual(
            error_guidance("NO_MATCH")[0], "No matching recording was found on YouTube."
        )
        self.assertEqual(
            error_guidance("NO_MATCH", site_label("youtube"))[0],
            "No matching recording was found on YouTube.",
        )
        self.assertEqual(
            error_guidance("SOURCE_BLOCKED", site_label("podcast"))[0],
            "The podcast host is blocking requests. Check credentials and tools.",
        )
        self.assertEqual(
            error_guidance("RATE_LIMITED", site_label("somewhere"))[0],
            "The download site rate limit reached. Wait before retrying.",
        )

    def test_old_database_carries_the_youtube_pause_across(self) -> None:
        path = self.root / "old.sqlite3"
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE queue_control (
                id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
                source_paused INTEGER NOT NULL DEFAULT 0,
                blocking_failures INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO queue_control VALUES (1,0,1,2);
            PRAGMA user_version=3;
        """)
        db.close()
        for _ in range(2):
            store = Store(path)
            try:
                self.assertEqual(
                    store.controls(),
                    {"paused": False, "source_paused": True, "paused_sources": ["youtube"]},
                )
                self.assertEqual(
                    [tuple(row) for row in store.db.execute("SELECT * FROM source_control")],
                    [("youtube", 1, 2)],
                )
                self.assertEqual(store.db.execute("PRAGMA user_version").fetchone()[0], 4)
            finally:
                store.close()

    def test_fresh_database_has_nothing_paused(self) -> None:
        self.assertEqual(
            self.store.controls(),
            {"paused": False, "source_paused": False, "paused_sources": []},
        )

    async def test_blocking_errors_pause_only_their_own_source(self) -> None:
        async with httpx.AsyncClient() as client:
            service = BlockedYouTube(self.store, Catalog(self.store, client), self.library)
            blocked = [
                service.jobs.enqueue(track, "original", str(self.root)) for track in (1, 2, 3)
            ]
            for job in blocked:
                service.jobs.update(job.id, meta=Metadata(id=job.track_id, artist="A").model_dump())
            app = FastAPI()
            install_download_routes(app, lambda: service)
            service.start()
            try:
                await until(lambda: all(service.jobs.get(j.id).stage == "failed" for j in blocked))
                await until(lambda: bool(service.controls()["source_paused"]))
                self.assertEqual(service.controls()["paused_sources"], ["youtube"])
                self.assertFalse(service.controls()["paused"])

                waiting = service.jobs.enqueue(4, "original", str(self.root))
                service.jobs.update(waiting.id, meta=Metadata(id=4, artist="A").model_dump())
                episode = service.jobs.enqueue_many(
                    [5],
                    "original",
                    str(self.root),
                    catalog="podcast",
                    prepared={5: (Metadata(id=5, artist="Host"), "https://feeds.test/5.mp3")},
                )[0]
                self.assertEqual(episode.source, "podcast")
                await until(lambda: service.jobs.get(episode.id).stage == "failed")
                # A host failure is not a YouTube block and does not pause the podcast source.
                self.assertEqual(service.controls()["paused_sources"], ["youtube"])
                self.assertEqual(service.jobs.get(waiting.id).stage, "queued")
                self.assertNotIn(waiting.id, service.ran)

                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as api:
                    other = await api.post("/api/queue/resume-source?source=podcast")
                    self.assertEqual(other.json()["controls"]["paused_sources"], ["youtube"])
                    bad = await api.post("/api/queue/resume-source?source=../x")
                    self.assertEqual(bad.status_code, 422)
                    resumed = await api.post("/api/queue/resume-source")
                    self.assertEqual(resumed.status_code, 200)
                    self.assertFalse(resumed.json()["controls"]["source_paused"])
                await until(lambda: service.jobs.get(waiting.id).stage == "failed")
                # The count restarted on resume, so one more block does not pause again.
                self.assertEqual(service.controls()["paused_sources"], [])
            finally:
                await service.close()

    async def test_pick_accepts_only_ids_valid_for_the_candidate_source(self) -> None:
        async with httpx.AsyncClient() as client:
            service = Downloads(
                self.store, Catalog(self.store, client), self.library, asyncio.Event()
            )
            job = service.jobs.enqueue(1, "original", str(self.root))
            service.jobs.update(
                job.id,
                stage="paused",
                desired="pause",
                candidates=[
                    Candidate(id="abcdefghijk", title="Song").model_dump(),
                    Candidate(id="short", title="Song", source="unknown").model_dump(),
                    Candidate(id="abcdefghijl", title="Song", source="unknown").model_dump(),
                ],
            )
            app = FastAPI()
            install_download_routes(app, lambda: service)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as api:
                for rejected in ("short", "abcdefghijl", "not-listed1"):
                    response = await api.post(
                        f"/api/jobs/{job.id}/pick", json={"candidate_id": rejected}
                    )
                    self.assertEqual(response.status_code, 422, rejected)
                picked = await api.post(
                    f"/api/jobs/{job.id}/pick", json={"candidate_id": "abcdefghijk"}
                )
                self.assertEqual(picked.status_code, 200)
                self.assertEqual(picked.json()["selected"], "abcdefghijk")


if __name__ == "__main__":
    unittest.main()
