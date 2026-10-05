import asyncio
import ctypes
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import mutagen
from fastapi import FastAPI
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

from backend.catalog import Catalog, CatalogError
from backend.download_api import install_download_routes
from backend.downloads import (
    CATALOG_DETAILS_WARNING,
    SIDE_FAILED,
    DownloadError,
    Downloads,
    catalog_details_pending,
    digest,
    enrichment_pending,
    publish_file,
)
from backend.job_models import Candidate, Job, Metadata
from backend.job_store import JobConflict, Jobs
from backend.library import Library, normalize
from backend.matching import Matcher
from backend.naming import Naming
from backend.store import Store
from backend.tagging import Tagger, probe


class DurableJobsTests(unittest.TestCase):
    def test_idempotency_batch_restart_and_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.sqlite3"
            store = Store(path)
            jobs = Jobs(store, lambda: None)
            first = jobs.enqueue(1, "original", directory)
            self.assertEqual(first.id, jobs.enqueue(1, "original", directory).id)
            batch = jobs.enqueue_many([1, 2, 2, 3], "original", directory, "batch-one")
            self.assertEqual(len(jobs.list()), 3)
            self.assertEqual(batch[1].id, batch[2].id)
            jobs.update(
                first.id,
                stage="downloading",
                meta=Metadata(id=1, lyrics="private payload").model_dump(),
            )
            self.assertNotIn("private payload", json.dumps(store.snapshot()))
            self.assertNotIn("private payload", json.dumps(store.events(0)))
            store.close()
            store = Store(path)
            jobs = Jobs(store, lambda: None)
            jobs.recover()
            self.assertEqual(jobs.get(first.id).stage, "queued")
            self.assertEqual(jobs.get(first.id).meta.lyrics, "private payload")
            jobs.update(
                first.id,
                stage="failed",
                error_code="NO_MATCH",
                error="No sufficiently close recording found",
                error_hint="No matching recording was found on YouTube.",
                error_fix="card:pick",
            )
            self.assertEqual(
                store.job_summary(),
                {
                    "active": 2,
                    "failed": 1,
                    "failure_reasons": [
                        {
                            "code": "NO_MATCH",
                            "message": "No sufficiently close recording found",
                            "count": 1,
                            "hint": "No matching recording was found on YouTube.",
                            "fix": "card:pick",
                        }
                    ],
                },
            )
            jobs.update(first.id, hidden=True)
            self.assertEqual(store.job_summary(), {"active": 2, "failed": 0, "failure_reasons": []})
            replacement = jobs.enqueue(1, "original", directory)
            with self.assertRaises(JobConflict):
                jobs.update(first.id, stage="queued")
            self.assertEqual(jobs.history("", 0, 1e12, 0)["total"], 1)
            self.assertNotEqual(first.id, replacement.id)
            store.close()

    def test_failure_summary_counts_jobs_beyond_visible_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "jobs.sqlite3")
            jobs = Jobs(store, lambda: None)
            for track_id in range(55):
                job = jobs.enqueue(track_id + 1, "original", directory)
                jobs.update(
                    job.id,
                    stage="failed",
                    error_code="NO_MATCH",
                    error="No sufficiently close recording found",
                )

            visible_failures = [job for job in jobs.visible() if job.stage == "failed"]
            self.assertEqual(len(visible_failures), 50)
            self.assertEqual(store.job_summary()["failed"], 55)
            for track_id in range(3):
                job = jobs.enqueue(track_id + 100, "original", directory)
                jobs.update(job.id, stage="failed", error_code="TIMEOUT", error="timed out")
            visible_failures = [job for job in jobs.visible() if job.stage == "failed"]
            self.assertEqual(
                sum(job.error_code == "NO_MATCH" for job in visible_failures),
                50,
            )
            self.assertEqual(
                sum(job.error_code == "TIMEOUT" for job in visible_failures),
                3,
            )
            snapped = store.snapshot()["jobs"]
            assert isinstance(snapped, list)
            snap_ids = {row["id"] for row in snapped if isinstance(row, dict)}
            self.assertEqual({job.id for job in jobs.visible()}, snap_ids)
            store.close()

    def test_visible_keeps_an_older_batch_sibling_outside_the_recent_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "jobs.sqlite3")
            jobs = Jobs(store, lambda: None)
            unrelated = jobs.enqueue(9, "original", directory)
            jobs.update(unrelated.id, stage="done", final_path=str(Path(directory) / "old.opus"))
            batch = jobs.enqueue_many([1, 2], "original", directory, "batch-one", "Artist")
            jobs.update(batch[0].id, stage="done", final_path=str(Path(directory) / "sibling.opus"))
            for track_id in range(50):
                finished = jobs.enqueue(100 + track_id, "original", directory)
                jobs.update(
                    finished.id, stage="done", final_path=str(Path(directory) / f"{track_id}.opus")
                )
            visible = {job.id for job in jobs.visible()}
            self.assertIn(batch[0].id, visible)
            self.assertIn(batch[1].id, visible)
            self.assertNotIn(unrelated.id, visible)
            snapped = store.snapshot()["jobs"]
            assert isinstance(snapped, list)
            self.assertEqual(visible, {row["id"] for row in snapped if isinstance(row, dict)})
            store.close()

    def test_recording_rank_rejects_wrong_duration_and_prefers_topic(self) -> None:
        meta = Metadata(id=1, title="Test Song", artist="Test Artist", duration=180)
        rows = [
            Candidate(
                id="correct0001",
                title="Test Song",
                artist="Test Artist - Topic",
                duration=180,
                topic=True,
            ),
            Candidate(
                id="cover000001", title="Test Song cover", artist="Test Artist", duration=180
            ),
            Candidate(id="long0000001", title="Test Song", artist="Test Artist", duration=360),
        ]
        ranked = Matcher().rank(meta, rows)
        self.assertEqual(ranked[0].id, "correct0001")
        self.assertGreater(ranked[0].score, 0.86)
        self.assertNotIn("long0000001", [row.id for row in ranked])

    def test_recording_rank_puts_decoy_uploads_below_the_original(self) -> None:
        meta = Metadata(id=1, title="Test Song", artist="Test Artist", duration=180)
        decoys = [
            "Test Artist - Test Song [Bass boosted]",
            "Test Artist - Test Song (8D Audio)",
            "Test Song (Originally Performed by Test Artist)",
            "Test Song (Nightcore)",
        ]
        rows = [
            Candidate(id=f"decoy{i:06d}", title=title, artist="Test Artist", duration=180)
            for i, title in enumerate(decoys)
        ]
        rows.append(Candidate(id="correct0001", title="Test Song", artist="Uploads", duration=180))
        ranked = Matcher().rank(meta, rows, min_score=0)
        self.assertEqual(ranked[0].id, "correct0001")
        # A wanted title that is itself the 8D version keeps its 8D match.
        wanted = Metadata(id=2, title="Test Song (8D Audio)", artist="Test Artist", duration=180)
        score = Matcher().score(wanted, decoys[1], "Test Artist", 180)
        assert score is not None
        self.assertFalse(score.version_mismatch or score.version_missing)

    def test_output_path_is_contained_and_publication_never_overwrites(self) -> None:
        naming = Naming()
        for bad in ["../{title}", "/{title}", "{title.__class__}", "{artist!r}", "x//{title}"]:
            with self.assertRaises(ValueError):
                naming.validate(bad)
        result = naming.path(
            "{album_artist}/{album}/{track:02d} - {title}",
            Metadata(id=1, album_artist="../CON", album="a/b", title="A:B?", track=2),
            "opus",
        )
        self.assertNotIn("..", result)
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "new", Path(directory) / "old"
            source.write_bytes(b"new")
            target.write_bytes(b"original")
            with self.assertRaises(FileExistsError):
                publish_file(source, target)
            self.assertEqual(target.read_bytes(), b"original")
            self.assertEqual(source.read_bytes(), b"new")


class QueueControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_windows_stop_also_terminates_worker_children(self) -> None:
        if sys.platform != "win32":
            self.skipTest("Windows process tree termination")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                service = Downloads(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-c",
                    "import subprocess,sys,time; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                    "print(p.pid,flush=True); time.sleep(60)",
                    stdout=asyncio.subprocess.PIPE,
                )
                service.processes["test"] = process
                assert process.stdout
                child_pid = int(await asyncio.wait_for(process.stdout.readline(), 5))
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                handle = kernel.OpenProcess(0x100000, False, child_pid)
                self.assertTrue(handle)
                try:
                    await service.stop_process("test")
                    self.assertIsNotNone(process.returncode)
                    self.assertEqual(kernel.WaitForSingleObject(ctypes.c_void_p(handle), 1000), 0)
                finally:
                    kernel.CloseHandle(ctypes.c_void_p(handle))
                    await service.stop_process("test")
                    store.close()

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    async def test_restart_after_publication_reconciles_without_second_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            store.update({"navidrome_mode": "watcher"})
            audio = root / "published.opus"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=duration=1",
                    "-c:a",
                    "libopus",
                    str(audio),
                ],
                check=True,
                capture_output=True,
            )
            meta = Metadata(id=1, title="Published", artist="Fixture", album="Tests")
            Tagger().write(audio, meta, None)
            async with httpx.AsyncClient() as client:
                service = Downloads(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=meta.model_dump(),
                    stage="cancelling",
                    desired="cancel",
                    final_path=str(audio),
                    artifact_hash=digest(audio),
                )
                service.start()
                async with asyncio.timeout(3):
                    while service.jobs.get(job.id).stage != "done":
                        await asyncio.sleep(0.01)
                self.assertEqual(service.jobs.get(job.id).attempts, 0)
                self.assertEqual(list(root.glob("*.opus")), [audio])
                self.assertEqual(
                    store.db.execute(
                        "SELECT title FROM library_files WHERE path=?", (str(audio),)
                    ).fetchone()[0],
                    "Published",
                )
                await service.close()
            store.close()

    async def test_batch_api_idempotency_controls_and_scan_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            requests: list[httpx.Request] = []

            def upstream(request: httpx.Request) -> httpx.Response:
                requests.append(request)
                if request.url.path == "/album/9":
                    return httpx.Response(
                        200,
                        json={
                            "id": 9,
                            "title": "Album",
                            "nb_tracks": 2,
                            "artist": {"id": 1, "name": "Artist"},
                            "tracks": {
                                "data": [
                                    {
                                        "id": 1,
                                        "title": "One",
                                        "artist": {"id": 1, "name": "Artist"},
                                    },
                                    {
                                        "id": 2,
                                        "title": "Two",
                                        "artist": {"id": 1, "name": "Artist"},
                                    },
                                ]
                            },
                        },
                    )
                return httpx.Response(200, json={"subsonic-response": {"status": "ok"}})

            async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                store.update(
                    {
                        "destination": str(root),
                        "navidrome_mode": "api",
                        "navidrome_url": "http://navidrome:4533",
                    }
                )
                app = FastAPI()
                install_download_routes(app, lambda: service)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as api:
                    response = await api.post("/api/batches", json={"album_id": 9})
                    self.assertEqual(response.status_code, 200)
                    payload = response.json()
                    self.assertEqual({job["album_id"] for job in payload["jobs"]}, {9})
                    # The listing is stored so matching can start without another catalog fetch.
                    self.assertEqual(
                        {job["meta"]["title"] for job in payload["jobs"]}, {"One", "Two"}
                    )
                    self.assertEqual({job["meta"]["artist"] for job in payload["jobs"]}, {"Artist"})
                    self.assertTrue(
                        all(job["meta"]["album_artist"] == "" for job in payload["jobs"])
                    )
                    again = (await api.post("/api/batches", json={"album_id": 9})).json()
                    self.assertEqual(
                        [row["id"] for row in payload["jobs"]], [row["id"] for row in again["jobs"]]
                    )
                    await api.post("/api/batches/" + payload["id"] + "/pause")
                    self.assertTrue(all(job.stage == "paused" for job in service.jobs.list()))
                    await api.post("/api/batches/" + payload["id"] + "/cancel")
                    self.assertTrue(all(job.stage == "cancelled" for job in service.jobs.list()))
                    self.assertEqual(
                        (
                            await api.post(
                                "/api/jobs", json={"track_id": 3, "target": str(root.parent)}
                            )
                        ).status_code,
                        422,
                    )
                job = service.jobs.list()[0]
                credentials = root / "credentials.json"
                credentials.write_text(
                    json.dumps({"username": "fixture", "password": "test secret"}), encoding="utf-8"
                )
                with patch.dict(
                    "os.environ", {"MUSIMO_NAVIDROME_CREDENTIALS_FILE": str(credentials)}
                ):
                    self.assertIsNone(
                        await service.navidrome(job, root / "Artist" / "Album" / "track.opus")
                    )
                request = requests[-1]
                self.assertEqual(request.url.params["target"], "1:Artist/Album")
                self.assertNotIn("test secret", str(request.url))
                self.assertNotIn("test secret", json.dumps(store.snapshot()))
            store.close()

    async def test_failed_jobs_clear_individually_and_in_bulk_without_touching_done(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                store.update({"destination": str(root)})
                jobs = [service.jobs.enqueue(track, "original", str(root)) for track in (1, 2, 3)]
                service.jobs.update(jobs[0].id, stage="failed", error="No match")
                service.jobs.update(jobs[1].id, stage="failed", error="No match")
                service.jobs.update(jobs[2].id, stage="done", final_path=str(root / "a.opus"))
                app = FastAPI()
                install_download_routes(app, lambda: service)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as api:
                    dismissed = await api.post(f"/api/jobs/{jobs[0].id}/dismiss")
                    self.assertEqual(dismissed.status_code, 200)
                    self.assertTrue(dismissed.json()["hidden"])
                    self.assertEqual((await api.post("/api/queue/clear-failed")).status_code, 200)
                    visible = {job.id: job for job in service.jobs.visible()}
                    self.assertNotIn(jobs[1].id, visible)
                    self.assertIn(jobs[2].id, visible)
                    running = service.jobs.enqueue(4, "original", str(root))
                    refused = await api.post(f"/api/jobs/{running.id}/dismiss")
                    self.assertEqual(refused.status_code, 409)
                    missed = service.jobs.enqueue(5, "original", str(root))
                    broken = service.jobs.enqueue(6, "original", str(root))
                    service.jobs.update(
                        missed.id,
                        stage="failed",
                        error_code="NO_MATCH",
                        error="No sufficiently close recording found",
                    )
                    service.jobs.update(
                        broken.id, stage="failed", error_code="TIMEOUT", error="timed out"
                    )
                    self.assertEqual((await api.post("/api/queue/retry-failed")).status_code, 200)
                    self.assertEqual(service.jobs.get(missed.id).stage, "failed")
                    self.assertEqual(service.jobs.get(broken.id).stage, "queued")
                    service.jobs.update(
                        broken.id, stage="failed", error_code="TIMEOUT", error="timed out"
                    )
                    self.assertEqual((await api.post("/api/queue/clear-failed")).status_code, 200)
                    self.assertFalse(service.jobs.get(missed.id).hidden)
                    self.assertTrue(service.jobs.get(broken.id).hidden)
                    self.assertEqual(
                        (await api.post("/api/queue/clear-unmatched")).status_code, 200
                    )
                    self.assertTrue(service.jobs.get(missed.id).hidden)
            store.close()

    async def test_pause_stops_worker_preserves_partial_cancel_removes_only_staging(self) -> None:
        class SlowWorker(Downloads):
            async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                (folder / "source.webm.part").write_bytes(b"resumable")
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-c",
                    "import time; time.sleep(60)",
                    start_new_session=sys.platform != "win32",
                )
                self.processes[job.id] = process
                self.jobs.update(job.id, stage="downloading")
                await process.wait()
                raise ValueError("Stopped worker cannot finish")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                library = Library(store, [root], asyncio.Event())
                service = SlowWorker(store, Catalog(store, client), library, asyncio.Event())
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(job.id, meta=Metadata(id=1, artist="Fixture").model_dump())
                service.start()
                async with asyncio.timeout(5):
                    while service.jobs.get(job.id).stage != "downloading":
                        await asyncio.sleep(0.01)
                process = service.processes[job.id]
                started = time.monotonic()
                service.command(job.id, "pause")
                async with asyncio.timeout(2):
                    while service.jobs.get(job.id).stage != "paused":
                        await asyncio.sleep(0.01)
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNotNone(process.returncode)
                self.assertTrue((service.folder(job) / "source.webm.part").exists())
                untouched = root / "existing.mp3"
                untouched.write_bytes(b"keep")
                service.command(job.id, "cancel")
                self.assertFalse(service.folder(job).exists())
                self.assertEqual(untouched.read_bytes(), b"keep")
                await service.close()
            store.close()

    async def test_disk_full_is_non_retryable_and_queued_cancel_is_immediate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                service = Downloads(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                with patch(
                    "backend.downloads.shutil.disk_usage",
                    return_value=shutil._ntuple_diskusage(100, 100, 0),
                ):
                    with self.assertRaises(DownloadError) as caught:
                        service.check_destination(root)
                self.assertEqual(caught.exception.code, "DISK_FULL")
                job = service.jobs.enqueue(1, "original", str(root))
                self.assertEqual(service.command(job.id, "cancel").stage, "cancelled")
            store.close()

    async def test_batch_response_separates_owned_and_queued(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/album/100":
                        return httpx.Response(
                            200,
                            json={
                                "id": 100,
                                "title": "Test Album",
                                "nb_tracks": 4,
                                "artist": {"id": 1, "name": "Test Artist"},
                                "tracks": {
                                    "data": [
                                        {
                                            "id": 1,
                                            "title": "Track One",
                                            "artist": {"id": 1, "name": "Test Artist"},
                                            "duration": 200,
                                        },
                                        {
                                            "id": 2,
                                            "title": "Track Two",
                                            "artist": {"id": 1, "name": "Test Artist"},
                                            "duration": 210,
                                        },
                                        {
                                            "id": 3,
                                            "title": "Track Three",
                                            "artist": {"id": 1, "name": "Test Artist"},
                                            "duration": 220,
                                        },
                                        {
                                            "id": 4,
                                            "title": "Track Four",
                                            "artist": {"id": 1, "name": "Test Artist"},
                                            "duration": 230,
                                        },
                                    ]
                                },
                            },
                        )
                    return httpx.Response(200, json={})

                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    library = Library(store, [root], asyncio.Event())
                    # Add one file to library (track 1 will be owned)
                    library_file = root / "track1.flac"
                    library_file.write_bytes(b"dummy")
                    store.db.execute(
                        "INSERT INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            str(library_file),
                            str(root),
                            1,
                            1,
                            "new",
                            "Track One",
                            "Test Artist",
                            "Test Album",
                            normalize("Track One"),
                            normalize("Test Artist"),
                            normalize("Test Album"),
                            200,
                            "",
                            "",
                        ),
                    )
                    store.db.execute(
                        "INSERT INTO library_fts VALUES (?,?,?,?)",
                        (str(library_file), "Track One", "Test Artist", "Test Album"),
                    )
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    store.update({"destination": str(root)})
                    # Queue track 2
                    service.jobs.enqueue(2, "original", str(root))
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        response = await api.post(
                            "/api/batches", json={"album_id": 100, "missing_only": False}
                        )
                        self.assertEqual(response.status_code, 200)
                        payload = response.json()
                        # Track 2 was pre-queued. Tracks 1, 3, 4 get new jobs. All 4 jobs returned.
                        self.assertEqual(payload["skipped_owned"], 0)
                        self.assertEqual(payload["skipped_queued"], 1)
                        self.assertEqual(len(payload["jobs"]), 4)
                        self.assertEqual({job["track_id"] for job in payload["jobs"]}, {1, 2, 3, 4})
                        # Second request: all four tracks now have active jobs from first request
                        again = await api.post(
                            "/api/batches", json={"album_id": 100, "missing_only": False}
                        )
                        again_payload = again.json()
                        self.assertEqual(again_payload["skipped_owned"], 0)
                        self.assertEqual(again_payload["skipped_queued"], 4)
                        self.assertEqual(len(again_payload["jobs"]), 4)
                    await service.close()
            finally:
                store.close()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class AudioTagTests(unittest.TestCase):
    def test_all_formats_round_trip_identity_cover_and_synced_lyrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.opus"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-c:a",
                    "libopus",
                    str(source),
                ],
                check=True,
                capture_output=True,
            )
            meta = Metadata(
                id=1,
                title="Fixture",
                artist="Test Artist",
                album_artist="Test Artist",
                album="Tests",
                track=2,
                tracks=4,
                disc=1,
                discs=2,
                isrc="USXXX2600001",
                mb_recording="00000000-0000-4000-8000-000000000001",
                mb_release="00000000-0000-4000-8000-000000000002",
                synced_lyrics="[00:00.00]A test line",
                lyrics="A test line",
            )
            cover = b"\xff\xd8\xfffixture"
            for format in ("original", "m4a", "opus", "mp3"):
                with self.subTest(format=format):
                    ready = Tagger().prepare(source, root, format)
                    Tagger().write(ready, meta, cover)
                    audio = mutagen.File(ready, easy=True)
                    self.assertIsNotNone(audio)
                    self.assertEqual(audio["title"], [meta.title])
                    self.assertEqual(audio["musicbrainz_trackid"], [meta.mb_recording])
                    self.assertEqual(audio["isrc"], [meta.isrc])
                    self.assertEqual(
                        ready.with_suffix(".lrc").read_text(encoding="utf-8"), meta.synced_lyrics
                    )
                    self.assertGreater(float(str(probe(ready)["duration"])), 0.9)
                    if ready.suffix == ".mp3":
                        tags = ID3(ready)
                        self.assertTrue(tags.getall("SYLT"))
                        self.assertEqual(tags.getall("APIC")[0].data, cover)
                    elif ready.suffix == ".m4a":
                        self.assertEqual(bytes(MP4(ready)["covr"][0]), cover)


