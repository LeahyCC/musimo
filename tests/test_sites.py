"""The indie sites (Bandcamp, SoundCloud, Audiomack, Audius, Jamendo) as pasted-link sites, from
canned yt-dlp answers. Nothing here touches the network."""

import asyncio
import tempfile
import threading
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import httpx

from backend import resolver, sources
from backend.catalog import Catalog
from backend.downloads import ART_HOPS, Downloads, art_candidates
from backend.job_models import LinkRequest, Metadata
from backend.library import Library, normalize
from backend.links import LinkError, Links
from backend.sources import Site
from backend.store import Store

JPEG = b"\xff\xd8\xff\xe0synthetic cover"


def site_of(source: str) -> Site:
    found = sources.by_source(source)
    assert found is not None
    return found


class HostTests(unittest.TestCase):
    def matches(self, url: str) -> str | None:
        found = sources.match(url)
        return found.source if found else None

    def test_bandcamp_takes_its_own_subdomains_and_nothing_that_only_looks_like_them(self) -> None:
        for url in (
            "https://bandcamp.com/",
            "https://artist.bandcamp.com/album/x",
            "https://some-artist.bandcamp.com/track/y",
            "https://a.b.bandcamp.com/track/y",
            "https://artist.bandcamp.com:443/music",
        ):
            with self.subTest(url=url):
                self.assertEqual(self.matches(url), "bandcamp")
        for url in (
            "https://evilbandcamp.com/album/x",
            "https://notbandcamp.com/album/x",
            "https://bandcamp.com.evil.test/album/x",
            "https://artist.bandcamp.com.evil.test/album/x",
            "https://artist.bandcamp.com.@evil.test/album/x",
            "https://artist.bandcamp.com@evil.test/album/x",
            "https://evil.test/https://artist.bandcamp.com/album/x",
            "https://evil.test/album/x?u=artist.bandcamp.com",
            # An empty label is not a subdomain.
            "https://.bandcamp.com/album/x",
            "https://a..bandcamp.com/album/x",
            # A trailing dot is a different name.
            "https://artist.bandcamp.com./album/x",
            "https://bandcamp.co/album/x",
            "https://bandcamp.com:8443/album/x",
            "http://artist.bandcamp.com/album/x",
            "https://user:pw@artist.bandcamp.com/album/x",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))

    def test_the_other_indie_sites_match_exact_hosts_only(self) -> None:
        for url, source in {
            "https://soundcloud.com/artist/track": "soundcloud",
            "https://www.soundcloud.com/artist/sets/album": "soundcloud",
            "https://m.soundcloud.com/artist": "soundcloud",
            "https://api-v2.soundcloud.com/tracks/123": "soundcloud",
            "https://audiomack.com/artist/song/title": "audiomack",
            "https://www.audiomack.com/artist/album/title": "audiomack",
            "https://audius.co/artist/track-1": "audius",
            "https://www.jamendo.com/track/1/title": "jamendo",
            "https://jamendo.com/album/1/title": "jamendo",
        }.items():
            with self.subTest(url=url):
                self.assertEqual(self.matches(url), source)
        for url in (
            "https://evilsoundcloud.com/a/b",
            "https://soundcloud.com.evil.test/a/b",
            "https://evil.soundcloud.com/a/b",
            "https://on.soundcloud.com/abc",
            "https://audiomack.com.evil.test/a/song/b",
            "https://music.audiomack.com/a.mp3",
            "https://audius.co.evil.test/a/b",
            "https://api.audius.co/v1/tracks/1",
            "https://jamendo.com.evil.test/track/1",
            "https://licensing.jamendo.com/en/track/1",
            "https://www.mixcloud.com/a/b",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))

    def test_an_audius_entry_address_needs_a_plain_id_and_no_web_address(self) -> None:
        self.assertEqual(self.matches("audius:4zxjE"), "audius")
        for text in (
            "audius:",
            "audius:../x",
            "audius:a b",
            "audius:https://api.audius.co/v1/tracks/1",
            "audius:" + "a" * 41,
            "xaudius:4zxjE",
            "AUDIUS:4zxjE",
            "spotify:4zxjE",
        ):
            with self.subTest(text=text):
                self.assertIsNone(sources.match(text))

    def test_every_new_row_is_music_and_lets_only_its_own_extractors_through(self) -> None:
        expected = {
            "bandcamp": {"Bandcamp", "Bandcamp:album", "Bandcamp:user"},
            "soundcloud": {
                "soundcloud",
                "soundcloud:set",
                "soundcloud:playlist",
                "soundcloud:user",
            },
            "audiomack": {"audiomack", "audiomack:album"},
            "audius": {"Audius", "audius:track", "audius:playlist", "audius:artist"},
            "jamendo": {"Jamendo", "JamendoAlbum"},
        }
        for source, extractors in expected.items():
            with self.subTest(source=source):
                site = site_of(source)
                self.assertEqual(site.kind, "music")
                self.assertEqual(set(site.extractors), extractors)
                self.assertTrue(site.quality_note)
        self.assertNotIn("soundcloud:search", site_of("soundcloud").extractors)
        # Every extractor name is a real one in the installed yt-dlp.
        from yt_dlp.extractor import gen_extractor_classes  # type: ignore[import-untyped]

        known = {cls.IE_NAME for cls in gen_extractor_classes()}
        for site in sources.SITES:
            for name in site.extractors:
                with self.subTest(name=name):
                    self.assertIn(name, known)

    def test_artwork_hosts_follow_the_same_subdomain_rule(self) -> None:
        bandcamp, soundcloud = site_of("bandcamp"), site_of("soundcloud")
        self.assertEqual(
            sources.safe_art(bandcamp, "https://f4.bcbits.com/img/a1_5.jpg"),
            "https://f4.bcbits.com/img/a1_5.jpg",
        )
        for url in (
            "https://evilbcbits.com/img/a.jpg",
            "https://bcbits.com.evil.test/img/a.jpg",
            "http://f4.bcbits.com/img/a.jpg",
            "https://f4.bcbits.com@evil.test/a.jpg",
        ):
            with self.subTest(url=url):
                self.assertEqual(sources.safe_art(bandcamp, url), "")
        self.assertNotEqual(
            sources.safe_art(soundcloud, "https://i1.sndcdn.com/a-t500x500.jpg"), ""
        )
        self.assertEqual(sources.safe_art(soundcloud, "https://i1.sndcdn.com.evil.test/a.jpg"), "")

    def test_profile_pages_are_told_apart_from_one_release(self) -> None:
        cases = {
            "bandcamp": (
                [
                    "https://band.bandcamp.com",
                    "https://band.bandcamp.com/",
                    "https://band.bandcamp.com/music",
                ],
                [
                    "https://band.bandcamp.com/album/x",
                    "https://band.bandcamp.com/track/y",
                    "https://band.bandcamp.com/music/extra",
                    "http://band.bandcamp.com/",
                ],
            ),
            "soundcloud": (
                [
                    "https://soundcloud.com/artist",
                    "https://soundcloud.com/artist/",
                    "https://soundcloud.com/artist/sets",
                    "https://soundcloud.com/artist/tracks",
                    "https://soundcloud.com/artist/albums",
                ],
                [
                    "https://soundcloud.com/artist/a-track",
                    "https://soundcloud.com/artist/sets/an-album",
                    "https://soundcloud.com/artist/a-track/s-secret",
                ],
            ),
            "audius": (
                ["https://audius.co/artist", "https://audius.co/artist/"],
                [
                    "https://audius.co/artist/a-track-123",
                    "https://audius.co/artist/playlist/a-list",
                    "https://audius.co/artist/album/a-record",
                ],
            ),
            "audiomack": ([], ["https://audiomack.com/artist", "https://audiomack.com/a/song/b"]),
            "jamendo": (
                [],
                ["https://www.jamendo.com/track/1/x", "https://www.jamendo.com/album/1/x"],
            ),
        }
        for source, (profiles, others) in cases.items():
            site = site_of(source)
            for url in profiles:
                with self.subTest(source=source, url=url):
                    self.assertTrue(site.is_profile(url))
            for url in others:
                with self.subTest(source=source, url=url):
                    self.assertFalse(site.is_profile(url))


