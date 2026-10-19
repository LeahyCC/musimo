"""Spotify track search and the Deezer match a download uses. No live Spotify calls."""

import asyncio
import json
import os
import sqlite3
import stat
import tempfile
import unittest
from collections.abc import Callable
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.api.search_api import install_search_routes
from backend.core.models import Settings
from backend.core.store import LockedSetting, Store
from backend.integrations import spotify_credentials
from backend.integrations.catalog import Catalog, safe_media
from backend.library.index import Library
from backend.main import create_app

CLIENT_ID = "a" * 32
SECRET = "b" * 32
PREVIEW = "https://p.scdn.co/mp3-preview/clip"
ART = "https://i.scdn.co/image/cover"


def spotify_track(number: int, *, preview: str | None) -> dict[str, object]:
    return {
        "id": f"sp{number:020d}",
        "name": f"Track {number}",
        "duration_ms": 180_000 + number * 1000,
        "explicit": number == 0,
        "preview_url": preview,
        "popularity": 10,
        "disc_number": 1,
        "track_number": number + 1,
        "external_ids": {"isrc": f"USAAA00000{number:02d}"},
        "artists": [{"id": "artist", "name": "Daft Punk"}],
        "album": {
            "id": "album",
            "name": "Discovery",
            "release_date": "2001-03-12",
            "images": [{"url": ART, "width": 300, "height": 300}],
        },
    }


def deezer_track(track_id: int, duration: int = 180) -> dict[str, object]:
    return {
        "id": track_id,
        "title": "Track 0",
        "duration": duration,
        "isrc": "USAAA0000000",
        "artist": {"id": 27, "name": "Daft Punk"},
        "album": {"id": 5, "title": "Discovery", "cover_medium": ""},
        "preview": "https://cdnt-preview.dzcdn.net/clip.mp3",
    }


class SpotifySearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.store = Store(self.root / "db.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())
        self.store.update({"search_catalog": "spotify"})
        spotify_credentials.write(self.root, CLIENT_ID, SECRET)

    async def asyncTearDown(self) -> None:
        os.environ.pop(spotify_credentials.ENV, None)
        self.store.close()
        self.folder.cleanup()

    def clients(
        self, transport: Callable[[httpx.Request], httpx.Response]
    ) -> tuple[httpx.AsyncClient, httpx.AsyncClient]:
        upstream = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        catalog = Catalog(self.store, upstream)
        app = FastAPI()
        install_search_routes(app, lambda: catalog, lambda: self.library)
        api = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")
        return upstream, api

    async def test_track_search_returns_ten_and_keeps_a_missing_preview_empty(self) -> None:
        seen: list[httpx.Request] = []

        def transport(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.host == "accounts.spotify.com":
                return httpx.Response(200, json={"access_token": "app-token", "expires_in": 3600})
            rows = [
                spotify_track(number, preview=PREVIEW if number == 0 else None)
                for number in range(10)
            ]
            return httpx.Response(
                200,
                json={
                    "tracks": {
                        "items": rows,
                        "total": 25,
                        "limit": 10,
                        "offset": 0,
                        "next": "x",
                    }
                },
            )

        upstream, api = self.clients(transport)
        async with upstream, api:
            response = await api.get("/api/search?q=daft&kind=track")
        self.assertEqual(response.status_code, 200)
        page = response.json()
        self.assertEqual(len(page["items"]), 10)
        self.assertEqual(page["total"], 25)
        self.assertEqual(page["next_index"], 10)
        first, second = page["items"][0], page["items"][1]
        self.assertEqual(first["id"], 0)
        self.assertEqual(first["spotify_id"], "sp" + "0" * 20)
        self.assertEqual(first["title"], "Track 0")
        self.assertEqual(first["artist"], "Daft Punk")
        self.assertEqual(first["album"], "Discovery")
        self.assertEqual(first["art"], ART)
        self.assertEqual(first["duration"], 180)
        self.assertEqual(first["year"], 2001)
        self.assertTrue(first["explicit"])
        self.assertEqual(first["preview"], PREVIEW)
        self.assertEqual(first["isrc"], "USAAA0000000")
        self.assertEqual(second["id"], 0)
        self.assertEqual(second["preview"], "")
        self.assertNotIn(SECRET, response.text)
        self.assertEqual(seen[0].url.host, "accounts.spotify.com")
        self.assertIn("limit=10", str(seen[1].url))
        self.assertTrue(seen[1].headers["authorization"].startswith("Bearer "))
        self.assertNotIn(SECRET, str(seen[1].url))

    async def test_track_search_without_an_app_does_not_call_spotify(self) -> None:
        spotify_credentials.remove(self.root)

        def transport(request: httpx.Request) -> httpx.Response:
            raise AssertionError(request.url)

        upstream, api = self.clients(transport)
        async with upstream, api:
            response = await api.get("/api/search?q=daft&kind=track")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(
            response.json()["detail"], "Add a Spotify app in Settings to search Spotify."
        )

    async def test_album_search_stays_on_deezer_and_deezer_mode_does_not_call_spotify(self) -> None:
        hosts: list[str] = []

        def transport(request: httpx.Request) -> httpx.Response:
            hosts.append(request.url.host)
            return httpx.Response(200, json={"data": [], "total": 0})

        upstream, api = self.clients(transport)
        async with upstream, api:
            album = await api.get("/api/search?q=daft&kind=album")
            self.assertEqual(album.status_code, 200)
            self.store.update({"search_catalog": "deezer"})
            tracks = await api.get("/api/search?q=daft&kind=track")
            self.assertEqual(tracks.status_code, 200)
        self.assertEqual(hosts, ["api.deezer.com", "api.deezer.com"])

    async def test_deezer_match_uses_isrc_then_artist_title_and_duration(self) -> None:
        calls: list[str] = []

        def hit(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.host + request.url.path)
            self.assertNotEqual(request.url.host, "api.spotify.com")
            return httpx.Response(200, json=deezer_track(4242))

        upstream, api = self.clients(hit)
        async with upstream, api:
            matched = await api.post(
                "/api/deezer-match",
                json={
                    "isrc": "us-aaa-00-00000",
                    "artist": "Daft Punk",
                    "title": "Track 0",
                    "duration": 180,
                },
            )
        self.assertEqual(matched.status_code, 200)
        self.assertEqual(matched.json()["track_id"], 4242)
        self.assertEqual(len(calls), 1)
        self.assertIn("isrc", calls[0].lower())

        def miss_isrc_then_text(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.host + request.url.path)
            if request.url.path.startswith("/track/isrc:"):
                return httpx.Response(200, json={"error": {"type": "DataException", "code": 800}})
            return httpx.Response(
                200,
                json={
                    "data": [deezer_track(7, duration=200), deezer_track(8, duration=181)],
                    "total": 2,
                },
            )

        calls.clear()
        upstream, api = self.clients(miss_isrc_then_text)
        async with upstream, api:
            text = await api.post(
                "/api/deezer-match",
                json={
                    "isrc": "USAAA0000000",
                    "artist": "DAFT PUNK",
                    "title": "Track 0",
                    "duration": 180,
                },
            )
            missed = await api.post(
                "/api/deezer-match",
                json={"artist": "Someone Else", "title": "Track 0", "duration": 180},
            )
        self.assertEqual(text.status_code, 200)
        self.assertEqual(text.json()["track_id"], 8)
        self.assertEqual(missed.status_code, 404)
        self.assertEqual(missed.json()["detail"], "No Deezer match for “Track 0” by Someone Else.")
        self.assertTrue(calls)
        self.assertTrue(all(call.startswith("api.deezer.com/") for call in calls))

    async def test_a_different_isrc_is_not_the_recording(self) -> None:
        def transport(request: httpx.Request) -> httpx.Response:
            if request.url.path.startswith("/track/isrc:"):
                other = deezer_track(999, duration=180)
                other["title"] = "Other song"
                other["isrc"] = "USBBB0000001"
                other["artist"] = {"id": 9, "name": "Someone"}
                return httpx.Response(200, json=other)
            same = deezer_track(8, duration=181)
            wrong = deezer_track(9, duration=180)
            wrong["isrc"] = "USBBB0000001"
            return httpx.Response(200, json={"data": [wrong, same], "total": 2})

        upstream, api = self.clients(transport)
        async with upstream, api:
            matched = await api.post(
                "/api/deezer-match",
                json={
                    "isrc": "USAAA0000000",
                    "artist": "Daft Punk",
                    "title": "Track 0",
                    "duration": 180,
                },
            )
            unknown = await api.post(
                "/api/deezer-match",
                json={"artist": "Daft Punk", "title": "Track 0", "duration": 0},
            )
        self.assertEqual(matched.status_code, 200)
        self.assertEqual(matched.json()["track_id"], 8)
        self.assertEqual(unknown.status_code, 404)

    async def test_the_matching_isrc_wins_over_a_closer_untagged_track(self) -> None:
        def transport(request: httpx.Request) -> httpx.Response:
            if request.url.path.startswith("/track/isrc:"):
                return httpx.Response(200, json={"error": {"type": "DataException", "code": 800}})
            closer = deezer_track(1, duration=180)
            closer["isrc"] = ""
            closer["title"] = "Track 0"
            right = deezer_track(2, duration=183)
            right["isrc"] = "USAAA0000000"
            right["title"] = "Track 0 (Remastered)"
            return httpx.Response(200, json={"data": [closer, right], "total": 2})

        upstream, api = self.clients(transport)
        async with upstream, api:
            matched = await api.post(
                "/api/deezer-match",
                json={
                    "isrc": "USAAA0000000",
                    "artist": "Daft Punk",
                    "title": "Track 0",
                    "duration": 180,
                },
            )
        self.assertEqual(matched.status_code, 200)
        self.assertEqual(matched.json()["track_id"], 2)

    async def test_a_missing_spotify_clip_uses_itunes_and_not_a_deezer_id(self) -> None:
        hosts: list[str] = []

        def transport(request: httpx.Request) -> httpx.Response:
            hosts.append(request.url.host)
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "trackName": "Track 0",
                            "artistName": "Cover",
                            "trackTimeMillis": 180000,
                            "previewUrl": "https://audio-ssl.itunes.apple.com/nope.m4a",
                        },
                        {
                            "trackName": "Track 0",
                            "artistName": "Daft Punk",
                            "trackTimeMillis": 180000,
                            "previewUrl": "https://audio-ssl.itunes.apple.com/clip.m4a",
                        },
                    ]
                },
            )

        upstream, api = self.clients(transport)
        async with upstream, api:
            clip = await api.get(
                "/api/preview-match",
                params={"artist": "Daft Punk", "title": "Track 0", "duration": 180},
            )
            refused = await api.get("/api/preview/0")
        self.assertEqual(
            clip.json(),
            {"url": "https://audio-ssl.itunes.apple.com/clip.m4a", "source": "iTunes"},
        )
        self.assertEqual(hosts, ["itunes.apple.com"])
        self.assertEqual(refused.status_code, 422)

    def test_safe_media_allows_spotify_preview_and_art_hosts(self) -> None:
        self.assertEqual(safe_media(PREVIEW), PREVIEW)
        self.assertEqual(safe_media(ART), ART)
        self.assertEqual(safe_media("https://p.scdn.co.evil.test/clip.mp3"), "")
        self.assertEqual(safe_media("http://p.scdn.co/clip.mp3"), "")


