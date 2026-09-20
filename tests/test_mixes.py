"""Mixes and radio shows as pasted-link sites: what the table takes and refuses, how the tags and
the landing path are made, and how a job of these kinds runs. Everything is canned, so nothing here
touches the network."""

import asyncio
import json
import tempfile
import threading
import time
import unittest
from collections.abc import Mapping
from datetime import date
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from backend import mixes, resolver, sources
from backend.catalog import Catalog
from backend.downloads import DownloadError, Downloads
from backend.errors import BLOCKING_CODES, error_guidance, geo_restricted
from backend.job_models import Job, LinkRequest, Metadata
from backend.library import Library
from backend.links import LinkError, Links, stable_id
from backend.sources import Kind, Site
from backend.store import Store
from backend.worker import main as worker_main

TODAY = date(2026, 9, 19)
BBC_GEO = "BBC Sounds only plays in the UK, and this server is not there."


def site_of(source: str) -> Site:
    found = sources.by_source(source)
    assert found is not None
    return found


def matches(url: str) -> str | None:
    found = sources.match(url)
    return found.source if found else None


class SiteTests(unittest.TestCase):
    def test_each_row_has_its_kind_and_only_its_own_extractors(self) -> None:
        expected = {
            "mixcloud": ("mix", {"mixcloud", "mixcloud:playlist", "mixcloud:user"}),
            # An NTS episode hands over to the Mixcloud or SoundCloud copy of the show.
            "nts": ("radio", {"nts.live", "mixcloud", "soundcloud"}),
            "hearthis": ("mix", {"HearThisAt"}),
            "bbc": ("radio", {"bbc.co.uk"}),
            "tunein": ("radio", {"tunein:podcast", "tunein:podcast:program"}),
        }
        from yt_dlp.extractor import gen_extractor_classes  # type: ignore[import-untyped]

        known = {cls.IE_NAME for cls in gen_extractor_classes()}
        for source, (kind, extractors) in expected.items():
            with self.subTest(source=source):
                site = site_of(source)
                self.assertEqual((site.kind, set(site.extractors)), (kind, extractors))
                self.assertTrue(extractors <= known)
                self.assertTrue(site.quality_note)
        # The generic BBC extractor, the news and article pages and the iPlayer lists are not here.
        for name in (
            "bbc",
            "bbc.co.uk:article",
            "bbc.co.uk:iplayer:episodes",
            "bbc.co.uk:playlist",
        ):
            self.assertNotIn(name, site_of("bbc").extractors)
        for name in ("tunein:station", "tunein:embed", "tunein:shortener"):
            self.assertNotIn(name, site_of("tunein").extractors)

    def test_good_links_reach_their_row(self) -> None:
        for url, source in {
            "https://www.mixcloud.com/dj/a-mix/": "mixcloud",
            "https://mixcloud.com/dj/": "mixcloud",
            "https://www.mixcloud.com/dj/uploads/": "mixcloud",
            "https://www.mixcloud.com/dj/playlists/list/": "mixcloud",
            "https://www.nts.live/shows/show/episodes/an-episode": "nts",
            "https://hearthis.at/dj/a-set/": "hearthis",
            "https://www.bbc.co.uk/programmes/b00772lv": "bbc",
            "https://bbc.co.uk/programmes/m0031c9v": "bbc",
            "https://www.bbc.co.uk/sounds/play/m0031c9v": "bbc",
            "https://tunein.com/podcasts/Music-Podcasts/Some-Show-p123/": "tunein",
        }.items():
            with self.subTest(url=url):
                self.assertEqual(matches(url), source)
        for url in (
            "https://mixcloud.com.evil.test/dj/a-mix/",
            "https://evilnts.live/shows/a/episodes/b",
            "https://hearthis.at.evil.test/dj/a/",
            "https://www.bbc.co.uk.evil.test/programmes/b00772lv",
            "https://tun.in/abc",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))

    def test_bbc_video_and_news_pages_are_refused(self) -> None:
        for url in (
            "https://www.bbc.co.uk/iplayer/episode/b00yng5w/some-video",
            "https://www.bbc.co.uk/iplayer/episodes/b006qykl/some-brand",
            "https://www.bbc.co.uk/news/articles/c1234abcd",
            "https://www.bbc.co.uk/news/videos/c1234abcd",
            "https://www.bbc.co.uk/news/uk-12345678",
            "https://www.bbc.co.uk/programmes/articles/zqq6cwx",
            "https://www.bbc.co.uk/programmes/b006qnmr/episodes/player",
            "https://www.bbc.co.uk/sport/football/12345678",
            "https://www.bbc.co.uk/",
            "https://www.bbc.com/news/videos/c1234abcd",
            "https://news.bbc.co.uk/2/hi/uk/1.stm",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))
        self.assertEqual(
            sources.refusal("https://www.bbc.co.uk/news/videos/c1234abcd"),
            "Musimo only takes programme and Sounds pages from BBC Sounds.",
        )

    def test_a_tunein_station_is_refused_as_live_and_a_podcast_is_not(self) -> None:
        for url in (
            "https://tunein.com/radio/BBC-Radio-1-s24939/",
            "https://tunein.com/radio/NTS-Radio-s123456",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))
                self.assertEqual(sources.refusal(url), sources.LIVE_MESSAGE)
        podcast = "https://tunein.com/podcasts/Comedy-Podcasts/A-Show-p1111/"
        self.assertEqual(matches(podcast), "tunein")
        self.assertIsNone(sources.match("https://tunein.com/embed/player/s24939/"))

    def test_live_channels_of_the_other_sites_are_refused_as_live(self) -> None:
        for url in (
            "https://www.mixcloud.com/live/some-dj",
            "https://www.nts.live/1",
            "https://nts.live/2/",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))
                self.assertEqual(sources.refusal(url), sources.LIVE_MESSAGE)

    def test_a_sounds_episode_is_read_from_its_programme_page(self) -> None:
        self.assertEqual(
            sources.canonical("https://www.bbc.co.uk/sounds/play/m0031c9v"),
            "https://www.bbc.co.uk/programmes/m0031c9v",
        )
        self.assertEqual(
            sources.canonical("https://www.bbc.co.uk/sounds/play/m0031c9v/?at_medium=x"),
            "https://www.bbc.co.uk/programmes/m0031c9v",
        )
        for url in (
            "https://www.bbc.co.uk/programmes/b00772lv",
            "https://www.mixcloud.com/dj/a-mix/",
            "https://evil.test/sounds/play/m0031c9v",
        ):
            self.assertEqual(sources.canonical(url), url)

    def test_a_site_may_hand_over_only_to_the_sites_its_row_names(self) -> None:
        nts = site_of("nts")
        self.assertTrue(sources.reaches(nts, "https://www.mixcloud.com/NTSRadio/an-episode/"))
        self.assertTrue(sources.reaches(nts, "https://soundcloud.com/nts-latest/an-episode"))
        self.assertTrue(sources.reaches(nts, "https://www.nts.live/shows/a/episodes/b"))
        self.assertFalse(sources.reaches(nts, "https://archive.org/details/x"))
        self.assertFalse(sources.reaches(nts, "https://evil.test/a"))
        # The hand over is not mutual.
        self.assertFalse(
            sources.reaches(site_of("mixcloud"), "https://www.nts.live/shows/a/episodes/b")
        )
        self.assertFalse(sources.reaches(site_of("bandcamp"), "https://www.mixcloud.com/dj/a-mix/"))

    def test_a_site_that_does_not_work_is_left_out_and_refused(self) -> None:
        self.assertFalse(site_of("audiomack").working)
        self.assertFalse(site_of("tunein").working)
        for source in ("youtube", "archive", "bandcamp", "soundcloud", "audius", "jamendo"):
            self.assertTrue(site_of(source).working, source)
        listed = sources.labels().split(", ")
        self.assertNotIn("Audiomack", listed)
        self.assertNotIn("TuneIn", listed)
        for label in ("Mixcloud", "NTS", "HearThisAt", "BBC Sounds", "Bandcamp"):
            self.assertIn(label, listed)
        self.assertEqual(
            sources.unavailable(site_of("audiomack")),
            "Audiomack links don't work right now. The tool Musimo uses can't read that site.",
        )
        # It still matches, so its tests and probe keep running.
        self.assertEqual(matches("https://audiomack.com/a/song/b"), "audiomack")


