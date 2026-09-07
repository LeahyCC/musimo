import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi import FastAPI

from backend.artist_downloads import install_artist_download_routes
from backend.catalog import Catalog, Result
from backend.download_api import install_download_routes
from backend.downloads import Downloads
from backend.library import Library
from backend.search_api import install_search_routes
from backend.store import Store


class ArtistDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_identity_blocks_duplicates_and_allows_match_correction(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as source:
                library = Library(store, [root], asyncio.Event())
                downloads = Downloads(store, Catalog(store, source), library, asyncio.Event())
                saved = root / "saved.opus"
                saved.write_bytes(b"existing user audio")
                job = downloads.jobs.enqueue(77, "original", str(root))
                downloads.jobs.update(job.id, stage="done", final_path=str(saved))
                store.db.execute(
                    "INSERT INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        str(saved),
                        str(root),
                        1,
                        1,
                        "fixture",
                        "Different title",
                        "Artist",
                        "Album",
                        "different title",
                        "artist",
                        "album",
                        200,
                        "USFIX2600077",
                        "",
                    ),
                )
                # Album listings may omit ISRC and differ from the acquired audio duration.
                result = Result(
                    id=77, kind="track", title="Catalog title", artist="Artist", duration=180
                )
                self.assertEqual(library.annotate([result])[0].ownership, "owned")
                self.assertEqual(downloads.jobs.enqueue(77, "original", str(root)).id, job.id)
                conflict = result.model_copy(update={"isrc": "USOTHER00001"})
                self.assertEqual(library.annotate([conflict])[0].ownership, "missing")
                store.db.execute("UPDATE library_roots SET enabled=0")
                self.assertEqual(library.annotate([result])[0].ownership, "missing")
                correction = downloads.jobs.enqueue(77, "original", str(root), replace_match=True)
                self.assertNotEqual(correction.id, job.id)
                self.assertEqual(saved.read_bytes(), b"existing user audio")
                downloads.jobs.update(correction.id, stage="cancelled")
                saved.unlink()
                reacquire = downloads.jobs.enqueue(77, "original", str(root))
                self.assertNotEqual(reacquire.id, job.id)
            store.close()

    async def test_full_plan_counts_skip_owned_queued_and_duplicates_then_enqueue_atomically(
        self,
    ) -> None:
        requests: list[str] = []

        def track(track_id: int) -> dict[str, object]:
            return {
                "id": track_id,
                "title": f"Song {track_id}",
                "artist": {"id": 7, "name": "Artist"},
                "duration": 180,
                "isrc": f"USFIX260000{track_id}",
            }

        def album(album_id: int) -> dict[str, object]:
            return {
                "id": album_id,
                "title": f"Album {album_id}",
                "record_type": "album",
                "release_date": "2026-01-01",
            }

        def upstream(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            if request.url.path == "/artist/7":
                return httpx.Response(200, json={"id": 7, "name": "Artist"})
            if request.url.path == "/artist/7/albums":
                if request.url.params.get("index") == "0":
                    singles = [
                        {"id": n + 100, "title": "Single", "record_type": "single"}
                        for n in range(49)
                    ]
                    return httpx.Response(
                        200, json={"data": [album(1), *singles], "next": "ignored-provider-url"}
                    )
                return httpx.Response(200, json={"data": [album(2), album(3)]})
            if request.url.path == "/artist/8/albums":
                return httpx.Response(200, json={"data": [album(1)], "next": "incomplete"})
            if request.url.path == "/artist/9/albums":
                return httpx.Response(200, json={"data": "invalid"})
            if request.url.path == "/artist/10/albums":
                return httpx.Response(200, json={"data": []})
            if request.url.path in {"/album/1", "/album/2", "/album/3"}:
                album_id = int(request.url.path.rsplit("/", 1)[1])
                ids = [1, 2, 3] if album_id == 1 else [3, 4] if album_id == 2 else []
                return httpx.Response(
                    200,
                    json={
                        **album(album_id),
                        "nb_tracks": 3 if album_id == 3 else len(ids),
                        "tracks": {"data": [track(n) for n in ids]},
                    },
                )
            return httpx.Response(200, json={"data": []})

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            store.update({"destination": str(root)})
            async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as source:
                catalog = Catalog(store, source)
                library = Library(store, [root], asyncio.Event())
                store.db.execute(
                    "INSERT INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        str(root / "owned.opus"),
                        str(root),
                        1,
                        1,
                        "fixture",
                        "Song 1",
                        "Artist",
                        "Album 1",
                        "song 1",
                        "artist",
                        "album 1",
                        180,
                        "USFIX2600001",
                        "",
                    ),
                )
                downloads = Downloads(store, catalog, library, asyncio.Event())
                downloads.jobs.enqueue(2, "original", str(root))
                app = FastAPI()
                install_search_routes(app, lambda: catalog, lambda: library)
                install_download_routes(app, lambda: downloads)
                install_artist_download_routes(app, lambda: downloads)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    result = (await client.get("/api/artists/7/download-plan")).json()
                    self.assertEqual([row["id"] for row in result["albums"]], [1, 2, 3])
                    self.assertTrue(result["albums"][0]["tracks"][0]["owned"])
                    self.assertTrue(result["albums"][2]["error"])
                    self.assertTrue(any("index=50" in url for url in requests))
                    self.assertEqual(len(downloads.jobs.list()), 1)
                    failed = await client.post(
                        "/api/artist-batches", json={"artist_id": 7, "album_ids": [1, 3]}
                    )
                    self.assertEqual(failed.status_code, 502)
                    self.assertEqual(len(downloads.jobs.list()), 1)
                    response = await client.post(
                        "/api/artist-batches", json={"artist_id": 7, "album_ids": [1, 2, 1]}
                    )
                    self.assertEqual(response.status_code, 200)
                    batch = response.json()
                    self.assertEqual([row["track_id"] for row in batch["jobs"]], [3, 4])
                    self.assertEqual(batch["albums"], 2)
                    self.assertEqual(batch["skipped_owned"], 1)
                    self.assertEqual(batch["skipped_queued"], 1)
                    self.assertEqual({row["batch_id"] for row in batch["jobs"]}, {batch["id"]})
                    repeated = (
                        await client.post(
                            "/api/artist-batches", json={"artist_id": 7, "album_ids": [1, 2]}
                        )
                    ).json()
                    self.assertEqual(repeated["jobs"], [])
                    self.assertEqual(repeated["albums"], 0)
                    self.assertEqual(repeated["skipped_queued"], 3)
                    all_tracks = (
                        await client.post(
                            "/api/artist-batches",
                            json={
                                "artist_id": 7,
                                "album_ids": [1],
                                "missing_only": False,
                                "format": "mp3",
                            },
                        )
                    ).json()
                    self.assertEqual(len(all_tracks["jobs"]), 3)
                    for body in [
                        {"artist_id": 7, "album_ids": []},
                        {"artist_id": 7, "album_ids": [999]},
                        {"artist_id": 7, "album_ids": [1], "target": str(root.parent)},
                        {"artist_id": 7, "album_ids": [True]},
                    ]:
                        self.assertEqual(
                            (await client.post("/api/artist-batches", json=body)).status_code, 422
                        )
                    self.assertEqual(
                        (await client.get("/api/artists/0/download-plan")).status_code, 422
                    )
                    self.assertEqual(
                        (await client.get("/api/artists/8/download-plan")).status_code, 502
                    )
                    self.assertEqual(
                        (await client.get("/api/artists/9/download-plan")).status_code, 502
                    )
                    self.assertEqual(
                        (await client.get("/api/artists/10/download-plan")).json(), {"albums": []}
                    )
            store.close()


if __name__ == "__main__":
    unittest.main()