def captured(
    source: str,
    url: str,
    raw: Mapping[str, object],
    pages: Mapping[str, Mapping[str, object]] | None = None,
) -> dict[str, object]:
    """The preview the resolver emits for a canned list, reading pages from `pages`."""
    downloader = MagicMock()
    downloader.extract_info.return_value = dict(raw)
    events: list[dict[str, object]] = []
    asked: list[str] = []

    def lookup(address: str) -> dict[str, object] | None:
        asked.append(address)
        page = (pages or {}).get(address)
        return dict(page) if page is not None else None

    with patch(
        "backend.resolver.emit", side_effect=lambda kind, **v: events.append({"kind": kind, **v})
    ):
        resolver.resolve(downloader, site_of(source), url, lookup)
    assert events[-1]["kind"] == "preview", events[-1]
    return events[-1] | {"asked": asked}


def entries_of(preview: dict[str, object]) -> list[dict[str, object]]:
    return cast(list[dict[str, object]], preview["entries"])


BAND = "https://band.bandcamp.com"


def bandcamp_track(number: int, **extra: object) -> dict[str, object]:
    """One track page as yt-dlp reads it, before processing."""
    return {
        "id": str(number),
        "extractor": "Bandcamp",
        "webpage_url": f"{BAND}/track/t{number}",
        "title": f"Band - Track {number}",
        "track": f"Track {number}",
        "artist": "Band",
        "uploader": "Band",
        "album": "The Album",
        "track_number": number,
        "release_timestamp": 1743724800.0,
        "timestamp": 1749473029.0,
        "duration": 100.0 + number,
        "thumbnail": "https://f4.bcbits.com/img/a1_5.jpg",
    } | extra


def bandcamp_album(count: int = 3, **extra: object) -> dict[str, object]:
    """An album as its extractor lists it: a title, an address and an ID per track, nothing more."""
    return {
        "_type": "playlist",
        "extractor": "Bandcamp:album",
        "id": "the-album",
        "title": "The Album",
        "uploader_id": "band",
        "webpage_url": f"{BAND}/album/the-album",
        "entries": [
            {
                "_type": "url",
                "url": f"{BAND}/track/t{number}",
                "ie_key": "Bandcamp",
                "id": str(number),
                "title": f"Track {number}",
            }
            for number in range(1, count + 1)
        ],
    } | extra


