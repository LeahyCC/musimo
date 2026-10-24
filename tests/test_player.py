"""The local player: browse, stream, art, lyrics and library state, from files on disk."""

import asyncio
import tempfile
import threading
import time
import unittest
import wave
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from mutagen.id3 import (
    APIC,
    ID3,
    TALB,
    TCMP,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TPUB,
    TRCK,
    TXXX,
    USLT,
)
from mutagen.wave import WAVE

from backend.api.player_api import install_player_routes
from backend.core.job_models import Metadata
from backend.core.store import Store
from backend.integrations.catalog import Catalog
from backend.jobs.downloads import Downloads
from backend.library.browse import sort_artists
from backend.library.index import Library
from backend.library.player import (
    PLAYING,
    SHUFFLE_GUARD,
    SHUFFLE_ID_LIMIT,
    SHUFFLE_ORDER_SECONDS,
    UNMOUNTED,
    FolderCover,
    LibraryView,
    Player,
    StoredSong,
)
from backend.version import VERSION


def write_wav(path: Path, frames: int = 800) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\0\0" * frames)


def tag_from(path: Path, fields: dict[str, object]) -> None:
    genres = fields.get("genres")
    tag(
        path,
        title=str(fields["title"]),
        artist=str(fields["artist"]),
        album=str(fields.get("album") or ""),
        album_artist=str(fields.get("album_artist") or ""),
        track=str(fields.get("track") or ""),
        year=str(fields.get("year") or ""),
        genres=[str(item) for item in genres] if isinstance(genres, list) else None,
        compilation=bool(fields.get("compilation")),
        label=str(fields.get("label") or ""),
    )


def tag(path: Path, **fields: object) -> None:
    audio = WAVE(path)
    audio.add_tags()
    assert isinstance(audio.tags, ID3)
    tags = audio.tags
    tags.add(TIT2(encoding=3, text=str(fields["title"])))
    tags.add(TPE1(encoding=3, text=str(fields["artist"])))
    if fields.get("album"):
        tags.add(TALB(encoding=3, text=str(fields["album"])))
    if fields.get("album_artist"):
        tags.add(TPE2(encoding=3, text=str(fields["album_artist"])))
    if fields.get("track"):
        tags.add(TRCK(encoding=3, text=str(fields["track"])))
    if fields.get("disc"):
        tags.add(TPOS(encoding=3, text=str(fields["disc"])))
    if fields.get("year"):
        tags.add(TDRC(encoding=3, text=str(fields["year"])))
    genres = fields.get("genres")
    if isinstance(genres, list) and genres:
        tags.add(TCON(encoding=3, text=[str(genre) for genre in genres]))
    if fields.get("compilation"):
        tags.add(TCMP(encoding=3, text="1"))
    if fields.get("gain"):
        tags.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text=str(fields["gain"])))
    if fields.get("album_gain"):
        tags.add(TXXX(encoding=3, desc="REPLAYGAIN_ALBUM_GAIN", text=str(fields["album_gain"])))
    if fields.get("peak"):
        tags.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_PEAK", text=str(fields["peak"])))
    if fields.get("label"):
        tags.add(TPUB(encoding=3, text=str(fields["label"])))
    if fields.get("lyrics"):
        tags.add(USLT(encoding=3, lang="eng", desc="", text=str(fields["lyrics"])))
    pictures = fields.get("pictures")
    if isinstance(pictures, list):
        for kind, data in pictures:
            tags.add(APIC(encoding=3, mime="image/jpeg", type=int(kind), desc="", data=data))
    audio.save()


class PlayerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.music = self.base / "music"
        self.music.mkdir()
        self.store = Store(self.base / "musimo.sqlite3")
        self.library = Library(self.store, [self.music], asyncio.Event())
        self.player = Player(self.store, [self.music])

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    def titles(self) -> dict[str, str]:
        return {
            str(row["title"]): str(row["song_id"])
            for row in self.store.db.execute("SELECT title, song_id FROM library_files")
        }

    def stamp(self, title: str, added: str) -> None:
        self.store.db.execute("UPDATE library_files SET added_at=? WHERE title=?", (added, title))

    @asynccontextmanager
    async def api(self, player: Player | None = None) -> AsyncIterator[httpx.AsyncClient]:
        app = FastAPI()
        install_player_routes(app, lambda: self.player if player is None else player)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            yield client

    async def test_queue_writer_rejects_delayed_and_previous_browser_saves(self) -> None:
        path = self.music / "kept.wav"
        write_wav(path)
        tag(path, title="Kept", artist="Fixture")
        self.library.scan()
        sid = self.titles()["Kept"]
        async with self.api() as client:
            epoch = (await client.post("/api/player/queue/writer")).json()["epoch"]
            undo = {"ids": [sid], "current": sid, "position": 4200, "epoch": epoch, "sequence": 3}
            self.assertEqual((await client.put("/api/player/queue", json=undo)).status_code, 204)
            for sequence in [1, 2, 3]:
                response = await client.put(
                    "/api/player/queue",
                    json={
                        "ids": [],
                        "epoch": epoch,
                        "sequence": sequence,
                    },
                )
                self.assertEqual(response.status_code, 409)
            saved = (await client.get("/api/player/queue")).json()
            self.assertEqual(saved["position"], 4200)
            self.assertEqual(saved["current"], sid)
            self.assertEqual([song["id"] for song in saved["entry"]], [sid])
            await client.post("/api/player/queue/writer")
            self.assertEqual(
                (await client.put("/api/player/queue", json=undo | {"sequence": 100})).status_code,
                409,
            )
            self.assertEqual(
                (
                    await client.put("/api/player/queue", json={"ids": [], "sequence": 5})
                ).status_code,
                422,
            )

    async def test_capabilities_follow_the_music_folder(self) -> None:
        async with self.api() as client:
            ready = (await client.get("/api/player/capabilities")).json()
        self.assertEqual(
            ready,
            {
                "configured": True,
                "available": True,
                "version": VERSION,
                "detail": PLAYING,
            },
        )
        unmounted = await Player(self.store, [self.base / "missing"]).capabilities()
        self.assertEqual(unmounted["configured"], True)
        self.assertEqual(unmounted["available"], False)
        self.assertEqual(unmounted["detail"], UNMOUNTED)
        self.assertEqual(unmounted["version"], VERSION)
        absent = await Player(self.store, []).capabilities()
        self.assertEqual(absent["configured"], False)
        self.assertEqual(absent["available"], False)
        self.assertEqual(absent["detail"], UNMOUNTED)
        self.assertNotIn("playback server", str(ready["detail"]) + str(unmounted["detail"]))

    async def test_two_callers_share_one_catalog_build(self) -> None:
        started = threading.Event()
        release = threading.Event()
        calls = 0
        real = self.player._build

        def counting(
            songs: list[StoredSong],
            covers: dict[str, FolderCover],
            favourites: Mapping[str, str],
            revision: int,
            token: int,
        ) -> LibraryView:
            nonlocal calls
            calls += 1
            started.set()
            self.assertTrue(release.wait(2))
            return real(songs, covers, favourites, revision, token)

        with patch.object(self.player, "_build", counting):
            first = asyncio.create_task(asyncio.to_thread(self.player.view))
            await asyncio.to_thread(started.wait, 2)
            second = asyncio.create_task(asyncio.to_thread(self.player.view))
            await asyncio.sleep(0.05)
            release.set()
            await first
            await second
        self.assertEqual(calls, 1)

    async def test_a_warm_catalog_serves_the_first_page(self) -> None:
        path = self.music / "Warm" / "Song.wav"
        write_wav(path)
        tag(path, title="Song", artist="Warm", album="Ready", album_artist="Warm")
        self.library.scan()
        self.assertIsNone(self.player._cached)
        await self.player.warm()
        self.assertIsNotNone(self.player._cached)
        with (
            patch.object(self.player, "_build", side_effect=AssertionError),
            patch("backend.library.player.sort_albums", side_effect=AssertionError),
            patch("backend.library.player.sort_tracks", side_effect=AssertionError),
        ):
            async with self.api() as client:
                albums = (
                    await client.get("/api/library/albums?sort=newest&offset=0&size=6")
                ).json()
                tracks = (
                    await client.get("/api/library/tracks?sort=title&offset=0&size=10")
                ).json()
        self.assertEqual(albums["total"], 1)
        self.assertEqual(albums["items"][0]["name"], "Ready")
        self.assertEqual(tracks["total"], 1)
        self.assertEqual(tracks["items"][0]["title"], "Song")

    async def test_albums_filter_and_sort_across_the_library(self) -> None:
        for album, artist, title, year, genres in (
            ("Stone 10", "Zia", "Beacon", "1999", ["Jazz"]),
            ("Stone 9", "Mox", "Anchor", "2011", ["Rock"]),
            ("Anchor", "Ame", "Cinder", "2011", ["jazz"]),
        ):
            path = self.music / artist / album / f"{title}.wav"
            write_wav(path)
            tag(
                path,
                title=title,
                artist=artist,
                album=album,
                album_artist=artist,
                year=year,
                genres=genres,
            )
        self.library.scan()
        for title, added in (
            ("Beacon", "2026-03-01T00:00:00.000Z"),
            ("Cinder", "2026-02-01T00:00:00.000Z"),
            ("Anchor", "2026-01-01T00:00:00.000Z"),
        ):
            self.stamp(title, added)

        async with self.api() as client:

            async def names(search: str) -> list[str]:
                body = (await client.get(f"/api/library/albums?{search}")).json()
                return [row["name"] for row in body["items"]]

            listing = (await client.get("/api/library/albums")).json()
            self.assertEqual(
                [row["name"] for row in listing["items"]], ["Stone 10", "Anchor", "Stone 9"]
            )
            self.assertEqual(listing["total"], 3)
            self.assertEqual([genre.casefold() for genre in listing["genres"]], ["jazz", "rock"])
            self.assertEqual(listing["years"], [2011, 1999])
            self.assertEqual(await names("sort=title"), ["Anchor", "Stone 9", "Stone 10"])
            self.assertEqual(await names("sort=artist"), ["Anchor", "Stone 9", "Stone 10"])
            self.assertEqual(await names("sort=year"), ["Anchor", "Stone 9", "Stone 10"])
            self.assertEqual(await names("genre=JAZZ"), ["Stone 10", "Anchor"])
            self.assertEqual(await names("year=2011&sort=title"), ["Anchor", "Stone 9"])
            self.assertEqual(await names("q=zia"), ["Stone 10"])
            self.assertEqual(await names("q=stone&sort=title"), ["Stone 9", "Stone 10"])
            self.assertEqual((await client.get("/api/library/albums?sort=random")).status_code, 422)

    async def test_artists_follow_album_artists_and_what_their_albums_carry(self) -> None:
        rows = (
            ("Zia", "Stone", "Beacon", "1999", ["Jazz"], "2026-03-01T00:00:00.000Z"),
            ("Mox", "Stone", "Anchor", "2011", ["Rock", "jazz"], "2026-01-01T00:00:00.000Z"),
            ("Mox", "Extra", "Bonus", "2011", ["Rock"], "2020-01-01T00:00:00.000Z"),
            ("Ame", "Soul", "Cinder", "2011", ["Soul"], "2026-02-01T00:00:00.000Z"),
        )
        for artist, album, title, year, genres, _added in rows:
            path = self.music / artist / album / f"{title}.wav"
            write_wav(path)
            tag(
                path,
                title=title,
                artist=artist,
                album=album,
                album_artist=artist,
                year=year,
                genres=genres,
            )
        self.library.scan()
        for row in rows:
            self.stamp(str(row[2]), str(row[5]))
        ids = self.titles()

        async with self.api() as client:
            await client.post(
                "/api/player/scrobble", json={"id": ids["Anchor"], "submission": True}
            )
            listing = (await client.get("/api/library/artists")).json()
            by_name = {row["name"]: row for row in listing["items"]}
            await client.put(f"/api/library/artists/{by_name['Mox']['id']}/favourite")

            async def names(search: str) -> list[str]:
                body = (await client.get(f"/api/library/artists?{search}")).json()
                return [row["name"] for row in body["items"]]

            self.assertEqual(await names(""), ["Ame", "Mox", "Zia"])
            self.assertEqual((await client.get("/api/library/artists")).json()["total"], 3)
            facets = (await client.get("/api/library/artists")).json()
            self.assertEqual(
                [genre.casefold() for genre in facets["genres"]], ["jazz", "rock", "soul"]
            )
            self.assertEqual(facets["years"], [2011, 1999])
            self.assertEqual(
                facets["letters"],
                [
                    {"letter": "A", "offset": 0},
                    {"letter": "M", "offset": 1},
                    {"letter": "Z", "offset": 2},
                ],
            )
            self.assertEqual(
                (await client.get("/api/library/artists?sort=albums")).json()["letters"], []
            )
            self.assertEqual(await names("genre=JAZZ"), ["Mox", "Zia"])
            self.assertEqual(await names("year=2011"), ["Ame", "Mox"])
            self.assertEqual(await names("genre=Soul&year=2011"), ["Ame"])
            self.assertEqual(await names("show=played"), ["Mox"])
            self.assertEqual(await names("show=unplayed"), ["Ame", "Zia"])
            self.assertEqual(await names("show=favourites"), ["Mox"])
            self.assertEqual(await names("q=m"), ["Ame", "Mox"])
            self.assertEqual(await names("sort=albums"), ["Mox", "Ame", "Zia"])
            self.assertEqual(await names("sort=recent"), ["Zia", "Ame", "Mox"])
            scrambled = await names("sort=scramble&seed=7")
            self.assertEqual(sorted(scrambled), ["Ame", "Mox", "Zia"])
            # The same seed deals the same order again, or paging would repeat artists.
            self.assertEqual(await names("sort=scramble&seed=7"), scrambled)
            self.assertEqual(
                (await client.get("/api/library/artists?sort=scramble&seed=7")).json()["letters"],
                [],
            )
            page = (await client.get("/api/library/artists?offset=1&size=1")).json()
            self.assertEqual(page["items"][0]["name"], "Mox")
            self.assertEqual(page["next_offset"], 2)
            self.assertEqual((await client.get("/api/library/artists?sort=plays")).status_code, 422)
            self.assertEqual(
                (await client.get("/api/library/artists?show=everyone")).status_code, 422
            )
            await client.put(f"/api/library/artists/{by_name['Zia']['id']}/favourite")
            await client.delete(f"/api/library/artists/{by_name['Mox']['id']}/favourite")
            self.assertEqual(await names("show=favourites"), ["Zia"])

    async def test_album_identity_and_artist_links(self) -> None:
        files: list[tuple[str, dict[str, object]]] = [
            (
                "ACDC/Back/thunder.wav",
                dict(title="Thunder", artist="AC/DC", album="Back in Black", album_artist="AC/DC"),
            ),
            (
                "Someone/Mix/feature.wav",
                dict(
                    title="Feature",
                    artist="Guest feat. AC/DC",
                    album="Mixtape",
                    album_artist="Someone",
                ),
            ),
            (
                "Rock/Roll/tune.wav",
                dict(title="Tune", artist="Rock & Roll", album="Roll", album_artist="Rock & Roll"),
            ),
            (
                "Comp/Album/one.wav",
                dict(title="Compilation", artist="Various Track", album="Comp", compilation=True),
            ),
            ("Loose/A/a.wav", dict(title="Loose A", artist="Loose")),
            ("Loose/B/b.wav", dict(title="Loose B", artist="Loose")),
            (
                "Same/One/left.wav",
                dict(
                    title="Left",
                    artist="Same",
                    album="Shared",
                    album_artist="Same",
                    year="1990",
                    track="1",
                ),
            ),
            (
                "Same/Two/right.wav",
                dict(
                    title="Right",
                    artist="Same",
                    album="Shared",
                    album_artist="Same",
                    year="2020",
                    track="2",
                    label="Static Records",
                ),
            ),
        ]
        for relative, fields in files:
            path = self.music / relative
            write_wav(path)
            tag_from(path, fields)
        self.library.scan()

        async with self.api() as client:
            artists = (await client.get("/api/library/artists?size=50")).json()["items"]
            names = {row["name"] for row in artists}
            self.assertIn("AC/DC", names)
            self.assertIn("Rock & Roll", names)
            self.assertIn("Various Artists", names)
            self.assertNotIn("AC", names)
            self.assertNotIn("DC", names)
            self.assertNotIn("Guest", names)
            self.assertNotIn("Rock", names)
            tracks = {
                row["title"]: row
                for row in (await client.get("/api/library/tracks?size=50")).json()["items"]
            }
            self.assertEqual(tracks["Feature"]["artistId"], tracks["Thunder"]["artistId"])
            self.assertEqual(tracks["Feature"]["artist"], "Guest feat. AC/DC")
            albums = {
                row["name"]: row
                for row in (await client.get("/api/library/albums?size=50")).json()["items"]
            }
            self.assertEqual(albums["Comp"]["artist"], "Various Artists")
            self.assertEqual(albums["Shared"]["songCount"], 2)
            self.assertEqual(albums["Shared"]["year"], 2020)
            loose = [row["name"] for row in albums.values() if row["artist"] == "Loose"]
            self.assertEqual(sorted(loose), ["A", "B"])
            detail = (await client.get(f"/api/library/albums/{albums['Shared']['id']}")).json()
            self.assertEqual([row["title"] for row in detail["song"]], ["Left", "Right"])
            self.assertEqual(detail["recordLabels"], [{"name": "Static Records"}])
            various = next(row for row in artists if row["name"] == "Various Artists")
            self.assertEqual(tracks["Compilation"]["artistId"], various["id"])
            acdc = next(row for row in artists if row["name"] == "AC/DC")
            acdc_tracks = (await client.get(f"/api/library/artists/{acdc['id']}/tracks")).json()
            self.assertEqual([row["title"] for row in acdc_tracks["items"]], ["Thunder"])

    async def test_tracks_filter_sort_and_shuffle(self) -> None:
        for artist, album, title, year, genres, gain in (
            ("Zia", "One", "Beacon", "1999", ["Jazz"], {}),
            (
                "Mox",
                "Two",
                "Anchor",
                "2011",
                ["Rock"],
                {"gain": "-6.5 dB", "album_gain": "-7.25 dB", "peak": "0.98"},
            ),
            ("Ame", "Three", "Cinder", "2011", ["Jazz"], {}),
        ):
            path = self.music / artist / f"{title}.wav"
            write_wav(path)
            tag(
                path,
                title=title,
                artist=artist,
                album=album,
                album_artist=artist,
                year=year,
                genres=genres,
                **gain,
            )
        self.library.scan()
        ids = self.titles()

        async with self.api() as client:
            listing = (await client.get("/api/library/tracks")).json()
            self.assertEqual(
                [row["title"] for row in listing["items"]], ["Anchor", "Beacon", "Cinder"]
            )
            self.assertNotIn("path", listing["items"][0])
            anchor = next(row for row in listing["items"] if row["title"] == "Anchor")
            beacon = next(row for row in listing["items"] if row["title"] == "Beacon")
            self.assertEqual(
                anchor["replayGain"], {"trackGain": -6.5, "albumGain": -7.25, "trackPeak": 0.98}
            )
            self.assertNotIn("replayGain", beacon)
            self.assertEqual(listing["total"], 3)
            self.assertEqual([genre.casefold() for genre in listing["genres"]], ["jazz", "rock"])
            self.assertEqual(listing["years"], [2011, 1999])
            by_artist = (await client.get("/api/library/tracks?sort=artist")).json()
            self.assertEqual(
                [row["title"] for row in by_artist["items"]], ["Cinder", "Anchor", "Beacon"]
            )
            page = (await client.get("/api/library/tracks?size=1&offset=1")).json()
            self.assertEqual(page["items"][0]["title"], "Beacon")
            self.assertEqual(page["next_offset"], 2)
            self.assertEqual(page["total"], 3)
            filtered = (await client.get("/api/library/tracks?genre=Jazz&year=2011")).json()
            self.assertEqual([row["title"] for row in filtered["items"]], ["Cinder"])
            self.assertEqual(filtered["total"], 1)
            self.assertEqual([genre.casefold() for genre in filtered["genres"]], ["jazz", "rock"])
            selection = (await client.get("/api/library/tracks/selection?sort=year&limit=2")).json()
            self.assertEqual([row["title"] for row in selection["items"]], ["Anchor", "Cinder"])
            self.assertEqual(selection["total"], 3)
            shuffled = (await client.get("/api/library/tracks/selection?shuffle=true")).json()
            self.assertEqual(
                sorted(row["title"] for row in shuffled["items"]), ["Anchor", "Beacon", "Cinder"]
            )
            self.assertEqual(shuffled["rest"], [])
            self.assertEqual(shuffled["seed"], "")
            self.assertEqual(shuffled["cursor"], 3)
            window = (await client.get("/api/library/tracks/selection?shuffle=true&limit=2")).json()
            self.assertEqual(len(window["items"]), 2)
            self.assertEqual(window["rest"], [])
            self.assertEqual(window["total"], 3)
            self.assertEqual(window["cursor"], 2)
            self.assertTrue(window["seed"])
            rest = (
                await client.post(
                    "/api/library/tracks/shuffle",
                    json={"seed": window["seed"], "cursor": window["cursor"], "limit": 2},
                )
            ).json()
            covered = [row["id"] for row in window["items"]] + [row["id"] for row in rest["items"]]
            self.assertEqual(sorted(covered), sorted(ids.values()))
            self.assertEqual(rest["cursor"], 3)
            again = (
                await client.post(
                    "/api/library/tracks/shuffle",
                    json={
                        "seed": rest["seed"],
                        "cursor": rest["cursor"],
                        "limit": 2,
                        "skip": [row["id"] for row in window["items"]],
                    },
                )
            ).json()
            self.assertEqual(
                [row["id"] for row in again["items"]], [row["id"] for row in rest["items"]]
            )
            self.assertEqual(again["total"], 1)
            self.assertNotEqual(again["seed"], window["seed"])
            looked = (
                await client.post(
                    "/api/library/tracks/lookup",
                    json={"ids": [ids["Cinder"], "missing", ids["Beacon"]]},
                )
            ).json()
            self.assertEqual([row["id"] for row in looked["items"]], [ids["Cinder"], ids["Beacon"]])
            self.assertEqual(looked["missing"], ["missing"])
            found = (await client.get("/api/library/tracks/search?q=cinder")).json()
            self.assertEqual([row["title"] for row in found["items"]], ["Cinder"])
            self.assertEqual(
                (await client.get("/api/library/tracks?sort=nonsense")).status_code, 422
            )

    async def test_search_finds_short_and_unusual_names(self) -> None:
        for artist, title in (
            ("MØ", "North"),
            ("AC/DC", "Highway"),
            ("Ry", "Small"),
            ("Blue", "Beacon"),
        ):
            path = self.music / artist / f"{title}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album="Album", album_artist=artist)
        self.library.scan()
        async with self.api() as client:
            for query, title in (
                ("MØ", "North"),
                ("AC/DC", "Highway"),
                ("Ry", "Small"),
                ("Beacon", "Beacon"),
            ):
                body = (await client.get("/api/library/tracks/search", params={"q": query})).json()
                self.assertEqual([row["title"] for row in body["items"]], [title], query)

    async def test_a_shuffle_expires_and_a_huge_one_is_refused(self) -> None:
        for title in ("One", "Two"):
            path = self.music / f"{title}.wav"
            write_wav(path)
            tag(path, title=title, artist="A", album="A", album_artist="A")
        self.library.scan()
        async with self.api() as client:
            window = (await client.get("/api/library/tracks/selection?shuffle=true&limit=1")).json()
            seed = window["seed"]
            stored = self.player.shuffle_orders[seed]
            aged = time.monotonic() - SHUFFLE_ORDER_SECONDS - 1
            self.player.shuffle_orders[seed] = (aged, stored[1])
            expired = await client.post(
                "/api/library/tracks/shuffle",
                json={"seed": seed, "cursor": 0, "limit": 1},
            )
            self.assertEqual(expired.status_code, 404)
            self.assertEqual(expired.json()["code"], "shuffle_expired")
            with patch("backend.library.player.SHUFFLE_GUARD", 1):
                refused = await client.get("/api/library/tracks/selection?shuffle=true&limit=1")
            self.assertEqual(refused.status_code, 503)
            self.assertIn("too large", refused.json()["detail"])
        self.assertGreater(SHUFFLE_GUARD, 1)

    def test_shuffle_orders_are_capped_by_the_ids_they_hold(self) -> None:
        player = Player(cast(Store, None), [])
        with patch("backend.library.player.SHUFFLE_ID_LIMIT", 10):
            for index in range(6):
                player.remember_shuffle(f"small{index}", [f"s{index}"])
            self.assertEqual(len(player.shuffle_orders), 6)
            player.remember_shuffle("large", [f"l{index}" for index in range(8)])
            self.assertEqual(list(player.shuffle_orders), ["small4", "small5", "large"])
            player.remember_shuffle("next", ["l0"], replaces="large")
            self.assertEqual(list(player.shuffle_orders), ["small4", "small5", "next"])
        self.assertGreater(SHUFFLE_ID_LIMIT, 10)

    async def test_stream_ranges_artwork_and_song_facts(self) -> None:
        path = self.music / "Artist" / "Album" / "song.wav"
        write_wav(path)
        tag(
            path,
            title="Song",
            artist="Artist",
            album="Album",
            album_artist="Artist",
            year="2020",
            pictures=[(0, b"other"), (3, b"front")],
        )
        disc = self.music / "Band" / "Album" / "CD1" / "disc.wav"
        write_wav(disc)
        tag(disc, title="Disc", artist="Band", album="Live", album_artist="Band")
        (self.music / "Band" / "Album" / "cover.jpg").write_bytes(b"parent-cover")
        (self.music / "Band" / "Album" / "cover.1.jpg").write_bytes(b"not-this")
        plain = self.music / "Plain" / "song.wav"
        write_wav(plain)
        tag(plain, title="Plain", artist="Plain", album="Plain", album_artist="Plain")
        old = self.music / "Band" / "Old" / "old.wav"
        new = self.music / "Band" / "New" / "new.wav"
        bare = self.music / "Band" / "Bare" / "bare.wav"
        for file, title, album, year in (
            (old, "Old", "Old", "2010"),
            (new, "New", "New", "2020"),
            (bare, "Bare", "Bare", "2024"),
        ):
            write_wav(file)
            tag(file, title=title, artist="Band", album=album, album_artist="Band", year=year)
        (old.parent / "cover.jpg").write_bytes(b"old-cover")
        (new.parent / "cover.jpg").write_bytes(b"new-cover")
        self.library.scan()
        ids = self.titles()
        raw = path.read_bytes()

        async with self.api() as client:
            song = (await client.get(f"/api/player/song/{ids['Song']}")).json()
            self.assertEqual(song["path"], "Artist/Album/song.wav")
            self.assertEqual(song["suffix"], "wav")
            self.assertEqual(song["contentType"], "audio/wav")
            self.assertEqual(song["samplingRate"], 8000)
            self.assertEqual(song["bitDepth"], 16)
            self.assertEqual(song["channelCount"], 1)
            self.assertEqual(song["size"], path.stat().st_size)
            audio = await client.get(
                f"/api/player/stream/{ids['Song']}", headers={"Range": "bytes=0-1"}
            )
            self.assertEqual(audio.status_code, 206)
            self.assertEqual(audio.content, raw[:2])
            self.assertEqual(audio.headers["content-range"], f"bytes 0-1/{len(raw)}")
            self.assertEqual(audio.headers["content-type"], "audio/wav")
            self.assertEqual(audio.headers["accept-ranges"], "bytes")
            size = len(raw)
            self.assertEqual(
                (
                    await client.get(
                        f"/api/player/stream/{ids['Song']}", headers={"Range": f"bytes={size}-"}
                    )
                ).status_code,
                416,
            )
            self.assertEqual(
                (
                    await client.get(
                        f"/api/player/stream/{ids['Song']}", headers={"Range": "bytes=0-1,2-3"}
                    )
                ).status_code,
                416,
            )
            self.assertEqual(
                (
                    await client.get(
                        f"/api/player/stream/{ids['Song']}", headers={"Range": "items=1-2"}
                    )
                ).status_code,
                416,
            )
            tracks = {
                row["title"]: row
                for row in (await client.get("/api/library/tracks?size=20")).json()["items"]
            }
            front = await client.get(f"/api/player/art/{tracks['Song']['coverArt']}")
            self.assertEqual(front.status_code, 200)
            self.assertEqual(front.content, b"front")
            self.assertEqual(front.headers["content-type"], "image/jpeg")
            self.assertIn("etag", front.headers)
            disc_art = await client.get(f"/api/player/art/{tracks['Disc']['coverArt']}")
            self.assertEqual(disc_art.content, b"parent-cover")
            self.assertNotIn("coverArt", tracks["Plain"])
            self.assertEqual(
                (await client.get(f"/api/player/art/{ids['Plain']}_00000000")).status_code, 404
            )
            artists = {
                row["name"]: row
                for row in (await client.get("/api/library/artists?size=20")).json()["items"]
            }
            band = await client.get(f"/api/player/art/{artists['Band']['coverArt']}")
            self.assertEqual(band.content, b"new-cover")
            missing = await client.get("/api/library/albums/bad!id")
            self.assertEqual(missing.status_code, 422)
            self.assertEqual(missing.json()["detail"], "Invalid item ID")
            self.assertNotIn("playback server", missing.text)

    async def test_playlists_queue_and_scrobble(self) -> None:
        for title in ("One", "Two"):
            path = self.music / f"{title}.wav"
            write_wav(path)
            tag(path, title=title, artist="A", album="A", album_artist="A")
        self.library.scan()
        ids = self.titles()
        one, two = ids["One"], ids["Two"]

        async with self.api() as client:
            unlinked = (await client.get("/api/library/playlists")).json()
            self.assertEqual(unlinked["liked_id"], "")
            named = await client.post(
                "/api/library/playlists", json={"name": "Liked", "song_ids": []}
            )
            self.assertEqual(
                (await client.delete(f"/api/library/playlists/{named.json()['id']}")).status_code,
                204,
            )
            first = (await client.get("/api/library/playlists/liked")).json()
            second = (await client.get("/api/library/playlists/liked")).json()
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(first["name"], "Liked")
            self.assertTrue(str(first["id"]).startswith("pl-"))
            refused = await client.delete(f"/api/library/playlists/{first['id']}")
            self.assertEqual(refused.status_code, 409)
            self.assertEqual(refused.json()["detail"], "The liked playlist cannot be deleted")
            self.store.set_linked_playlist("liked", "old-server")
            listing = (await client.get("/api/library/playlists")).json()
            self.assertEqual(listing["liked_id"], first["id"])
            adopted = (await client.get("/api/library/playlists/liked")).json()
            self.assertEqual(adopted["id"], first["id"])
            self.assertEqual([row["name"] for row in listing["items"]], ["Liked"])

            created = await client.post(
                "/api/library/playlists", json={"name": "Road trip", "song_ids": [one]}
            )
            self.assertEqual(created.status_code, 200)
            playlist_id = created.json()["id"]
            self.assertEqual(created.json()["entry"][0]["id"], one)
            renamed = await client.patch(
                f"/api/library/playlists/{playlist_id}", json={"name": "Morning"}
            )
            self.assertEqual(renamed.json()["name"], "Morning")
            added = await client.post(
                f"/api/library/playlists/{playlist_id}/songs", json={"song_id_to_add": two}
            )
            self.assertEqual([row["id"] for row in added.json()["entry"]], [one, two])
            removed = await client.post(
                f"/api/library/playlists/{playlist_id}/songs", json={"song_index_to_remove": 0}
            )
            self.assertEqual([row["id"] for row in removed.json()["entry"]], [two])
            self.assertEqual(
                (
                    await client.post(
                        f"/api/library/playlists/{playlist_id}/songs",
                        json={"song_id_to_add": one, "song_index_to_remove": 0},
                    )
                ).status_code,
                422,
            )
            self.assertEqual(
                (await client.delete(f"/api/library/playlists/{playlist_id}")).status_code, 204
            )

            saved = await client.put(
                "/api/player/queue", json={"ids": [one, two], "current": one, "position": 1200}
            )
            self.assertEqual(saved.status_code, 204)
            queue = (await client.get("/api/player/queue")).json()
            self.assertEqual(queue["current"], one)
            self.assertEqual(queue["position"], 1200)
            self.assertEqual([row["id"] for row in queue["entry"]], [one, two])
            self.assertEqual(
                (
                    await client.put(
                        "/api/player/queue", json={"ids": [one], "current": two, "position": 0}
                    )
                ).status_code,
                422,
            )
            for count, status in ((500, 204), (501, 422)):
                self.assertEqual(
                    (
                        await client.put(
                            "/api/player/queue",
                            json={
                                "ids": [f"tr-{index:016x}" for index in range(count)],
                                "current": "tr-0000000000000000",
                                "position": 0,
                            },
                        )
                    ).status_code,
                    status,
                )

            self.assertEqual(
                (
                    await client.post("/api/player/scrobble", json={"id": one, "submission": False})
                ).status_code,
                204,
            )
            self.assertEqual((await client.get(f"/api/player/song/{one}")).json()["playCount"], 0)
            self.assertEqual(
                (
                    await client.post("/api/player/scrobble", json={"id": one, "submission": True})
                ).status_code,
                204,
            )
            played = (await client.get(f"/api/player/song/{one}")).json()
            self.assertEqual(played["playCount"], 1)
            self.assertTrue(played["played"])
            await client.post("/api/player/scrobble", json={"id": one, "submission": True})
            self.assertEqual((await client.get(f"/api/player/song/{one}")).json()["playCount"], 2)
            albums = (await client.get("/api/library/albums")).json()["items"]
            self.assertEqual(albums[0]["playCount"], 2)

    async def test_lyrics_prefer_sidecar_then_embedded_then_lrclib(self) -> None:
        path = self.music / "Artist" / "song.wav"
        write_wav(path)
        tag(
            path,
            title="Song",
            artist="Artist",
            album="Album",
            album_artist="Artist",
            lyrics="[00:02.00]Embedded",
        )
        path.with_suffix(".lrc").write_text("\ufeff[00:01.00]Sidecar\n", encoding="utf-8")
        self.library.scan()
        song_id = self.titles()["Song"]
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            self.assertEqual(request.url.params["track_name"], "Song")
            return httpx.Response(
                200,
                json={"syncedLyrics": "[00:01.25]Remote", "plainLyrics": "Remote"},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            player = Player(self.store, [self.music], http)
            async with self.api(player) as client:
                sidecar = (await client.get(f"/api/player/lyrics/{song_id}")).json()["items"][0]
                self.assertEqual(sidecar["line"][0], {"start": 1000, "value": "Sidecar"})
                self.assertTrue(sidecar["synced"])
                self.assertEqual(calls["n"], 0)
                path.with_suffix(".lrc").unlink()
                embedded = (await client.get(f"/api/player/lyrics/{song_id}")).json()["items"][0]
                self.assertEqual(embedded["line"][0]["value"], "Embedded")
                self.assertEqual(embedded["line"][0]["start"], 2000)
                self.assertEqual(calls["n"], 0)
                write_wav(path)
                tag(path, title="Song", artist="Artist", album="Album", album_artist="Artist")
                self.library.scan()
                remote = (await client.get(f"/api/player/lyrics/{song_id}")).json()["items"][0]
                self.assertEqual(remote["line"][0], {"start": 1250, "value": "Remote"})
                self.assertEqual(calls["n"], 1)
                path.with_suffix(".lrc").write_bytes("歌词".encode("gbk"))
                rough = await client.get(f"/api/player/lyrics/{song_id}")
                self.assertEqual(rough.status_code, 200)
                self.assertGreaterEqual(len(rough.json()["items"][0]["line"]), 1)
                self.assertEqual(calls["n"], 1)

    async def test_an_id_survives_a_rescan_and_a_removed_file_leaves_the_queue(self) -> None:
        path = self.music / "Artist" / "song.wav"
        write_wav(path)
        tag(path, title="First", artist="Artist", album="Album", album_artist="Artist")
        self.library.scan()
        song_id = self.titles()["First"]
        added = str(
            self.store.db.execute(
                "SELECT added_at FROM library_files WHERE song_id=?", (song_id,)
            ).fetchone()["added_at"]
        )
        write_wav(path)
        tag(path, title="Second", artist="Artist", album="Album", album_artist="Artist")
        self.library.scan()
        self.assertEqual(self.titles()["Second"], song_id)
        self.assertEqual(
            str(
                self.store.db.execute(
                    "SELECT added_at FROM library_files WHERE song_id=?", (song_id,)
                ).fetchone()["added_at"]
            ),
            added,
        )
        async with self.api() as client:
            self.assertEqual(
                (await client.get(f"/api/player/song/{song_id}")).json()["id"], song_id
            )
            created = await client.post(
                "/api/library/playlists", json={"name": "Keep", "song_ids": [song_id]}
            )
            playlist_id = created.json()["id"]
            await client.put(
                "/api/player/queue", json={"ids": [song_id], "current": song_id, "position": 10}
            )
            stored = self.store.db.execute(
                "SELECT path FROM library_files WHERE song_id=?", (song_id,)
            ).fetchone()
            self.library.remove(str(stored["path"]))
            self.assertEqual(
                (await client.get(f"/api/library/playlists/{playlist_id}")).json()["songCount"], 0
            )
            queue = (await client.get("/api/player/queue")).json()
            self.assertEqual(queue["entry"], [])
            self.assertEqual(queue["current"], "")
            self.assertEqual((await client.get(f"/api/player/stream/{song_id}")).status_code, 404)

    async def test_a_song_id_cannot_reach_outside_a_root(self) -> None:
        inside = self.music / "inside.wav"
        outside = self.base / "outside.wav"
        write_wav(inside)
        write_wav(outside)
        tag(inside, title="Inside", artist="A", album="A", album_artist="A")
        self.library.scan()
        song_id = self.titles()["Inside"]
        async with self.api() as client:
            self.assertEqual((await client.get(f"/api/player/stream/{song_id}")).status_code, 200)
            self.store.db.execute(
                "UPDATE library_files SET path=? WHERE song_id=?", (str(outside), song_id)
            )
            self.assertEqual((await client.get(f"/api/player/stream/{song_id}")).status_code, 404)
            self.store.db.execute(
                "UPDATE library_files SET path=? WHERE song_id=?", (str(inside), song_id)
            )
            self.store.db.execute("UPDATE library_roots SET enabled=0")
            self.store.bump_library_revision()
            self.assertEqual((await client.get(f"/api/player/stream/{song_id}")).status_code, 404)
            self.assertEqual((await client.get("/api/library/tracks")).json()["total"], 0)

    async def test_a_song_symlink_outside_a_root_is_not_streamed(self) -> None:
        inside = self.music / "inside.wav"
        outside = self.base / "outside.wav"
        write_wav(inside)
        write_wav(outside)
        tag(inside, title="Inside", artist="A", album="A", album_artist="A")
        self.library.scan()
        song_id = self.titles()["Inside"]
        inside.unlink()
        try:
            inside.symlink_to(outside)
        except OSError as exc:
            if getattr(exc, "winerror", None) == 1314:
                self.skipTest("Windows account lacks permission to create symlinks (WinError 1314)")
            raise
        async with self.api() as client:
            self.assertEqual((await client.get(f"/api/player/stream/{song_id}")).status_code, 404)

    async def test_replacing_a_cover_changes_its_url(self) -> None:
        folder = self.music / "Band" / "Album"
        path = folder / "song.wav"
        write_wav(path)
        tag(path, title="Song", artist="Band", album="Album", album_artist="Band")
        cover = folder / "cover.jpg"
        cover.write_bytes(b"first")
        self.library.scan()
        before = self.store.library_revision()
        async with self.api() as client:
            first = (await client.get("/api/library/albums")).json()["items"][0]["coverArt"]
            cover.write_bytes(b"second-image")
            self.library.refresh({str(cover)})
            self.assertGreater(self.store.library_revision(), before)
            again = (await client.get("/api/library/albums")).json()["items"][0]
            self.assertNotEqual(again["coverArt"], first)
            art = await client.get(f"/api/player/art/{again['coverArt']}")
            self.assertEqual(art.status_code, 200)
            self.assertEqual(art.content, b"second-image")
            self.assertIn("immutable", art.headers["cache-control"])

    async def test_browsing_does_not_list_music_folders(self) -> None:
        folder = self.music / "Band" / "Album"
        path = folder / "song.wav"
        write_wav(path)
        tag(path, title="Song", artist="Band", album="Album", album_artist="Band")
        (folder / "cover.jpg").write_bytes(b"jpeg-bytes")
        self.library.scan()
        with patch.object(Path, "iterdir", side_effect=AssertionError("listed a music folder")):
            async with self.api() as client:
                listing = (await client.get("/api/library/tracks?size=10")).json()
                self.assertEqual(listing["total"], 1)
                cover_id = listing["items"][0]["coverArt"]
                art = await client.get(f"/api/player/art/{cover_id}")
                self.assertEqual(art.status_code, 200)
                self.assertEqual(art.content, b"jpeg-bytes")
                albums = (await client.get("/api/library/albums")).json()
                album_art = await client.get(f"/api/player/art/{albums['items'][0]['coverArt']}")
                self.assertEqual(album_art.content, b"jpeg-bytes")

    async def test_a_finished_download_is_browsable_and_streamable(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise AssertionError(f"no separate playback server: {request.url}")

        async with httpx.AsyncClient(transport=httpx.MockTransport(refuse)) as http:
            downloads = Downloads(
                self.store, Catalog(self.store, http), self.library, asyncio.Event()
            )
            job = downloads.jobs.enqueue(7, "original", str(self.music))
            job = downloads.jobs.update(
                job.id,
                meta=Metadata(
                    id=7,
                    title="Finished",
                    artist="Downloaded",
                    album_artist="Downloaded",
                    album="Shelf",
                    track=1,
                ).model_dump(),
            )
            ready = self.base / "ready.wav"
            write_wav(ready)
            tag(
                ready,
                title="Finished",
                artist="Downloaded",
                album="Shelf",
                album_artist="Downloaded",
            )
            await downloads.finish(job, ready)

        done = downloads.jobs.get(job.id)
        self.assertEqual(done.stage, "done")
        published = Path(done.final_path)
        self.assertTrue(published.is_file())
        self.assertTrue(published.is_relative_to(self.music))
        async with self.api() as client:
            albums = (await client.get("/api/library/albums")).json()
            self.assertEqual([row["name"] for row in albums["items"]], ["Shelf"])
            song_id = self.titles()["Finished"]
            stream = await client.get(f"/api/player/stream/{song_id}")
            self.assertEqual(stream.status_code, 200)
            self.assertEqual(stream.headers["content-type"], "audio/wav")
            self.assertEqual(stream.content, published.read_bytes())


class SortTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
