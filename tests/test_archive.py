"""The Internet Archive as a pasted-link site, from canned yt-dlp answers. Nothing here touches the
network."""

import asyncio
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import cast
from unittest.mock import MagicMock, patch

import httpx
import yt_dlp  # type: ignore[import-untyped]
from fastapi import FastAPI

from backend import resolver, sources
from backend.catalog import Catalog
from backend.downloads import Downloads
from backend.library import Library
from backend.link_api import install_link_routes
from backend.links import Links
from backend.sources import Site
from backend.store import Store

ITEM = "Goldberg_Demo-1"


def load_probe() -> ModuleType:
    """The probe script runs on its own, so it is loaded by path rather than imported."""
    path = Path(__file__).resolve().parents[1] / "scripts" / "source_probe.py"
    spec = importlib.util.spec_from_file_location("source_probe", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


source_probe = load_probe()


def site() -> Site:
    found = sources.by_source("archive")
    assert found is not None
    return found


def track(
    name: str, title: str, number: int | None, seconds: float, **extra: object
) -> dict[str, object]:
    """One entry as the yt-dlp archive.org extractor lists it before any processing."""
    row: dict[str, object] = {
        "id": f"{ITEM}/{name}",
        "title": title,
        "track": title,
        "display_id": name,
        "duration": seconds,
        "creators": ["Kimiko Ishizaka"],
        "album": "A per-file album name",
        "thumbnails": [],
        "formats": [{"url": f"https://archive.org/download/{ITEM}/{name}", "source_preference": 0}],
    }
    if number is not None:
        row["track_number"] = number
    return row | extra


def item(*entries: dict[str, object], **extra: object) -> dict[str, object]:
    return {
        "_type": "playlist",
        "id": ITEM,
        "extractor": "archive.org",
        "webpage_url": f"https://archive.org/details/{ITEM}",
        "title": "The Item Title",
        "creators": ["Kimiko Ishizaka"],
        "uploader": "someone@archive.org",
        "release_date": "20120529",
        "entries": list(entries),
    } | extra


def preview(raw: dict[str, object]) -> list[dict[str, object]]:
    downloader = MagicMock()
    downloader.extract_info.return_value = raw
    events: list[dict[str, object]] = []
    with patch(
        "backend.resolver.emit", side_effect=lambda kind, **v: events.append({"kind": kind, **v})
    ):
        resolver.resolve(downloader, site(), f"https://archive.org/details/{ITEM}")
    assert events[-1]["kind"] == "preview", events[-1]
    return cast(list[dict[str, object]], events[-1]["entries"])


class AllowlistTests(unittest.TestCase):
    def test_archive_org_is_allowed(self) -> None:
        for url in (
            "https://archive.org/details/Goldberg_Demo-1",
            "https://www.archive.org/details/Goldberg_Demo-1",
            "https://archive.org:443/details/Goldberg_Demo-1/01.flac",
        ):
            with self.subTest(url=url):
                found = sources.match(url)
                self.assertIsNotNone(found)
                assert found is not None
                self.assertEqual((found.source, found.kind), ("archive", "music"))

    def test_look_alike_hosts_are_not(self) -> None:
        for url in (
            "https://archive.org.example.com/details/x",
            "https://archive.org.evil.test./details/x",
            "https://www.archive.org.example.com/details/x",
            "https://notarchive.org/details/x",
            "https://myarchive.org/details/x",
            "https://archive.org.evil.test@archive.org.evil.test/details/x",
            "https://archive.org@evil.test/details/x",
            "https://evil.test/https://archive.org/details/x",
            "https://evil.test/details/x?u=archive.org",
            "https://wwww.archive.org/details/x",
            # The Wayback Machine is another service on a subdomain, and is not listed.
            "https://web.archive.org/web/2020/https://example.com/",
            "https://ia800000.us.archive.org/1/items/x/a.mp3",
            "http://archive.org/details/x",
            "https://archive.org:8443/details/x",
            "https://user:pw@archive.org/details/x",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))

    def test_only_the_archive_extractor_is_allowed_through(self) -> None:
        self.assertEqual(site().allowed_extractors(), ["archive\\.org"])
        # Escaped, so it cannot match an extractor whose name only looks like it.
        self.assertIsNone(re.fullmatch(site().allowed_extractors()[0], "archiveXorg"))

    def test_artwork_only_from_the_archive_itself(self) -> None:
        self.assertEqual(
            sources.safe_art(site(), "https://archive.org/download/x/a.jpg"),
            "https://archive.org/download/x/a.jpg",
        )
        for art in (
            "https://archive.org.example.com/a.jpg",
            "http://archive.org/a.jpg",
            "https://i.ytimg.com/vi/x/hqdefault.jpg",
        ):
            self.assertEqual(sources.safe_art(site(), art), "")


