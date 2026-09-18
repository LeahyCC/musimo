import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from backend.catalog import Catalog
from backend.downloads import Downloads
from backend.job_models import Job, Metadata
from backend.library import Library
from backend.naming import Naming
from backend.podcast_api import install_podcast_routes
from backend.store import Store
from backend.worker import main

ART = "https://is1-ssl.mzstatic.com/image/thumb/show/600x600bb.jpg"
SHOW = {
    "wrapperType": "track",
    "kind": "podcast",
    "collectionId": 77,
    "collectionName": "History: Told",
    "artistName": "A Host",
    "artworkUrl600": ART,
    "primaryGenreName": "History",
    "trackCount": 3,
}


def episode(episode_id: int, **extra: object) -> dict[str, object]:
    return {
        "wrapperType": "podcastEpisode",
        "episodeContentType": "audio",
        "collectionId": 77,
        "trackId": episode_id,
        "trackName": f"Episode {episode_id}",
        "releaseDate": "2026-07-31T18:02:23Z",
        "trackTimeMillis": 3_600_000,
        "episodeUrl": f"https://feeds.example.test/{episode_id}.mp3",
        **extra,
    }


class PodcastApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_detail_and_episode_download_use_directory_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            requests: list[httpx.Request] = []

            def upstream(request: httpx.Request) -> httpx.Response:
                requests.append(request)
                if request.url.path == "/search":
                    return httpx.Response(200, json={"results": [SHOW, {"kind": "song"}]})
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            SHOW,
                            episode(1001),
                            episode(1002, episodeContentType="video"),
                            episode(1003, episodeUrl="file:///etc/passwd"),
                        ]
                    },
                )

            async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                library = Library(store, [root], asyncio.Event())
                service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                store.update({"destination": str(root)})
                app = FastAPI()
                install_podcast_routes(app, lambda: service)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as api:
                    found = (await api.get("/api/podcasts", params={"q": "history"})).json()
                    self.assertEqual([row["title"] for row in found], ["History: Told"])
                    self.assertEqual(requests[0].url.params["media"], "podcast")

                    detail = (await api.get("/api/podcasts/77")).json()
                    # Video episodes and non-web files never reach the list.
                    self.assertEqual([row["id"] for row in detail["episodes"]], [1001])
                    self.assertEqual(detail["episodes"][0]["duration"], 3600)
                    self.assertEqual(detail["episodes"][0]["date"], "2026-07-31")

                    response = await api.post(
                        "/api/podcast-episodes", json={"podcast_id": 77, "episode_id": 1001}
                    )
                    self.assertEqual(response.status_code, 200)
                    job = response.json()
                    self.assertEqual(job["catalog"], "podcast")
                    self.assertEqual(job["format"], "original")
                    self.assertEqual(job["source_url"], "https://feeds.example.test/1001.mp3")
                    self.assertEqual(job["meta"]["album"], "History: Told")
                    self.assertEqual(job["meta"]["artist"], "A Host")
                    self.assertEqual(job["meta"]["genre"], "Podcast")
                    again = await api.post(
                        "/api/podcast-episodes", json={"podcast_id": 77, "episode_id": 1001}
                    )
                    self.assertEqual(again.json()["id"], job["id"])
                    # The episode list is cached, so queueing did not call the directory again.
                    self.assertEqual(len(requests), 2)

                    missing = await api.post(
                        "/api/podcast-episodes", json={"podcast_id": 77, "episode_id": 1002}
                    )
                    self.assertEqual(missing.status_code, 404)
                    smuggled = await api.post(
                        "/api/podcast-episodes",
                        json={"podcast_id": 77, "episode_id": 1001, "url": "http://evil.test"},
                    )
                    self.assertEqual(smuggled.status_code, 422)
                # A Deezer track with the same number is a different job.
                self.assertNotEqual(service.jobs.enqueue(1001, "original", str(root)).id, job["id"])
            store.close()


class PodcastNamingTests(unittest.TestCase):
    def test_episodes_land_in_a_dated_show_folder(self) -> None:
        meta = Metadata(id=1, title="Part: One?", album="History: Told", date="2026-07-31")
        self.assertEqual(
            Naming().podcast_path(meta, "mp3"),
            "Podcasts/History_ Told/2026-07-31 - Part_ One_.mp3",
        )
        self.assertEqual(
            Naming().podcast_path(Metadata(id=1, title="Undated", album="Show"), "m4a"),
            "Podcasts/Show/Undated.m4a",
        )


class PodcastWorkerTests(unittest.TestCase):
    def job(self, directory: str) -> Job:
        return Job(
            id="test",
            catalog="podcast",
            track_id=1001,
            source_url="https://feeds.example.test/1001.mp3",
            target=directory,
            created_at=0,
            updated_at=0,
            meta=Metadata(id=1001, title="Episode", artist="Host", duration=60),
        )

    def test_episode_downloads_feed_file_without_youtube_search(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "job.json").write_text(self.job(directory).model_dump_json(), "utf-8")
            (folder / "source.mp3").write_bytes(b"synthetic audio placeholder")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                # Much longer than the directory said: stitched-in ads must not fail the episode.
                patch("backend.worker.probe", return_value={"duration": 900}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.return_value = {}
                tagger.return_value.prepare.return_value = folder / "source.mp3"
                main()
            downloader.return_value.extract_info.assert_called_once_with(
                "https://feeds.example.test/1001.mp3"
            )
            self.assertEqual(downloader.call_args.args[0]["format"], "bestaudio/best")
            self.assertNotIn("matching", [event.get("stage") for event in events])
            self.assertEqual(events[-1]["kind"], "ready")

    def test_host_refusal_is_not_reported_as_a_youtube_block(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "job.json").write_text(self.job(directory).model_dump_json(), "utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.side_effect = RuntimeError("HTTP Error 403")
                main()
            self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
            self.assertTrue(events[-1]["retryable"])