class BandcampMappingTests(unittest.TestCase):
    def test_an_album_lands_like_a_catalog_album(self) -> None:
        preview = captured(
            "bandcamp",
            f"{BAND}/album/the-album",
            bandcamp_album(),
            {f"{BAND}/track/t1": bandcamp_track(1)},
        )
        rows = entries_of(preview)
        self.assertEqual([row["title"] for row in rows], ["Track 1", "Track 2", "Track 3"])
        for position, row in enumerate(rows, 1):
            with self.subTest(track=position):
                # The list gives the album title. The first track's page gives the artist, the
                # release day and the cover, which belong to the whole album.
                self.assertEqual(row["album"], "The Album")
                self.assertEqual(row["artist"], "Band")
                self.assertEqual(row["date"], "2025-04-04")
                self.assertEqual(row["art"], "https://f4.bcbits.com/img/a1_5.jpg")
                self.assertEqual((row["track"], row["tracks"]), (position, 3))
                self.assertIs(row["album_list"], True)
                self.assertEqual(row["extractor"], "bandcamp")
                self.assertEqual(row["url"], f"{BAND}/track/t{position}")
        # One page is read for the whole album, not one per track.
        self.assertEqual(preview["asked"], [f"{BAND}/track/t1"])
        self.assertFalse(preview["partial"])

    def test_an_album_whose_first_page_cannot_be_read_still_lists_its_tracks(self) -> None:
        preview = captured("bandcamp", f"{BAND}/album/the-album", bandcamp_album(), {})
        rows = entries_of(preview)
        self.assertEqual(len(rows), 3)
        self.assertEqual({row["artist"] for row in rows}, {""})
        self.assertEqual([row["track"] for row in rows], [1, 2, 3])
        self.assertEqual({row["album"] for row in rows}, {"The Album"})

    def test_a_lone_track_keeps_its_own_tags_and_is_not_from_an_album_list(self) -> None:
        preview = captured("bandcamp", f"{BAND}/track/t2", bandcamp_track(2))
        self.assertIs(preview["single"], True)
        (row,) = entries_of(preview)
        self.assertEqual(
            (row["title"], row["artist"], row["album"], row["date"], row["duration"]),
            ("Track 2", "Band", "The Album", "2025-04-04", 102.0),
        )
        self.assertIs(row["album_list"], False)
        self.assertEqual((row["track"], row["tracks"]), (0, 0))

    def test_an_artist_page_opens_each_release_and_numbers_each_album_on_its_own(self) -> None:
        other = "https://band.bandcamp.com/album/second"
        profile = {
            "_type": "playlist",
            "extractor": "Bandcamp:user",
            "id": "band",
            "title": "Discography of band",
            "entries": [
                {"_type": "url", "url": f"{BAND}/album/the-album"},
                {"_type": "url", "url": f"{BAND}/track/loose"},
                {"_type": "url", "url": other},
            ],
        }
        second = bandcamp_album(2, id="second", title="Second", webpage_url=other)
        second["entries"] = [
            {
                "_type": "url",
                "url": f"{BAND}/track/s{n}",
                "ie_key": "Bandcamp",
                "id": f"s{n}",
                "title": f"Second {n}",
            }
            for n in (1, 2)
        ]
        loose = bandcamp_track(
            9, id="loose", webpage_url=f"{BAND}/track/loose", track="Loose", album=""
        )
        preview = captured(
            "bandcamp",
            f"{BAND}/music",
            profile,
            {
                f"{BAND}/album/the-album": bandcamp_album(),
                f"{BAND}/track/loose": loose,
                other: second,
                f"{BAND}/track/t1": bandcamp_track(1),
                f"{BAND}/track/s1": bandcamp_track(1, id="s1"),
            },
        )
        rows = entries_of(preview)
        self.assertEqual(
            [
                (row["title"], row["album"], row["track"], row["tracks"], row["album_list"])
                for row in rows
            ],
            [
                ("Track 1", "The Album", 1, 3, True),
                ("Track 2", "The Album", 2, 3, True),
                ("Track 3", "The Album", 3, 3, True),
                ("Loose", "", 0, 0, False),
                ("Second 1", "Second", 1, 2, True),
                ("Second 2", "Second", 2, 2, True),
            ],
        )
        self.assertFalse(preview["partial"])

    def test_an_artist_page_with_too_many_releases_says_it_is_partial(self) -> None:
        count = resolver.OPEN_LIMIT + 2
        addresses = [f"{BAND}/album/a{n}" for n in range(count)]
        profile = {
            "_type": "playlist",
            "extractor": "Bandcamp:user",
            "title": "Discography of band",
            "entries": [{"_type": "url", "url": address} for address in addresses],
        }
        pages = {address: bandcamp_album(1, webpage_url=address) for address in addresses}
        preview = captured("bandcamp", f"{BAND}/music", profile, pages)
        self.assertTrue(preview["partial"])
        opened = [address for address in cast(list[str], preview["asked"]) if "/album/" in address]
        self.assertEqual(len(opened), resolver.OPEN_LIMIT)
        self.assertEqual(len(entries_of(preview)), resolver.OPEN_LIMIT)

    def test_a_release_that_is_on_another_site_is_never_opened(self) -> None:
        profile = {
            "_type": "playlist",
            "extractor": "Bandcamp:user",
            "title": "Discography of band",
            "entries": [{"_type": "url", "url": "https://evil.test/album/x"}],
        }
        preview = captured("bandcamp", f"{BAND}/music", profile, {})
        self.assertEqual(preview["asked"], [])
        self.assertEqual(entries_of(preview), [])


SET = "https://soundcloud.com/levi/sets/out-of-spite"


def cloud_track(number: int, **extra: object) -> dict[str, object]:
    return {
        "id": str(100 + number),
        "extractor": "soundcloud",
        "webpage_url": f"https://soundcloud.com/levi/t{number}",
        "title": f"Song {number}",
        "track": f"Song {number}",
        "uploader": "Levi Ryan",
        "artists": ["Levi Ryan"],
        "duration": 180.0 + number,
    } | extra