class ListingTests(unittest.TestCase):
    def test_a_track_offered_in_several_formats_is_listed_once(self) -> None:
        # Two originals for the same track (an MP3 and a FLAC), as some uploaders leave them.
        entries = preview(
            item(
                track("t01.mp3", "Aria", 1, 299.5),
                track("t02.mp3", "Variatio 1", 2, 115.5),
                track("t01.flac", "Aria", 1, 299.5),
                track("t02.flac", "Variatio 1", 2, 115.9),
                track("t03.mp3", "Variatio 2", 3, 123.8),
            )
        )
        self.assertEqual([row["title"] for row in entries], ["Aria", "Variatio 1", "Variatio 2"])
        self.assertEqual(len({row["id"] for row in entries}), 3)

    def test_the_flac_copy_is_the_one_kept(self) -> None:
        entries = preview(
            item(
                track("t01.mp3", "Aria", 1, 299.5),
                track("t01.flac", "Aria", 1, 299.5),
                track("t02.flac", "Variatio 1", 2, 115.5),
                track("t02.mp3", "Variatio 1", 2, 115.5),
            )
        )
        self.assertEqual([row["id"] for row in entries], [f"{ITEM}/t01.flac", f"{ITEM}/t02.flac"])
        # Where each track sits in the list is where its first copy was.
        self.assertEqual([row["track"] for row in entries], [1, 2])

    def test_a_flac_derivative_inside_one_entry_counts_as_flac(self) -> None:
        # yt-dlp's usual shape: one entry per original file, its other formats inside it.
        row = track("t01.wav", "Aria", 1, 299.5)
        row["formats"] = [
            {"url": f"https://archive.org/download/{ITEM}/t01.wav"},
            {"url": f"https://archive.org/download/{ITEM}/t01.flac"},
        ]
        plain = track("t01.mp3", "Aria", 1, 299.5)
        entries = preview(item(plain, row))
        self.assertEqual([r["id"] for r in entries], [f"{ITEM}/t01.wav"])

    def test_different_tracks_with_the_same_name_stay_apart(self) -> None:
        entries = preview(
            item(
                track("t01.mp3", "Interlude", 1, 60),
                track("t02.mp3", "Song", 2, 200),
                track("t03.mp3", "Interlude", 3, 61),
                # Same title and number as the first, but a different length: a different track.
                track("t01b.mp3", "Interlude", 1, 240),
            )
        )
        self.assertEqual(len(entries), 4)

    def test_the_item_tags_every_track(self) -> None:
        entries = preview(
            item(
                track("t01.mp3", "Aria", 1, 299.5),
                track("t02.mp3", "Variatio 1", 2, 115.5, creators=["Someone Else"]),
                track("t03.mp3", "Variatio 2", 3, 123.8, creators=[], artist="Solo Artist"),
            )
        )
        first, second, third = entries
        # Creator to artist, item title to album (over the file's own), item date to date.
        self.assertEqual(
            (first["artist"], first["album"], first["date"]),
            ("Kimiko Ishizaka", "The Item Title", "2012-05-29"),
        )
        self.assertEqual(second["artist"], "Someone Else")
        self.assertEqual(third["artist"], "Solo Artist")
        # Track order to track numbers, out of the whole item.
        self.assertEqual(
            [(row["track"], row["tracks"]) for row in entries], [(1, 3), (2, 3), (3, 3)]
        )

    def test_several_creators_become_one_artist_and_the_uploader_never_does(self) -> None:
        entries = preview(
            item(
                track("t01.mp3", "Aria", 1, 100, creators=["A", "B"]),
                track("t02.mp3", "Two", 2, 100, creators=[]),
                creators=[],
            )
        )
        self.assertEqual(entries[0]["artist"], "A, B")
        # No creator anywhere: blank, not the uploader's e-mail address.
        self.assertEqual(entries[1]["artist"], "")

    def test_the_item_year_stands_in_when_it_has_no_date(self) -> None:
        raw = item(track("t01.mp3", "Aria", 1, 100), release_year=1998)
        del raw["release_date"]
        self.assertEqual(preview(raw)[0]["date"], "1998")

    def test_track_order_numbers_the_tracks_when_the_site_gives_no_usable_numbers(self) -> None:
        for numbers in ([None, None, None], [1, 1, 2], [3, None, 1]):
            with self.subTest(numbers=numbers):
                rows = [
                    track(f"t{n}.mp3", f"Song {n}", num, 100 + n) for n, num in enumerate(numbers)
                ]
                entries = preview(item(*rows))
                self.assertEqual([r["track"] for r in entries], [1, 2, 3])
                self.assertEqual({r["tracks"] for r in entries}, {3})

    def test_an_item_with_nothing_playable_lists_nothing(self) -> None:
        self.assertEqual(preview(item()), [])

    def test_the_sites_own_numbers_are_kept_when_they_are_all_there(self) -> None:
        # Disc two of a two disc set, listed alone: 11 and 12 stay 11 and 12.
        entries = preview(
            item(track("d2t01.mp3", "Eleven", 11, 100), track("d2t02.mp3", "Twelve", 12, 100))
        )
        self.assertEqual([(r["track"], r["tracks"]) for r in entries], [(11, 12), (12, 12)])

    def test_entries_take_the_archive_address_and_a_plain_id(self) -> None:
        entries = preview(item(track('01. Bells (Act 2, "Prince") + Chorus.mp3', "Bells", 1, 100)))
        entry = entries[0]
        self.assertEqual(entry["extractor"], "archive.org")
        self.assertEqual(
            entry["id"], f"{ITEM}/01.%20Bells%20%28Act%202%2C%20%22Prince%22%29%20%2B%20Chorus.mp3"
        )
        url = str(entry["url"])
        self.assertEqual(url, f"https://archive.org/details/{entry['id']}")
        self.assertIs(sources.match(url), site())

    def test_a_single_file_item_is_one_entry(self) -> None:
        raw = track("only.mp3", "Only", None, 90) | {
            "id": ITEM,
            "extractor": "archive.org",
            "webpage_url": f"https://archive.org/details/{ITEM}",
            "uploader": "someone@archive.org",
        }
        entries = preview(raw)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["artist"], "Kimiko Ishizaka")
        self.assertEqual(entries[0]["url"], f"https://archive.org/details/{ITEM}")


