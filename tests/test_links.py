"""Pasted links: the allowlist, previews, queueing and the worker's direct mode."""

import asyncio
import io
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import httpx
from fastapi import FastAPI

from backend import resolver, sources
from backend.catalog import Catalog
from backend.downloads import DownloadError, Downloads
from backend.errors import error_guidance, source_code
from backend.job_models import Job, Metadata
from backend.library import Library
from backend.link_api import install_link_routes
from backend.links import Links, stable_id
from backend.sources import Site
from backend.store import Store
from backend.worker import main as worker_main

ART = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"


def video(video_id: str, **extra: object) -> dict[str, object]:
    return {
        "id": video_id,
        "extractor": "youtube",
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": f"Song {video_id}",
        "artist": "Band",
        "album": "",
        "date": "2024-05-01",
        "duration": 200,
        "art": ART,
        "live": False,
        **extra,
    }


class FakeLinks(Links):
    """Answers from canned resolver output instead of starting a process."""

    def __init__(self, downloads: Downloads, clock: Callable[[], float]) -> None:
        super().__init__(downloads, clock)
        self.answer: dict[str, object] = {"kind": "preview", "single": True, "entries": []}
        self.asked: list[str] = []

    async def extract(self, url: str, site: Site) -> dict[str, object]:
        self.asked.append(url)
        return self.answer


class AllowlistTests(unittest.TestCase):
    def test_only_https_links_to_listed_hosts_match(self) -> None:
        for url in (
            "https://www.youtube.com/watch?v=abcdefghijk",
            "https://youtu.be/abcdefghijk",
            "https://music.youtube.com/playlist?list=OLAK5uy",
            "https://www.youtube.com:443/watch?v=abcdefghijk",
        ):
            with self.subTest(url=url):
                site = sources.match(url)
                self.assertIsNotNone(site)
                assert site is not None
                self.assertEqual((site.source, site.kind), ("youtube", "music"))
        for url in (
            "https://example.com/song.mp3",
            "http://www.youtube.com/watch?v=abcdefghijk",
            "file:///etc/passwd",
            "https://127.0.0.1/watch?v=abcdefghijk",
            "https://10.0.0.8/watch",
            "https://[::1]/watch",
            "https://user:secret@www.youtube.com/watch?v=abcdefghijk",
            "https://user@www.youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com:8443/watch?v=abcdefghijk",
            "https://www.youtube.com.evil.test/watch",
            "https://www.youtube.com/watch?v=a b",
            "youtube.com/watch?v=abcdefghijk",
            "",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sources.match(url))

    def test_refusals_name_the_host_and_the_supported_sites(self) -> None:
        self.assertEqual(
            sources.refusal("https://example.com/a"),
            "Musimo can't download from example.com. It works with: YouTube.",
        )
        self.assertEqual(
            sources.refusal("file:///etc/passwd"),
            "Musimo can't download from this link. It works with: YouTube.",
        )
        for url in ("https://open.spotify.com/track/1", "https://music.apple.com/us/album/x/1"):
            self.assertEqual(sources.refusal(url), "Catalog imports are not built yet.")

    def test_artwork_only_from_the_site_image_hosts(self) -> None:
        site = sources.SITES[0]
        self.assertEqual(sources.safe_art(site, ART), ART)
        self.assertEqual(sources.safe_art(site, "https://evil.test/a.jpg"), "")
        self.assertEqual(sources.safe_art(site, "http://i.ytimg.com/a.jpg"), "")

    def test_profile_pages_are_told_apart_from_lists(self) -> None:
        site = sources.SITES[0]
        for url in (
            "https://www.youtube.com/@band",
            "https://www.youtube.com/channel/UC123/videos",
            "https://www.youtube.com/c/band",
            "https://www.youtube.com/user/band",
        ):
            with self.subTest(url=url):
                self.assertTrue(site.is_profile(url))
        for url in (
            "https://www.youtube.com/playlist?list=PL1",
            "https://www.youtube.com/watch?v=abcdefghijk&list=PL1",
            "http://www.youtube.com/@band",
        ):
            with self.subTest(url=url):
                self.assertFalse(site.is_profile(url))

    def test_extractor_names_are_matched_literally(self) -> None:
        self.assertIn(r"youtube:tab", sources.SITES[0].allowed_extractors())
        self.assertNotIn("generic", sources.SITES[0].allowed_extractors())

    def test_link_ids_are_stable_positive_and_fit_sqlite(self) -> None:
        first = stable_id("youtube:abcdefghijk")
        self.assertEqual(first, stable_id("youtube:abcdefghijk"))
        self.assertNotEqual(first, stable_id("youtube:abcdefghijl"))
        self.assertTrue(0 < first < 2**63)