class KindTests(unittest.TestCase):
    def test_a_soundcloud_track_over_twenty_minutes_is_a_mix(self) -> None:
        soundcloud = site_of("soundcloud")
        self.assertEqual(soundcloud.kind, "music")
        self.assertEqual(mixes.kind_of(soundcloud, 20 * 60 + 1), "mix")
        self.assertEqual(mixes.kind_of(soundcloud, 20 * 60), "music")
        self.assertEqual(mixes.kind_of(soundcloud, 240), "music")
        # A row that does not say so never turns a long recording into a mix.
        self.assertEqual(mixes.kind_of(site_of("youtube"), 3 * 3600), "music")
        self.assertEqual(mixes.kind_of(site_of("bandcamp"), 3 * 3600), "music")
        self.assertEqual(mixes.kind_of(site_of("mixcloud"), 60), "mix")
        self.assertEqual(mixes.kind_of(site_of("bbc"), 60), "radio")


class TagTests(unittest.TestCase):
    def meta(self, **values: object) -> Metadata:
        base: dict[str, object] = {
            "id": 1,
            "title": "Mix 1",
            "artist": "DJ Rex",
            "album_artist": "DJ Rex",
            "album": "Mix 1",
            "date": "2024-03-02",
            "duration": 3600,
            "track": 1,
            "tracks": 1,
        }
        return Metadata.model_validate(base | values)

    def test_a_mix_is_tagged_with_its_uploader_as_artist_and_album(self) -> None:
        meta = mixes.retag(
            self.meta(), site_of("mixcloud"), "mix", "https://www.mixcloud.com/dj/a-mix/", False
        )
        self.assertEqual(
            (meta.artist, meta.album_artist, meta.album, meta.genre, meta.track, meta.tracks),
            ("DJ Rex", "DJ Rex", "DJ Rex", "DJ Mix", 1, 1),
        )

    def test_a_show_is_its_own_album_and_has_the_radio_genre(self) -> None:
        nts = mixes.retag(
            self.meta(title="Absolute Fiction", artist="Mixcloud NTS Radio"),
            site_of("nts"),
            "radio",
            "https://www.nts.live/shows/absolute-fiction/episodes/absolute-fiction-23rd-july-2022",
            False,
        )
        self.assertEqual(
            (nts.artist, nts.album, nts.genre), ("Mixcloud NTS Radio", "Absolute Fiction", "Radio")
        )
        bbc = mixes.retag(
            self.meta(title="Desert Island Discs, Lady Natasha Spender", artist=""),
            site_of("bbc"),
            "radio",
            "https://www.bbc.co.uk/programmes/b00772lv",
            False,
        )
        # The page names nobody, so the site stands in, and the title's first part is the show.
        self.assertEqual(
            (bbc.artist, bbc.album, bbc.genre), ("BBC Sounds", "Desert Island Discs", "Radio")
        )
        no_show = mixes.retag(
            self.meta(title="One Off", artist=""),
            site_of("bbc"),
            "radio",
            "https://www.bbc.co.uk/programmes/b00772lv",
            False,
        )
        self.assertEqual((no_show.artist, no_show.album), ("BBC Sounds", "BBC Sounds"))

    def test_an_uploader_missing_from_the_page_comes_from_the_address(self) -> None:
        meta = mixes.retag(
            self.meta(artist=""),
            site_of("hearthis"),
            "mix",
            "https://hearthis.at/djquicke/a-set/",
            False,
        )
        self.assertEqual((meta.artist, meta.album, meta.genre), ("djquicke", "djquicke", "DJ Mix"))
        # What the page says wins over the address.
        named = mixes.retag(
            self.meta(artist="Quicke"),
            site_of("hearthis"),
            "mix",
            "https://hearthis.at/djquicke/a/",
            False,
        )
        self.assertEqual(named.artist, "Quicke")

    def test_a_long_soundcloud_track_keeps_the_album_its_set_gives_it(self) -> None:
        soundcloud = site_of("soundcloud")
        url = "https://soundcloud.com/dj/a-long-set"
        kept = mixes.retag(self.meta(album="The Set"), soundcloud, "mix", url, True)
        self.assertEqual((kept.album, kept.genre), ("The Set", "DJ Mix"))
        loose = mixes.retag(self.meta(album="The Set"), soundcloud, "mix", url, False)
        self.assertEqual(loose.album, "DJ Rex")

    def test_retagging_twice_gives_the_same_tags(self) -> None:
        site = site_of("nts")
        url = "https://www.nts.live/shows/absolute-fiction/episodes/x"
        once = mixes.retag(self.meta(artist=""), site, "radio", url, False)
        self.assertEqual(mixes.retag(once, site, "radio", url, False), once)

    def test_the_landing_path_is_uploader_then_day_and_title(self) -> None:
        self.assertEqual(
            mixes.landing(self.meta(), TODAY, "mp3"), "Mixes/DJ Rex/2024-03-02 - Mix 1.mp3"
        )
        self.assertEqual(mixes.landing(self.meta(), TODAY), "Mixes/DJ Rex/2024-03-02 - Mix 1")

    def test_an_unknown_date_falls_back_to_the_download_date(self) -> None:
        for known in ("", "2019", "March 2019", "2019-03"):
            with self.subTest(date=known):
                self.assertEqual(
                    mixes.landing(self.meta(date=known), TODAY, "m4a"),
                    "Mixes/DJ Rex/2026-09-19 - Mix 1.m4a",
                )

    def test_path_parts_are_cleaned_like_every_other_path(self) -> None:
        path = mixes.landing(self.meta(artist='A/B: "C"', title="Live: Part 1/2?"), TODAY, "opus")
        self.assertEqual(path, "Mixes/A_B_ _C_/2024-03-02 - Live_ Part 1_2_.opus")
        self.assertEqual(
            mixes.landing(self.meta(artist=".."), TODAY, "mp3").split("/")[1], "Unknown"
        )
        long = mixes.landing(self.meta(title="x" * 300), TODAY, "mp3")
        self.assertLessEqual(len(long.split("/")[2]), 80 + len(".mp3"))


