"""Opt-in live fixture test. Publishes one public-domain recording to the specified root."""

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

import httpx

from backend.catalog import Catalog
from backend.downloads import Downloads, digest
from backend.job_models import Job, Metadata
from backend.library import Library
from backend.store import Store
from backend.tagging import probe

SOURCE = "https://upload.wikimedia.org/wikipedia/commons/6/65/Star_Spangled_Banner_instrumental.ogg"
CREDIT = "https://commons.wikimedia.org/wiki/File:Star_Spangled_Banner_instrumental.ogg"


class FixtureDownload(Downloads):
    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        # Feed a verified completed transport artifact into the normal resume/tag/publish path.
        self.jobs.update(job.id, stage="downloading")
        async with self.catalog.client.stream("GET", SOURCE, timeout=30) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length", 0))
            downloaded = 0
            with (folder / "source.ogg").open("wb") as stream:
                async for chunk in response.aiter_bytes():
                    stream.write(chunk)
                    downloaded += len(chunk)
                    self.jobs.update(job.id, downloaded=downloaded, total=total)
        (folder / "download.json").write_text(
            json.dumps({"selected": "", "file": "source.ogg"}), encoding="utf-8"
        )
        return await super().worker(job, folder)


async def main() -> None:
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        raise ValueError("Mount an existing test destination")
    started = time.monotonic()
    with tempfile.TemporaryDirectory() as directory:
        store = Store(Path(directory) / "fixture.sqlite3")
        store.update(
            {
                "destination": str(root),
                "naming_template": "Musimo Integration Test/{album}/{track:02d} - {title}",
                "navidrome_mode": "watcher",
            }
        )
        async with httpx.AsyncClient(
            headers={"User-Agent": "Musimo integration fixture (https://github.com/LeahyCC)"}
        ) as client:
            library = Library(store, [root], asyncio.Event())
            service = FixtureDownload(store, Catalog(store, client), library, asyncio.Event())
            job = service.jobs.enqueue(1, "original", str(root))
            service.jobs.update(
                job.id,
                meta=Metadata(
                    id=1,
                    title="The Star-Spangled Banner",
                    artist="United States Navy Band",
                    album_artist="United States Navy Band",
                    album="Public domain smoke " + job.id[:8],
                    duration=78,
                    genre="Instrumental",
                ).model_dump(),
            )
            service.start()
            async with asyncio.timeout(90):
                while service.jobs.get(job.id).stage not in {"done", "failed"}:
                    await asyncio.sleep(0.1)
            final = service.jobs.get(job.id)
            await service.close()
            if final.stage != "done":
                raise RuntimeError(final.error_code + ": " + final.error)
            audio = Path(final.final_path)
            with store.lock:
                indexed = store.db.execute(
                    "SELECT title,artist FROM library_files WHERE path=?", (str(audio),)
                ).fetchone()
            assert indexed and indexed[0] == final.meta.title
            assert digest(audio) == final.artifact_hash
            print(
                json.dumps(
                    {
                        "file": str(audio),
                        "sha256": final.artifact_hash,
                        "seconds": round(time.monotonic() - started, 3),
                        "codec": probe(audio, accurate=True),
                        "index_title": indexed[0],
                        "source": SOURCE,
                        "credit": CREDIT,
                        "warnings": final.warnings,
                    }
                ),
                flush=True,
            )
        store.close()


if __name__ == "__main__":
    asyncio.run(main())