class ErrorMappingTests(unittest.TestCase):
    def test_site_refusals_stay_with_their_own_site(self) -> None:
        # Another allowed site keeps its block and rate limit so it can pause on its own.
        self.assertEqual(source_code("SOURCE_BLOCKED", "bandcamp"), "SOURCE_BLOCKED")
        self.assertEqual(source_code("RATE_LIMITED", "bandcamp"), "RATE_LIMITED")
        self.assertEqual(source_code("SOURCE_BLOCKED", "youtube"), "SOURCE_BLOCKED")
        for code in ("POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"):
            self.assertEqual(source_code(code, "bandcamp"), "DOWNLOAD_FAILED")
            self.assertEqual(source_code(code, "youtube"), code)
        # Every episode has its own host, so a refusal never counts toward a podcast pause.
        self.assertEqual(source_code("SOURCE_BLOCKED", "podcast"), "DOWNLOAD_FAILED")
        self.assertEqual(source_code("RATE_LIMITED", "podcast"), "DOWNLOAD_FAILED")

    def test_new_codes_have_guidance(self) -> None:
        for code in ("LIVE_STREAM", "SITE_NOT_ALLOWED"):
            hint, fix = error_guidance(code)
            self.assertTrue(hint and fix, code)


class LinkApiTests(unittest.IsolatedAsyncioTestCase):
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
        self.now = 1000.0
        self.links = FakeLinks(self.service, lambda: self.now)
        app = FastAPI()
        install_link_routes(app, lambda: self.links)
        self.api = httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")

    async def asyncTearDown(self) -> None:
        await self.api.aclose()
        await self.client.aclose()
        self.store.close()
        self.temporary.cleanup()

    async def resolve(
        self, url: str = "https://www.youtube.com/watch?v=abcdefghijk"
    ) -> httpx.Response:
        return await self.api.post("/api/links/resolve", json={"url": url})

    async def test_unlisted_links_are_refused_before_anything_runs(self) -> None:
        cases = {
            "https://example.com/watch?v=abcdefghijk": "example.com",
            "http://www.youtube.com/watch?v=abcdefghijk": "this link",
            "file:///etc/passwd": "this link",
            "https://192.168.1.10/watch?v=abcdefghijk": "this link",
            "https://user:pw@www.youtube.com/watch?v=abcdefghijk": "this link",
            "https://soundcloud.com/artist/track": "soundcloud.com",
        }
        for url, where in cases.items():
            with self.subTest(url=url):
                response = await self.resolve(url)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json()["detail"],
                    f"Musimo can't download from {where}. It works with: YouTube.",
                )
        spotify = await self.resolve("https://open.spotify.com/album/1")
        self.assertEqual(spotify.json()["detail"], "Catalog imports are not built yet.")
        extra = await self.api.post(
            "/api/links/resolve", json={"url": "https://youtu.be/abcdefghijk", "cookies": "x"}
        )
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(self.links.asked, [])

    async def test_single_link_previews_and_queues_from_the_saved_preview(self) -> None:
        self.links.answer = {
            "kind": "preview",
            "single": True,
            "title": "",
            "entries": [video("abcdefghijk")],
        }
        response = await self.resolve()
        self.assertEqual(response.status_code, 200)
        preview = response.json()
        self.assertEqual(
            (preview["site"], preview["kind"], preview["single"]), ("YouTube", "music", True)
        )
        self.assertEqual(preview["title"], "Song abcdefghijk")
        entry = preview["entries"][0]
        self.assertEqual(entry["art"], ART)
        self.assertFalse(entry["owned"])
        # The download address stays on the server.
        self.assertNotIn("url", entry)

        smuggled = await self.api.post(
            "/api/links",
            json={"token": preview["token"], "entry_ids": ["abcdefghijk"], "title": "Other"},
        )
        self.assertEqual(smuggled.status_code, 422)
        queued = await self.api.post(
            "/api/links", json={"token": preview["token"], "entry_ids": ["abcdefghijk"]}
        )
        self.assertEqual(queued.status_code, 200)
        body = queued.json()
        self.assertEqual(body["id"], "")
        job = body["jobs"][0]
        self.assertEqual((job["catalog"], job["source"], job["kind"]), ("link", "youtube", "music"))
        self.assertEqual(job["track_id"], stable_id("youtube:abcdefghijk"))
        self.assertEqual(job["source_url"], "https://www.youtube.com/watch?v=abcdefghijk")
        self.assertEqual(job["meta"]["title"], "Song abcdefghijk")
        self.assertEqual(job["meta"]["artist"], "Band")
        self.assertEqual(job["meta"]["album"], "Song abcdefghijk")
        self.assertEqual(job["meta"]["date"], "2024-05-01")
        self.assertEqual(job["meta"]["art"], ART)

    async def test_duplicate_links_reuse_the_job(self) -> None:
        self.links.answer = {"kind": "preview", "single": True, "entries": [video("abcdefghijk")]}
        ids = []
        for _ in range(2):
            token = (await self.resolve()).json()["token"]
            for _ in range(2):
                queued = await self.api.post(
                    "/api/links", json={"token": token, "entry_ids": ["abcdefghijk"]}
                )
                ids.append(queued.json()["jobs"][0]["id"])
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(self.service.jobs.list()), 1)

    async def test_playlist_queues_only_the_ticked_entries_as_one_group(self) -> None:
        self.links.answer = {
            "kind": "preview",
            "single": False,
            "title": "Road trip",
            "entries": [
                video("aaaaaaaaaaa"),
                video("bbbbbbbbbbb", album="Record"),
                video("ccccccccccc"),
                # Dropped: off the site, a live stream, a list page and a malformed ID.
                video("ddddddddddd", url="https://evil.test/watch?v=ddddddddddd"),
                video("eeeeeeeeeee", live=True),
                video("fffffffffff", extractor="youtube:tab"),
                video("bad id!"),
            ],
        }
        preview = (await self.resolve("https://www.youtube.com/playlist?list=PL1")).json()
        self.assertFalse(preview["single"])
        self.assertEqual(
            [row["id"] for row in preview["entries"]], ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]
        )
        response = await self.api.post(
            "/api/links",
            json={"token": preview["token"], "entry_ids": ["bbbbbbbbbbb", "ccccccccccc"]},
        )
        body = response.json()
        self.assertEqual(response.status_code, 200)
        jobs = body["jobs"]
        self.assertEqual(
            [job["meta"]["title"] for job in jobs], ["Song bbbbbbbbbbb", "Song ccccccccccc"]
        )
        self.assertEqual(jobs[0]["meta"]["album"], "Record")
        self.assertTrue(body["id"])
        self.assertTrue(all(job["batch_id"] == body["id"] for job in jobs))
        self.assertEqual(jobs[0]["batch_label"], "Road trip · YouTube")
        self.assertEqual(len(self.service.jobs.list()), 2)

        unknown = await self.api.post(
            "/api/links", json={"token": preview["token"], "entry_ids": ["ddddddddddd"]}
        )
        self.assertEqual(unknown.status_code, 422)
        self.assertEqual(unknown.json()["detail"], "Choose entries from this link's preview.")

    async def test_profile_links_are_flagged_and_lists_are_not(self) -> None:
        self.links.answer = {
            "kind": "preview",
            "single": False,
            "title": "Band",
            "entries": [video("aaaaaaaaaaa"), video("bbbbbbbbbbb")],
        }
        profile = (await self.resolve("https://www.youtube.com/@band")).json()
        playlist = (await self.resolve("https://www.youtube.com/playlist?list=PL1")).json()
        single = (await self.resolve()).json()
        self.assertEqual((profile["profile"], playlist["profile"]), (True, False))
        self.assertFalse(single["profile"])

    async def test_only_two_resolves_run_at_once_and_the_third_waits(self) -> None:
        gate = asyncio.Event()
        running = 0
        peak = 0

        class Slow(FakeLinks):
            async def extract(self, url: str, site: Site) -> dict[str, object]:
                nonlocal running, peak
                running += 1
                peak = max(peak, running)
                try:
                    await gate.wait()
                finally:
                    running -= 1
                return self.answer

        slow = Slow(self.service, lambda: self.now)
        slow.answer = {"kind": "preview", "single": True, "entries": [video("abcdefghijk")]}
        tasks = [asyncio.create_task(slow.resolve(f"https://youtu.be/{n:011d}")) for n in range(3)]
        await until(lambda: running == 2)
        # Give the third a chance to start. It has to keep waiting for a free place.
        await asyncio.sleep(0.05)
        self.assertEqual((running, peak), (2, 2))
        gate.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(len(results), 3)
        self.assertEqual(peak, 2)

    async def test_a_cancelled_resolve_frees_its_place(self) -> None:
        release = asyncio.Event()

        class Stuck(FakeLinks):
            async def extract(self, url: str, site: Site) -> dict[str, object]:
                await release.wait()
                return self.answer

        stuck = Stuck(self.service, lambda: self.now)
        stuck.answer = {"kind": "preview", "single": True, "entries": [video("abcdefghijk")]}
        first = [
            asyncio.create_task(stuck.resolve("https://youtu.be/abcdefghijk")) for _ in range(2)
        ]
        await asyncio.sleep(0.02)
        for task in first:
            task.cancel()
        await asyncio.gather(*first, return_exceptions=True)
        release.set()
        answer = await asyncio.wait_for(stuck.resolve("https://youtu.be/abcdefghijk"), 1)
        self.assertEqual(answer["site"], "YouTube")

    async def test_expired_or_unknown_tokens_are_refused_plainly(self) -> None:
        self.links.answer = {"kind": "preview", "single": True, "entries": [video("abcdefghijk")]}
        token = (await self.resolve()).json()["token"]
        self.now += 601
        expired = await self.api.post(
            "/api/links", json={"token": token, "entry_ids": ["abcdefghijk"]}
        )
        self.assertEqual(expired.status_code, 404)
        self.assertEqual(
            expired.json()["detail"], "This link preview has expired. Paste the link again."
        )
        unknown = await self.api.post(
            "/api/links", json={"token": "A" * 32, "entry_ids": ["abcdefghijk"]}
        )
        self.assertEqual(unknown.status_code, 404)
        malformed = await self.api.post("/api/links", json={"token": "../x", "entry_ids": ["a"]})
        self.assertEqual(malformed.status_code, 422)
        self.assertEqual(self.service.jobs.list(), [])

    async def test_saved_previews_stay_bounded(self) -> None:
        self.links.answer = {"kind": "preview", "single": True, "entries": [video("abcdefghijk")]}
        first = (await self.resolve()).json()["token"]
        for _ in range(40):
            await self.resolve()
        self.assertLessEqual(len(self.links.previews), 32)
        self.assertNotIn(first, self.links.previews)

    async def test_live_streams_and_empty_lists_are_refused(self) -> None:
        self.links.answer = {"kind": "error", "code": "LIVE_STREAM", "message": "live"}
        live = await self.resolve()
        self.assertEqual(live.status_code, 422)
        self.assertEqual(
            live.json()["detail"], "Live streams never finish, so they can't be saved."
        )

        self.links.answer = {
            "kind": "preview",
            "single": False,
            "entries": [video("a" * 11, live=True)],
        }
        only_live = await self.resolve()
        self.assertEqual(
            only_live.json()["detail"], "Live streams never finish, so they can't be saved."
        )

        self.links.answer = {"kind": "preview", "single": False, "entries": []}
        empty = await self.resolve()
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.json()["detail"], "There is nothing to download at this link.")

        self.links.answer = {"kind": "error", "code": "SITE_NOT_ALLOWED", "message": "x"}
        away = await self.resolve()
        self.assertEqual(
            away.json()["detail"], "The link led away from YouTube. Musimo works with: YouTube."
        )

        self.links.answer = {"kind": "error", "code": "FAILED", "message": "x"}
        failed = await self.resolve()
        self.assertEqual(failed.status_code, 422)
        self.assertEqual(self.service.jobs.list(), [])