def row(source: str, number: int = 1, **extra: object) -> dict[str, object]:
    """One resolver row for a recording of a site, the way the resolver prints it."""
    site = site_of(source)
    return {
        "id": f"t{number}",
        "extractor": site.items[0],
        "url": f"https://{site.hosts[0]}/dj/mix-{number}/",
        "title": f"Mix {number}",
        "artist": "DJ Rex",
        "album": "",
        "date": "2024-03-02",
        "duration": 3600,
        "art": "",
        "live": False,
        "track": 0,
        "tracks": 0,
        "album_list": False,
    } | extra


class Canned(Links):
    """Answers from canned resolver output instead of starting a process."""

    answer: dict[str, object] = {}
    asked: list[str]

    async def extract(self, url: str, site: Site) -> dict[str, object]:
        self.asked = [*getattr(self, "asked", []), url]
        return self.answer


class Harness(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "test.sqlite3")
        self.store.update({"destination": str(self.root)})
        self.requests: list[str] = []

        def respond(request: httpx.Request) -> httpx.Response:
            self.requests.append(str(request.url))
            return httpx.Response(404)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        library = Library(self.store, [self.root], asyncio.Event())
        self.service = Downloads(
            self.store, Catalog(self.store, self.client), library, asyncio.Event()
        )
        self.service.today = lambda: TODAY
        self.service.worker = self.fake_worker  # type: ignore[method-assign]
        # The placeholder audio is not a real file, so the library cannot read tags from it.
        library.index_published = lambda path, root: None  # type: ignore[method-assign]
        # Nothing of kind mix or radio may reach the catalog, the lyrics or MusicBrainz.
        self.tidy = AsyncMock(side_effect=AssertionError("catalog tidy-up"))
        self.service.link_tags.tidy = self.tidy  # type: ignore[method-assign]
        self.track = AsyncMock(side_effect=AssertionError("catalog track"))
        self.extra = AsyncMock(side_effect=AssertionError("lyrics and MusicBrainz"))
        self.service.enrichment.track = self.track  # type: ignore[method-assign]
        self.service.enrichment.extra = self.extra  # type: ignore[method-assign]
        self.fails: DownloadError | None = None
        self.links = Canned(self.service)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.temporary.cleanup()

    async def fake_worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        if self.fails:
            raise self.fails
        ready = folder / "ready.mp3"
        ready.write_bytes(b"synthetic audio placeholder")
        return ready, {"codec": "mp3", "bitrate": 128}

    def no_catalog_calls(self) -> None:
        self.tidy.assert_not_called()
        self.track.assert_not_called()
        self.extra.assert_not_called()
        self.assertEqual(self.requests, [])


