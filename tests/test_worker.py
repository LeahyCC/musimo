import json
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

from backend.deezer_audio import DeezerAudioError
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
            ("Sign in to confirm your age", "AGE_RESTRICTED", False),
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

    def test_account_audio_skips_the_youtube_search(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "source.flac"
            source.write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=3135556,
                target=directory,
                meta=Metadata(id=3135556, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("backend.worker.configured", return_value=True),
                patch("backend.worker.fetch", return_value=source) as account,
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 180, "codec": "flac"}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                tagger.return_value.prepare.return_value = source
                main()
            account.assert_called_once()
            downloader.return_value.extract_info.assert_not_called()
            self.assertEqual(events[-1]["kind"], "ready")
            self.assertTrue(any(event.get("source") == "deezer" for event in events))

    def test_an_account_file_a_bit_off_the_listed_length_is_kept(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "source.flac"
            source.write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Dead Memories", artist="Slipknot", duration=238),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "deezer,youtube"}),
                patch("backend.worker.configured", return_value=True),
                patch("backend.worker.fetch", return_value=source),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 180, "codec": "flac"}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                tagger.return_value.prepare.return_value = source
                main()
            downloader.return_value.extract_info.assert_not_called()
            self.assertEqual(events[-1]["kind"], "ready")

    def test_an_account_preview_still_tries_the_next_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "source.mp3"
            source.write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=238),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "deezer,youtube"}),
                patch("backend.worker.configured", return_value=True),
                patch("backend.worker.fetch", return_value=source),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 20}),
                patch("backend.worker.emit"),
            ):
                downloader.return_value.extract_info.return_value = {"entries": []}
                main()
            downloader.return_value.extract_info.assert_called()

    def test_account_audio_failure_falls_back_to_youtube(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            with (
                patch("sys.argv", ["worker", directory]),
                patch("backend.worker.configured", return_value=True),
                patch(
                    "backend.worker.fetch", side_effect=DeezerAudioError("cookie rejected")
                ) as account,
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit"),
            ):
                downloader.return_value.extract_info.return_value = {"entries": []}
                main()
            account.assert_called_once()
            downloader.return_value.extract_info.assert_called()

    def test_a_youtube_miss_tries_the_next_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "source.flac"
            source.write_bytes(b"synthetic audio placeholder")
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "youtube,deezer"}),
                patch("backend.worker.configured", return_value=True),
                patch("backend.worker.fetch", return_value=source) as account,
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 180, "codec": "flac"}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.return_value = {
                    "entries": [{"id": "abcdefghijk", "title": "Unrelated", "duration": 900}]
                }
                tagger.return_value.prepare.return_value = source
                main()
            account.assert_called_once()
            self.assertEqual(events[-1]["kind"], "ready")
            self.assertFalse(any(event.get("code") == "NO_MATCH" for event in events))

    def test_turned_off_youtube_is_not_searched(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict(
                    "os.environ",
                    {"MUSIMO_DISABLED_SOURCES": "youtube", "MUSIMO_DEEZER_ARL": ""},
                ),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit", side_effect=record),
            ):
                main()
            downloader.return_value.extract_info.assert_not_called()
            self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
            self.assertEqual(events[-1]["fix"], "settings:sources")
            self.assertIn("turned off", str(events[-1]["message"]))

    def test_a_failed_download_is_tried_then_the_next_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict(
                    "os.environ",
                    {
                        "MUSIMO_SOURCE_ORDER": "deezer,youtube",
                        "MUSIMO_TRIES_PER_SOURCE": "2",
                        "MUSIMO_MAX_ATTEMPTS": "1",
                    },
                ),
                patch("backend.worker.configured", return_value=True),
                patch(
                    "backend.worker.fetch", side_effect=DeezerAudioError("cookie rejected")
                ) as account,
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit"),
            ):
                downloader.return_value.extract_info.return_value = {"entries": []}
                main()
            self.assertEqual(account.call_count, 2)
            downloader.return_value.extract_info.assert_called()

    def test_a_later_lap_retries_a_source_that_failed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict(
                    "os.environ",
                    {
                        "MUSIMO_SOURCE_ORDER": "deezer,youtube",
                        "MUSIMO_TRIES_PER_SOURCE": "1",
                        "MUSIMO_MAX_ATTEMPTS": "2",
                    },
                ),
                patch("backend.worker.configured", return_value=True),
                patch(
                    "backend.worker.fetch", side_effect=DeezerAudioError("cookie rejected")
                ) as account,
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit"),
            ):
                downloader.return_value.extract_info.return_value = {"entries": []}
                main()
            self.assertEqual(account.call_count, 2)
            self.assertEqual(downloader.return_value.extract_info.call_count, 1)

    def test_a_deezer_cookie_failure_is_kept_when_youtube_has_no_song(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = Job(
                id="test",
                track_id=1,
                target=directory,
                meta=Metadata(id=1, title="Test song", artist="Test artist", duration=180),
                created_at=0,
                updated_at=0,
            )
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "deezer,youtube"}),
                patch("backend.worker.configured", return_value=True),
                patch("backend.worker.fetch", side_effect=DeezerAudioError("cookie rejected")),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.return_value = {"entries": []}
                main()
            error = events[-1]
            self.assertEqual(error["code"], "DOWNLOAD_FAILED")
            self.assertEqual(error["source"], "deezer")
            self.assertIn("cookie rejected", str(error["hint"]))
            self.assertIn("YouTube", str(error["hint"]))