class ResolverTests(unittest.TestCase):
    def run_resolve(
        self, *answers: object, url: str = "https://youtu.be/abcdefghijk"
    ) -> list[dict[str, object]]:
        downloader = MagicMock()
        downloader.extract_info.side_effect = list(answers)
        events: list[dict[str, object]] = []
        with patch(
            "backend.resolver.emit",
            side_effect=lambda kind, **v: events.append({"kind": kind, **v}),
        ):
            resolver.resolve(downloader, sources.SITES[0], url)
        for call in downloader.extract_info.call_args_list:
            self.assertEqual(call.kwargs, {"download": False, "process": False})
        return events

    def test_single_video_becomes_one_entry(self) -> None:
        events = self.run_resolve(
            {
                "id": "abcdefghijk",
                "extractor": "youtube",
                "webpage_url": "https://www.youtube.com/watch?v=abcdefghijk",
                "title": "Band - Song (Official Video)",
                "track": "Song",
                "artist": "Band",
                "upload_date": "20240501",
                "duration": 201,
                "thumbnails": [{"url": ART}, {"url": "https://i.ytimg.com/vi/x/maxres.webp"}],
                "live_status": "not_live",
            }
        )
        self.assertEqual(events[-1]["kind"], "preview")
        self.assertTrue(events[-1]["single"])
        entry = cast(list[dict[str, object]], events[-1]["entries"])[0]
        self.assertEqual(entry["title"], "Song")
        self.assertEqual(entry["date"], "2024-05-01")
        self.assertEqual(entry["art"], ART)
        self.assertFalse(entry["live"])

    def test_playlist_entries_come_back_flat_and_capped(self) -> None:
        rows = (
            {"id": f"{n:011d}", "ie_key": "Youtube", "url": "u", "title": str(n)}
            for n in range(600)
        )
        events = self.run_resolve({"_type": "playlist", "title": "Mix", "entries": rows})
        entries = cast(list[dict[str, object]], events[-1]["entries"])
        self.assertEqual(len(entries), resolver.LIMIT)
        self.assertEqual(entries[0]["extractor"], "youtube")

    def test_live_streams_and_redirects_off_the_site_are_refused(self) -> None:
        self.assertEqual(self.run_resolve({"id": "x", "is_live": True})[-1]["code"], "LIVE_STREAM")
        self.assertEqual(
            self.run_resolve({"id": "x", "live_status": "is_upcoming"})[-1]["code"], "LIVE_STREAM"
        )
        away = self.run_resolve({"_type": "url", "url": "https://evil.test/a"})
        self.assertEqual(away[-1]["code"], "SITE_NOT_ALLOWED")
        hop = self.run_resolve(
            {"_type": "url", "url": "https://www.youtube.com/watch?v=abcdefghijk"},
            {"id": "abcdefghijk", "extractor": "youtube", "title": "Song"},
        )
        self.assertEqual(hop[-1]["kind"], "preview")

    def test_process_refuses_unlisted_input_and_passes_the_allowlist(self) -> None:
        events: list[dict[str, object]] = []

        def record(kind: str, **values: object) -> None:
            events.append({"kind": kind, **values})

        with (
            patch("sys.stdin", io.StringIO('{"url": "https://evil.test/a", "source": "youtube"}')),
            patch("yt_dlp.YoutubeDL") as downloader,
            patch("backend.resolver.emit", side_effect=record),
        ):
            resolver.main()
        downloader.assert_not_called()
        self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")

        events.clear()
        with (
            patch(
                "sys.stdin",
                io.StringIO('{"url": "https://youtu.be/abcdefghijk", "source": "youtube"}'),
            ),
            patch("yt_dlp.YoutubeDL") as downloader,
            patch("backend.resolver.emit", side_effect=record),
        ):
            downloader.return_value.extract_info.side_effect = RuntimeError(
                "No suitable extractor found for URL https://elsewhere.test"
            )
            resolver.main()
        options = downloader.call_args.args[0]
        self.assertEqual(options["allowed_extractors"], sources.SITES[0].allowed_extractors())
        self.assertEqual(options["extract_flat"], "in_playlist")
        self.assertTrue(options["skip_download"])
        self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")
        downloader.return_value.close.assert_called_once()