def cloud_set(album_type: str, **extra: object) -> dict[str, object]:
    """A set as its extractor lists it: every row carries the set's title as its album."""
    info = {"album": "Out of Spite", "album_artist": "Levi Ryan", "album_type": album_type}
    return (
        {
            "_type": "playlist",
            "extractor": "soundcloud:set",
            "id": "7",
            "title": "Out of Spite",
            "uploader": "Levi Ryan",
            "release_timestamp": 1667865600,
            "thumbnails": [
                {"url": "https://i1.sndcdn.com/artworks-x-large.jpg", "width": 100, "height": 100},
                {
                    "url": "https://i1.sndcdn.com/artworks-x-t500x500.jpg",
                    "width": 500,
                    "height": 500,
                },
            ],
            "entries": [
                {
                    "_type": "url_transparent",
                    "url": f"https://soundcloud.com/levi/t{number}",
                    "ie_key": "Soundcloud",
                    "id": str(100 + number),
                    **info,
                }
                for number in (1, 2, 3)
            ],
        }
        | info
        | extra
    )


class SoundCloudMappingTests(unittest.TestCase):
    def pages(self) -> dict[str, dict[str, object]]:
        return {f"https://soundcloud.com/levi/t{n}": cloud_track(n) for n in (1, 2, 3)}

    def test_a_set_that_is_an_album_keeps_its_order_as_track_numbers(self) -> None:
        for album_type in ("album", "ep", "single", "compilation"):
            with self.subTest(album_type=album_type):
                rows = entries_of(captured("soundcloud", SET, cloud_set(album_type), self.pages()))
                self.assertEqual([row["title"] for row in rows], ["Song 1", "Song 2", "Song 3"])
                self.assertEqual(
                    [(row["track"], row["tracks"]) for row in rows], [(1, 3), (2, 3), (3, 3)]
                )
                self.assertEqual({row["album"] for row in rows}, {"Out of Spite"})
                self.assertEqual({row["artist"] for row in rows}, {"Levi Ryan"})
                self.assertEqual({row["date"] for row in rows}, {"2022-11-08"})
                # The set's largest cover stands in, because the rows list none of their own.
                self.assertEqual(
                    {row["art"] for row in rows}, {"https://i1.sndcdn.com/artworks-x-t500x500.jpg"}
                )
                self.assertEqual({row["album_list"] for row in rows}, {True})

    def test_the_album_artist_names_a_track_the_page_gave_no_artist_for(self) -> None:
        pages = {
            address: {
                key: value for key, value in page.items() if key not in {"artists", "uploader"}
            }
            for address, page in self.pages().items()
        }
        rows = entries_of(captured("soundcloud", SET, cloud_set("album"), pages))
        self.assertEqual({row["artist"] for row in rows}, {"Levi Ryan"})

    def test_a_playlist_of_mixed_uploaders_is_not_an_album(self) -> None:
        pages = {
            "https://soundcloud.com/levi/t1": cloud_track(1, uploader="Ann", artists=["Ann"]),
            "https://soundcloud.com/levi/t2": cloud_track(2, uploader="Bob", artists=[]),
            "https://soundcloud.com/levi/t3": cloud_track(
                3, uploader="Cy", artists=["Cy", "Di"], track_number=9
            ),
        }
        preview = captured("soundcloud", SET, cloud_set("playlist", title="My Mix"), pages)
        rows = entries_of(preview)
        # Each track keeps its own artist, and the playlist's name is nobody's album.
        self.assertEqual([row["artist"] for row in rows], ["Ann", "Bob", "Cy, Di"])
        self.assertEqual([row["album"] for row in rows], ["", "", ""])
        self.assertEqual([(row["track"], row["tracks"]) for row in rows], [(0, 0)] * 3)
        self.assertEqual({row["album_list"] for row in rows}, {False})
        # The set's cover, date and album artist are not copied onto them either.
        self.assertEqual({row["art"] for row in rows}, {""})
        self.assertEqual({row["date"] for row in rows}, {""})

    def test_a_track_the_site_would_not_show_is_left_out_and_keeps_the_others_numbers(self) -> None:
        pages = self.pages()
        del pages["https://soundcloud.com/levi/t2"]
        preview = captured("soundcloud", SET, cloud_set("album"), pages)
        rows = entries_of(preview)
        self.assertEqual(
            [(row["title"], row["track"], row["tracks"]) for row in rows],
            [("Song 1", 1, 3), ("Song 3", 3, 3)],
        )
        self.assertTrue(preview["partial"])

    def test_a_failed_page_is_tried_once_more(self) -> None:
        calls: list[str] = []

        def lookup(address: str) -> dict[str, object] | None:
            calls.append(address)
            if len(calls) == 1:
                raise RuntimeError("HTTP Error 429: Too Many Requests")
            return cloud_track(1)

        with patch("backend.resolver.time.sleep") as pause:
            found = resolver.looked_up(lookup, ["https://soundcloud.com/levi/t1"], 5)
        self.assertEqual(len(calls), 2)
        self.assertEqual(list(found), ["https://soundcloud.com/levi/t1"])
        pause.assert_called_once()

    def test_a_page_that_never_answers_does_not_hold_the_preview_back(self) -> None:
        release = threading.Event()

        def lookup(address: str) -> dict[str, object] | None:
            release.wait(5)
            return None

        try:
            found = resolver.looked_up(lookup, ["https://soundcloud.com/levi/t1"], 0.05)
        finally:
            release.set()
        self.assertEqual(found, {})

    def test_a_profile_lists_tracks_by_title_and_opens_its_sets(self) -> None:
        profile = {
            "_type": "playlist",
            "extractor": "soundcloud:user",
            "title": "Levi (All)",
            "entries": [
                {
                    "_type": "url",
                    "url": "https://soundcloud.com/levi/t1",
                    "ie_key": "Soundcloud",
                    "id": "101",
                    "title": "Song 1",
                },
                # A set has no extractor of its own in this list, so it takes the profile's.
                {"_type": "url", "url": SET, "id": "7", "title": "Out of Spite"},
            ],
        }
        pages = self.pages() | {SET: cloud_set("album")}
        preview = captured("soundcloud", "https://soundcloud.com/levi", profile, pages)
        rows = entries_of(preview)
        # The loose track has only its title (the artist comes from its page at download time),
        # and the set's tracks land as an album.
        self.assertEqual(
            [(row["title"], row["album"], row["album_list"]) for row in rows[:1]],
            [("Song 1", "", False)],
        )
        self.assertEqual([row["album"] for row in rows[1:]], ["Out of Spite"] * 3)


