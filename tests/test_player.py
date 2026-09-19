import asyncio
import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.navidrome import Navidrome, sort_artists
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
                if path.endswith("/getAlbumList2"):
                    return subsonic(albumList2={"album": [{"id": "album-1", "name": "One"}]})
                if path.endswith("/getArtists"):
                    return subsonic(
                        artists={
                            "index": [
                                {"name": "A", "artist": [{"id": "artist-1", "name": "Artist"}]}
                            ]
                        }
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
                        # Navidrome keeps 500 songs, and the queue editor relies on the last one
                        # being accepted and the next being refused.
                        for count, status in ((500, 204), (501, 422)):
                            self.assertEqual(
                                (
                                    await client.put(
                                        "/api/player/queue",
                                        json={
                                            "ids": [f"song-{n}" for n in range(count)],
                                            "current": "song-1",
                                            "position": 0,
                                        },
                                    )
                                ).status_code,
                                status,
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

    async def test_artist_without_a_photo_shows_their_newest_album_cover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            star = b"star"
            art = {"ar-pictured_0": b"photo", "al-new": b"new cover", "al-old": b"old cover"}
            albums = {
                "photoless": [
                    {"id": "old", "coverArt": "al-old", "year": 2010},
                    {"id": "bare", "coverArt": "al-bare", "year": 2024},
                    {"id": "new", "coverArt": "al-new", "year": 2020},
                    {"id": "none"},
                ],
                "coverless": [{"id": "bare", "coverArt": "al-bare", "year": 2024}],
            }

            def upstream(request: httpx.Request) -> httpx.Response:
                cover_id = request.url.params.get("id", "")
                if request.url.path.endswith("/getArtist"):
                    return subsonic(artist={"id": cover_id, "album": albums[cover_id]})
                # Navidrome answers anything it has no picture for with the same star.
                return httpx.Response(200, content=art.get(cover_id, star))

            with (
                patch.dict("os.environ", {"MUSIMO_NAVIDROME_CREDENTIALS_FILE": str(credentials)}),
                patch("backend.navidrome.PLACEHOLDER_ART", {hashlib.sha256(star).hexdigest()}),
            ):
                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(upstream)
                ) as upstream_client:
                    navidrome = Navidrome(store, upstream_client)
                    app = FastAPI()
                    install_player_routes(app, lambda: navidrome)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app), base_url="http://test"
                    ) as client:

                        async def picture(cover_id: str) -> bytes:
                            return (await client.get(f"/api/player/art/{cover_id}")).content

                        self.assertEqual(await picture("ar-photoless_0"), b"new cover")
                        self.assertEqual(await picture("ar-pictured_0"), b"photo")
                        self.assertEqual(await picture("ar-coverless_0"), star)
                        self.assertEqual(await picture("al-bare"), star)
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

    async def test_linked_playlist_route_creates_and_reuses_default(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            requests = {"created": 0}

            def upstream(request: httpx.Request) -> httpx.Response:
                path = request.url.path
                if path.endswith("/ping"):
                    return subsonic(serverVersion="0.63.0")
                if path.endswith("/getPlaylists"):
                    return subsonic(playlists={"playlist": []})
                if path.endswith("/createPlaylist"):
                    requests["created"] += 1
                    return subsonic(
                        playlist={
                            "id": f"liked-{requests['created']}",
                            "name": "Liked",
                            "entry": [],
                        }
                    )
                if path.endswith("/getPlaylist"):
                    return subsonic(
                        playlist={"id": request.url.params.get("id"), "name": "Liked", "entry": []}
                    )
                return subsonic()

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
                        first = (await client.get("/api/library/playlists/liked")).json()
                        second = (await client.get("/api/library/playlists/liked")).json()
                        self.assertEqual(first["id"], second["id"])
                        self.assertEqual(first["name"], "Liked")
                        self.assertEqual(requests["created"], 1)
            store.close()

    async def test_artist_browsing_filters_by_what_their_albums_carry(self) -> None:
        artists = [
            {"id": "zia", "name": "Zia", "albumCount": 1},
            {"id": "mox", "name": "Mox", "albumCount": 3, "starred": "2026-01-01T00:00:00Z"},
            {"id": "ame", "name": "Ame", "albumCount": 2, "sortName": "Ame"},
        ]
        albums = [
            {"id": "a1", "artistId": "zia", "genre": "Jazz", "year": 1999, "created": "2026-03"},
            {
                "id": "a2",
                "artistId": "mox",
                "genres": [{"name": "Rock"}, {"name": "jazz"}],
                "year": 2011,
                "created": "2026-01",
                "playCount": 4,
            },
            # A shared album counts for every artist on it.
            {
                "id": "a3",
                "artists": [{"id": "ame"}, {"id": "zia"}],
                "genre": "Soul",
                "year": 2011,
                "created": "2026-02",
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            walks = {"count": 0}
            stars: list[tuple[str, str]] = []

            def upstream(request: httpx.Request) -> httpx.Response:
                path = request.url.path
                if path.endswith("/getArtists"):
                    walks["count"] += 1
                    return subsonic(artists={"index": [{"name": "A", "artist": artists}]})
                if path.endswith("/getAlbumList2"):
                    offset = int(request.url.params.get("offset", 0))
                    return subsonic(albumList2={"album": albums[offset:]})
                if path.endswith("/star") or path.endswith("/unstar"):
                    stars.append((path.rsplit("/", 1)[1], request.url.params["artistId"]))
                    return subsonic()
                return subsonic()

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

                        async def names(search: str) -> list[str]:
                            response = await client.get(f"/api/library/artists?{search}")
                            return [row["name"] for row in response.json()["items"]]

                        listing = (await client.get("/api/library/artists")).json()
                        self.assertEqual(
                            [row["name"] for row in listing["items"]], ["Ame", "Mox", "Zia"]
                        )
                        self.assertEqual(listing["total"], 3)
                        self.assertEqual(listing["genres"], ["Jazz", "Rock", "Soul"])
                        self.assertEqual(listing["years"], [2011, 1999])
                        self.assertEqual(await names("genre=JAZZ"), ["Mox", "Zia"])
                        self.assertEqual(await names("year=2011"), ["Ame", "Mox", "Zia"])
                        self.assertEqual(await names("genre=Soul&year=2011"), ["Ame", "Zia"])
                        self.assertEqual(await names("show=played"), ["Mox"])
                        self.assertEqual(await names("show=unplayed"), ["Ame", "Zia"])
                        self.assertEqual(await names("show=favourites"), ["Mox"])
                        self.assertEqual(await names("q=m"), ["Ame", "Mox"])
                        self.assertEqual(await names("sort=albums"), ["Mox", "Ame", "Zia"])
                        self.assertEqual(await names("sort=recent"), ["Zia", "Ame", "Mox"])
                        page = (await client.get("/api/library/artists?offset=1&size=1")).json()
                        self.assertEqual(page["next_offset"], 2)
                        self.assertEqual(
                            (await client.get("/api/library/artists?sort=plays")).status_code, 422
                        )
                        self.assertEqual(
                            (await client.get("/api/library/artists?show=everyone")).status_code,
                            422,
                        )

                        put = await client.put("/api/library/artists/zia/favourite")
                        self.assertEqual(put.status_code, 204)
                        self.assertEqual(await names("show=favourites"), ["Mox", "Zia"])
                        await client.delete("/api/library/artists/mox/favourite")
                        self.assertEqual(await names("show=favourites"), ["Zia"])
                        self.assertEqual(stars, [("star", "zia"), ("unstar", "mox")])
                        # Every call above came from one walk of the library.
                        self.assertEqual(walks["count"], 1)
                        navidrome.forget_tracks()
                        await client.get("/api/library/artists")
                        self.assertEqual(walks["count"], 2)
            store.close()

    async def test_album_browsing_filters_and_sorts_the_whole_library(self) -> None:
        albums = [
            {
                "id": "b",
                "name": "Stone 10",
                "artist": "Zia",
                "genre": "Jazz",
                "year": 1999,
                "created": "2026-03",
            },
            {
                "id": "a",
                "name": "Stone 9",
                "artist": "Mox",
                "genres": [{"name": "Rock"}],
                "year": 2011,
                "created": "2026-01",
            },
            {
                "id": "c",
                "name": "Anchor",
                "artist": "Ame",
                "genre": "jazz",
                "year": 2011,
                "created": "2026-02",
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )

            def upstream(request: httpx.Request) -> httpx.Response:
                if request.url.path.endswith("/getAlbumList2"):
                    offset = int(request.url.params.get("offset", 0))
                    return subsonic(albumList2={"album": albums[offset:]})
                return subsonic(artists={"index": []})

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

                        async def ids(search: str) -> list[str]:
                            response = await client.get(f"/api/library/albums?{search}")
                            return [row["id"] for row in response.json()["items"]]

                        listing = (await client.get("/api/library/albums")).json()
                        self.assertEqual([row["id"] for row in listing["items"]], ["b", "c", "a"])
                        self.assertEqual(listing["total"], 3)
                        self.assertEqual(listing["genres"], ["Jazz", "Rock"])
                        self.assertEqual(listing["years"], [2011, 1999])
                        self.assertEqual(await ids("sort=title"), ["c", "a", "b"])
                        self.assertEqual(await ids("sort=artist"), ["c", "a", "b"])
                        self.assertEqual(await ids("sort=year"), ["c", "a", "b"])
                        self.assertEqual(await ids("genre=JAZZ"), ["b", "c"])
                        self.assertEqual(await ids("year=2011&sort=title"), ["c", "a"])
                        self.assertEqual(await ids("q=zia"), ["b"])
                        self.assertEqual(await ids("q=stone&sort=title"), ["a", "b"])
                        self.assertEqual(
                            (await client.get("/api/library/albums?sort=random")).status_code,
                            422,
                        )
            store.close()

    async def test_media_errors_are_not_passed_on_as_media(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            drawing = b"<svg xmlns='http://www.w3.org/2000/svg'/>" * 20

            def upstream(request: httpx.Request) -> httpx.Response:
                cover_id = request.url.params.get("id")
                if cover_id == "gone":
                    # What Navidrome sends for an item it does not have.
                    return httpx.Response(
                        200,
                        content=gzip.compress(b'{"subsonic-response":{"status":"failed"}}'),
                        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
                    )
                packed = gzip.compress(drawing)
                return httpx.Response(
                    200,
                    content=packed,
                    headers={
                        "Content-Type": "image/svg+xml",
                        "Content-Encoding": "gzip",
                        "Content-Length": str(len(packed)),
                    },
                )

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
                        self.assertEqual(
                            (await client.get("/api/player/art/gone")).status_code, 503
                        )
                        # The body arrives decoded, so the compressed length must not go with it.
                        art = await client.get("/api/player/art/drawing")
                        self.assertEqual(art.content, drawing)
                        self.assertNotEqual(
                            art.headers.get("content-length"), str(len(gzip.compress(drawing)))
                        )
            store.close()

    def test_artist_names_sort_numbers_as_numbers(self) -> None:
        rows: list[dict[str, object]] = [
            {"name": "311"},
            {"name": "100mg"},
            {"name": "9 Theory"},
            {"name": "Abba", "sortName": "abba"},
        ]
        self.assertEqual(
            [row["name"] for row in sort_artists(rows, {}, "name")],
            ["9 Theory", "100mg", "311", "Abba"],
        )

    async def test_track_browsing_filters_sorts_and_shuffles_the_whole_library(self) -> None:
        library = [
            {
                "id": "s1",
                "title": "Beacon",
                "artist": "Zia",
                "genre": "Jazz",
                "year": 1999,
                # The browser never reads this, so the snapshot does not keep it.
                "path": "Zia/Beacon.flac",
            },
            {"id": "s2", "title": "Anchor", "artist": "Mox", "genre": "Rock", "year": 2011},
            {"id": "s3", "title": "Cinder", "artist": "Ame", "genre": "Jazz", "year": 2011},
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            searches = {"count": 0}

            def upstream(request: httpx.Request) -> httpx.Response:
                path = request.url.path
                if path.endswith("/ping"):
                    return subsonic(serverVersion="0.63.0")
                if path.endswith("/search3"):
                    searches["count"] += 1
                    offset = int(request.url.params.get("songOffset", 0))
                    return subsonic(searchResult3={"song": library[offset:]})
                return subsonic()

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
                        listing = (await client.get("/api/library/tracks")).json()
                        self.assertEqual(
                            [row["id"] for row in listing["items"]], ["s2", "s1", "s3"]
                        )
                        self.assertNotIn("path", listing["items"][1])
                        self.assertEqual(listing["total"], 3)
                        self.assertEqual(listing["genres"], ["Jazz", "Rock"])
                        self.assertEqual(listing["years"], [2011, 1999])
                        by_artist = (await client.get("/api/library/tracks?sort=artist")).json()
                        self.assertEqual(
                            [row["id"] for row in by_artist["items"]], ["s3", "s2", "s1"]
                        )
                        # Sorting and totals must cover the library, not the requested page.
                        page = (await client.get("/api/library/tracks?size=1&offset=1")).json()
                        self.assertEqual([row["id"] for row in page["items"]], ["s1"])
                        self.assertEqual(page["next_offset"], 2)
                        self.assertEqual(page["total"], 3)
                        filtered = (
                            await client.get("/api/library/tracks?genre=Jazz&year=2011")
                        ).json()
                        self.assertEqual([row["id"] for row in filtered["items"]], ["s3"])
                        self.assertEqual(filtered["total"], 1)
                        self.assertEqual(filtered["genres"], ["Jazz", "Rock"])
                        selection = (
                            await client.get("/api/library/tracks/selection?sort=year&limit=2")
                        ).json()
                        self.assertEqual([row["id"] for row in selection["items"]], ["s2", "s3"])
                        self.assertEqual(selection["total"], 3)
                        shuffled = (
                            await client.get("/api/library/tracks/selection?shuffle=true")
                        ).json()
                        self.assertEqual(
                            sorted(row["id"] for row in shuffled["items"]), ["s1", "s2", "s3"]
                        )
                        cached = searches["count"]
                        await client.get("/api/library/tracks")
                        self.assertEqual(searches["count"], cached)
                        # A library inside one page costs one upstream request, not a
                        # speculative fan-out, and concurrent callers share that one walk.
                        navidrome.forget_tracks()
                        searches["count"] = 0
                        await asyncio.gather(
                            client.get("/api/library/tracks"),
                            client.get("/api/library/tracks/selection"),
                        )
                        self.assertEqual(searches["count"], 1)
                        # The picker endpoint asks Navidrome directly instead of walking.
                        navidrome.forget_tracks()
                        searches["count"] = 0
                        picker = (await client.get("/api/library/tracks/search?q=cinder")).json()
                        self.assertEqual([row["id"] for row in picker["items"]], ["s1", "s2", "s3"])
                        self.assertEqual(searches["count"], 1)
                        self.assertEqual(
                            (await client.get("/api/library/tracks")).json()["total"], 3
                        )
                        # A scan changes what search3 returns, so the snapshot is dropped.
                        searches["count"] = 0
                        await navidrome.start_scan("1:Artist/Album")
                        await client.get("/api/library/tracks")
                        self.assertGreater(searches["count"], 0)
                        self.assertEqual(
                            (await client.get("/api/library/tracks?sort=nonsense")).status_code, 422
                        )
            store.close()

    async def test_linked_liked_playlist_is_reported_without_creating_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "musimo.sqlite3")
            store.update({"navidrome_url": "http://navidrome:4533"})
            credentials = root / "navidrome.json"
            credentials.write_text(
                json.dumps({"username": "listener", "password": "private password"}),
                encoding="utf-8",
            )
            deleted: list[str] = []
            created: list[str] = []

            def upstream(request: httpx.Request) -> httpx.Response:
                path = request.url.path
                if path.endswith("/getPlaylists"):
                    return subsonic(
                        playlists={
                            "playlist": [
                                {"id": "p1", "name": "Road trip", "songCount": 4},
                                {"id": "p2", "name": "Liked", "songCount": 9},
                            ]
                        }
                    )
                if path.endswith("/createPlaylist"):
                    created.append(str(request.url.params.get("name")))
                    return subsonic(playlist={"id": "p3", "name": "Liked", "entry": []})
                if path.endswith("/deletePlaylist"):
                    deleted.append(str(request.url.params.get("id")))
                return subsonic()

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
                        # Nothing is linked yet, so listing reports no liked playlist and
                        # creates none: a playlist merely named Liked is still deletable.
                        unlinked = (await client.get("/api/library/playlists")).json()
                        self.assertEqual(unlinked["liked_id"], "")
                        self.assertEqual(created, [])
                        self.assertEqual(
                            (await client.delete("/api/library/playlists/p2")).status_code, 204
                        )

                        store.set_linked_playlist("liked", "p2")
                        listing = (await client.get("/api/library/playlists")).json()
                        self.assertEqual(listing["liked_id"], "p2")
                        self.assertEqual([row["id"] for row in listing["items"]], ["p1", "p2"])
                        self.assertEqual(created, [])
                        refused = await client.delete("/api/library/playlists/p2")
                        self.assertEqual(refused.status_code, 409)
                        self.assertEqual(
                            refused.json()["detail"], "The liked playlist cannot be deleted"
                        )
                        self.assertEqual(
                            (await client.delete("/api/library/playlists/p1")).status_code, 204
                        )
                        self.assertEqual(deleted, ["p2", "p1"])
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
