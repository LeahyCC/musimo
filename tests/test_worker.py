import json
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

from backend.job_models import Candidate, Job, Metadata
from backend.worker import main, redact


class WorkerTests(unittest.TestCase):
    def test_untrusted_candidates_and_wrong_recordings_never_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                created_at=0,
                updated_at=0,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_POT_SERVER_HOME": directory}),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit", side_effect=record),
                patch("backend.worker.Tagger") as tagger,
            ):
                downloader.return_value.extract_info.return_value = {
                    "entries": [
                        {"id": "https://untrusted.test", "title": "Test song", "duration": 180},
                        {"id": "abcdefghijk", "title": "Unrelated song", "duration": 900},
                        {
                            "id": "cover000001",
                            "title": "Test song cover",
                            "channel": "Cover Band",
                            "duration": 180,
                        },
                    ]
                }
                main()
                self.assertEqual(
                    downloader.call_args.args[0]["extractor_args"],
                    {"youtubepot-bgutilscript": {"server_home": [directory]}},
                )
                downloader.return_value.extract_info.assert_called_once()
                self.assertFalse(downloader.return_value.extract_info.call_args.kwargs["download"])
                self.assertEqual(events[-1]["code"], "NO_MATCH")
                self.assertEqual(events[-2]["kind"], "candidates")
                self.assertEqual(events[-2]["selected"], "")
                items = cast(list[dict[str, object]], events[-2]["items"])
                self.assertEqual(items[0]["id"], "cover000001")
                self.assertEqual(items[0]["source"], "youtube")
                self.assertEqual(items[0]["url"], "https://www.youtube.com/watch?v=cover000001")
                tagger.assert_not_called()

    def test_logs_redact_urls_and_bound_output(self) -> None:
        output = redact("x" * 4000 + " https://provider.test/media?token=secret")
        self.assertLessEqual(len(output), 3000)
        self.assertNotIn("secret", output)
        self.assertTrue(output.endswith("[URL]"))

    def test_source_failures_emit_classified_redacted_errors(self) -> None:
        cases = (
            ("HTTP 403", "SOURCE_BLOCKED", False),
            ("HTTP 429", "RATE_LIMITED", True),
            ("missing po token", "POT_MISSING", False),
            ("deno unavailable", "JS_RUNTIME_MISSING", False),
            ("sign in required", "COOKIES_EXPIRED", False),
            ("no space left", "DISK_FULL", False),
            ("timed out", "TIMEOUT", True),
            ("unexpected failure", "DOWNLOAD_FAILED", True),
        )
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                selected="abcdefghijk",
                meta=Metadata(id=1),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            for message, code, retryable in cases:
                with self.subTest(code=code):
                    events.clear()
                    with (
                        patch("sys.argv", ["worker", directory]),
                        patch("yt_dlp.YoutubeDL") as downloader,
                        patch("backend.worker.emit", side_effect=record),
                    ):
                        downloader.return_value.extract_info.side_effect = RuntimeError(
                            message + " https://provider.test/?token=private"
                        )
                        main()
                    self.assertEqual(events[-1]["kind"], "error")
                    self.assertEqual(events[-1]["code"], code)
                    self.assertEqual(events[-1]["retryable"], retryable)
                    self.assertNotIn("private", str(events[-1]["message"]))

    def test_verified_download_manifest_resumes_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "source.m4a"
            source.write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                selected="abcdefghijk",
                meta=Metadata(id=1),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            (folder / "download.json").write_text(
                json.dumps({"selected": job.selected, "file": source.name}), encoding="utf-8"
            )
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 180}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                tagger.return_value.prepare.return_value = source
                main()
                downloader.return_value.extract_info.assert_not_called()
                tagger.return_value.write.assert_called_once()
                self.assertEqual(events[-1]["kind"], "ready")

    def test_wrong_duration_never_tags_or_publishes_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                selected="abcdefghijk",
                meta=Metadata(id=1, duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 400}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit") as emit,
            ):
                downloader.return_value.extract_info.return_value = {}
                main()
                tagger.assert_not_called()
                self.assertEqual(emit.call_args.kwargs["code"], "DURATION_MISMATCH")
                self.assertFalse((folder / "download.json").exists())


TRACK = "https://soundcloud.com/artist/test-song"


def soundcloud(
    title: str, track_id: str = "123456789", artist: str = "Test artist"
) -> dict[str, object]:
    return {"id": track_id, "title": title, "uploader": artist, "duration": 180, "url": TRACK}