class OtherSitesMappingTests(unittest.TestCase):
    def test_audius_playlist_rows_are_filled_in_from_their_own_pages(self) -> None:
        raw = {
            "_type": "playlist",
            "extractor": "audius:playlist",
            "title": "A List",
            "entries": [
                {"_type": "url", "url": f"audius:{tid}", "ie_key": "AudiusTrack", "id": tid}
                for tid in ("aa1", "bb2")
            ],
        }
        pages = {
            "audius:aa1": {
                "id": "aa1",
                "extractor": "audius:track",
                "title": "One",
                "track": "One",
                "artist": "Ann",
                "duration": 100,
                "webpage_url": "audius:aa1",
            },
            "audius:bb2": {
                "id": "bb2",
                "extractor": "audius:track",
                "title": "Two",
                "track": "Two",
                "artist": "Bob",
                "duration": 200,
                "webpage_url": "audius:bb2",
            },
        }
        preview = captured("audius", "https://audius.co/ann/playlist/a-list", raw, pages)
        rows = entries_of(preview)
        # A playlist is not marked as an album, so each track keeps its own artist.
        self.assertEqual(
            [(row["title"], row["artist"], row["album"]) for row in rows],
            [("One", "Ann", ""), ("Two", "Bob", "")],
        )
        self.assertEqual({row["extractor"] for row in rows}, {"audius:track"})
        self.assertEqual({row["album_list"] for row in rows}, {False})

    def test_a_jamendo_album_numbers_its_tracks_and_names_each_artist(self) -> None:
        raw = {
            "_type": "playlist",
            "extractor": "JamendoAlbum",
            "id": "121486",
            "title": "Duck On Cover",
            "entries": [
                {
                    "_type": "url_transparent",
                    "url": f"https://www.jamendo.com/track/{n}",
                    "ie_key": "Jamendo",
                    "id": str(n),
                    "album": "Duck On Cover",
                }
                for n in (11, 12)
            ],
        }
        pages = {
            f"https://www.jamendo.com/track/{n}": {
                "id": str(n),
                "extractor": "Jamendo",
                "title": f"Track {n}",
                "track": f"Track {n}",
                "artist": "Shearer",
                "album": "Duck On Cover",
                "duration": 190,
                "timestamp": 1368057600,
                "webpage_url": f"https://www.jamendo.com/track/{n}",
            }
            for n in (11, 12)
        }
        rows = entries_of(captured("jamendo", "https://www.jamendo.com/album/121486/x", raw, pages))
        self.assertEqual(
            [
                (row["title"], row["artist"], row["album"], row["track"], row["tracks"])
                for row in rows
            ],
            [
                ("Track 11", "Shearer", "Duck On Cover", 1, 2),
                ("Track 12", "Shearer", "Duck On Cover", 2, 2),
            ],
        )
        self.assertEqual({row["date"] for row in rows}, {"2013-05-09"})
        self.assertEqual({row["album_list"] for row in rows}, {True})

    def test_an_audiomack_song_takes_its_uploader_as_the_artist(self) -> None:
        raw = {
            "id": "55",
            "extractor": "audiomack",
            "title": "Cylinder Four",
            "uploader": "Chris",
            "url": "https://music.audiomack.com/song.mp3",
            "webpage_url": "https://audiomack.com/chris/song/cylinder-four",
        }
        preview = captured("audiomack", "https://audiomack.com/chris/song/cylinder-four", raw)
        (row,) = entries_of(preview)
        self.assertEqual(
            (row["title"], row["artist"], row["album_list"]), ("Cylinder Four", "Chris", False)
        )
        # The address kept is the page, which is on the site, not the file address.
        self.assertEqual(row["url"], "https://audiomack.com/chris/song/cylinder-four")

    def test_release_dates_come_from_seconds_since_1970_when_no_date_field_is_there(self) -> None:
        self.assertEqual(resolver.day({"release_timestamp": 1743724800.0}), "2025-04-04")
        self.assertEqual(resolver.day({"timestamp": 1368057600}), "2013-05-09")
        # The release beats the upload, and a written date beats both.
        self.assertEqual(
            resolver.day({"release_timestamp": 1743724800, "timestamp": 1368057600}), "2025-04-04"
        )
        self.assertEqual(
            resolver.day({"release_date": "20120529", "release_timestamp": 1743724800}),
            "2012-05-29",
        )
        for junk in (0, -5, 1e12, "soon", None):
            with self.subTest(junk=junk):
                self.assertEqual(resolver.day({"release_timestamp": junk}), "")


class Harness(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "test.sqlite3")
        self.store.update({"destination": str(self.root)})
        self.client = httpx.AsyncClient()
        library = Library(self.store, [self.root], asyncio.Event())
        self.service = Downloads(
            self.store, Catalog(self.store, self.client), library, asyncio.Event()
        )
        self.links = Canned(self.service)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.temporary.cleanup()


class Canned(Links):
    """Answers from canned resolver output instead of starting a process."""

    answer: dict[str, object] = {}

    async def extract(self, url: str, site: Site) -> dict[str, object]:
        return self.answer


