import asyncio
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from mutagen.id3 import TALB, TIT2, TPE1, TSRC, UFID
from mutagen.wave import WAVE
from watchdog.events import DirCreatedEvent, FileCreatedEvent, FileMovedEvent

from backend.catalog import Catalog, Result
from backend.download_api import install_download_routes
from backend.downloads import Downloads
from backend.job_models import Job, Metadata
from backend.library import Library
from backend.store import Store


class SlowStopDownloads(Downloads):
    def __init__(self, store: Store, catalog: Catalog, library: Library) -> None:
        super().__init__(store, catalog, library, asyncio.Event())
        self.entered = asyncio.Event()
        self.stopped = asyncio.Event()
        self.release = asyncio.Event()

    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        self.jobs.update(job.id, stage="downloading")
        self.entered.set()
        await asyncio.sleep(60)
        raise AssertionError("Fixture must be stopped")

    async def stop_process(self, job_id: str) -> None:
        self.stopped.set()
        await self.release.wait()


class ReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "test.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.temporary.cleanup()

    async def test_watcher_never_indexes_staging_audio(self) -> None:
        staged = self.root / ".musimo" / "job" / "source.wav"
        staged.parent.mkdir(parents=True)
        with wave.open(str(staged), "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 8000)
        self.library.refresh({str(staged)})
        self.assertEqual(self.library.status()["total_files"], 0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM library_fts").fetchone()[0], 0)

    async def test_wav_tags_are_searchable_and_match_ownership(self) -> None:
        path = self.root / "tagged.wav"
        with wave.open(str(path), "wb") as stream:
            stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            stream.writeframes(bytes(16000))
        audio = WAVE(path)
        audio.add_tags()
        assert audio.tags is not None
        for frame in (
            TIT2(encoding=3, text="Fixture"),
            TPE1(encoding=3, text="Artist"),
            TALB(encoding=3, text="Album"),
            TSRC(encoding=3, text="US-XXX-26-00001"),
            UFID(owner="http://musicbrainz.org", data=b"00000000-0000-4000-8000-000000000001"),
        ):
            audio.tags.add(frame)
        audio.save()
        self.library.scan()
        row = self.store.db.execute("SELECT * FROM library_files").fetchone()
        self.assertEqual(
            (row["title"], row["artist"], row["album"]), ("Fixture", "Artist", "Album")
        )
        self.assertEqual(row["isrc"], "USXXX2600001")
        self.assertEqual(row["mbid"], "00000000-0000-4000-8000-000000000001")
        wanted = Result(id=1, kind="track", title="Fixture", artist="Artist", duration=1)
        self.assertEqual(self.library.annotate([wanted])[0].ownership, "owned")
        self.store.db.execute("UPDATE library_files SET title='',artist='',album=''")
        self.library.scan()
        self.assertEqual(
            self.store.db.execute("SELECT title FROM library_files").fetchone()[0], "Fixture"
        )

    async def test_publication_waits_for_scan_pruning(self) -> None:
        entered, release = threading.Event(), threading.Event()
        published = self.root / "published.wav"
        with wave.open(str(published), "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\0\0" * 8000)

        def scan() -> None:
            with self.library.work_lock:
                self.library.generation = "scanning"
                entered.set()
                if not release.wait(2):
                    raise TimeoutError("Test did not release scan")
                self.library.remove(str(published))

        scanning = asyncio.create_task(asyncio.to_thread(scan))
        await asyncio.wait_for(asyncio.to_thread(entered.wait), 2)
        indexing = asyncio.create_task(
            asyncio.to_thread(self.library.index_published, published, self.root)
        )
        try:
            await asyncio.sleep(0.03)
            self.assertFalse(indexing.done())
        finally:
            release.set()
            await asyncio.gather(scanning, indexing)
        self.assertEqual(self.library.status()["total_files"], 1)
        self.assertEqual(
            self.store.db.execute("SELECT generation FROM library_files").fetchone()[0], "scanning"
        )

    async def test_watcher_ignores_staging_and_sidecars_but_keeps_published_moves(self) -> None:
        with (
            patch.object(self.library.observer, "schedule") as schedule,
            patch.object(self.library.observer, "start"),
            patch.object(self.library, "start_scan"),
        ):
            self.library.start()
            handler = schedule.call_args.args[0]
            staged = str(self.root / ".musimo" / "job" / "ready.opus")
            final = str(self.root / "Album" / "track.opus")
            handler.dispatch(DirCreatedEvent(str(self.root / ".musimo")))
            handler.dispatch(FileCreatedEvent(staged))
            handler.dispatch(FileCreatedEvent(str(self.root / "Album" / "cover.jpg")))
            handler.dispatch(FileMovedEvent(staged, final))
            handler.dispatch(DirCreatedEvent(str(self.root / "Album")))
            await asyncio.sleep(0)
            self.library.stop.set()
            if self.library.background:
                await self.library.background
            self.assertEqual(self.library.pending, {final, str(self.root / "Album")})

    async def test_repeated_stop_commands_finish_cleanup(self) -> None:
        async with httpx.AsyncClient() as client:
            service = SlowStopDownloads(self.store, Catalog(self.store, client), self.library)
            job = service.jobs.enqueue(1, "original", str(self.root))
            service.jobs.update(job.id, meta=Metadata(id=1, artist="Fixture").model_dump())
            service.start()
            try:
                await asyncio.wait_for(service.entered.wait(), 2)
                service.command(job.id, "pause")
                await asyncio.wait_for(service.stopped.wait(), 2)
                service.command(job.id, "pause")
                service.command(job.id, "cancel")
                service.release.set()
                await asyncio.wait_for(asyncio.gather(*service.running.values()), 2)
                self.assertEqual(service.jobs.get(job.id).stage, "cancelled")
                self.assertFalse(service.folder(job).exists())
            finally:
                service.release.set()
                await service.close()

    async def test_global_resume_during_pause_does_not_strand_jobs(self) -> None:
        async with httpx.AsyncClient() as client:
            service = SlowStopDownloads(self.store, Catalog(self.store, client), self.library)
            job = service.jobs.enqueue(1, "original", str(self.root))
            service.jobs.update(job.id, meta=Metadata(id=1, artist="Fixture").model_dump())
            app = FastAPI()
            install_download_routes(app, lambda: service)
            service.start()
            try:
                await asyncio.wait_for(service.entered.wait(), 2)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as api:
                    self.assertEqual((await api.post("/api/queue/pause")).status_code, 200)
                    await asyncio.wait_for(service.stopped.wait(), 2)
                    self.assertEqual((await api.post("/api/queue/resume")).status_code, 200)
                service.entered.clear()
                service.release.set()
                await asyncio.wait_for(service.entered.wait(), 2)
                self.assertEqual(service.jobs.get(job.id).stage, "downloading")
                self.assertFalse(service.controls()["paused"])
            finally:
                service.release.set()
                await service.close()

    async def test_incomplete_album_queues_nothing(self) -> None:
        def upstream(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/album/9":
                return httpx.Response(
                    200,
                    json={
                        "id": 9,
                        "title": "Incomplete",
                        "nb_tracks": 2,
                        "tracks": {"data": [{"id": 1, "title": "Only one", "artist": {"id": 1}}]},
                    },
                )
            return httpx.Response(200, json={"data": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            service = Downloads(
                self.store, Catalog(self.store, client), self.library, asyncio.Event()
            )
            self.store.update({"destination": str(self.root)})
            app = FastAPI()
            install_download_routes(app, lambda: service)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as api:
                response = await api.post("/api/batches", json={"album_id": 9})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(service.jobs.list(), [])