class CannedLinks(Links):
    """Answers with a listing instead of starting a resolver process."""

    def __init__(self, downloads: Downloads) -> None:
        super().__init__(downloads)
        self.entries: list[dict[str, object]] = []

    async def extract(self, url: str, found: Site) -> dict[str, object]:
        return {
            "kind": "preview",
            "single": False,
            "title": "The Item Title",
            "entries": self.entries,
        }


class QueueTests(unittest.IsolatedAsyncioTestCase):
    """A listing goes through the server the way the browser would send it."""

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
        self.links = CannedLinks(self.service)
        app = FastAPI()
        install_link_routes(app, lambda: self.links)
        self.api = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")

    async def asyncTearDown(self) -> None:
        await self.api.aclose()
        await self.client.aclose()
        self.store.close()
        self.temporary.cleanup()

    async def test_tags_and_track_numbers_reach_the_queued_jobs(self) -> None:
        self.links.entries = preview(
            item(
                track("t01.mp3", "Aria", 1, 299.5),
                track("t01.flac", "Aria", 1, 299.5),
                track("t02.mp3", "Variatio 1", 2, 115.5),
            )
        )
        resolved = await self.api.post(
            "/api/links/resolve", json={"url": f"https://archive.org/details/{ITEM}"}
        )
        self.assertEqual(resolved.status_code, 200, resolved.text)
        body = resolved.json()
        self.assertEqual(
            (body["site"], body["source"], body["single"]), ("Internet Archive", "archive", False)
        )
        self.assertEqual([row["title"] for row in body["entries"]], ["Aria", "Variatio 1"])
        # The browser never sees where a track sits, only what it needs to tick.
        self.assertNotIn("track", body["entries"][0])
        self.assertNotIn("url", body["entries"][0])
        ticked = body["entries"][1]["id"]
        queued = await self.api.post(
            "/api/links", json={"token": body["token"], "entry_ids": [ticked]}
        )
        self.assertEqual(queued.status_code, 200, queued.text)
        job = self.service.jobs.list()[0]
        self.assertEqual(job.source, "archive")
        self.assertEqual(job.source_url, f"https://archive.org/details/{ITEM}/t02.mp3")
        meta = job.meta
        self.assertEqual(
            (meta.title, meta.artist, meta.album_artist, meta.album, meta.date),
            ("Variatio 1", "Kimiko Ishizaka", "Kimiko Ishizaka", "The Item Title", "2012-05-29"),
        )
        self.assertEqual((meta.track, meta.tracks), (2, 2))