def row(source: str, number: int, **extra: object) -> dict[str, object]:
    """One resolver row for a site's own recording."""
    site = site_of(source)
    host = site.hosts[0]
    address = f"audius:t{number}" if source == "audius" else f"https://{host}/a/song-{number}"
    return {
        "id": f"t{number}",
        "extractor": site.items[0],
        "url": address,
        "title": f"Song {number}",
        "artist": "Band",
        "album": "",
        "date": "",
        "duration": 100,
        "art": "",
        "live": False,
        "track": 0,
        "tracks": 0,
        "album_list": False,
    } | extra


class PreviewTests(Harness):
    async def test_each_row_sends_its_quality_note_with_the_preview(self) -> None:
        urls = {
            "bandcamp": "https://band.bandcamp.com/track/x",
            "soundcloud": "https://soundcloud.com/a/song-1",
            "audiomack": "https://audiomack.com/a/song/song-1",
            "audius": "https://audius.co/a/song-1",
            "jamendo": "https://www.jamendo.com/track/1/x",
            "archive": "https://archive.org/details/x",
            "youtube": "https://www.youtube.com/watch?v=abcdefghijk",
        }
        for source, url in urls.items():
            with self.subTest(source=source):
                self.links.answer = {
                    "kind": "preview",
                    "single": True,
                    "title": "t",
                    "entries": [row(source, 1)],
                }
                preview = await self.links.resolve(url)
                self.assertEqual(preview["quality_note"], site_of(source).quality_note)
                self.assertEqual(preview["source"], source)
        self.assertEqual(site_of("youtube").quality_note, "")
        self.assertIn("128 kbps", site_of("bandcamp").quality_note)
        self.assertIn("lossless", site_of("bandcamp").quality_note)

    async def test_profile_links_are_flagged_so_nothing_starts_ticked(self) -> None:
        profiles = {
            "bandcamp": "https://band.bandcamp.com/music",
            "soundcloud": "https://soundcloud.com/artist",
            "audius": "https://audius.co/artist",
        }
        for source, url in profiles.items():
            with self.subTest(source=source):
                self.links.answer = {
                    "kind": "preview",
                    "single": False,
                    "title": "t",
                    "entries": [row(source, 1), row(source, 2)],
                }
                preview = await self.links.resolve(url)
                self.assertIs(preview["profile"], True)
        albums = {
            "bandcamp": "https://band.bandcamp.com/album/x",
            "soundcloud": "https://soundcloud.com/artist/sets/x",
            "audius": "https://audius.co/artist/playlist/x",
        }
        for source, url in albums.items():
            with self.subTest(source=source, kind="release"):
                self.links.answer = {
                    "kind": "preview",
                    "single": False,
                    "title": "t",
                    "entries": [row(source, 1), row(source, 2)],
                }
                self.assertIs((await self.links.resolve(url))["profile"], False)

    async def test_a_partial_list_says_so_and_a_full_one_does_not(self) -> None:
        url = "https://band.bandcamp.com/music"
        entries = [row("bandcamp", 1)]
        self.links.answer = {
            "kind": "preview",
            "single": False,
            "title": "t",
            "entries": entries,
            "partial": True,
        }
        self.assertIs((await self.links.resolve(url))["partial"], True)
        self.links.answer = {"kind": "preview", "single": False, "title": "t", "entries": entries}
        self.assertIs((await self.links.resolve(url))["partial"], False)

    async def test_a_row_from_another_site_or_a_bad_audius_address_is_dropped(self) -> None:
        self.links.answer = {
            "kind": "preview",
            "single": False,
            "title": "t",
            "entries": [
                row("audius", 1),
                row("audius", 2, url="audius:../secret"),
                row("audius", 3, url="https://evil.test/a.mp3"),
                row("audius", 4, extractor="audius:playlist"),
            ],
        }
        preview = await self.links.resolve("https://audius.co/artist")
        self.assertEqual(
            [entry["id"] for entry in cast(list[dict[str, object]], preview["entries"])], ["t1"]
        )

    async def test_an_empty_answer_is_still_refused(self) -> None:
        self.links.answer = {"kind": "preview", "single": False, "title": "t", "entries": []}
        with self.assertRaises(LinkError):
            await self.links.resolve("https://band.bandcamp.com/music")


class TidyFlagTests(Harness):
    """Which pasted recordings may be retagged from the catalog is decided when they are queued."""

    async def queue(self, source: str, url: str, rows: list[dict[str, object]]) -> list[bool]:
        self.links.answer = {"kind": "preview", "single": False, "title": "t", "entries": rows}
        preview = await self.links.resolve(url)
        queued = self.links.enqueue(
            LinkRequest(
                token=str(preview["token"]),
                entry_ids=[
                    str(entry["id"]) for entry in cast(list[dict[str, object]], preview["entries"])
                ],
                format="original",
            )
        )
        jobs = cast(list[dict[str, object]], queued["jobs"])
        return [self.service.jobs.get(str(job["id"])).tidy for job in jobs]

    async def test_a_loose_track_may_be_tidied(self) -> None:
        rows = [row("bandcamp", 1), row("bandcamp", 2)]
        self.assertEqual(
            await self.queue("bandcamp", "https://band.bandcamp.com/music", rows), [True, True]
        )

    async def test_a_track_from_an_album_list_never_is(self) -> None:
        rows = [
            row("bandcamp", 1, album_list=True, album="The Album", track=1, tracks=2),
            row("bandcamp", 2, album_list=True, album="The Album", track=2, tracks=2),
        ]
        self.assertEqual(
            await self.queue("bandcamp", "https://band.bandcamp.com/album/x", rows), [False, False]
        )

    async def test_a_profile_can_mix_loose_tracks_and_album_tracks(self) -> None:
        rows = [
            row("bandcamp", 1),
            row("bandcamp", 2, album_list=True, album="A", track=1, tracks=1),
        ]
        self.assertEqual(
            await self.queue("bandcamp", "https://band.bandcamp.com/music", rows), [True, False]
        )

    async def test_the_internet_archive_is_never_tidied_even_for_a_loose_file(self) -> None:
        self.assertFalse(site_of("archive").catalog_tidy)
        rows = [
            row("archive", 1, extractor="archive.org", url="https://archive.org/details/x/a.mp3")
        ]
        self.assertEqual(
            await self.queue("archive", "https://archive.org/details/x", rows), [False]
        )

    async def test_every_other_site_allows_it(self) -> None:
        self.assertEqual(
            {site.source for site in sources.SITES if not site.catalog_tidy}, {"archive"}
        )