class BackupSourceTests(unittest.TestCase):
    """The SoundCloud search that runs only after YouTube found nothing."""

    def run_worker(
        self, directory: str, job: Job, answers: list[object]
    ) -> tuple[list[dict[str, object]], list[str]]:
        folder = Path(directory)
        (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
        (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
        events: list[dict[str, object]] = []

        def record(kind: str, **values: object) -> None:
            events.append({"kind": kind, **values})

        with (
            patch("sys.argv", ["worker", directory]),
            patch("yt_dlp.YoutubeDL") as downloader,
            patch("backend.worker.probe", return_value={"duration": 180}),
            patch("backend.worker.Tagger") as tagger,
            patch("backend.worker.emit", side_effect=record),
        ):
            tagger.return_value.prepare.return_value = folder / "source.m4a"
            downloader.return_value.extract_info.side_effect = answers
            main()
            asked = [
                str(call.args[0]) for call in downloader.return_value.extract_info.call_args_list
            ]
        return events, asked

    def job(self, directory: str, **fields: object) -> Job:
        return Job.model_validate(
            {
                "id": "test",
                "track_id": 1,
                "target": directory,
                "created_at": 0,
                "updated_at": 0,
                "meta": Metadata(
                    id=1, title="Test song", artist="Test artist", duration=180
                ).model_dump(),
                **fields,
            }
        )

    def test_soundcloud_is_searched_after_a_youtube_no_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked = self.run_worker(
                directory,
                self.job(directory, backup_source="soundcloud"),
                [
                    {"entries": [{"id": "abcdefghijk", "title": "Unrelated", "duration": 900}]},
                    {"entries": [soundcloud("Test artist - Test song")]},
                    {"id": "123456789", "title": "Test song"},
                ],
            )
            self.assertTrue(asked[0].startswith("ytsearch8:"))
            self.assertTrue(asked[1].startswith("scsearch8:"))
            # "official audio" is a YouTube habit and would only hide SoundCloud results.
            self.assertTrue(asked[0].endswith(" official audio"))
            self.assertNotIn("official audio", asked[1])
            self.assertEqual(asked[2], TRACK)
            switched = [row for row in events if row["kind"] == "source"]
            self.assertEqual(switched[0]["source"], "soundcloud")
            chosen = next(row for row in events if row["kind"] == "candidates")
            items = cast(list[dict[str, object]], chosen["items"])
            self.assertEqual(items[0]["source"], "soundcloud")
            self.assertEqual(items[0]["url"], TRACK)
            self.assertEqual(chosen["selected"], "123456789")
            self.assertEqual(events[-1]["kind"], "ready")

    def test_no_fallback_when_the_setting_is_off(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked = self.run_worker(
                directory,
                self.job(directory),
                [{"entries": [{"id": "abcdefghijk", "title": "Unrelated", "duration": 900}]}],
            )
            self.assertEqual(len(asked), 1)
            self.assertTrue(asked[0].startswith("ytsearch8:"))
            self.assertEqual(events[-1]["code"], "NO_MATCH")
            self.assertEqual(events[-1]["hint"], "No matching recording was found on YouTube.")

    def test_no_fallback_after_a_duration_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = self.job(directory, backup_source="soundcloud")
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 400}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.side_effect = [
                    {
                        "entries": [
                            {
                                "id": "abcdefghijk",
                                "title": "Test artist - Test song",
                                "channel": "Test artist",
                                "duration": 180,
                            }
                        ]
                    },
                    {"id": "abcdefghijk", "title": "Test song"},
                ]
                main()
                asked = [
                    str(call.args[0])
                    for call in downloader.return_value.extract_info.call_args_list
                ]
            self.assertEqual(events[-1]["code"], "DURATION_MISMATCH")
            self.assertFalse(any(address.startswith("scsearch8:") for address in asked))
            tagger.return_value.write.assert_not_called()

    def test_remixes_and_sped_up_uploads_fail_the_higher_soundcloud_bar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked = self.run_worker(
                directory,
                self.job(directory, backup_source="soundcloud"),
                [
                    {"entries": []},
                    {
                        "entries": [
                            soundcloud("Test song (Remix)", "111111111", "Some DJ"),
                            soundcloud("Test song sped up", "222222222", "Edits"),
                        ]
                    },
                ],
            )
            self.assertTrue(asked[1].startswith("scsearch8:"))
            self.assertEqual(events[-1]["code"], "NO_MATCH")
            review = next(row for row in events if row["kind"] == "candidates")
            items = cast(list[dict[str, object]], review["items"])
            self.assertEqual(review["selected"], "")
            self.assertTrue(items)
            for row in items:
                self.assertEqual(row["source"], "soundcloud")
                self.assertLess(cast(float, row["score"]), 0.70)

    def test_rejected_candidates_from_both_sources_are_offered_for_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _ = self.run_worker(
                directory,
                self.job(directory, backup_source="soundcloud"),
                [
                    {
                        "entries": [
                            {
                                "id": "cover000001",
                                "title": "Test song cover",
                                "channel": "Cover Band",
                                "duration": 180,
                            }
                        ]
                    },
                    {"entries": [soundcloud("Test song (Remix)", "111111111", "Some DJ")]},
                ],
            )
            review = next(row for row in events if row["kind"] == "candidates")
            items = cast(list[dict[str, object]], review["items"])
            self.assertEqual(
                [row["source"] for row in items],
                ["youtube", "soundcloud"],
            )
            self.assertEqual(
                [row["source_label"] for row in items],
                ["YouTube", "SoundCloud"],
            )
            self.assertEqual(events[-1]["code"], "NO_MATCH")

    def test_a_chosen_soundcloud_recording_downloads_its_own_page(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(
                directory,
                source="soundcloud",
                selected="123456789",
                candidates=[
                    Candidate(
                        id="123456789",
                        title="Test song",
                        artist="Test artist",
                        duration=180,
                        source="soundcloud",
                        url=TRACK,
                    ).model_dump()
                ],
            )
            events, asked = self.run_worker(directory, job, [{"id": "123456789"}])
            self.assertEqual(asked, [TRACK])
            self.assertEqual(events[-1]["kind"], "ready")

    def test_a_candidate_pointing_off_its_own_site_is_never_downloaded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(
                directory,
                source="soundcloud",
                selected="123456789",
                candidates=[
                    Candidate(
                        id="123456789",
                        title="Test song",
                        source="soundcloud",
                        url="https://evil.test/track",
                    ).model_dump()
                ],
            )
            events, asked = self.run_worker(directory, job, [{"id": "123456789"}])
            self.assertEqual(asked, [])
            self.assertEqual(events[-1]["code"], "SITE_NOT_ALLOWED")