class LinkWorkerTests(unittest.TestCase):
    def job(self, directory: str, **extra: object) -> Job:
        return Job.model_validate(
            {
                "id": "test",
                "catalog": "link",
                "source": "youtube",
                "track_id": stable_id("youtube:abcdefghijk"),
                "source_url": "https://www.youtube.com/watch?v=abcdefghijk",
                "target": directory,
                "created_at": 0,
                "updated_at": 0,
                "meta": Metadata(id=1, title="Song", artist="Band", duration=60).model_dump(),
                **extra,
            }
        )

    def run_worker(
        self, directory: str, job: Job, info: object, audio: bool = True
    ) -> tuple[MagicMock, list[dict[str, object]]]:
        folder = Path(directory)
        (folder / "job.json").write_text(job.model_dump_json(), "utf-8")
        if audio:
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
        events: list[dict[str, object]] = []

        def record(kind: str, **values: object) -> None:
            events.append({"kind": kind, **values})

        with (
            patch("sys.argv", ["worker", directory]),
            patch("yt_dlp.YoutubeDL") as downloader,
            # The site's own length is the truth for a link, so a mismatch is not checked.
            patch("backend.worker.probe", return_value={"duration": 900}),
            patch("backend.worker.Tagger") as tagger,
            patch("backend.worker.emit", side_effect=record),
        ):
            if isinstance(info, Exception):
                downloader.return_value.extract_info.side_effect = info
            else:
                downloader.return_value.extract_info.return_value = info
            downloader.return_value.process_ie_result.return_value = {}
            tagger.return_value.prepare.return_value = folder / "source.m4a"
            worker_main()
        return downloader, events

    def test_link_downloads_its_own_address_with_the_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            info = {"id": "abcdefghijk", "extractor": "youtube", "live_status": "not_live"}
            downloader, events = self.run_worker(directory, self.job(directory), info)
        options = downloader.call_args.args[0]
        self.assertEqual(options["allowed_extractors"], sources.SITES[0].allowed_extractors())
        self.assertEqual(options["format"], "bestaudio")
        downloader.return_value.extract_info.assert_called_once_with(
            "https://www.youtube.com/watch?v=abcdefghijk", download=False
        )
        downloader.return_value.process_ie_result.assert_called_once_with(info, download=True)
        self.assertNotIn("matching", [event.get("stage") for event in events])
        self.assertEqual(events[-1]["kind"], "ready")

    def test_redirects_off_the_list_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            landed = {"id": "x", "extractor": "generic"}
            downloader, events = self.run_worker(
                directory, self.job(directory), landed, audio=False
            )
            downloader.return_value.process_ie_result.assert_not_called()
            self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")
            self.assertFalse(events[-1]["retryable"])

            refused = RuntimeError("ERROR: No suitable extractor found for URL https://evil.test/")
            _, events = self.run_worker(directory, self.job(directory), refused, audio=False)
            self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")
            self.assertFalse(events[-1]["retryable"])
            self.assertNotIn("evil.test", str(events[-1]["message"]))

    def test_live_streams_never_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            info = {"id": "x", "extractor": "youtube", "is_live": True}
            downloader, events = self.run_worker(directory, self.job(directory), info, audio=False)
        downloader.return_value.process_ie_result.assert_not_called()
        self.assertEqual(events[-1]["code"], "LIVE_STREAM")

    def test_a_site_dropped_from_the_list_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(directory, source="gone")
            downloader, events = self.run_worker(directory, job, {}, audio=False)
        downloader.assert_not_called()
        self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")

    def test_an_address_off_the_jobs_own_site_is_refused_before_any_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for address in (
                "https://evil.test/watch?v=abcdefghijk",
                "http://www.youtube.com/watch?v=abcdefghijk",
                "https://user:pw@www.youtube.com/watch?v=abcdefghijk",
                "file:///etc/passwd",
                "",
            ):
                with self.subTest(address=address):
                    job = self.job(directory, source_url=address)
                    downloader, events = self.run_worker(directory, job, {}, audio=False)
                    downloader.assert_not_called()
                    self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")
                    self.assertFalse(events[-1]["retryable"])

    def test_other_sites_keep_their_block_codes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(directory, catalog="deezer", source="elsewhere", selected="abcdefghijk")
            for message, code in (
                ("HTTP Error 403", "SOURCE_BLOCKED"),
                ("HTTP Error 429", "RATE_LIMITED"),
                ("sign in to confirm", "DOWNLOAD_FAILED"),
            ):
                with self.subTest(code=code):
                    _, events = self.run_worker(directory, job, RuntimeError(message), audio=False)
                    self.assertEqual(events[-1]["code"], code)


