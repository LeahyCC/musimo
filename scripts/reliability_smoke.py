"""Exercise a 12-track batch with generated audio and real worker processes, without providers."""

import argparse
import asyncio
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
import mutagen
from fastapi import FastAPI

from backend.catalog import Catalog
from backend.download_api import install_download_routes
from backend.downloads import DownloadError, Downloads, digest
from backend.job_models import Job, Metadata
from backend.library import Library
from backend.store import Store


class FixtureDownloads(Downloads):
    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        if job.track_id == 3 and job.attempts == 1:
            raise DownloadError("TIMEOUT", "Injected transient transport failure", True)
        source = Path(job.target).parent / "fixture.opus"
        shutil.copyfile(source, folder / "source.opus")
        (folder / "download.json").write_text(
            json.dumps({"selected": job.selected, "file": "source.opus"}), encoding="utf-8"
        )
        return await super().worker(job, folder)


async def run() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="musimo-batch-") as directory:
        root = Path(directory).resolve()
        music = root / "music"
        music.mkdir()
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
                str(root / "fixture.opus"),
            ],
            check=True,
            capture_output=True,
        )
        tracks = [
            {
                "id": n,
                "title": f"Fixture {n:02d}",
                "duration": 1,
                "artist": {"id": 1, "name": "Generated Artist"},
            }
            for n in range(1, 13)
        ]

        def upstream(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/album/1", str(request.url)
            return httpx.Response(
                200,
                json={
                    "id": 1,
                    "title": "Generated Album",
                    "nb_tracks": 12,
                    "artist": {"id": 1, "name": "Generated Artist"},
                    "tracks": {"data": tracks},
                },
            )

        store = Store(root / "test.sqlite3")
        store.update({"destination": str(music), "concurrency": 3, "retry_base_seconds": 1})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            service = FixtureDownloads(
                store,
                Catalog(store, client),
                Library(store, [music], asyncio.Event()),
                asyncio.Event(),
            )
            app = FastAPI()
            install_download_routes(app, lambda: service)
            report: dict[str, object] = {
                "fixture": "One-second generated tone, 12 distinct track tags, original Opus",
                "concurrency": 3,
                "provider_downloads": False,
            }
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as api:
                    first = await api.post("/api/batches", json={"album_id": 1})
                    first.raise_for_status()
                    duplicate = await api.post("/api/batches", json={"album_id": 1})
                    duplicate.raise_for_status()
                    assert {row["id"] for row in first.json()["jobs"]} == {
                        row["id"] for row in duplicate.json()["jobs"]
                    }
                    assert len(service.jobs.list()) == 12
                    for job in service.jobs.list():
                        service.jobs.update(
                            job.id,
                            meta=Metadata(
                                id=job.track_id,
                                title=f"Fixture {job.track_id:02d}",
                                artist="Generated Artist",
                                album_artist="Generated Artist",
                                album="Generated Album",
                                track=job.track_id,
                                tracks=12,
                                duration=1,
                            ).model_dump(),
                        )
                    service.start()
                    async with asyncio.timeout(10):
                        while not service.processes:
                            await asyncio.sleep(0.005)
                    processes = list(service.processes.values())
                    started = time.perf_counter()
                    (await api.post("/api/queue/pause")).raise_for_status()
                    report["pause_ack_ms"] = round((time.perf_counter() - started) * 1000, 2)
                    async with asyncio.timeout(5):
                        while any(row.stage != "paused" for row in service.jobs.list()):
                            await asyncio.sleep(0.005)
                    report["pause_settled_ms"] = round((time.perf_counter() - started) * 1000, 2)
                    assert all(process.returncode is not None for process in processes)
                    await service.close()
                    store.close()
                    store = Store(root / "test.sqlite3")
                    service = FixtureDownloads(
                        store,
                        Catalog(store, client),
                        Library(store, [music], asyncio.Event()),
                        asyncio.Event(),
                    )
                    service.start()
                    assert service.controls()["paused"]
                    assert all(row.stage == "paused" for row in service.jobs.list())
                    report["paused_state_survived_reopen"] = True
                    started = time.perf_counter()
                    (await api.post("/api/queue/resume")).raise_for_status()
                    async with asyncio.timeout(90):
                        while any(row.stage != "done" for row in service.jobs.list()):
                            failed = [row for row in service.jobs.list() if row.stage == "failed"]
                            assert not failed, [(row.error_code, row.error) for row in failed]
                            await asyncio.sleep(0.02)
                    report["resumed_batch_seconds"] = round(time.perf_counter() - started, 3)
                    jobs = service.jobs.list()
                    assert len({row.final_path for row in jobs}) == 12
                    for job in jobs:
                        path = Path(job.final_path)
                        audio = mutagen.File(path, easy=True)
                        assert audio is not None and audio["title"] == [job.meta.title]
                        assert digest(path) == job.artifact_hash
                        assert not service.folder(job).exists()
                    assert service.library.status()["total_files"] == 12
                    assert next(job for job in jobs if job.track_id == 3).attempts >= 2
                    done_again = await api.post("/api/batches", json={"album_id": 1})
                    done_again.raise_for_status()
                    assert done_again.json()["jobs"] == [] and done_again.json()["skipped"] == 12
                    assert len(service.jobs.list()) == 12
                    report.update(
                        completed=12,
                        indexed=12,
                        duplicate_files=0,
                        transient_retry_recovered=True,
                        completed_batch_skipped=True,
                    )
            finally:
                await service.close()
                store.close()
            return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = asyncio.run(run())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