class PreviewTests(Harness):
    async def preview(self, source: str, url: str, *rows: dict[str, object]) -> dict[str, object]:
        self.links.answer = {
            "kind": "preview",
            "single": len(rows) == 1,
            "title": "t",
            "entries": list(rows),
        }
        return await self.links.resolve(url)

    def entries(self, preview: dict[str, object]) -> list[dict[str, object]]:
        return cast(list[dict[str, object]], preview["entries"])

    async def test_the_sheet_gets_the_landing_path_before_anything_is_queued(self) -> None:
        preview = await self.preview(
            "mixcloud", "https://www.mixcloud.com/dj/mix-1/", row("mixcloud")
        )
        (item,) = self.entries(preview)
        self.assertEqual(preview["kind"], "mix")
        self.assertEqual(
            (item["kind"], item["lands"], item["artist"], item["album"]),
            ("mix", "Mixes/DJ Rex/2024-03-02 - Mix 1", "DJ Rex", "DJ Rex"),
        )

    async def test_a_show_with_no_date_previews_the_download_date(self) -> None:
        url = "https://www.nts.live/shows/absolute-fiction/episodes/an-episode"
        preview = await self.preview(
            "nts",
            url,
            row("nts", url=url, title="Absolute Fiction", artist="Mixcloud NTS Radio", date=""),
        )
        (item,) = self.entries(preview)
        self.assertEqual(item["kind"], "radio")
        self.assertEqual(item["album"], "Absolute Fiction")
        self.assertEqual(item["lands"], "Mixes/Mixcloud NTS Radio/2026-09-19 - Absolute Fiction")

    async def test_a_song_has_no_landing_path(self) -> None:
        preview = await self.preview(
            "soundcloud", "https://soundcloud.com/dj/mix-1/", row("soundcloud", duration=240)
        )
        (item,) = self.entries(preview)
        self.assertEqual((item["kind"], item["lands"]), ("music", ""))

    async def test_a_profile_lists_songs_and_long_sets_side_by_side(self) -> None:
        preview = await self.preview(
            "soundcloud",
            "https://soundcloud.com/dj",
            row("soundcloud", 1, duration=180),
            row("soundcloud", 2, duration=3 * 3600),
            row("soundcloud", 3, duration=20 * 60),
            row("soundcloud", 4, duration=20 * 60 + 1),
        )
        self.assertEqual(
            [(item["kind"], bool(item["lands"])) for item in self.entries(preview)],
            [("music", False), ("mix", True), ("music", False), ("mix", True)],
        )

    async def test_the_queue_gets_each_recordings_own_kind_and_tags(self) -> None:
        preview = await self.preview(
            "soundcloud",
            "https://soundcloud.com/dj",
            row("soundcloud", 1, duration=180),
            row("soundcloud", 2, duration=3 * 3600),
        )
        queued = self.links.enqueue(
            LinkRequest(token=str(preview["token"]), entry_ids=["t1", "t2"])
        )
        jobs = {
            job["meta"]["title"]: job
            for job in cast(list[dict[str, dict[str, str]]], queued["jobs"])
        }
        self.assertEqual(
            {title: (job["kind"], job["meta"]["genre"]) for title, job in jobs.items()},
            {"Mix 1": ("music", ""), "Mix 2": ("mix", "DJ Mix")},
        )
        self.assertEqual({job["source"] for job in jobs.values()}, {"soundcloud"})

    async def test_a_mix_job_gets_its_uploader_as_artist_and_a_show_as_album(self) -> None:
        url = "https://www.nts.live/shows/absolute-fiction/episodes/an-episode"
        preview = await self.preview("nts", url, row("nts", url=url, artist="NTS Radio"))
        queued = self.links.enqueue(LinkRequest(token=str(preview["token"]), entry_ids=["t1"]))
        (job,) = cast(list[dict[str, object]], queued["jobs"])
        meta = self.service.jobs.get(str(job["id"])).meta
        self.assertEqual(
            (meta.artist, meta.album_artist, meta.album, meta.genre, meta.art),
            ("NTS Radio", "NTS Radio", "Absolute Fiction", "Radio", ""),
        )

    async def test_a_site_that_does_not_work_is_refused_before_anything_runs(self) -> None:
        for url, message in {
            "https://audiomack.com/a/song/b": sources.unavailable(site_of("audiomack")),
            "https://tunein.com/podcasts/Comedy-Podcasts/A-Show-p1111/": sources.unavailable(
                site_of("tunein")
            ),
            "https://tunein.com/radio/BBC-Radio-1-s24939/": sources.LIVE_MESSAGE,
            "https://www.bbc.co.uk/iplayer/episode/b00yng5w/x": (
                "Musimo only takes programme and Sounds pages from BBC Sounds."
            ),
        }.items():
            with self.subTest(url=url):
                with self.assertRaises(LinkError) as caught:
                    await self.links.resolve(url)
                self.assertEqual((caught.exception.status, caught.exception.detail), (422, message))
        self.assertFalse(hasattr(self.links, "asked"))

    async def test_a_sounds_link_is_sent_to_the_resolver_as_its_programme_page(self) -> None:
        self.links.answer = {
            "kind": "preview",
            "single": True,
            "entries": [
                row("bbc", url="https://www.bbc.co.uk/programmes/m0031c9v", title="Show, Ep")
            ],
        }
        await self.links.resolve("https://www.bbc.co.uk/sounds/play/m0031c9v")
        self.assertEqual(self.links.asked, ["https://www.bbc.co.uk/programmes/m0031c9v"])

    async def test_a_geo_block_at_the_preview_says_where_it_plays(self) -> None:
        self.links.answer = {"kind": "error", "code": "GEO_RESTRICTED", "message": "raw"}
        with self.assertRaises(LinkError) as caught:
            await self.links.resolve("https://www.bbc.co.uk/programmes/m0031c9v")
        self.assertEqual((caught.exception.status, caught.exception.detail), (422, BBC_GEO))