class FormatTests(unittest.TestCase):
    """The format selector, run by yt-dlp itself on canned formats."""

    def pick(self, *urls: str) -> str:
        formats = [
            {"url": url, "source_preference": 0 if n == 0 else -1, "protocol": "https"}
            for n, url in enumerate(urls)
        ]
        info = {
            "id": "x",
            "title": "x",
            "extractor": "archive.org",
            "formats": formats,
            "_format_sort_fields": ["source"],
        }
        with yt_dlp.YoutubeDL({"format": site().audio_format, "quiet": True}) as ydl:
            done = ydl.process_video_result(info, download=False)
        return str(done["ext"])

    def test_flac_wins_over_the_original_when_the_item_has_it(self) -> None:
        base = "https://archive.org/download/i/"
        self.assertEqual(self.pick(base + "a.mp3", base + "a.ogg", base + "a.flac"), "flac")
        self.assertEqual(self.pick(base + "a.wav", base + "a.mp3", base + "a.flac"), "flac")

    def test_without_flac_the_original_is_kept(self) -> None:
        base = "https://archive.org/download/i/"
        self.assertEqual(self.pick(base + "a.mp3", base + "a.ogg"), "mp3")
        self.assertEqual(self.pick(base + "a.ogg"), "ogg")


class ProbeListTests(unittest.TestCase):
    def sites(self) -> list[dict[str, str]]:
        text = source_probe.SITES.read_text(encoding="utf-8")
        return cast(list[dict[str, str]], json.loads(text))

    def test_every_listed_url_belongs_to_its_own_site_and_uses_its_format(self) -> None:
        rows = self.sites()
        self.assertEqual({row["source"] for row in rows}, {found.source for found in sources.SITES})
        for row in rows:
            with self.subTest(source=row["source"]):
                found = sources.match(row["url"])
                self.assertIsNotNone(found)
                assert found is not None
                self.assertEqual(found.source, row["source"])
                self.assertEqual(row["format"], found.audio_format)
                # Each says why it is safe to use.
                self.assertGreater(len(row["why"]), 40)

    def test_the_po_token_argument_is_only_for_youtube(self) -> None:
        youtube = sources.by_source("youtube")
        assert youtube is not None
        self.assertEqual(source_probe.YOUTUBE_HOSTS, set(youtube.hosts))
        for row in self.sites():
            args = source_probe.command(
                row["url"], "out.%(ext)s", "native", "http://provider:1", row["format"]
            )
            with self.subTest(source=row["source"]):
                self.assertEqual("--extractor-args" in args, row["source"] == "youtube")
                self.assertEqual(args[args.index("-f") + 1], row["format"])
                self.assertEqual(args[-1], row["url"])
        args = source_probe.command("https://youtu.be/abc", "o", "native", "http://provider:1")
        self.assertIn("youtubepot-bgutilhttp:base_url=http://provider:1", args)

    def test_a_site_list_run_writes_the_usual_report(self) -> None:
        calls: list[list[str]] = []

        def run(args: list[str], **_: object) -> MagicMock:
            calls.append(args)
            # The first site (YouTube, with no helper running) fails.
            return MagicMock(returncode=1 if len(calls) == 1 else 0, stderr="no helper")

        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "report.json"
            with (
                patch("sys.argv", ["probe", "--site-list", "--output", str(output)]),
                patch.object(source_probe.subprocess, "run", side_effect=run),
                patch.object(source_probe.time, "sleep"),
                patch("builtins.print"),
            ):
                source_probe.main()
            report = json.loads(output.read_text(encoding="utf-8"))
        # One failing site does not stop the next, and each row says which site it was.
        self.assertEqual(
            (report["requested"], report["attempted"], report["successful"]), (2, 2, 1)
        )
        self.assertEqual([row["site"] for row in report["rows"]], ["youtube", "archive"])
        self.assertEqual([row["ok"] for row in report["rows"]], [False, True])
        self.assertEqual(
            set(report) - {"rows"},
            {
                "yt_dlp",
                "downloader",
                "requested",
                "attempted",
                "successful",
                "p50_seconds",
                "p95_seconds",
                "scope",
            },
        )
        self.assertEqual(len(calls), 2)
        self.assertIn("--extractor-args", calls[0])
        self.assertNotIn("--extractor-args", calls[1])
