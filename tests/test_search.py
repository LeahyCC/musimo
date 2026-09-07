import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.catalog import Catalog, CatalogError, Result, Track, safe_media
from backend.library import Library
from backend.search_api import install_search_routes
from backend.store import Store

TRACK = {
    "id": 1,
    "title": "One More Time",
    "duration": 320,
    "isrc": "GBDUW0000053",
    "artist": {"id": 27, "name": "Daft Punk"},
    "album": {"id": 302127, "title": "Discovery"},
    "preview": "https://cdnt-preview.dzcdn.net/clip.mp3",
}


class SearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.store = Store(self.root / "db.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.folder.cleanup()

    def add_file(self, name: str, isrc: str = "", mbid: str = "", duration: float = 320) -> str:
        path = str(self.root / name)
        self.store.db.execute(
            "INSERT INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                path,
                str(self.root),
                1,
                1,
                "old",
                "One More Time",
                "Daft Punk",
                "Discovery",
                "one more time",
                "daft punk",
                "discovery",
                duration,
                isrc,
                mbid,
            ),
        )
        self.store.db.execute(
            "INSERT INTO library_fts VALUES (?,?,?,?)",
            (path, "One More Time", "Daft Punk", "Discovery"),
        )
        return path

    async def test_catalog_cache_survives_client_restart_and_paginates_safely(self) -> None:
        requests: list[str] = []

        def transport(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            return httpx.Response(
                200, json={"data": [TRACK], "total": 3, "next": "http://127.0.0.1/private"}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            catalog = Catalog(self.store, client)
            first = await catalog.search("Daft Punk", "track", 0)
            self.assertFalse(first.cached)
            self.assertEqual(first.next_index, 1)
            self.assertEqual(first.items[0].isrc, "GBDUW0000053")
            self.assertIsNone(first.items[0].year)
            self.assertTrue((await catalog.search("Daft Punk", "track", 0)).cached)
            catalog = Catalog(self.store, client)
            self.assertTrue((await catalog.search("Daft Punk", "track", 0)).cached)
            await catalog.search("Daft Punk", "track", 1)
        self.assertEqual(len(requests), 2)
        self.assertTrue(
            all(url.startswith("https://api.deezer.com/search/track?") for url in requests)
        )

    async def test_rate_limit_is_shared_and_retry_after_honored(self) -> None:
        track = Track.model_validate(
            TRACK | {"preview": None, "album": {"id": 1, "cover_medium": None, "cover_big": None}}
        )
        self.assertEqual(track.preview, "")
        self.assertIsNotNone(track.album)
        if track.album:
            self.assertEqual(track.album.cover_medium, "")
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(429, headers={"Retry-After": "7"})
            )
        ) as client:
            catalog = Catalog(self.store, client)
            with self.assertRaises(CatalogError) as error:
                await catalog.search("hello", "track", 0)
            self.assertEqual(error.exception.status, 429)
            self.assertGreater(catalog.blocked_until, time.monotonic() + 6)
            with self.assertRaises(TimeoutError):
                async with asyncio.timeout(0.03):
                    await catalog.get("album/1")
        self.assertEqual(safe_media("https://dzcdn.net.evil.test/clip.mp3"), "")

    async def test_search_deadline_includes_rate_wait_and_album_coverage_is_exact(self) -> None:
        def transport(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/album/302127":
                return httpx.Response(
                    200,
                    json={
                        "id": 302127,
                        "title": "Discovery",
                        "artist": {"id": 27, "name": "Daft Punk"},
                        "nb_tracks": 1,
                        "tracks": {"data": [TRACK]},
                    },
                )
            return httpx.Response(200, json={"data": [TRACK]})

        self.add_file("owned.flac", isrc="GBDUW0000053")
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as upstream:
            catalog = Catalog(self.store, upstream)
            app = FastAPI()
            install_search_routes(app, lambda: catalog, lambda: self.library)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                detail = (await client.get("/api/albums/302127")).json()
                self.assertEqual(detail["album"]["ownership"], "owned")
                self.assertTrue(detail["album"]["coverage_verified"])
                background = (await client.get("/api/albums/302127?background=true")).json()
                self.assertEqual(background, detail)
                self.store.db.execute("DELETE FROM library_files")
                refreshed = (await client.get("/api/albums/302127?background=true")).json()
                self.assertEqual(refreshed["album"]["owned_count"], 0)
                self.assertEqual(refreshed["album"]["ownership"], "missing")
                catalog.blocked_until = time.monotonic() + 30
                started = time.monotonic()
                response = await client.get("/api/search?q=hello")
                self.assertEqual(response.status_code, 504)
                self.assertLess(time.monotonic() - started, 2.8)

    async def test_identity_matching_and_cancelled_scan_preserve_index(self) -> None:
        exact = self.add_file("isrc.flac", isrc="GBDUW0000053", duration=10)
        self.add_file("near.flac", duration=323)
        self.add_file("different.flac", isrc="WRONG", duration=320)
        self.add_file("too-long.flac", duration=324)
        item = Result(
            id=1,
            kind="track",
            title="One More Time",
            artist="DAFT PUNK",
            duration=320,
            isrc="GB-DUW-00-00053",
        )
        self.library.annotate([item])
        self.assertEqual(set(item.matched_paths), {exact})
        self.library.annotate([item])
        self.assertEqual(len(item.matched_paths), 1)
        self.library.cancelled.set()
        self.library.scan()
        self.assertEqual(self.library.status()["total_files"], 4)
        self.assertEqual(self.library.state["status"], "cancelled")
        self.library.cancelled.clear()
        self.library.scan()
        self.assertEqual(self.library.status()["total_files"], 0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM library_fts").fetchone()[0], 0)

    async def test_preview_fallback_rejects_wrong_artist_and_duration(self) -> None:
        matching = {
            "trackName": "One More Time",
            "artistName": "Daft Punk",
            "trackTimeMillis": 320000,
            "previewUrl": "https://audio-ssl.itunes.apple.com/clip.m4a",
        }

        def transport(request: httpx.Request) -> httpx.Response:
            if request.url.host == "api.deezer.com":
                return httpx.Response(200, json=TRACK | {"preview": ""})
            return httpx.Response(
                200,
                json={
                    "results": [
                        matching | {"artistName": "Cover Band"},
                        matching | {"trackTimeMillis": 500000},
                        matching,
                    ]
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as upstream:
            catalog = Catalog(self.store, upstream)
            app = FastAPI()
            install_search_routes(app, lambda: catalog, lambda: self.library)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                response = await client.get("/api/preview/1")
                self.assertEqual(
                    response.json(), {"url": matching["previewUrl"], "source": "iTunes"}
                )
        self.assertEqual(len(catalog.itunes_requests), 1)

    async def test_scan_reads_tags_and_caches_unchanged_files(self) -> None:
        path = self.root / "record.flac"
        path.write_bytes(b"fixture")

        class Info:
            length = 320.0

        class Audio(dict[str, list[str]]):
            info = Info()

        audio = Audio(
            title=["One More Time"],
            artist=["Daft Punk"],
            album=["Discovery"],
            isrc=["GBDUW0000053"],
        )
        with patch("backend.library.mutagen.File", return_value=audio) as reader:
            self.library.scan()
            self.library.scan()
            self.assertEqual(reader.call_count, 1)
        self.assertEqual(self.library.status()["total_files"], 1)
        self.assertEqual(
            self.store.db.execute(
                "SELECT title FROM library_fts WHERE library_fts MATCH 'Discovery'"
            ).fetchone()[0],
            "One More Time",
        )
        path.write_bytes(b"changed fixture")
        audio["title"] = ["Replacement title"]
        with patch("backend.library.mutagen.File", return_value=audio):
            self.library.refresh({str(path)})
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM library_fts").fetchone()[0], 1)
        self.assertEqual(
            self.store.db.execute("SELECT title FROM library_fts").fetchone()[0],
            "Replacement title",
        )
        self.store.db.execute("UPDATE library_roots SET enabled=0")
        item = Result(id=1, kind="track", title="One More Time", artist="Daft Punk", duration=320)
        self.assertEqual(self.library.annotate([item])[0].ownership, "missing")
