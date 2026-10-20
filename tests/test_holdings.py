"""A holding points a Deezer track at a file this install already has."""

import asyncio
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.api.download_api import install_download_routes
from backend.core.store import SCHEMA_VERSION, Store
from backend.integrations.catalog import Catalog, Result
from backend.jobs.downloads import Downloads, digest
from backend.jobs.holdings import HoldingMismatch, save_holding
from backend.jobs.job_store import Jobs
from backend.library.index import Library


def index_file(
    store: Store,
    root: Path,
    name: str,
    song_id: str,
    *,
    body: bytes = b"house",
    title: str = "Song",
    artist: str = "Artist",
    album: str = "Album",
    isrc: str = "",
    duration: float = 180,
) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    store.db.execute(
        "INSERT INTO library_files ("
        "path, root, mtime_ns, size, generation, title, artist, album, "
        "title_key, artist_key, album_key, duration, isrc, mbid, song_id"
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            str(path),
            str(root),
            1,
            len(body),
            "test",
            title,
            artist,
            album,
            title.lower(),
            artist.lower(),
            album.lower(),
            duration,
            isrc,
            "",
            song_id,
        ),
    )
    return path


def mark_done(
    jobs: Jobs, track_id: int, path: Path, root: Path, created_at: float, checksum: str = ""
) -> str:
    job = jobs.enqueue(track_id, "original", str(root))
    jobs.update(job.id, stage="done", final_path=str(path), artifact_hash=checksum)
    jobs.store.db.execute("UPDATE jobs SET created_at=? WHERE id=?", (created_at, job.id))
    return job.id


class SchemaTests(unittest.TestCase):
    def test_version_13_gains_holdings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "db.sqlite3"
            store = Store(path)
            store.db.execute("DROP TABLE holdings")
            store.db.execute("PRAGMA user_version=13")
            store.close()
            store = Store(path)
            try:
                version = store.db.execute("PRAGMA user_version").fetchone()[0]
                self.assertEqual((version, SCHEMA_VERSION), (15, 15))
                columns = [str(row[1]) for row in store.db.execute("PRAGMA table_info(holdings)")]
                self.assertEqual(
                    columns, ["id", "catalog", "track_id", "song_id", "path", "reason", "created"]
                )
            finally:
                store.close()