class RunTests(Harness):
    async def land(
        self, source: str, url: str, kind: Kind, meta: Metadata, template: str = ""
    ) -> Job:
        if template:
            self.store.update({"naming_template": template})
        job = self.service.jobs.enqueue_many(
            [meta.id],
            "original",
            str(self.root),
            catalog="link",
            prepared={meta.id: (meta, url)},
            source=source,
            kind=kind,
        )[0]
        await self.service.run(job.id)
        return self.service.jobs.get(job.id)

    def meta(self, **values: object) -> Metadata:
        base: dict[str, object] = {
            "id": stable_id("mixcloud:t1"),
            "title": "Mix 1",
            "artist": "DJ Rex",
            "album_artist": "DJ Rex",
            "album": "DJ Rex",
            "genre": "DJ Mix",
            "date": "2024-03-02",
            "duration": 3600,
        }
        return Metadata.model_validate(base | values)

    async def test_a_mix_lands_under_mixes_whatever_the_naming_template_says(self) -> None:
        job = await self.land(
            "mixcloud",
            "https://www.mixcloud.com/dj/mix-1/",
            "mix",
            self.meta(),
            template="{album_artist}/{year}/{title}",
        )
        self.assertEqual((job.stage, job.error), ("done", ""))
        expected = self.root / "Mixes" / "DJ Rex" / "2024-03-02 - Mix 1.mp3"
        self.assertEqual(Path(job.final_path), expected)
        self.assertTrue(expected.is_file())
        self.no_catalog_calls()

    async def test_a_show_with_no_date_lands_under_the_download_date(self) -> None:
        meta = self.meta(
            id=stable_id("bbc.co.uk:t1"), artist="BBC Sounds", album="Show", genre="Radio", date=""
        )
        job = await self.land("bbc", "https://www.bbc.co.uk/programmes/b00772lv", "radio", meta)
        expected = self.root / "Mixes" / "BBC Sounds" / "2026-09-19 - Mix 1.mp3"
        self.assertEqual(Path(job.final_path), expected)
        self.assertEqual(job.meta.genre, "Radio")
        self.no_catalog_calls()

    async def test_a_song_still_lands_by_the_naming_template(self) -> None:
        # A music link on the same site takes the ordinary road, so the layout follows the kind.
        meta = self.meta(id=stable_id("soundcloud:t1"), genre="", album="Song")
        self.tidy.side_effect = None
        self.tidy.return_value = (meta, "Tagged from SoundCloud, no catalog match")
        job = await self.land(
            "soundcloud",
            "https://soundcloud.com/dj/song",
            "music",
            meta,
            template="{artist}/{title}",
        )
        self.tidy.assert_awaited_once()
        self.assertEqual(Path(job.final_path), self.root / "DJ Rex" / "Mix 1.mp3")

    async def test_mixes_and_shows_get_the_hour_long_budget(self) -> None:
        for kind, seconds in (("mix", 3600), ("radio", 3600), ("music", 600)):
            with self.subTest(kind=kind):
                job = self.service.jobs.enqueue_many(
                    [stable_id(f"budget:{kind}")],
                    "original",
                    str(self.root),
                    catalog="link",
                    prepared={
                        stable_id(f"budget:{kind}"): (
                            self.meta(id=stable_id(f"budget:{kind}")),
                            "https://www.mixcloud.com/dj/mix-1/",
                        )
                    },
                    source="mixcloud",
                    kind=cast(Kind, kind),
                )[0]
                self.assertEqual(self.service.budget(job), seconds)

    async def test_a_geo_block_is_not_counted_toward_pausing_any_source(self) -> None:
        self.assertNotIn("GEO_RESTRICTED", BLOCKING_CODES)
        self.fails = DownloadError("GEO_RESTRICTED", BBC_GEO)
        for number in range(4):
            meta = self.meta(id=stable_id(f"bbc.co.uk:{number}"), title=f"Show {number}")
            job = await self.land(
                "bbc", f"https://www.bbc.co.uk/programmes/b00772l{number}", "radio", meta
            )
            self.assertEqual(
                (job.stage, job.error_code, job.retryable), ("failed", "GEO_RESTRICTED", False)
            )
            self.assertEqual(
                (job.error, job.error_hint, job.error_fix), (BBC_GEO, BBC_GEO, "card:dismiss")
            )
        self.assertEqual(self.service.controls()["paused_sources"], [])
        with self.store.lock:
            counts = self.store.db.execute(
                "SELECT blocking_failures FROM source_control WHERE source='bbc'"
            ).fetchall()
        self.assertEqual(counts, [])