class ArtworkTests(unittest.IsolatedAsyncioTestCase):
    """The cover fetch: YouTube's missing sizes, and a redirect that may only stay on the site."""

    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "test.sqlite3")
        self.store.update({"destination": str(self.root)})
        self.asked: list[str] = []
        self.answers: dict[str, httpx.Response] = {}
        self.count = 0
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.respond))
        library = Library(self.store, [self.root], asyncio.Event())
        self.service = Downloads(
            self.store, Catalog(self.store, self.client), library, asyncio.Event()
        )
        self.folder = self.root

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.temporary.cleanup()

    def respond(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(str(request.url))
        return self.answers.get(str(request.url), httpx.Response(404))

    async def fetch(self, source: str, art: str) -> tuple[bool, list[str]]:
        """Fetch one cover for a new job. Says whether it was saved, and what was requested."""
        self.count += 1
        self.asked.clear()
        job = self.service.jobs.enqueue_many(
            [self.count],
            "original",
            str(self.root),
            catalog="link",
            prepared={
                self.count: (
                    Metadata(id=self.count, title="Song", artist="Band", art=art),
                    "https://x",
                )
            },
            source=source,
        )[0]
        self.folder = self.root / f"stage{self.count}"
        self.folder.mkdir()
        await self.service.artwork(job, self.folder)
        self.job = self.service.jobs.get(job.id)
        return (self.folder / "cover.jpg").is_file(), [*self.asked]

    def yt(self, name: str) -> str:
        return f"https://i.ytimg.com/vi/abcdefghijk/{name}"

    def test_youtube_falls_back_one_size_at_a_time_on_the_same_host_only(self) -> None:
        big = self.yt("maxresdefault.jpg")
        self.assertEqual(
            art_candidates(big), [big, self.yt("sddefault.jpg"), self.yt("hqdefault.jpg")]
        )
        self.assertEqual(
            art_candidates(self.yt("sddefault.jpg")),
            [self.yt("sddefault.jpg"), self.yt("hqdefault.jpg")],
        )
        self.assertEqual(art_candidates(self.yt("hqdefault.jpg")), [self.yt("hqdefault.jpg")])
        for other in (
            "https://evil.test/vi/abcdefghijk/maxresdefault.jpg",
            "https://i.ytimg.com.evil.test/vi/abcdefghijk/maxresdefault.jpg",
            "https://i.ytimg.com/vi/abcdefghijk/1.jpg",
            "https://f4.bcbits.com/img/maxresdefault.jpg",
        ):
            with self.subTest(other=other):
                self.assertEqual(art_candidates(other), [other])

    async def test_a_missing_largest_size_falls_back_to_the_next(self) -> None:
        self.answers[self.yt("sddefault.jpg")] = httpx.Response(200, content=JPEG)
        saved, asked = await self.fetch("youtube", self.yt("maxresdefault.jpg"))
        self.assertTrue(saved)
        self.assertEqual(asked, [self.yt("maxresdefault.jpg"), self.yt("sddefault.jpg")])
        self.assertEqual((self.folder / "cover.jpg").read_bytes(), JPEG)

    async def test_two_missing_sizes_fall_back_to_the_last(self) -> None:
        self.answers[self.yt("hqdefault.jpg")] = httpx.Response(200, content=JPEG)
        saved, asked = await self.fetch("youtube", self.yt("maxresdefault.jpg"))
        self.assertTrue(saved)
        self.assertEqual(
            asked,
            [self.yt("maxresdefault.jpg"), self.yt("sddefault.jpg"), self.yt("hqdefault.jpg")],
        )

    async def test_a_video_with_no_cover_at_all_only_warns(self) -> None:
        saved, asked = await self.fetch("youtube", self.yt("maxresdefault.jpg"))
        self.assertFalse(saved)
        self.assertEqual(len(asked), 3)
        self.assertEqual(self.job.warnings, ["Cover art unavailable"])

    async def test_only_a_missing_file_moves_on_to_a_smaller_size(self) -> None:
        self.answers[self.yt("maxresdefault.jpg")] = httpx.Response(500)
        self.answers[self.yt("sddefault.jpg")] = httpx.Response(200, content=JPEG)
        saved, asked = await self.fetch("youtube", self.yt("maxresdefault.jpg"))
        self.assertFalse(saved)
        self.assertEqual(asked, [self.yt("maxresdefault.jpg")])

    async def test_a_site_without_sizes_never_guesses_another_address(self) -> None:
        art = "https://f4.bcbits.com/img/a1_5.jpg"
        saved, asked = await self.fetch("bandcamp", art)
        self.assertFalse(saved)
        self.assertEqual(asked, [art])

    async def test_an_archive_cover_follows_a_redirect_to_its_storage_host(self) -> None:
        start = "https://archive.org/services/img/Some_Item-1"
        storage = "https://ia800000.us.archive.org/img/Some_Item-1.jpg"
        self.answers[start] = httpx.Response(302, headers={"location": storage})
        self.answers[storage] = httpx.Response(200, content=JPEG)
        saved, asked = await self.fetch("archive", start)
        self.assertTrue(saved)
        self.assertEqual(asked, [start, storage])
        self.assertEqual(self.job.warnings, [])

    async def test_a_relative_redirect_stays_on_the_archive(self) -> None:
        start = "https://archive.org/services/img/Some_Item-1"
        self.answers[start] = httpx.Response(
            301, headers={"location": "/download/Some_Item-1/cover.jpg"}
        )
        self.answers["https://archive.org/download/Some_Item-1/cover.jpg"] = httpx.Response(
            200, content=JPEG
        )
        saved, _ = await self.fetch("archive", start)
        self.assertTrue(saved)

    async def test_a_redirect_off_the_archive_is_refused_before_it_is_followed(self) -> None:
        start = "https://archive.org/services/img/Some_Item-1"
        for target in (
            "https://evil.test/a.jpg",
            "https://archive.org.evil.test/a.jpg",
            "https://evilarchive.org/a.jpg",
            "http://ia800000.us.archive.org/a.jpg",
            "https://user@evil.test/a.jpg",
        ):
            with self.subTest(target=target):
                self.answers[start] = httpx.Response(302, headers={"location": target})
                self.answers[target] = httpx.Response(200, content=JPEG)
                saved, asked = await self.fetch("archive", start)
                self.assertFalse(saved)
                self.assertEqual(asked, [start])

    async def test_another_sites_cover_may_not_redirect_to_the_archive(self) -> None:
        start = "https://f4.bcbits.com/img/a1_5.jpg"
        storage = "https://ia800000.us.archive.org/a.jpg"
        self.answers[start] = httpx.Response(302, headers={"location": storage})
        self.answers[storage] = httpx.Response(200, content=JPEG)
        saved, asked = await self.fetch("bandcamp", start)
        self.assertFalse(saved)
        self.assertEqual(asked, [start])

    async def test_a_redirect_loop_gives_up(self) -> None:
        start = "https://archive.org/services/img/Loop-1"
        self.answers[start] = httpx.Response(302, headers={"location": start})
        saved, asked = await self.fetch("archive", start)
        self.assertFalse(saved)
        self.assertEqual(len(asked), ART_HOPS + 1)

    async def test_the_type_and_size_checks_still_apply_after_a_redirect(self) -> None:
        start = "https://archive.org/services/img/Some_Item-1"
        storage = "https://ia800000.us.archive.org/img/x"
        self.answers[start] = httpx.Response(302, headers={"location": storage})
        for body in (b"GIF89a not a jpeg", JPEG + b"x" * (5 * 1024**2 + 1)):
            with self.subTest(size=len(body)):
                self.answers[storage] = httpx.Response(200, content=body)
                saved, _ = await self.fetch("archive", start)
                self.assertFalse(saved)


class LabelTests(unittest.TestCase):
    def test_the_server_names_every_source_it_can_hold(self) -> None:
        for site in sources.SITES:
            self.assertEqual(sources.source_label(site.source), site.label)
        self.assertEqual(sources.source_label("podcast"), "Podcasts")
        # A source this build does not know still reads as a name.
        self.assertEqual(sources.source_label("newsite"), "Newsite")

    def test_a_job_carries_its_label_in_its_public_payload(self) -> None:
        from backend.job_models import Job

        for source, label in (
            ("bandcamp", "Bandcamp"),
            ("archive", "Internet Archive"),
            ("podcast", "Podcasts"),
        ):
            with self.subTest(source=source):
                job = Job(
                    id="a",
                    track_id=1,
                    source=source,
                    target="/x",
                    created_at=0,
                    updated_at=0,
                    meta=Metadata(id=1),
                )
                self.assertEqual(job.public()["source_label"], label)

    def test_the_queue_controls_name_each_paused_source(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "test.sqlite3")
            try:
                for source in ("bandcamp", "youtube"):
                    store.db.execute(
                        "INSERT INTO source_control(source,paused,blocking_failures) "
                        "VALUES (?,1,3)",
                        (source,),
                    )
                controls = store.controls()
            finally:
                store.close()
        self.assertEqual(controls["paused_sources"], ["bandcamp", "youtube"])
        self.assertEqual(controls["source_labels"], {"bandcamp": "Bandcamp", "youtube": "YouTube"})


class OnePerTrackTests(unittest.TestCase):
    def test_each_title_is_normalised_once_however_long_the_list_is(self) -> None:
        rows = [
            {"id": f"t{n}", "title": f"Title {n}", "track": f"Title {n}", "duration": 100}
            for n in range(200)
        ]
        with patch("backend.resolver.normalize", wraps=normalize) as spy:
            kept = resolver.one_per_track(rows)
        self.assertEqual(len(kept), 200)
        self.assertEqual(spy.call_count, 200)

    def test_copies_meet_only_rows_with_their_own_title(self) -> None:
        flac = {"id": "a.flac", "title": "Aria", "duration": 100.0}
        mp3 = {"id": "a.mp3", "title": "aria", "duration": 101.0}
        other = {"id": "b.mp3", "title": "Other", "duration": 100.0}
        longer = {"id": "a2.mp3", "title": "Aria", "duration": 300.0}
        self.assertEqual(resolver.one_per_track([mp3, other, flac, longer]), [flac, other, longer])
