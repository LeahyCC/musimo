import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.navidrome import Navidrome
from backend.player_api import install_player_routes
from backend.store import Store


def subsonic(**payload: object) -> httpx.Response:
    return httpx.Response(200, json={"subsonic-response": {"status": "ok", **payload}})


class PlayerTests(unittest.IsolatedAsyncioTestCase):
    async def test_library_capabilities_and_ranged_media_use_navidrome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            requests: list[httpx.Request] = []

            def upstream(request: httpx.Request) -> httpx.Response:
                requests.append(request)
                if request.url.host == "lrclib.net":
                    return httpx.Response(
                        200,
                        json={
                            "plainLyrics": "First line\nSecond line",
                            "syncedLyrics": "[00:01.25]First line\n[00:03.00]Second line",
                        },
                    )
                path = request.url.path
                if path.endswith("/ping"):
                    return subsonic(serverVersion="0.63.0")
                if path.endswith("/getOpenSubsonicExtensions"):
                    return subsonic(
                        openSubsonicExtensions=[
                            {"name": "sonicSimilarity", "versions": [1]},
                            {"name": "formPost", "versions": [1]},
                        ]
                    )
                if path.endswith("/getAlbumList2"):
                    return subsonic(albumList2={"album": [{"id": "album-1", "name": "One"}]})
                if path.endswith("/getArtists"):
                    return subsonic(
                        artists={"index": [{"name": "A", "artist": [{"id": "artist-1"}]}]}
                    )
                if path.endswith("/search3"):
                    if request.url.params.get("albumCount") != "0":
                        return subsonic(searchResult3={"album": [{"id": "album-1", "name": "One"}]})
                    if request.url.params.get("artistCount") != "0":
                        return subsonic(
                            searchResult3={"artist": [{"id": "artist-1", "name": "Artist"}]}
                        )
                    return subsonic(searchResult3={"song": [{"id": "song-1", "title": "Track"}]})
                if path.endswith("/getPlaylists"):
                    return subsonic(playlists={"playlist": [{"id": "playlist-1"}]})
                if path.endswith("/getPlaylist"):
                    return subsonic(playlist={"id": "playlist-1", "entry": [{"id": "song-1"}]})
                if path.endswith("/createPlaylist"):
                    return subsonic(playlist={"id": "playlist-2", "name": "Road trip"})
                if path.endswith("/updatePlaylist") or path.endswith("/deletePlaylist"):
                    return subsonic()
                if path.endswith("/getAlbum"):
                    return subsonic(album={"id": "album-1", "song": [{"id": "song-1"}]})
                if path.endswith("/getArtist"):
                    return subsonic(artist={"id": "artist-1", "album": [{"id": "album-1"}]})
                if path.endswith("/getSong"):
                    return subsonic(
                        song={
                            "id": request.url.params.get("id"),
                            "title": "Track",
                            "artist": "Artist",
                            "album": "One",
                            "duration": 180,
                        }
                    )
                if path.endswith("/getPlayQueue"):
                    return subsonic(
                        playQueue={
                            "current": "song-1",
                            "position": 1200,
                            "entry": [{"id": "song-1"}],
                        }
                    )
                if path.endswith("/savePlayQueue") or path.endswith("/scrobble"):
                    return subsonic()
                if path.endswith("/getLyricsBySongId"):
                    if request.url.params.get("id") == "no-lyrics":
                        return subsonic(lyricsList={"structuredLyrics": []})
                    return subsonic(
                        lyricsList={
                            "structuredLyrics": [
                                {"displayArtist": "Artist", "line": [{"value": "Words"}]}
                            ]
                        }
                    )
                if path.endswith("/getSonicSimilarTracks") or path.endswith("/findSonicPath"):
                    if request.url.params.get("id") == "radio-not-ready":
                        return subsonic(
                            status="failed",
                            error={
                                "message": (
                                    "plugin call failed: AudioMuse-AI HTTP request failed: "
                                    'Get "http://127.0.0.1:8000/api/similar_tracks": '
                                    "connectex: No connection could be made"
                                )
                            },
                        )
                    return subsonic(
                        sonicMatch=[{"entry": {"id": "song-2", "title": "Next"}, "similarity": 0.9}]
                    )
                if path.endswith("/stream"):
                    self.assertEqual(request.headers.get("range"), "bytes=2-5")
                    return httpx.Response(
                        206,
                        content=b"udio",
                        headers={
                            "Accept-Ranges": "bytes",
                            "Content-Range": "bytes 2-5/8",
                            "Content-Type": "audio/ogg",
                            "X-Upstream-Secret": "no",
                        },
                    )
                if path.endswith("/getCoverArt"):
                    return httpx.Response(
                        200, content=b"image", headers={"Content-Type": "image/jpeg"}
                    )
                return httpx.Response(404)

            with patch.dict("os.environ", {"MUSIMO_NAVIDROME_CREDENTIALS_FILE": str(credentials)}):
                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(upstream)
                ) as upstream_client:
                    navidrome = Navidrome(store, upstream_client)
                    app = FastAPI()
                    install_player_routes(app, lambda: navidrome)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app), base_url="http://test"
                    ) as client:
                        capabilities = (await client.get("/api/player/capabilities")).json()
                        self.assertTrue(capabilities["available"])
                        self.assertTrue(capabilities["sonic_similarity"])
                        self.assertEqual(capabilities["version"], "0.63.0")
                        self.assertEqual(
                            (await client.get("/api/library/albums")).json()["items"][0]["id"],
                            "album-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/artists")).json()["items"][0]["id"],
                            "artist-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/albums?q=one")).json()["items"][0][
                                "id"
                            ],
                            "album-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/artists?q=artist")).json()["items"][0][
                                "id"
                            ],
                            "artist-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/tracks?q=track")).json()["items"][0][
                                "id"
                            ],
                            "song-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/playlists")).json()["items"][0]["id"],
                            "playlist-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/playlists/playlist-1")).json()["id"],
                            "playlist-1",
                        )
                        created = await client.post(
                            "/api/library/playlists",
                            json={"name": "Road trip", "song_ids": ["song-1"]},
                        )
                        self.assertEqual(created.status_code, 200)
                        self.assertEqual(created.json()["id"], "playlist-2")
                        renamed = await client.patch(
                            "/api/library/playlists/playlist-1", json={"name": "Morning"}
                        )
                        self.assertEqual(renamed.status_code, 200)
                        added = await client.post(
                            "/api/library/playlists/playlist-1/songs",
                            json={"song_id_to_add": "song-2"},
                        )
                        self.assertEqual(added.status_code, 200)
                        removed = await client.post(
                            "/api/library/playlists/playlist-1/songs",
                            json={"song_index_to_remove": 0},
                        )
                        self.assertEqual(removed.status_code, 200)
                        self.assertEqual(
                            (
                                await client.post(
                                    "/api/library/playlists/playlist-1/songs",
                                    json={"song_id_to_add": "song-1", "song_index_to_remove": 0},
                                )
                            ).status_code,
                            422,
                        )
                        self.assertEqual(
                            (await client.delete("/api/library/playlists/playlist-1")).status_code,
                            204,
                        )
                        self.assertEqual(
                            (await client.get("/api/library/albums/album-1")).json()["id"],
                            "album-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/artists/artist-1")).json()["id"],
                            "artist-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/library/artists/artist-1/tracks")).json()[
                                "items"
                            ][0]["id"],
                            "song-1",
                        )
                        self.assertEqual(
                            (await client.get("/api/player/song/song-1")).json()["id"], "song-1"
                        )
                        self.assertEqual(
                            (await client.get("/api/player/queue")).json()["current"], "song-1"
                        )
                        saved = await client.put(
                            "/api/player/queue",
                            json={
                                "ids": ["song-1", "song-2"],
                                "current": "song-1",
                                "position": 1200,
                            },
                        )
                        self.assertEqual(saved.status_code, 204)
                        self.assertEqual(
                            (
                                await client.put(
                                    "/api/player/queue",
                                    json={
                                        "ids": ["song-1"],
                                        "current": "song-2",
                                        "position": 0,
                                    },
                                )
                            ).status_code,
                            422,
                        )
                        self.assertEqual(
                            (
                                await client.post(
                                    "/api/player/scrobble",
                                    json={"id": "song-1", "submission": False},
                                )
                            ).status_code,
                            204,
                        )
                        self.assertEqual(
                            len((await client.get("/api/player/lyrics/song-1")).json()["items"]), 1
                        )
                        fallback_lyrics = (await client.get("/api/player/lyrics/no-lyrics")).json()[
                            "items"
                        ][0]
                        self.assertTrue(fallback_lyrics["synced"])
                        self.assertEqual(fallback_lyrics["line"][0]["start"], 1250)
                        self.assertEqual(
                            (await client.get("/api/player/radio/song-1?count=12")).json()["items"][
                                0
                            ]["entry"]["id"],
                            "song-2",
                        )
                        self.assertEqual(
                            (await client.get("/api/player/path?start=song-1&end=song-2")).json()[
                                "items"
                            ][0]["entry"]["id"],
                            "song-2",
                        )
                        radio_error = await client.get("/api/player/radio/radio-not-ready?count=12")
                        self.assertEqual(radio_error.status_code, 503)
                        self.assertEqual(
                            radio_error.json()["detail"],
                            "AudioMuse is not ready. Check that it is running, then wait for its "
                            "similarity index to finish building.",
                        )
                        audio = await client.get(
                            "/api/player/stream/song-1", headers={"Range": "bytes=2-5"}
                        )
                        self.assertEqual(audio.status_code, 206)
                        self.assertEqual(audio.content, b"udio")
                        self.assertEqual(audio.headers["content-range"], "bytes 2-5/8")
                        self.assertNotIn("x-upstream-secret", audio.headers)
                        art = await client.get("/api/player/art/song-1")
                        self.assertEqual(art.content, b"image")
                        self.assertEqual(art.headers["content-type"], "image/jpeg")
                        self.assertEqual(
                            (
                                await client.get(
                                    "/api/player/stream/song-1", headers={"Range": "items=1-2"}
                                )
                            ).status_code,
                            416,
                        )
                        self.assertEqual(
                            (await client.get("/api/library/albums/bad!id")).status_code, 422
                        )

            self.assertTrue(requests)
            for request in requests:
                if request.url.host == "lrclib.net":
                    continue
                self.assertEqual(request.url.params["u"], "listener")
                self.assertNotIn("private password", str(request.url))
            save_request = next(
                request for request in requests if request.url.path.endswith("/savePlayQueue")
            )
            self.assertEqual(save_request.url.params.get_list("id"), ["song-1", "song-2"])
            store.close()

    async def test_missing_configuration_is_a_capability_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "musimo.sqlite3")
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: httpx.Response(500))
            ) as upstream_client:
                navidrome = Navidrome(store, upstream_client)
                app = FastAPI()
                install_player_routes(app, lambda: navidrome)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as client:
                    response = await client.get("/api/player/capabilities")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(
                        response.json(),
                        {
                            "configured": False,
                            "available": False,
                            "version": "",
                            "extensions": [],
                            "sonic_similarity": False,
                            "detail": (
                                "Add a Navidrome address in Settings to enable library playback"
                            ),
                        },
                    )
                    store.update({"navidrome_url": "http://navidrome:4533"})
                    self.assertEqual(
                        (await client.get("/api/player/capabilities")).json()["detail"],
                        "Mount a Navidrome credentials file to enable library playback",
                    )
                    self.assertEqual((await client.get("/api/library/albums")).status_code, 503)
            store.close()

    def test_navidrome_url_rejects_credentials_and_non_http_schemes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "musimo.sqlite3")
            for value in (
                "file:///music",
                "http://user:password@navidrome:4533",
                "http://navidrome:4533?token=secret",
            ):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    store.update({"navidrome_url": value})
            store.update({"navidrome_url": "https://music.test/navidrome/"})
            self.assertEqual(
                store.settings()["navidrome_url"],
                {
                    "value": "https://music.test/navidrome/",
                    "origin": "database",
                    "locked": False,
                },
            )
            store.close()


if __name__ == "__main__":
    unittest.main()
