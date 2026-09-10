import asyncio
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

from backend.catalog import Catalog
from backend.download_api import install_download_routes
from backend.downloads import DownloadError, Downloads, digest, publish_file
from backend.job_models import Candidate, Job, Metadata
from backend.job_store import JobConflict, Jobs
from backend.library import Library
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