TRACK = "https://soundcloud.com/artist/test-song"


def soundcloud(
    title: str, track_id: str = "123456789", artist: str = "Test artist"
) -> dict[str, object]:
    return {"id": track_id, "title": title, "uploader": artist, "duration": 180, "url": TRACK}


class BackupSourceTests(unittest.TestCase):
    """The SoundCloud search that runs only after YouTube found nothing."""

    def run_worker(
        self, directory: str, job: Job, answers: list[object], order: str | None = None
    ) -> tuple[list[dict[str, object]], list[str]]:
        folder = Path(directory)
        (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
        (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
        events: list[dict[str, object]] = []
        env = {"MUSIMO_SOURCE_ORDER": order} if order else {}

        def record(kind: str, **values: object) -> None:
            events.append({"kind": kind, **values})

        with (
            patch("sys.argv", ["worker", directory]),
            patch.dict("os.environ", env),
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
                self.job(directory),
                [
                    {"entries": [{"id": "abcdefghijk", "title": "Unrelated", "duration": 900}]},
                    {"entries": [soundcloud("Test artist - Test song")]},
                    {"id": "123456789", "title": "Test song"},
                ],
                order="youtube,soundcloud",
            )
            self.assertTrue(asked[0].startswith("ytsearch8:"))
            self.assertTrue(asked[1].startswith("scsearch8:"))
            # The label upload phrase is a YouTube habit and would only hide SoundCloud results.
            self.assertTrue(asked[0].endswith(' "provided to youtube by"'))
            self.assertNotIn("provided to youtube", asked[1])
            self.assertEqual(asked[2], TRACK)
            switched = [row["source"] for row in events if row["kind"] == "source"]
            self.assertEqual(switched[0], "youtube")
            self.assertEqual(switched[-1], "soundcloud")
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
            job = self.job(directory)
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

    def test_a_wrong_length_still_asks_every_later_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job = self.job(directory)
            (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
            events: list[dict[str, object]] = []

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "youtube,soundcloud"}),
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
                    {"entries": []},
                ]
                main()
                asked = [
                    str(call.args[0])
                    for call in downloader.return_value.extract_info.call_args_list
                ]
            self.assertTrue(any(address.startswith("scsearch8:") for address in asked))
            self.assertEqual(events[-1]["code"], "DURATION_MISMATCH")
            self.assertIn("YouTube", str(events[-1]["hint"]))
            self.assertIn("SoundCloud", str(events[-1]["hint"]))
            tagger.return_value.write.assert_not_called()

    def test_remixes_and_sped_up_uploads_fail_the_higher_soundcloud_bar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked = self.run_worker(
                directory,
                self.job(directory),
                [
                    {"entries": []},
                    {
                        "entries": [
                            soundcloud("Test song (Remix)", "111111111", "Some DJ"),
                            soundcloud("Test song sped up", "222222222", "Edits"),
                        ]
                    },
                ],
                order="youtube,soundcloud",
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
                self.job(directory),
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
                order="youtube,soundcloud",
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

    def test_a_soundcloud_search_block_names_soundcloud(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _asked = self.run_worker(
                directory,
                self.job(directory),
                [RuntimeError("HTTP Error 403: Forbidden")],
                order="soundcloud",
            )
            error = events[-1]
            self.assertEqual(error["code"], "SOURCE_BLOCKED")
            self.assertEqual(error["source"], "soundcloud")
            self.assertIn("SoundCloud", str(error["hint"]))
            blocked = [row for row in events if row["kind"] == "blocked"]
            self.assertEqual(blocked[0]["source"], "soundcloud")

    def test_a_miss_names_the_source_that_was_asked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _asked = self.run_worker(
                directory,
                self.job(directory),
                [{"entries": []}],
                order="soundcloud",
            )
            self.assertEqual(events[-1]["hint"], "No matching recording was found on SoundCloud.")
            self.assertEqual(events[-1]["source"], "soundcloud")

    def test_a_hand_pick_does_not_ask_the_next_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = self.job(
                directory,
                selected="abcdefghijk",
                hand_picked=True,
                candidates=[
                    Candidate(
                        id="abcdefghijk",
                        title="Test song",
                        artist="Test artist",
                        duration=180,
                    ).model_dump()
                ],
            )
            events, asked = self.run_worker(
                directory,
                job,
                [RuntimeError("HTTP Error 403: Forbidden")],
                order="youtube,soundcloud",
            )
            self.assertEqual(asked, ["https://www.youtube.com/watch?v=abcdefghijk"])
            self.assertEqual(events[-1]["source"], "youtube")