class ErrorTests(unittest.TestCase):
    def test_the_geo_message_names_the_site(self) -> None:
        self.assertEqual(error_guidance("GEO_RESTRICTED", "BBC Sounds"), (BBC_GEO, "card:dismiss"))
        self.assertEqual(
            error_guidance("GEO_RESTRICTED", "Mixcloud"),
            ("Mixcloud does not play in the country this server is in.", "card:dismiss"),
        )

    def test_the_tools_own_wording_for_a_geo_block_is_recognised(self) -> None:
        for text in (
            "ERROR: [bbc.co.uk] m0031c9v: bbc.co.uk returned error: geolocation",
            "This video is not available from your location due to geo restriction.",
            "The site is geo-restricted",
        ):
            with self.subTest(text=text):
                self.assertTrue(geo_restricted(text))
        for text in ("HTTP Error 403: Forbidden", "Unable to download JSON metadata", ""):
            with self.subTest(text=text):
                self.assertFalse(geo_restricted(text))


class WorkerTests(unittest.TestCase):
    def job(self, directory: str, source: str, url: str, kind: Kind) -> Job:
        return Job.model_validate(
            {
                "id": "test",
                "catalog": "link",
                "source": source,
                "kind": kind,
                "track_id": stable_id(f"{source}:1"),
                "source_url": url,
                "target": directory,
                "created_at": 0,
                "updated_at": 0,
                "meta": Metadata(id=1, title="Show", artist="BBC Sounds", duration=60).model_dump(),
            }
        )

    def run_worker(self, job: Job, info: object) -> tuple[MagicMock, list[dict[str, object]]]:
        folder = Path(job.target)
        (folder / "job.json").write_text(job.model_dump_json(), "utf-8")
        (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
        events: list[dict[str, object]] = []
        with (
            patch("sys.argv", ["worker", job.target]),
            patch("yt_dlp.YoutubeDL") as downloader,
            patch("backend.worker.probe", return_value={"duration": 900}),
            patch("backend.worker.Tagger") as tagger,
            patch(
                "backend.worker.emit",
                side_effect=lambda kind, **v: events.append({"kind": kind, **v}),
            ),
        ):
            if isinstance(info, Exception):
                downloader.return_value.extract_info.side_effect = info
            else:
                downloader.return_value.extract_info.return_value = info
            downloader.return_value.process_ie_result.return_value = {}
            tagger.return_value.prepare.return_value = folder / "source.m4a"
            worker_main()
        return downloader, events

    def test_a_geo_block_gets_its_own_message_and_is_never_retried(self) -> None:
        for text in (
            "ERROR: [bbc.co.uk] m0031c9v: bbc.co.uk returned error: geolocation",
            "This video is not available from your location due to geo restriction.",
        ):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as directory:
                job = self.job(
                    directory, "bbc", "https://www.bbc.co.uk/programmes/m0031c9v", "radio"
                )
                _, events = self.run_worker(job, Exception(text))
                (error,) = [event for event in events if event["kind"] == "error"]
                self.assertEqual(error["code"], "GEO_RESTRICTED")
                self.assertEqual(error["message"], BBC_GEO)
                self.assertEqual((error["hint"], error["fix"]), (BBC_GEO, "card:dismiss"))
                self.assertIs(error["retryable"], False)

    def test_a_link_that_hands_over_to_another_site_downloads_from_the_copy(self) -> None:
        url = "https://www.nts.live/shows/absolute-fiction/episodes/an-episode"
        with tempfile.TemporaryDirectory() as directory:
            info = {"id": "NTSRadio_an-episode", "extractor": "mixcloud"}
            downloader, events = self.run_worker(self.job(directory, "nts", url, "radio"), info)
        options = downloader.call_args.args[0]
        self.assertEqual(options["allowed_extractors"], site_of("nts").allowed_extractors())
        self.assertIn("mixcloud", options["allowed_extractors"])
        self.assertEqual(events[-1]["kind"], "ready")

    def test_a_bbc_show_is_taken_as_audio_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(directory, "bbc", "https://www.bbc.co.uk/programmes/b00772lv", "radio")
            downloader, _ = self.run_worker(job, {"id": "b006rxxz", "extractor": "bbc.co.uk"})
        self.assertEqual(downloader.call_args.args[0]["format"], "bestaudio")


def run_resolver(
    source: str,
    url: str,
    answers: list[Mapping[str, object]],
    pages: Mapping[str, Mapping[str, object]] | None = None,
) -> dict[str, object]:
    """The last thing the resolver emits for canned answers, one per read of the link."""
    downloader = MagicMock()
    downloader.extract_info.side_effect = [dict(answer) for answer in answers]
    events: list[dict[str, object]] = []
    with patch(
        "backend.resolver.emit", side_effect=lambda kind, **v: events.append({"kind": kind, **v})
    ):
        resolver.resolve(
            downloader,
            site_of(source),
            url,
            lambda address: dict(pages[address]) if pages and address in pages else None,
        )
    return events[-1]


class ResolverTests(unittest.TestCase):
    NTS = "https://www.nts.live/shows/absolute-fiction/episodes/absolute-fiction-23rd-july-2022"
    MIXCLOUD = "https://www.mixcloud.com/NTSRadio/absolute-fiction-23rd-july-2022/"
    THUMB = "https://thumbnailer.mixcloud.com/unsafe/1024x1024/extaudio/5/1/a/d/ae3e-1be9-4fd4"

    def mixcloud_info(self, **extra: object) -> dict[str, object]:
        return {
            "extractor": "mixcloud",
            "id": "NTSRadio_absolute-fiction-23rd-july-2022",
            "title": "Absolute Fiction - 23rd July 2022",
            "uploader": "Mixcloud NTS Radio",
            "timestamp": 1658772398,
            "duration": 3529,
            "thumbnail": self.THUMB,
            "webpage_url": self.MIXCLOUD,
        } | extra

    def test_an_nts_episode_passes_through_to_mixcloud_and_keeps_the_address_pasted(self) -> None:
        handover = {"_type": "url_transparent", "extractor": "nts.live", "url": self.MIXCLOUD}
        preview = run_resolver("nts", self.NTS, [handover, self.mixcloud_info()])
        (item,) = cast(list[dict[str, object]], preview["entries"])
        self.assertEqual(item["url"], self.NTS)
        self.assertEqual(item["extractor"], "mixcloud")
        self.assertEqual((item["artist"], item["date"]), ("Mixcloud NTS Radio", "2022-07-25"))

    def test_a_mix_is_by_its_uploader_not_by_the_artists_of_the_tracks_in_it(self) -> None:
        info = self.mixcloud_info(artists=["Anja Schneider", "Musumeci"], artist="Anja Schneider")
        preview = run_resolver("mixcloud", self.MIXCLOUD, [info])
        (item,) = cast(list[dict[str, object]], preview["entries"])
        self.assertEqual(item["artist"], "Mixcloud NTS Radio")
        # A song on a music site keeps its own artist.
        song = {
            "extractor": "soundcloud",
            "id": "1",
            "title": "Song",
            "artist": "Named Artist",
            "uploader": "account",
            "webpage_url": "https://soundcloud.com/account/song",
        }
        preview = run_resolver("soundcloud", "https://soundcloud.com/account/song", [song])
        (item,) = cast(list[dict[str, object]], preview["entries"])
        self.assertEqual(item["artist"], "Named Artist")

    def test_a_handover_to_a_site_off_the_row_is_refused(self) -> None:
        for target in ("https://evil.test/a", "https://archive.org/details/x"):
            with self.subTest(target=target):
                handover = {"_type": "url_transparent", "extractor": "nts.live", "url": target}
                event = run_resolver("nts", self.NTS, [handover])
                self.assertEqual((event["kind"], event["code"]), ("error", "SITE_NOT_ALLOWED"))
        # A music site may not hand over to a mix site either.
        handover = {"_type": "url", "url": self.MIXCLOUD}
        event = run_resolver("bandcamp", "https://band.bandcamp.com/track/x", [handover])
        self.assertEqual(event["code"], "SITE_NOT_ALLOWED")

    def test_a_cover_with_no_extension_is_kept_for_mixes_and_never_for_songs(self) -> None:
        self.assertEqual(resolver.artwork({"thumbnail": self.THUMB}, bare=True), self.THUMB)
        self.assertEqual(resolver.artwork({"thumbnail": self.THUMB}), "")
        self.assertEqual(
            resolver.artwork(
                {"thumbnails": [{"url": self.THUMB}, {"url": "https://x.test/a.png"}]}, True
            ),
            self.THUMB,
        )
        self.assertEqual(resolver.artwork({"thumbnail": "https://x.test/a.png"}, bare=True), "")
        preview = run_resolver("mixcloud", self.MIXCLOUD, [self.mixcloud_info()])
        (item,) = cast(list[dict[str, object]], preview["entries"])
        self.assertEqual(item["art"], self.THUMB)
        # The site's own image hosts still decide what the server will fetch.
        self.assertEqual(sources.safe_art(site_of("mixcloud"), self.THUMB), self.THUMB)
        self.assertEqual(sources.safe_art(site_of("mixcloud"), "https://evil.test/a"), "")

    def test_a_mixcloud_profile_lists_each_mix_it_could_read_and_marks_the_rest(self) -> None:
        user = "https://www.mixcloud.com/dj/"
        listed = {
            "_type": "playlist",
            "extractor": "mixcloud:user",
            "title": "dj (uploads)",
            "entries": [
                {"_type": "url", "ie_key": "Mixcloud", "id": f"dj_m{n}", "url": f"{user}m{n}/"}
                for n in (1, 2, 3)
            ],
        }
        pages = {
            f"{user}m{n}/": {
                "extractor": "mixcloud",
                "id": f"dj_m{n}",
                "title": f"Mix {n}",
                "uploader": "DJ",
                "webpage_url": f"{user}m{n}/",
                "duration": 3000,
            }
            for n in (1, 2)
        }
        preview = run_resolver("mixcloud", user, [listed], pages)
        self.assertEqual(
            [item["title"] for item in cast(list[dict[str, object]], preview["entries"])],
            ["Mix 1", "Mix 2"],
        )
        self.assertIs(preview["partial"], True)
        self.assertTrue(site_of("mixcloud").is_profile(user))
        self.assertFalse(site_of("mixcloud").is_profile(f"{user}m1/"))

    def test_a_geo_block_at_the_preview_is_reported_with_its_own_code(self) -> None:
        events: list[dict[str, object]] = []
        request = json.dumps({"url": "https://www.bbc.co.uk/programmes/m0031c9v", "source": "bbc"})
        with (
            patch("sys.stdin", MagicMock(read=lambda: request)),
            patch("yt_dlp.YoutubeDL") as downloader,
            patch(
                "backend.resolver.emit",
                side_effect=lambda kind, **v: events.append({"kind": kind, **v}),
            ),
        ):
            downloader.return_value.extract_info.side_effect = Exception(
                "ERROR: [bbc.co.uk] m0031c9v: bbc.co.uk returned error: geolocation"
            )
            resolver.main()
        self.assertEqual((events[-1]["kind"], events[-1]["code"]), ("error", "GEO_RESTRICTED"))


class ReadingPagesTests(unittest.TestCase):
    def test_pages_are_read_a_few_at_a_time_and_never_more_than_four(self) -> None:
        self.assertEqual(resolver.LOOKUP_THREADS, 4)
        lock = threading.Lock()
        active = peak = 0

        def lookup(address: str) -> dict[str, object] | None:
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.05)
            with lock:
                active -= 1
            return {"title": address}

        addresses = [f"https://www.mixcloud.com/dj/m{n}/" for n in range(16)]
        started = time.monotonic()
        found = resolver.looked_up(lookup, addresses, 10)
        took = time.monotonic() - started
        self.assertEqual(set(found), set(addresses))
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 4)
        # Sixteen pages of 50 ms one after another would take 0.8 s.
        self.assertLess(took, 0.6)

    def test_a_page_still_loading_at_the_cap_is_left_out(self) -> None:
        release = threading.Event()

        def lookup(address: str) -> dict[str, object] | None:
            if address.endswith("slow/"):
                release.wait(5)
            return {"title": address}

        try:
            found = resolver.looked_up(
                lookup,
                ["https://www.mixcloud.com/dj/fast/", "https://www.mixcloud.com/dj/slow/"],
                0.3,
            )
        finally:
            release.set()
        self.assertEqual(list(found), ["https://www.mixcloud.com/dj/fast/"])

    def test_nothing_is_started_once_the_time_is_spent(self) -> None:
        calls: list[str] = []

        def lookup(address: str) -> dict[str, object] | None:
            calls.append(address)
            return {}

        found = resolver.looked_up(lookup, ["a", "b"], 0)
        self.assertEqual((found, calls), ({}, []))
        # A listing that reaches its pages after the cap leaves every thin row out and says so.
        user = "https://www.mixcloud.com/dj/"
        listed = {
            "_type": "playlist",
            "extractor": "mixcloud:user",
            "title": "dj (uploads)",
            "entries": [{"_type": "url", "ie_key": "Mixcloud", "id": "dj_m1", "url": f"{user}m1/"}],
        }
        with patch("backend.resolver.BUDGET_SECONDS", 0):
            preview = run_resolver("mixcloud", user, [listed], {f"{user}m1/": {"title": "Mix 1"}})
        self.assertEqual((preview["entries"], preview["partial"]), ([], True))