class Blocked(Downloads):
    def __init__(self, store: Store, catalog: Catalog, library: Library) -> None:
        super().__init__(store, catalog, library, asyncio.Event())
        self.ran: list[str] = []

    async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
        self.ran.append(job.source)
        if job.source == "elsewhere":
            raise DownloadError("SOURCE_BLOCKED", "HTTP 403")
        raise DownloadError("DOWNLOAD_FAILED", "Went away")


async def until(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(3):
        while not check():
            await asyncio.sleep(0.01)


class ResolverProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_child_process_answers_with_one_json_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                service = Downloads(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                # The child checks the link again on its own and stops before any request.
                answer = await Links(service).extract("https://evil.test/a", sources.SITES[0])
            store.close()
        self.assertEqual(answer["kind"], "error")
        self.assertEqual(answer["code"], "SITE_NOT_ALLOWED")


class LinkQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocks_on_another_site_pause_only_that_site(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                library = Library(store, [root], asyncio.Event())
                service = Blocked(store, Catalog(store, client), library)
                prepared = {
                    n: (Metadata(id=n, artist="A"), f"https://site.test/{n}") for n in (1, 2, 3)
                }
                blocked = service.jobs.enqueue_many(
                    [1, 2, 3],
                    "original",
                    str(root),
                    catalog="link",
                    prepared=prepared,
                    source="elsewhere",
                )
                service.start()
                try:
                    await until(lambda: service.jobs.get(blocked[0].id).stage == "failed")
                    # The count is committed as soon as it is written, not when the cursor closes.
                    other = sqlite3.connect(root / "db.sqlite3")
                    try:
                        count = other.execute(
                            "SELECT blocking_failures FROM source_control WHERE source='elsewhere'"
                        ).fetchone()
                    finally:
                        other.close()
                    self.assertIsNotNone(count)
                    await until(
                        lambda: all(service.jobs.get(j.id).stage == "failed" for j in blocked)
                    )
                    await until(lambda: service.controls()["paused_sources"] == ["elsewhere"])
                    youtube = service.jobs.enqueue(4, "original", str(root))
                    service.jobs.update(youtube.id, meta=Metadata(id=4, artist="A").model_dump())
                    await until(lambda: service.jobs.get(youtube.id).stage == "failed")
                    self.assertEqual(service.controls()["paused_sources"], ["elsewhere"])
                    self.assertFalse(service.controls()["source_paused"])
                finally:
                    await service.close()
            store.close()

    async def test_link_jobs_never_enter_the_matching_stage(self) -> None:
        seen: list[str] = []

        class Watching(Downloads):
            async def worker(self, job: Job, folder: Path) -> tuple[Path, dict[str, object]]:
                seen.append(self.jobs.get(job.id).stage)
                raise DownloadError("DOWNLOAD_FAILED", "Went away")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                service = Watching(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                prepared = {1: (Metadata(id=1, artist="A"), "https://www.youtube.com/watch?v=x")}
                job = service.jobs.enqueue_many(
                    [1], "original", str(root), catalog="link", prepared=prepared, source="youtube"
                )[0]
                service.start()
                try:
                    await until(lambda: service.jobs.get(job.id).stage == "failed")
                finally:
                    await service.close()
            store.close()
        self.assertEqual(seen, ["downloading"])

    async def test_long_kinds_get_the_episode_budget_and_music_uses_the_template(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            async with httpx.AsyncClient() as client:
                service = Downloads(
                    store,
                    Catalog(store, client),
                    Library(store, [root], asyncio.Event()),
                    asyncio.Event(),
                )
                base = {
                    "id": "x",
                    "catalog": "link",
                    "track_id": 1,
                    "target": str(root),
                    "created_at": 0,
                    "updated_at": 0,
                    "meta": Metadata(
                        id=1, title="Song", artist="Band", album_artist="Band", album="Song"
                    ).model_dump(),
                }
                music = Job.model_validate(base)
                self.assertEqual(service.budget(music), 600)
                for kind in ("mix", "radio"):
                    self.assertEqual(
                        service.budget(Job.model_validate({**base, "kind": kind})), 3600
                    )
                self.assertEqual(
                    service.budget(Job.model_validate({**base, "catalog": "podcast"})), 3600
                )
                self.assertEqual(service.layout(music, "m4a"), "Band/Song/01 - Song.m4a")
            store.close()


if __name__ == "__main__":
    unittest.main()