if __name__ == "__main__":
    unittest.main()


class BackupSourceTests(unittest.IsolatedAsyncioTestCase):
    """Dispatch, pausing and hand picking when SoundCloud stands in for YouTube."""

    async def service(self, root: Path, store: Store, client: httpx.AsyncClient) -> Downloads:
        library = Library(store, [root], asyncio.Event())
        return Downloads(store, Catalog(store, client), library, asyncio.Event())

    async def test_a_paused_youtube_dispatches_catalog_jobs_to_soundcloud(self) -> None:
        class Recording(Downloads):
            started: list[str] = []

            async def run(self, job_id: str) -> None:
                self.started.append(job_id)
                self.jobs.update(job_id, stage="done")

        # YouTube is paused after the job is queued. The source was chosen while YouTube
        # could still run, and it stays until a worker asks the next row.
        cases = (
            (["youtube", "soundcloud"], True),
            (["youtube"], False),
        )
        for order, starts in cases:
            with self.subTest(order=order):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory).resolve()
                    store = Store(root / "db.sqlite3")
                    try:
                        async with httpx.AsyncClient(
                            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
                        ) as client:
                            library = Library(store, [root], asyncio.Event())
                            service = Recording(
                                store, Catalog(store, client), library, asyncio.Event()
                            )
                            service.started = []
                            store.update({"destination": str(root), "source_order": order})
                            job = service.jobs.enqueue(1, "original", str(root))
                            service.set_controls(source_paused=True, source="youtube")
                            service.start()
                            if starts:
                                async with asyncio.timeout(2):
                                    while job.id not in service.started:
                                        await asyncio.sleep(0.01)
                            else:
                                await asyncio.sleep(0.2)
                            self.assertEqual(service.jobs.get(job.id).source, "youtube")
                            self.assertEqual(service.started, [job.id] if starts else [])
                            await service.close()
                    finally:
                        store.close()

    async def test_a_retry_clears_an_automatic_pick_and_keeps_a_hand_pick(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                service = await self.service(root, store, client)
                store.update({"destination": str(root)})
                fell_back = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    fell_back.id,
                    source="soundcloud",
                    selected="abcdefghijk",
                    stage="failed",
                )
                picked = service.jobs.enqueue(2, "original", str(root))
                service.jobs.update(
                    picked.id,
                    source="soundcloud",
                    selected="123456",
                    hand_picked=True,
                    stage="failed",
                )
                automatic = service.command(fell_back.id, "retry")
                self.assertEqual(automatic.selected, "")
                self.assertEqual(automatic.source, "youtube")
                self.assertFalse(automatic.hand_picked)
                kept = service.command(picked.id, "retry")
                self.assertEqual(kept.source, "soundcloud")
                self.assertEqual(kept.selected, "123456")
                self.assertTrue(kept.hand_picked)
                await service.close()
            store.close()

    async def test_a_new_catalog_job_names_the_first_source_that_can_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                service = await self.service(root, store, client)
                self.assertIsNone(service.task)
                cases = (
                    (
                        "soundcloud when youtube is off",
                        {
                            "source_order": ["soundcloud", "deezer"],
                            "disabled_sources": ["youtube"],
                        },
                        "soundcloud",
                    ),
                    (
                        "youtube when it is first and on",
                        {"source_order": ["youtube", "soundcloud"], "disabled_sources": []},
                        "youtube",
                    ),
                    (
                        "the next row when deezer has no cookie",
                        {
                            "source_order": ["deezer", "soundcloud"],
                            "deezer_arl": "",
                            "deezer_audio": True,
                        },
                        "soundcloud",
                    ),
                    (
                        "deezer when the cookie is set",
                        {
                            "source_order": ["deezer", "youtube"],
                            "deezer_audio": True,
                            "deezer_arl": "a" * 192,
                        },
                        "deezer",
                    ),
                )
                for track, (label, settings, expected) in enumerate(cases, start=1):
                    with self.subTest(label=label):
                        store.update({"destination": str(root), **settings})
                        job = service.jobs.enqueue(track, "original", str(root))
                        self.assertEqual(job.source, expected)
                        self.assertIsNone(service.task)
                store.update(
                    {
                        "destination": str(root),
                        "source_order": ["youtube", "soundcloud"],
                        "disabled_sources": [],
                        "deezer_arl": "",
                    }
                )
                picked = service.jobs.enqueue(20, "original", str(root), source="soundcloud")
                self.assertEqual(picked.source, "soundcloud")
                episode = service.jobs.enqueue_many([21], "original", str(root), catalog="podcast")[
                    0
                ]
                self.assertEqual(episode.source, "podcast")
                link = service.jobs.enqueue_many(
                    [22], "original", str(root), catalog="link", source="bandcamp"
                )[0]
                self.assertEqual(link.source, "bandcamp")
                service.set_controls(source_paused=True, source="youtube")
                held = service.jobs.enqueue(23, "original", str(root))
                self.assertEqual(held.source, "soundcloud")
                await service.close()
            store.close()

    async def test_retry_uses_the_first_live_source_when_youtube_is_off(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                service = await self.service(root, store, client)
                store.update(
                    {
                        "destination": str(root),
                        "source_order": ["youtube", "soundcloud"],
                        "disabled_sources": ["youtube"],
                    }
                )
                failed = service.jobs.enqueue(1, "original", str(root))
                self.assertEqual(failed.source, "soundcloud")
                service.jobs.update(
                    failed.id,
                    stage="failed",
                    source="youtube",
                    selected="abcdefghijk",
                )
                retried = service.command(failed.id, "retry")
                self.assertEqual(retried.source, "soundcloud")
                self.assertEqual(retried.selected, "")
                self.assertEqual(retried.lap, 0)
                store.update(
                    {
                        "source_order": ["soundcloud", "youtube"],
                        "disabled_sources": [],
                    }
                )
                hand = service.jobs.enqueue(2, "original", str(root), source="youtube")
                self.assertEqual(hand.source, "youtube")
                service.jobs.update(
                    hand.id,
                    stage="failed",
                    source="youtube",
                    selected="abcdefghijk",
                    hand_picked=True,
                )
                kept = service.command(hand.id, "retry")
                self.assertEqual(kept.source, "youtube")
                self.assertEqual(kept.selected, "abcdefghijk")
                self.assertTrue(kept.hand_picked)
                await service.close()
            store.close()

    async def test_a_catalog_job_fails_when_no_source_can_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                service = await self.service(root, store, client)
                store.update(
                    {
                        "destination": str(root),
                        "source_order": ["youtube"],
                        "disabled_sources": ["youtube"],
                    }
                )
                job = service.jobs.enqueue(1, "original", str(root))
                service.start()
                async with asyncio.timeout(2):
                    while service.jobs.get(job.id).stage != "failed":
                        await asyncio.sleep(0.01)
                failed = service.jobs.get(job.id)
                self.assertIn("turned off", failed.error_hint)
                self.assertEqual(failed.error_fix, "settings:sources")
                await service.close()
            store.close()

    async def test_a_search_block_pauses_the_source_named_on_the_error(self) -> None:
        class FakeOut:
            def __init__(self, payload: bytes) -> None:
                self.payload = payload
                self.sent = False

            async def readline(self) -> bytes:
                if self.sent:
                    return b""
                self.sent = True
                return self.payload

        class FakeProc:
            def __init__(self) -> None:
                line = json.dumps(
                    {
                        "kind": "error",
                        "code": "SOURCE_BLOCKED",
                        "message": "HTTP 403",
                        "retryable": False,
                        "hint": "SoundCloud is blocking requests.",
                        "fix": "diagnostics:sources",
                        "source": "soundcloud",
                    }
                )
                self.stdout = FakeOut((line + "\n").encode())
                self.returncode = 0
                self.pid = 1

            async def wait(self) -> int:
                return 0

        async def fake_exec(*_args: object, **_kwargs: object) -> FakeProc:
            return FakeProc()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                service = await self.service(root, store, client)
                store.update({"destination": str(root)})
                with patch("backend.downloads.asyncio.create_subprocess_exec", fake_exec):
                    for track in (1, 2, 3):
                        job = service.jobs.enqueue(track, "original", str(root))
                        service.jobs.update(
                            job.id,
                            source="youtube",
                            meta=Metadata(id=track, title="x", artist="A").model_dump(),
                        )
                        await service.run(job.id)
                        self.assertEqual(service.jobs.get(job.id).source, "soundcloud")
                self.assertEqual(service.paused_sources(), {"soundcloud"})
                await service.close()
            store.close()

    async def test_a_block_on_one_source_never_pauses_the_other(self) -> None:
        class Blocked(Downloads):
            async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                raise DownloadError("SOURCE_BLOCKED", "The site refused the request")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                service = Blocked(store, Catalog(store, client), library, asyncio.Event())
                store.update({"destination": str(root)})
                for track in (1, 2, 3):
                    job = service.jobs.enqueue(track, "original", str(root))
                    service.jobs.update(
                        job.id,
                        source="soundcloud",
                        meta=Metadata(id=track, title="x", artist="A").model_dump(),
                    )
                    await service.run(job.id)
                self.assertEqual(service.paused_sources(), {"soundcloud"})
                youtube = service.jobs.enqueue(4, "original", str(root))
                service.jobs.update(
                    youtube.id, meta=Metadata(id=4, title="x", artist="A").model_dump()
                )
                await service.run(youtube.id)
                self.assertEqual(service.paused_sources(), {"soundcloud"})
                for track in (5, 6):
                    job = service.jobs.enqueue(track, "original", str(root))
                    service.jobs.update(
                        job.id, meta=Metadata(id=track, title="x", artist="A").model_dump()
                    )
                    await service.run(job.id)
                self.assertEqual(service.paused_sources(), {"soundcloud", "youtube"})
            store.close()

    async def test_picking_a_soundcloud_recording_moves_the_job_to_soundcloud(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                store.update({"destination": str(root)})
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    stage="failed",
                    error_code="NO_MATCH",
                    candidates=[
                        Candidate(id="abcdefghijk", title="A cover", source="youtube").model_dump(),
                        Candidate(
                            id="123456789",
                            title="The song",
                            source="soundcloud",
                            url="https://soundcloud.com/artist/the-song",
                        ).model_dump(),
                    ],
                )
                app = FastAPI()
                install_download_routes(app, lambda: service)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as api:
                    picked = await api.post(
                        f"/api/jobs/{job.id}/pick", json={"candidate_id": "123456789"}
                    )
                    self.assertEqual(picked.status_code, 200)
                    self.assertEqual(picked.json()["source"], "soundcloud")
                    self.assertTrue(picked.json()["hand_picked"])
                    unknown = await api.post(
                        f"/api/jobs/{job.id}/pick", json={"candidate_id": "999999999"}
                    )
                    self.assertEqual(unknown.status_code, 422)
            store.close()


class OverlappedMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def test_lyrics_load_while_the_file_downloads(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            order: list[str] = []

            async def extra(meta: Metadata) -> list[str]:
                order.append("extra-start")
                await asyncio.sleep(0.05)
                meta.lyrics = "the words"
                order.append("extra-end")
                return []

            async def worker(job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                order.append("worker-start")
                self.assertEqual(job.meta.lyrics, "")
                await asyncio.sleep(0.1)
                order.append("worker-end")
                ready = folder / "ready.mp3"
                ready.write_bytes(b"synthetic audio placeholder")
                return ready, {"codec": "mp3", "bitrate": 128}

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(404))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                library.index_published = lambda path, root: None  # type: ignore[method-assign]
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                service.enrichment.extra = extra  # type: ignore[method-assign]
                service.worker = worker  # type: ignore[method-assign]
                store.update({"destination": str(root)})
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=Metadata(
                        id=1,
                        title="Song",
                        artist="Band",
                        album_artist="Band",
                        album="Album",
                        duration=180,
                    ).model_dump(),
                )
                await service.run(job.id)
                done = service.jobs.get(job.id)
                self.assertEqual(done.stage, "done")
                self.assertEqual(done.meta.lyrics, "the words")
                self.assertEqual(order, ["worker-start", "extra-start", "extra-end", "worker-end"])
            store.close()

    def test_catalog_and_side_warnings_still_allow_lyrics(self) -> None:
        job = Job(
            id="job",
            track_id=1,
            target="library",
            created_at=0,
            updated_at=0,
            meta=Metadata(id=1, title="Song", artist="Band"),
            warnings=[CATALOG_DETAILS_WARNING, SIDE_FAILED],
        )
        self.assertTrue(catalog_details_pending(job))
        self.assertTrue(enrichment_pending(job))
        blocked = job.model_copy(
            update={"warnings": ["Optional metadata was not ready before tagging"]}
        )
        self.assertFalse(enrichment_pending(blocked))

    async def test_a_catalog_cooldown_keeps_the_listing_tags(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            seen: list[Job] = []

            async def track(track_id: int) -> Metadata:
                await asyncio.sleep(30)
                return Metadata(
                    id=track_id,
                    title="Song",
                    artist="Band",
                    album_artist="Various Artists",
                    album="Compilation",
                )

            async def extra(meta: Metadata) -> list[str]:
                return []

            async def worker(job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                deadline = time.monotonic() + 2
                while not (folder / "side.json").is_file():
                    if time.monotonic() > deadline:
                        raise AssertionError("side metadata never finished")
                    await asyncio.sleep(0.01)
                seen.append(Job.model_validate_json((folder / "job.json").read_text()))
                ready = folder / "ready.mp3"
                ready.write_bytes(b"synthetic audio placeholder")
                return ready, {"codec": "mp3", "bitrate": 128}

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(404))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                library.index_published = lambda path, root: None  # type: ignore[method-assign]
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                service.enrichment.track = track  # type: ignore[method-assign]
                service.enrichment.extra = extra  # type: ignore[method-assign]
                service.worker = worker  # type: ignore[method-assign]
                store.update({"destination": str(root)})
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=Metadata(
                        id=1, title="Song", artist="Band", album="Compilation", duration=180
                    ).model_dump(),
                )
                started = time.monotonic()
                with patch("backend.downloads.CATALOG_DETAILS_SECONDS", 0.05):
                    await service.run(job.id)
                self.assertLess(time.monotonic() - started, 2)
                done = service.jobs.get(job.id)
                self.assertEqual(done.stage, "done")
                self.assertEqual(done.meta.album_artist, "")
                self.assertIn(CATALOG_DETAILS_WARNING, done.warnings)
                self.assertNotIn(SIDE_FAILED, done.warnings)
                self.assertEqual(seen[0].meta.album_artist, "")
                self.assertIn(CATALOG_DETAILS_WARNING, seen[0].warnings)
                self.assertIn("Unknown", Path(done.final_path).parts)
            store.close()

    async def test_side_work_stops_before_tagging_gives_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            seen: list[Job] = []

            async def extra(meta: Metadata) -> list[str]:
                await asyncio.sleep(30)
                meta.lyrics = "too late"
                return []

            async def worker(job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                deadline = time.monotonic() + 2
                while not (folder / "side.json").is_file():
                    if time.monotonic() > deadline:
                        raise AssertionError("side metadata never finished")
                    await asyncio.sleep(0.01)
                seen.append(Job.model_validate_json((folder / "job.json").read_text()))
                ready = folder / "ready.mp3"
                ready.write_bytes(b"synthetic audio placeholder")
                return ready, {"codec": "mp3", "bitrate": 128}

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(404))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                library.index_published = lambda path, root: None  # type: ignore[method-assign]
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                service.enrichment.extra = extra  # type: ignore[method-assign]
                service.worker = worker  # type: ignore[method-assign]
                store.update({"destination": str(root)})
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=Metadata(
                        id=1,
                        title="Song",
                        artist="Band",
                        album_artist="Band",
                        album="Album",
                        duration=180,
                    ).model_dump(),
                )
                started = time.monotonic()
                with patch("backend.downloads.SIDE_BUDGET_SECONDS", 0.05):
                    await service.run(job.id)
                self.assertLess(time.monotonic() - started, 2)
                done = service.jobs.get(job.id)
                self.assertEqual(done.stage, "done")
                self.assertEqual(done.meta.lyrics, "")
                self.assertEqual(seen[0].meta.lyrics, "")
                self.assertIn(SIDE_FAILED, done.warnings)
                self.assertNotIn("Optional metadata", " ".join(done.warnings))
            store.close()

    async def test_a_later_catalog_response_keeps_lyrics_and_looks_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            calls = {"track": 0, "extra": 0}

            async def track(track_id: int) -> Metadata:
                calls["track"] += 1
                if calls["track"] == 1:
                    raise CatalogError("Deezer is rate limited. Try again shortly.", 429)
                return Metadata(
                    id=track_id,
                    title="Song",
                    artist="Band",
                    album_artist="Various Artists",
                    album="Compilation",
                    genre="Pop",
                    isrc="USABC1234567",
                    duration=180,
                )

            async def extra(meta: Metadata) -> list[str]:
                calls["extra"] += 1
                if calls["extra"] == 1:
                    return ["Lyrics unavailable from LRCLIB"]
                self.assertEqual(meta.album, "Compilation")
                self.assertEqual(meta.isrc, "USABC1234567")
                self.assertEqual(meta.lyrics, "")
                meta.lyrics = "the words"
                return []

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(404))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                service.enrichment.track = track  # type: ignore[method-assign]
                service.enrichment.extra = extra  # type: ignore[method-assign]
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=Metadata(
                        id=1, title="Song", artist="Band", album="Single", duration=180
                    ).model_dump(),
                )
                folder = root / "stage"
                folder.mkdir()
                await service.side_metadata(job.id, folder)
                missed = service.jobs.get(job.id)
                self.assertEqual(missed.meta.album_artist, "")
                self.assertIn(CATALOG_DETAILS_WARNING, missed.warnings)
                self.assertIn("Lyrics unavailable from LRCLIB", missed.warnings)
                await service.side_metadata(job.id, folder)
                found = service.jobs.get(job.id)
                self.assertEqual(found.meta.lyrics, "the words")
                self.assertEqual(found.meta.album_artist, "Various Artists")
                self.assertEqual(found.meta.album, "Compilation")
                self.assertNotIn(CATALOG_DETAILS_WARNING, found.warnings)
                self.assertNotIn("Lyrics unavailable from LRCLIB", found.warnings)
                self.assertEqual(calls, {"track": 2, "extra": 2})
            store.close()

    async def test_cancelling_side_work_leaves_no_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            started = asyncio.Event()

            async def extra(meta: Metadata) -> list[str]:
                started.set()
                await asyncio.sleep(30)
                return []

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(404))
            ) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                service.enrichment.extra = extra  # type: ignore[method-assign]
                job = service.jobs.enqueue(1, "original", str(root))
                service.jobs.update(
                    job.id,
                    meta=Metadata(
                        id=1,
                        title="Song",
                        artist="Band",
                        album_artist="Band",
                        album="Album",
                        duration=180,
                    ).model_dump(),
                )
                folder = root / "stage"
                folder.mkdir()
                task = asyncio.create_task(service.side_metadata(job.id, folder))
                await asyncio.wait_for(started.wait(), 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertFalse((folder / "side.json").is_file())
            store.close()