class SpotifyCredentialTests(unittest.TestCase):
    def tearDown(self) -> None:
        os.environ.pop(spotify_credentials.ENV, None)
        os.environ.pop("MUSIMO_SPOTIFY_CLIENT_ID", None)
        os.environ.pop("MUSIMO_SPOTIFY_CLIENT_SECRET", None)
        os.environ.pop("MUSIMO_SEARCH_CATALOG", None)

    def test_settings_replies_never_carry_the_client_secret(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(Path(folder))) as client:
                saved = client.patch(
                    "/api/settings",
                    json={"spotify_client_id": CLIENT_ID, "spotify_client_secret": SECRET},
                )
                self.assertEqual(saved.status_code, 200)
                replies = (
                    saved.json(),
                    client.get("/api/settings").json(),
                    client.get("/api/snapshot").json()["settings"],
                    client.get("/api/diagnostics").json(),
                )
                for reply in replies:
                    self.assertNotIn(SECRET, json.dumps(reply))
                    self.assertNotIn(CLIENT_ID, json.dumps(reply))
                self.assertTrue(saved.json()["spotify_credentials"]["value"])
                self.assertEqual(saved.json()["spotify_client_secret"]["value"], "")
                app_file = Path(folder) / "spotify-app.json"
                stored = json.loads(app_file.read_text(encoding="utf-8"))
                self.assertEqual(stored["client_secret"], SECRET)
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(app_file.stat().st_mode), 0o600)
                with closing(sqlite3.connect(Path(folder) / "musimo.sqlite3")) as db:
                    table = db.execute("SELECT group_concat(value) FROM settings").fetchone()[0]
                    jobs = db.execute("SELECT group_concat(payload) FROM jobs").fetchone()[0]
                    events = db.execute("SELECT group_concat(payload) FROM job_events").fetchone()[
                        0
                    ]
                self.assertNotIn(SECRET, table)
                self.assertNotIn(SECRET, jobs or "")
                self.assertNotIn(SECRET, events or "")
                self.assertNotIn(CLIENT_ID, events or "")
                client.patch(
                    "/api/settings",
                    json={"spotify_client_id": "", "spotify_client_secret": ""},
                )
                self.assertFalse(client.get("/api/settings").json()["spotify_credentials"]["value"])
                self.assertFalse(app_file.exists())

    def test_a_rejected_secret_is_not_echoed(self) -> None:
        secret = "not a spotify secret"
        cookie = "ab" * 96 + "zz"
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(Path(folder))) as client:
                rejected = client.patch(
                    "/api/settings",
                    json={"spotify_client_id": "a" * 32, "spotify_client_secret": secret},
                )
                self.assertEqual(rejected.status_code, 422)
                self.assertNotIn(secret, rejected.text)
                self.assertIn("16 to 128", rejected.text)
                refused = client.patch("/api/settings", json={"deezer_arl": cookie})
                self.assertEqual(refused.status_code, 422)
                self.assertNotIn(cookie, refused.text)
                self.assertIn("192", refused.text)

    def test_search_catalog_defaults_to_deezer_and_locks_from_the_environment(self) -> None:
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ", {}, clear=False):
            os.environ.pop("MUSIMO_SEARCH_CATALOG", None)
            store = Store(Path(folder) / "db.sqlite3")
            self.assertEqual(store.current().search_catalog, "deezer")
            row = store.settings()["search_catalog"]
            assert isinstance(row, dict)
            self.assertFalse(row["locked"])
            store.close()
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict("os.environ", {"MUSIMO_SEARCH_CATALOG": "spotify"}),
        ):
            store = Store(Path(folder) / "again.sqlite3")
            self.assertEqual(store.current().search_catalog, "spotify")
            saved = store.settings()["search_catalog"]
            assert isinstance(saved, dict)
            self.assertEqual(saved["origin"], "MUSIMO_SEARCH_CATALOG")
            self.assertTrue(saved["locked"])
            with self.assertRaises(LockedSetting):
                store.update({"search_catalog": "deezer"})
            store.close()
        os.environ.pop("MUSIMO_SEARCH_CATALOG", None)
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "bad.sqlite3")
            store.db.execute("DELETE FROM settings WHERE key='search_catalog'")
            with (
                patch.dict("os.environ", {"MUSIMO_SEARCH_CATALOG": "apple"}),
                self.assertRaises(ValidationError),
            ):
                store.seed()
            store.close()
        with self.assertRaises(ValidationError):
            Settings.model_validate({"search_catalog": "apple"})
        self.assertEqual(Settings().search_catalog, "deezer")

    def test_the_environment_seeds_the_app_once_and_a_removal_stays_removed(self) -> None:
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict(
                "os.environ",
                {"MUSIMO_SPOTIFY_CLIENT_ID": CLIENT_ID, "MUSIMO_SPOTIFY_CLIENT_SECRET": SECRET},
            ),
        ):
            app_file = Path(folder) / "spotify-app.json"
            with TestClient(create_app(Path(folder))) as client:
                self.assertTrue(client.get("/api/settings").json()["spotify_credentials"]["value"])
                self.assertNotIn(SECRET, client.get("/api/settings").text)
                stored = json.loads(app_file.read_text(encoding="utf-8"))
                self.assertEqual(stored["client_secret"], SECRET)
                self.assertNotIn("MUSIMO_SPOTIFY_CLIENT_SECRET", os.environ)
                client.patch(
                    "/api/settings",
                    json={"spotify_client_id": "", "spotify_client_secret": ""},
                )
            os.environ["MUSIMO_SPOTIFY_CLIENT_ID"] = CLIENT_ID
            os.environ["MUSIMO_SPOTIFY_CLIENT_SECRET"] = SECRET
            with TestClient(create_app(Path(folder))) as client:
                self.assertFalse(client.get("/api/settings").json()["spotify_credentials"]["value"])
            self.assertFalse(app_file.exists())
