"""Opt-in live fixture tests. Each publishes one public-domain recording to the specified root.

    python -m scripts.download_smoke ROOT [--case wikimedia|link|all]

`wikimedia` feeds a downloaded file into the regular resume, tag and publish path. `link` takes
the whole pasted-link road: resolve an Internet Archive item, queue one of its tracks, download it
with the real worker, tag it and index it.
"""

import argparse
import asyncio
import json
import tempfile
import time
from pathlib import Path
from typing import cast

import httpx
import mutagen

from backend.catalog import Catalog
from backend.downloads import Downloads, digest
from backend.job_models import Job, LinkRequest, Metadata
from backend.library import Library
from backend.links import Links
from backend.store import Store
from backend.tagging import probe

SOURCE = "https://upload.wikimedia.org/wikipedia/commons/6/65/Star_Spangled_Banner_instrumental.ogg"
CREDIT = "https://commons.wikimedia.org/wiki/File:Star_Spangled_Banner_instrumental.ogg"

# One item of the Open Goldberg Variations: Bach's Goldberg Variations, released to the public
# domain by the pianist Kimiko Ishizaka. The item lists every track as an MP3 with an Ogg copy.
# The reasons it is safe to use are written out in `source_probe_sites.json`.
ITEM = "https://archive.org/details/The_Open_Goldberg_Variations-11823"
ITEM_CREDIT = "https://www.opengoldbergvariations.org/"
# The shortest track, so the download is under 2 MB.
ITEM_TRACK = "Variatio 4 a 1 Clav."
ITEM_TRACKS = 32
TEMPLATE = "Musimo Integration Test/{album}/{track:02d} - {title}"


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


def prepare(root: Path, directory: str) -> Store:
    if not root.is_dir():
        raise ValueError("Mount an existing test destination")
    store = Store(Path(directory) / "fixture.sqlite3")
    store.update(
        {"destination": str(root), "naming_template": TEMPLATE, "navidrome_mode": "watcher"}
    )
    return store


async def run_queue(service: Downloads, job_id: str) -> Job:
    """Run the queue until the job ends, then stop it and return the job."""
    service.start()
    async with asyncio.timeout(90):
        while service.jobs.get(job_id).stage not in {"done", "failed"}:
            await asyncio.sleep(0.1)
    final = service.jobs.get(job_id)
    await service.close()
    if final.stage != "done":
        raise RuntimeError(final.error_code + ": " + final.error)
    return final


def indexed(store: Store, audio: Path) -> tuple[str, str]:
    with store.lock:
        row = store.db.execute(
            "SELECT title,artist FROM library_files WHERE path=?", (str(audio),)
        ).fetchone()
    assert row, "The published file is not in the library index"
    return row[0], row[1]


async def wikimedia(root: Path) -> dict[str, object]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory() as directory:
        store = prepare(root, directory)
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
            final = await run_queue(service, job.id)
            audio = Path(final.final_path)
            title, _ = indexed(store, audio)
            assert title == final.meta.title
            assert digest(audio) == final.artifact_hash
            result: dict[str, object] = {
                "case": "wikimedia",
                "file": str(audio),
                "sha256": final.artifact_hash,
                "seconds": round(time.monotonic() - started, 3),
                "codec": probe(audio, accurate=True),
                "index_title": title,
                "source": SOURCE,
                "credit": CREDIT,
                "warnings": final.warnings,
            }
        store.close()
    return result


def no_catalog_match(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"data": [], "total": 0})


async def link(root: Path) -> dict[str, object]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory() as directory:
        store = prepare(root, directory)
        # The Deezer tidy-up step is real but answers "no match", so the tags written are the
        # site's own and the check does not depend on what Deezer holds today.
        async with httpx.AsyncClient(transport=httpx.MockTransport(no_catalog_match)) as client:
            library = Library(store, [root], asyncio.Event())
            service = Downloads(store, Catalog(store, client), library, asyncio.Event())
            links = Links(service)
            # Resolve: the real resolver process reads the item from the Internet Archive.
            preview = await links.resolve(ITEM)
            entries = cast(list[dict[str, object]], preview["entries"])
            assert preview["source"] == "archive"
            assert len(entries) == ITEM_TRACKS, f"Expected one entry per track, got {len(entries)}"
            assert len({row["title"] for row in entries}) == ITEM_TRACKS
            track = next(row for row in entries if row["title"] == ITEM_TRACK)
            # Queue: only the ticked entry, from the saved preview.
            queued = links.enqueue(
                LinkRequest(
                    token=str(preview["token"]), entry_ids=[str(track["id"])], format="original"
                )
            )
            jobs = cast(list[dict[str, object]], queued["jobs"])
            assert len(jobs) == 1
            # Download, tag and publish: the real worker, then the normal finish.
            final = await run_queue(service, str(jobs[0]["id"]))
            audio = Path(final.final_path)
            tags = mutagen.File(audio, easy=True)
            assert tags is not None and tags.tags is not None
            # Tag: the item's creator, title and date, and the track's place in the item.
            assert tags.tags["title"] == [ITEM_TRACK]
            assert tags.tags["artist"] == ["Kimiko Ishizaka"]
            assert tags.tags["album"] == ["The Open Goldberg Variations"]
            assert tags.tags["date"] == ["2012-05-29"]
            assert tags.tags["tracknumber"] == [f"5/{ITEM_TRACKS}"]
            # Index: the library sees the file under those tags.
            title, artist = indexed(store, audio)
            assert (title, artist) == (ITEM_TRACK, "Kimiko Ishizaka")
            assert digest(audio) == final.artifact_hash
            result: dict[str, object] = {
                "case": "link",
                "file": str(audio),
                "sha256": final.artifact_hash,
                "seconds": round(time.monotonic() - started, 3),
                "codec": probe(audio, accurate=True),
                "index_title": title,
                "entries": len(entries),
                "source": ITEM,
                "credit": ITEM_CREDIT,
                "notes": final.notes,
                "warnings": final.warnings,
            }
        store.close()
    return result


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", type=Path, help="an existing, dedicated, writable test root")
    parser.add_argument("--case", choices=["wikimedia", "link", "all"], default="all")
    args = parser.parse_args()
    root = args.root.resolve()
    cases = {"wikimedia": wikimedia, "link": link}
    for name in cases if args.case == "all" else [args.case]:
        print(json.dumps(await cases[name](root)), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