class HoldingTests(unittest.IsolatedAsyncioTestCase):
    async def test_certain_catalog_reuses_the_house_file_for_any_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                Library(store, [root], asyncio.Event())
                house = index_file(store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa", body=b"keep")
                jobs = Jobs(store, lambda: None)
                done_id = mark_done(jobs, 7, house, root, 10)
                other = root / "elsewhere"
                other.mkdir()
                again = jobs.enqueue(7, "mp3", str(other))
                self.assertEqual(again.id, done_id)
                self.assertEqual(again.stage, "done")
                self.assertEqual(store.db.execute("SELECT count(*) FROM jobs").fetchone()[0], 1)
                self.assertEqual(list(other.iterdir()), [])
                self.assertEqual(house.read_bytes(), b"keep")
                same = jobs.enqueue(7, "original", str(root))
                self.assertEqual(same.id, done_id)
                rows = store.db.execute("SELECT reason, song_id, path FROM holdings").fetchall()
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["reason"], "catalog")
                self.assertEqual(rows[0]["song_id"], "tr-aaaaaaaaaaaaaaaa")
                self.assertEqual(rows[0]["path"], str(house))
                self.assertEqual(house.read_bytes(), b"keep")
            finally:
                store.close()

    async def test_a_missing_file_is_downloaded_again(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                Library(store, [root], asyncio.Event())
                house = index_file(store, root, "gone.flac", "tr-aaaaaaaaaaaaaaaa")
                jobs = Jobs(store, lambda: None)
                done_id = mark_done(jobs, 7, house, root, 10)
                house.unlink()
                fresh = jobs.enqueue(7, "original", str(root))
                self.assertNotEqual(fresh.id, done_id)
                self.assertEqual(fresh.stage, "queued")
                self.assertEqual(store.db.execute("SELECT count(*) FROM jobs").fetchone()[0], 2)
                self.assertEqual(store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 0)
            finally:
                store.close()

    async def test_replace_match_downloads_even_when_the_file_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                Library(store, [root], asyncio.Event())
                house = index_file(store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa", body=b"keep")
                jobs = Jobs(store, lambda: None)
                done_id = mark_done(jobs, 7, house, root, 10)
                fresh = jobs.enqueue(7, "original", str(root), replace_match=True)
                self.assertNotEqual(fresh.id, done_id)
                self.assertEqual(fresh.stage, "queued")
                self.assertEqual(store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 0)
                self.assertEqual(house.read_bytes(), b"keep")
            finally:
                store.close()

    async def test_equal_bytes_reuse_the_oldest_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                body = b"same-bytes"
                oldest = index_file(store, root, "oldest.flac", "tr-aaaaaaaaaaaaaaaa", body=body)
                newer = index_file(store, root, "newer.flac", "tr-bbbbbbbbbbbbbbbb", body=body)
                checksum = digest(oldest)
                async with httpx.AsyncClient() as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    mark_done(service.jobs, 1, oldest, root, 1, checksum)
                    mark_done(service.jobs, 2, newer, root, 2, checksum)
                    job = service.jobs.enqueue(9, "original", str(root))
                    ready = root / ".musimo" / job.id / "ready.flac"
                    ready.parent.mkdir(parents=True)
                    ready.write_bytes(body)
                    await service.finish(service.jobs.get(job.id), ready)
                    done = service.jobs.get(job.id)
                    self.assertEqual(done.stage, "done")
                    self.assertEqual(done.final_path, str(oldest))
                    self.assertEqual(done.artifact_hash, checksum)
                    self.assertFalse(ready.exists())
                    self.assertEqual(oldest.read_bytes(), body)
                    self.assertEqual(newer.read_bytes(), body)
                    self.assertFalse((root / service.layout(done, "flac")).exists())
                    rows = store.db.execute(
                        "SELECT reason, song_id, path, track_id FROM holdings"
                    ).fetchall()
                    self.assertEqual(len(rows), 1)
                    self.assertEqual(rows[0]["reason"], "bytes")
                    self.assertEqual(rows[0]["track_id"], 9)
                    self.assertEqual(rows[0]["song_id"], "tr-aaaaaaaaaaaaaaaa")
                    self.assertEqual(rows[0]["path"], str(oldest))
                    self.assertTrue(done.reused_file)
            finally:
                store.close()

    async def test_byte_match_recovery_leaves_the_house_folder_alone(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                body = b"same-bytes"
                house = index_file(store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa", body=body)
                checksum = digest(house)
                indexed: list[Path] = []
                library.index_published = lambda path, root: indexed.append(path)  # type: ignore[method-assign]
                async with httpx.AsyncClient() as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    mark_done(service.jobs, 1, house, root, 1, checksum)
                    job = service.jobs.enqueue(9, "original", str(root))
                    ready = root / ".musimo" / job.id / "ready.flac"
                    ready.parent.mkdir(parents=True)
                    ready.write_bytes(body)
                    (ready.parent / "cover.jpg").write_bytes(b"cover")
                    (ready.parent / "ready.lrc").write_text("lyric", encoding="utf-8")
                    await service.finish(service.jobs.get(job.id), ready)
                    self.assertTrue(service.jobs.get(job.id).reused_file)
                    self.assertFalse((house.parent / "cover.jpg").exists())
                    self.assertFalse(house.with_suffix(".lrc").exists())
                    self.assertEqual(indexed, [])
                    # A crash or cancel after the path was stored calls finish with no staged audio.
                    service.jobs.update(job.id, stage="scanning", desired="run")
                    folder = root / ".musimo" / job.id
                    folder.mkdir(parents=True)
                    (folder / "cover.jpg").write_bytes(b"cover")
                    (folder / "ready.lrc").write_text("lyric", encoding="utf-8")
                    await service.finish(service.jobs.get(job.id))
                    recovered = service.jobs.get(job.id)
                    self.assertEqual(recovered.stage, "done")
                    self.assertEqual(recovered.final_path, str(house))
                    self.assertEqual(house.read_bytes(), body)
                    self.assertFalse((house.parent / "cover.jpg").exists())
                    self.assertFalse(house.with_suffix(".lrc").exists())
                    self.assertEqual(indexed, [])
            finally:
                store.close()

    async def test_restart_still_publishes_sidecars_for_this_jobs_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                house = index_file(store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa")
                library.index_published = lambda path, root: None  # type: ignore[method-assign]
                async with httpx.AsyncClient() as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    job = service.jobs.enqueue(9, "original", str(root))
                    service.jobs.update(
                        job.id,
                        stage="scanning",
                        final_path=str(house),
                        artifact_hash=digest(house),
                    )
                    folder = root / ".musimo" / job.id
                    folder.mkdir(parents=True)
                    (folder / "cover.jpg").write_bytes(b"cover")
                    (folder / "ready.lrc").write_text("lyric", encoding="utf-8")
                    await service.finish(service.jobs.get(job.id))
                    self.assertEqual((house.parent / "cover.jpg").read_bytes(), b"cover")
                    self.assertEqual(house.with_suffix(".lrc").read_text(encoding="utf-8"), "lyric")
                    self.assertEqual(house.read_bytes(), b"house")
            finally:
                store.close()

    async def test_different_bytes_publish_beside_an_existing_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                library.index_published = lambda path, root: None  # type: ignore[method-assign]
                house = index_file(store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa", body=b"house")
                async with httpx.AsyncClient() as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    mark_done(service.jobs, 1, house, root, 1, digest(house))
                    job = service.jobs.enqueue(9, "original", str(root))
                    ready = root / ".musimo" / job.id / "ready.flac"
                    ready.parent.mkdir(parents=True)
                    ready.write_bytes(b"new-bytes")
                    current = service.jobs.get(job.id)
                    occupied = root / service.layout(current, "flac")
                    occupied.parent.mkdir(parents=True, exist_ok=True)
                    occupied.write_bytes(b"occupied")
                    await service.finish(current, ready)
                    done = service.jobs.get(job.id)
                    self.assertEqual(done.stage, "done")
                    self.assertIn(job.id[:8], Path(done.final_path).name)
                    self.assertNotEqual(done.final_path, str(occupied))
                    self.assertEqual(occupied.read_bytes(), b"occupied")
                    self.assertEqual(house.read_bytes(), b"house")
                    self.assertEqual(Path(done.final_path).read_bytes(), b"new-bytes")
                    self.assertFalse(ready.exists())
                    self.assertEqual(
                        store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 0
                    )
            finally:
                store.close()

    async def test_chosen_holding_accepts_a_tag_match_on_another_album(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                house = index_file(
                    store,
                    root,
                    "deluxe.flac",
                    "tr-aaaaaaaaaaaaaaaa",
                    body=b"keep",
                    album="Deluxe",
                )
                item = Result(
                    id=12,
                    kind="track",
                    title="Song",
                    artist="Artist",
                    album="Album",
                    duration=180,
                )
                library.annotate([item])
                self.assertEqual(item.ownership, "edition")
                self.assertEqual(item.matched_by, "tags")
                self.assertEqual(item.matched_song, "tr-aaaaaaaaaaaaaaaa")

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/track/12":
                        return httpx.Response(
                            200,
                            json={
                                "id": 12,
                                "title": "Song",
                                "duration": 180,
                                "isrc": "",
                                "artist": {"id": 1, "name": "Artist"},
                                "album": {"id": 2, "title": "Album"},
                            },
                        )
                    return httpx.Response(404)

                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        accepted = await api.post(
                            "/api/holdings",
                            json={"track_id": 12, "song_id": "tr-aaaaaaaaaaaaaaaa"},
                        )
                        self.assertEqual(accepted.status_code, 200)
                        self.assertEqual(accepted.json()["reason"], "chosen")
                        self.assertEqual(accepted.json()["path"], str(house))
                        self.assertEqual(house.read_bytes(), b"keep")
            finally:
                store.close()

    async def test_chosen_holding_accepts_an_isrc_and_leaves_with_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:

                def track(track_id: int, isrc: str) -> dict[str, object]:
                    return {
                        "id": track_id,
                        "title": f"Track {track_id}",
                        "duration": 180,
                        "isrc": isrc,
                        "artist": {"id": 1, "name": "Artist"},
                        "album": {"id": 2, "title": "Album"},
                    }

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/track/10":
                        return httpx.Response(200, json=track(10, "USFIX2600010"))
                    if request.url.path == "/track/11":
                        return httpx.Response(200, json=track(11, "USFIX2600011"))
                    return httpx.Response(404)

                library = Library(store, [root], asyncio.Event())
                good = index_file(
                    store,
                    root,
                    "good.flac",
                    "tr-aaaaaaaaaaaaaaaa",
                    body=b"keep",
                    isrc="USFIX2600010",
                )
                other = index_file(
                    store,
                    root,
                    "other.flac",
                    "tr-bbbbbbbbbbbbbbbb",
                    body=b"other",
                    isrc="USFIX2600099",
                )
                link = root / "link.flac"
                symlink_refused = ""
                try:
                    os.symlink(good, link)
                except OSError as exc:
                    symlink_refused = str(exc)
                else:
                    store.db.execute(
                        "INSERT INTO library_files ("
                        "path, root, mtime_ns, size, generation, title, artist, album, "
                        "title_key, artist_key, album_key, duration, isrc, mbid, song_id"
                        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            str(link),
                            str(root),
                            1,
                            4,
                            "test",
                            "Link",
                            "Artist",
                            "Album",
                            "link",
                            "artist",
                            "album",
                            180,
                            "USFIX2600011",
                            "",
                            "tr-dddddddddddddddd",
                        ),
                    )
                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        accepted = await api.post(
                            "/api/holdings",
                            json={"track_id": 10, "song_id": "tr-aaaaaaaaaaaaaaaa"},
                        )
                        self.assertEqual(accepted.status_code, 200)
                        body = accepted.json()
                        self.assertEqual(body["reason"], "chosen")
                        self.assertEqual(body["catalog"], "deezer")
                        self.assertEqual(body["track_id"], 10)
                        self.assertEqual(body["song_id"], "tr-aaaaaaaaaaaaaaaa")
                        self.assertEqual(body["path"], str(good))
                        self.assertTrue(str(body["id"]).startswith("hd-"))
                        self.assertEqual(len(str(body["id"])), 19)
                        self.assertIn("T", body["created"])
                        self.assertTrue(str(body["created"]).endswith("Z"))
                        again = await api.post(
                            "/api/holdings",
                            json={"track_id": 10, "song_id": "tr-aaaaaaaaaaaaaaaa"},
                        )
                        self.assertEqual(again.status_code, 200)
                        self.assertEqual(again.json()["id"], body["id"])
                        unknown = await api.post(
                            "/api/holdings",
                            json={"track_id": 10, "song_id": "tr-cccccccccccccccc"},
                        )
                        self.assertEqual(unknown.status_code, 422)
                        self.assertEqual(
                            unknown.json()["detail"], "That song does not match this track."
                        )
                        with ExitStack() as stack:
                            if symlink_refused:
                                link.write_bytes(b"link")
                                store.db.execute(
                                    "INSERT INTO library_files ("
                                    "path, root, mtime_ns, size, generation, title, artist, album, "
                                    "title_key, artist_key, album_key, duration, isrc, mbid, "
                                    "song_id"
                                    ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (
                                        str(link),
                                        str(root),
                                        1,
                                        4,
                                        "test",
                                        "Link",
                                        "Artist",
                                        "Album",
                                        "link",
                                        "artist",
                                        "album",
                                        180,
                                        "USFIX2600011",
                                        "",
                                        "tr-dddddddddddddddd",
                                    ),
                                )
                                stack.enter_context(
                                    patch(
                                        "backend.api.download_api.Path.is_symlink",
                                        return_value=True,
                                    )
                                )
                            linked = await api.post(
                                "/api/holdings",
                                json={"track_id": 11, "song_id": "tr-dddddddddddddddd"},
                            )
                        self.assertEqual(linked.status_code, 422, symlink_refused)
                        self.assertEqual(
                            linked.json()["detail"],
                            "That file is a link, not a library copy.",
                        )
                        mismatch = await api.post(
                            "/api/holdings",
                            json={"track_id": 10, "song_id": "tr-bbbbbbbbbbbbbbbb"},
                        )
                        self.assertEqual(mismatch.status_code, 422)
                        self.assertEqual(
                            mismatch.json()["detail"], "That song does not match this track."
                        )
                        self.assertEqual(
                            store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 1
                        )
                        self.assertEqual(good.read_bytes(), b"keep")
                        self.assertEqual(other.read_bytes(), b"other")
                        library.remove(str(good))
                        self.assertEqual(
                            store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 0
                        )
                        queued = service.jobs.enqueue(10, "original", str(root))
                        self.assertEqual(queued.stage, "queued")
                        self.assertEqual(
                            store.db.execute("SELECT count(*) FROM jobs").fetchone()[0], 1
                        )
            finally:
                store.close()

    async def test_a_live_holding_beats_isrc_and_a_stale_one_is_dropped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                house = index_file(
                    store, root, "house.flac", "tr-aaaaaaaaaaaaaaaa", isrc="USFIX2600077"
                )
                store.db.execute(
                    "INSERT INTO holdings VALUES (?,?,?,?,?,?,?)",
                    (
                        "hd-1111111111111111",
                        "deezer",
                        7,
                        "tr-aaaaaaaaaaaaaaaa",
                        str(house),
                        "chosen",
                        "2026-01-01T00:00:00.000000Z",
                    ),
                )
                store.db.execute(
                    "INSERT INTO holdings VALUES (?,?,?,?,?,?,?)",
                    (
                        "hd-2222222222222222",
                        "deezer",
                        8,
                        "tr-bbbbbbbbbbbbbbbb",
                        str(root / "missing.flac"),
                        "chosen",
                        "2026-01-01T00:00:00.000000Z",
                    ),
                )
                live = Result(
                    id=7,
                    kind="track",
                    title="Elsewhere",
                    artist="Someone",
                    duration=10,
                    isrc="USFIX2600077",
                )
                stale = Result(
                    id=8,
                    kind="track",
                    title="Song",
                    artist="Artist",
                    duration=180,
                    isrc="USFIX2600077",
                )
                library.annotate([live, stale])
                self.assertEqual(live.matched_by, "holding")
                self.assertEqual(live.ownership, "owned")
                self.assertEqual(live.matched_song, "tr-aaaaaaaaaaaaaaaa")
                self.assertEqual(live.matched_paths, [str(house)])
                self.assertEqual(live.matched_album, "")
                self.assertEqual(stale.matched_by, "isrc")
                left = [str(row[0]) for row in store.db.execute("SELECT id FROM holdings")]
                self.assertEqual(left, ["hd-1111111111111111"])
            finally:
                store.close()

    async def test_album_batch_skips_a_catalog_match_and_counts_an_isrc_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/album/50":
                        return httpx.Response(
                            200,
                            json={
                                "id": 50,
                                "title": "Batch",
                                "nb_tracks": 3,
                                "artist": {"id": 1, "name": "Artist"},
                                "tracks": {
                                    "data": [
                                        {
                                            "id": 1,
                                            "title": "Owned",
                                            "duration": 180,
                                            "artist": {"id": 1, "name": "Artist"},
                                        },
                                        {
                                            "id": 2,
                                            "title": "Asked",
                                            "duration": 180,
                                            "isrc": "USFIX2600002",
                                            "artist": {"id": 1, "name": "Artist"},
                                        },
                                        {
                                            "id": 3,
                                            "title": "Missing",
                                            "duration": 180,
                                            "artist": {"id": 1, "name": "Artist"},
                                        },
                                    ]
                                },
                            },
                        )
                    return httpx.Response(404)

                library = Library(store, [root], asyncio.Event())
                house = index_file(store, root, "owned.flac", "tr-aaaaaaaaaaaaaaaa", title="Owned")
                index_file(
                    store,
                    root,
                    "asked.flac",
                    "tr-bbbbbbbbbbbbbbbb",
                    title="Something else",
                    isrc="USFIX2600002",
                )
                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    store.update({"destination": str(root)})
                    mark_done(service.jobs, 1, house, root, 5)
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        response = await api.post("/api/batches", json={"album_id": 50})
                        self.assertEqual(response.status_code, 200)
                        payload = response.json()
                        self.assertEqual(payload["skipped_owned"], 1)
                        self.assertEqual(payload["needs_choice"], 1)
                        self.assertEqual([job["track_id"] for job in payload["jobs"]], [3])
            finally:
                store.close()

    def test_a_second_song_does_not_take_the_holding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                first = save_holding(
                    store, 10, "tr-aaaaaaaaaaaaaaaa", str(root / "a.flac"), "chosen"
                )
                with self.assertRaises(HoldingMismatch):
                    save_holding(store, 10, "tr-bbbbbbbbbbbbbbbb", str(root / "b.flac"), "bytes")
                self.assertEqual(
                    store.db.execute("SELECT song_id FROM holdings WHERE track_id=10").fetchone()[
                        0
                    ],
                    "tr-aaaaaaaaaaaaaaaa",
                )
                again = save_holding(
                    store, 10, "tr-aaaaaaaaaaaaaaaa", str(root / "a.flac"), "chosen"
                )
                self.assertEqual(again["id"], first["id"])
                self.assertEqual(store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 1)
            finally:
                store.close()

    async def test_a_choice_that_loses_the_race_stays_on_the_first_song(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/track/10":
                        return httpx.Response(
                            200,
                            json={
                                "id": 10,
                                "title": "Track 10",
                                "duration": 180,
                                "isrc": "USFIX2600010",
                                "artist": {"id": 1, "name": "Artist"},
                                "album": {"id": 2, "title": "Album"},
                            },
                        )
                    return httpx.Response(404)

                library = Library(store, [root], asyncio.Event())
                index_file(
                    store,
                    root,
                    "good.flac",
                    "tr-aaaaaaaaaaaaaaaa",
                    body=b"keep",
                    isrc="USFIX2600010",
                )
                other = index_file(
                    store,
                    root,
                    "other.flac",
                    "tr-bbbbbbbbbbbbbbbb",
                    body=b"other",
                    isrc="USFIX2600010",
                )
                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        accepted = await api.post(
                            "/api/holdings",
                            json={"track_id": 10, "song_id": "tr-aaaaaaaaaaaaaaaa"},
                        )
                        self.assertEqual(accepted.status_code, 200)
                        with (
                            patch("backend.api.download_api.indexed_holding", return_value=None),
                            patch("backend.library.index.refresh_holdings", return_value={}),
                        ):
                            raced = await api.post(
                                "/api/holdings",
                                json={"track_id": 10, "song_id": "tr-bbbbbbbbbbbbbbbb"},
                            )
                        self.assertEqual(raced.status_code, 422)
                        self.assertEqual(
                            raced.json()["detail"], "That song does not match this track."
                        )
                        self.assertEqual(
                            store.db.execute("SELECT song_id FROM holdings").fetchone()[0],
                            "tr-aaaaaaaaaaaaaaaa",
                        )
                        self.assertEqual(other.read_bytes(), b"other")
            finally:
                store.close()
