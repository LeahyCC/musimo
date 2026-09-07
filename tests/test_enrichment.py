import tempfile
import unittest
from pathlib import Path

import httpx

from backend.catalog import Catalog
from backend.enrichment import Enrichment
from backend.job_models import Metadata
from backend.store import Store


class EnrichmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name) / "test.sqlite3")
        self.responses: dict[str, httpx.Response] = {}
        self.requests: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return self.responses.get(request.url.path, httpx.Response(404))

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        self.enrichment = Enrichment(Catalog(self.store, self.client))
        self.meta = Metadata(id=1, title="Test song", artist="Test artist", album="Test album")

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.folder.cleanup()

    async def test_optional_missing_metadata_leaves_download_usable(self) -> None:
        warnings = await self.enrichment.extra(self.meta)
        self.assertIn("Lyrics unavailable from LRCLIB", warnings)
        self.assertIn("No ISRC supplied; MusicBrainz identification unavailable", warnings)
        self.assertEqual(self.meta.title, "Test song")
        self.assertEqual(self.meta.mb_recording, "")

    async def test_catalog_metadata_preserves_disc_counts_and_rejects_unsafe_art(self) -> None:
        self.responses["/track/1"] = httpx.Response(
            200,
            json={
                "id": 1,
                "title": "Test song",
                "artist": {"id": 7, "name": "Test artist"},
                "album": {"id": 42, "title": "Test album"},
                "duration": 180,
                "disk_number": 2,
                "track_position": 1,
                "contributors": [{"name": "Guest"}],
            },
        )
        self.responses["/album/42"] = httpx.Response(
            200,
            json={
                "id": 42,
                "title": "Test album",
                "artist": {"id": 7, "name": "Test artist"},
                "cover_big": "http://127.0.0.1/private.jpg",
                "release_date": "2020-01-01",
                "genres": {"data": [{"name": "Jazz"}]},
                "label": "Fixture label",
                "tracks": {"data": [{"disk_number": 1}, {"disk_number": 2}, {"disk_number": 2}]},
            },
        )
        result = await self.enrichment.track(1)
        self.assertEqual((result.disc, result.discs, result.tracks), (2, 2, 2))
        self.assertEqual(result.album_artist, "Test artist")
        self.assertEqual(result.date, "2020-01-01")
        self.assertEqual(result.genre, "Jazz")
        self.assertEqual(result.contributors, ["Guest"])
        self.assertEqual(result.art, "")

    async def test_external_cache_preserves_success_and_negative_results(self) -> None:
        self.responses["/api/get"] = httpx.Response(200, json={"plainLyrics": "Synthetic words"})
        first = await self.enrichment.external("https://lrclib.net/api/get", {"id": 1})
        second = await self.enrichment.external("https://lrclib.net/api/get", {"id": 1})
        self.assertEqual(first, second)
        self.assertEqual(len(self.requests), 1)
        for _ in range(2):
            self.assertEqual(await self.enrichment.external("https://lrclib.net/missing", {}), {})
        self.assertEqual(len(self.requests), 2)

    async def test_failures_and_malformed_metadata_are_not_cached(self) -> None:
        for response in (httpx.Response(503), httpx.Response(200, json=["invalid"])):
            self.responses["/api/get"] = response
            with self.assertRaises((httpx.HTTPStatusError, ValueError)):
                await self.enrichment.external("https://lrclib.net/api/get", {})
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM search_cache").fetchone()[0], 0
        )
        warnings = await self.enrichment.extra(self.meta)
        self.assertIn("Lyrics lookup failed", warnings)

    async def test_ambiguous_recordings_never_assign_identifiers(self) -> None:
        self.meta.isrc = "TEST123"
        record = {"id": "one", "title": "Test song", "artist-credit": [{"name": "Test artist"}]}
        self.responses["/ws/2/isrc/TEST123"] = httpx.Response(
            200, json={"recordings": [record, record | {"id": "two"}]}
        )
        warnings = await self.enrichment.extra(self.meta)
        self.assertIn("MusicBrainz match unavailable or ambiguous; IDs left empty", warnings)
        self.assertEqual(self.meta.mb_recording, "")

    async def test_exact_recording_and_release_assign_verified_ids(self) -> None:
        self.meta.isrc = "TEST123"
        self.responses["/api/get"] = httpx.Response(
            200, json={"plainLyrics": "Synthetic words", "syncedLyrics": "[00:00] Synthetic words"}
        )
        self.responses["/ws/2/isrc/TEST123"] = httpx.Response(
            200,
            json={
                "recordings": [
                    {
                        "id": "recording-one",
                        "title": "Test song",
                        "artist-credit": [{"name": "Test artist", "artist": {"id": "artist-one"}}],
                        "releases": [{"id": "release-one", "title": "Test album"}],
                    }
                ]
            },
        )
        self.responses["/ws/2/release/release-one"] = httpx.Response(
            200,
            json={
                "release-group": {"id": "group-one"},
                "media": [{"tracks": [{"id": "track-one", "recording": {"id": "recording-one"}}]}],
            },
        )
        self.assertEqual(await self.enrichment.extra(self.meta), [])
        self.assertEqual(self.meta.mb_recording, "recording-one")
        self.assertEqual(self.meta.mb_release, "release-one")
        self.assertEqual(self.meta.mb_track, "track-one")
        self.assertEqual(self.meta.mb_artist, "artist-one")
        self.assertEqual(self.meta.mb_release_group, "group-one")
        self.assertEqual(self.meta.lyrics, "Synthetic words")
        self.assertTrue(
            all(
                "Musimo/" in request.headers["user-agent"]
                for request in self.requests
                if request.url.host == "musicbrainz.org"
            )
        )
