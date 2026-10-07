import json
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import httpx

from backend.deezer_audio import DeezerAudioError, Saved
from backend.job_models import Candidate, Job, Metadata
from backend.worker import base_options, classify, found, main, redact


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
                self.assertEqual(downloader.call_args.args[0]["concurrent_fragment_downloads"], 4)
                self.assertEqual(downloader.call_args.args[0]["fragment_retries"], 2)
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

    def test_a_name_lookup_miss_is_its_own_retry(self) -> None:
        self.assertEqual(
            classify(
                "Failed to resolve 'api-v2.soundcloud.com' ([Errno -2] Name or service not known)"
            ),
            "LOOKUP_FAILED",
        )

    def test_a_tool_footer_is_not_a_bot_check(self) -> None:
        self.assertEqual(
            classify("Confirm you are on the latest version using yt-dlp -U"), "DOWNLOAD_FAILED"
        )
        self.assertEqual(classify("Sign in to confirm you are not a bot"), "SOURCE_BLOCKED")
        self.assertEqual(classify("[SSL: UNEXPECTED_EOF_WHILE_READING]"), "CONNECTION_FAILED")
        self.assertEqual(classify("HTTP Error 403: Forbidden SSL handshake"), "SOURCE_BLOCKED")

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

    def _resume(self, folder: Path, lyrics: str = "") -> tuple[Job, list[dict[str, object]]]:
        source = folder / "source.m4a"
        source.write_bytes(b"synthetic audio placeholder")
        job = Job(
            id="test",
            track_id=1,
            target=str(folder),
            selected="abcdefghijk",
            meta=Metadata(id=1, title="Song", artist="Band", lyrics=lyrics),
            created_at=0,
            updated_at=0,
        )
        (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
        (folder / "download.json").write_text(
            json.dumps({"selected": job.selected, "file": source.name}), encoding="utf-8"
        )
        return job, []

    def test_tagging_waits_for_metadata_that_arrives_during_the_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            job, events = self._resume(folder)
            (folder / "wait-side").write_bytes(b"")

            def arrive() -> None:
                updated = job.model_copy(
                    update={"meta": job.meta.model_copy(update={"lyrics": "the words"})}
                )
                temporary = folder / "job.json.tmp"
                temporary.write_text(updated.model_dump_json(), encoding="utf-8")
                temporary.replace(folder / "job.json")
                (folder / "side.json").write_text("{}", encoding="utf-8")

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})
                if kind == "stage" and values.get("stage") == "tagging":
                    threading.Timer(0.05, arrive).start()

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL"),
                patch(
                    "backend.worker.probe",
                    return_value={"duration": 180, "codec": "aac", "bitrate": 1},
                ),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                tagger.return_value.prepare.return_value = folder / "source.m4a"
                main()
            meta = tagger.return_value.write.call_args.args[1]
            self.assertEqual(meta.lyrics, "the words")
            self.assertNotIn("warning", [event["kind"] for event in events])

    def test_tagging_continues_when_optional_metadata_never_arrives(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            _, events = self._resume(folder)
            (folder / "wait-side").write_bytes(b"")

            def record(kind: str, **values: object) -> None:
                events.append({"kind": kind, **values})

            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL"),
                patch("backend.worker.SIDE_WAIT_SECONDS", 0.05),
                patch(
                    "backend.worker.probe",
                    return_value={"duration": 180, "codec": "aac", "bitrate": 1},
                ),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                tagger.return_value.prepare.return_value = folder / "source.m4a"
                main()
            meta = tagger.return_value.write.call_args.args[1]
            self.assertEqual(meta.lyrics, "")
            self.assertIn("warning", [event["kind"] for event in events])

    def test_player_cache_is_used_only_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict("os.environ", {"MUSIMO_YTDLP_CACHE": directory}):
                self.assertEqual(base_options()["cachedir"], directory)
            with patch.dict("os.environ", {"MUSIMO_YTDLP_CACHE": ""}):
                self.assertIs(base_options()["cachedir"], False)

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
                patch("backend.worker.fetch", return_value=Saved(source, False)) as account,
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
                patch("backend.worker.fetch", return_value=Saved(source, False)),
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
                patch("backend.worker.fetch", return_value=Saved(source, False)),
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
                patch("backend.worker.fetch", return_value=Saved(source, False)) as account,
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
                    {"MUSIMO_DISABLED_SOURCES": "youtube", "MUSIMO_DEEZER_ARL_FILE": ""},
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

    def test_a_name_lookup_miss_is_retried_instead_of_a_missing_song(self) -> None:
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
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "youtube"}),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.side_effect = OSError(
                    "[Errno -2] Name or service not known"
                )
                main()
            error = events[-1]
            self.assertEqual(error["code"], "LOOKUP_FAILED")
            self.assertIs(error["retryable"], True)
            self.assertNotIn("No matching recording", str(error["hint"]))


TRACK = "https://soundcloud.com/artist/test-song"


def soundcloud(
    title: str, track_id: str = "123456789", artist: str = "Test artist"
) -> dict[str, object]:
    return {"id": track_id, "title": title, "uploader": artist, "duration": 180, "url": TRACK}


def writes_audio(folder: Path, replies: list[object]) -> Callable[..., object]:
    """yt-dlp answers that save source.m4a on a download, as yt-dlp does, and not on a search.

    The walk clears whatever an earlier run left in the folder, so the file has to appear here.
    """
    queue = list(replies)

    def answer(address: object, *args: object, **kwargs: object) -> object:
        reply = queue.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if "search8:" not in str(address):
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
        return reply

    return answer


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
            downloader.return_value.extract_info.side_effect = writes_audio(folder, answers)
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

    def test_a_soundcloud_page_is_kept_when_the_tool_also_gives_the_api_address(self) -> None:
        entry = soundcloud("Test artist - Test song")
        entry["url"] = "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A123456789"
        entry["webpage_url"] = TRACK
        self.assertEqual(found("soundcloud", [entry])[0].url, TRACK)
        # The public page still wins when the tool puts the API address in webpage_url.
        swapped = soundcloud("Test artist - Test song")
        swapped["url"] = TRACK
        swapped["webpage_url"] = (
            "https://api-v2.soundcloud.com/tracks/soundcloud%3Atracks%3A123456789"
        )
        self.assertEqual(found("soundcloud", [swapped])[0].url, TRACK)
        # No public page: keep the API address, which is what the download can open.
        api = "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A123456789"
        only = soundcloud("Test artist - Test song")
        only["url"] = api
        self.assertEqual(found("soundcloud", [only])[0].url, api)

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

    def test_a_wrong_length_with_nothing_left_to_ask_files_a_duration_mismatch(self) -> None:
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
                patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "youtube"}),
                patch("backend.worker.configured", return_value=False),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.probe", return_value={"duration": 400}),
                patch("backend.worker.Tagger") as tagger,
                patch("backend.worker.emit", side_effect=record),
            ):
                downloader.return_value.extract_info.side_effect = writes_audio(
                    folder,
                    [
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
                    ],
                )
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
                downloader.return_value.extract_info.side_effect = writes_audio(
                    folder,
                    [
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
                    ],
                )
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


MATCH = {
    "id": "abcdefghijk",
    "title": "Test artist - Test song",
    "channel": "Test artist",
    "duration": 180,
}
# Ranks above MATCH: the same title on the artist's Topic channel.
TOPIC = {
    "id": "bcdefghijkl",
    "title": "Test song",
    "channel": "Test artist - Topic",
    "duration": 180,
}


def run_walk(
    directory: str,
    replies: list[object],
    *,
    env: dict[str, str] | None = None,
    account: Callable[..., Saved] | None = None,
    lengths: dict[str, object] | None = None,
    fields: dict[str, object] | None = None,
    answer: Callable[..., object] | None = None,
) -> tuple[list[dict[str, object]], list[str], MagicMock]:
    """Run the worker on one catalog song with yt-dlp, the Deezer fetch and ffprobe faked.

    `replies` answer yt-dlp in order. Without `account` the Deezer row has no cookie. `lengths`
    maps a file suffix to what ffprobe reports, or to the exception it raises. Returns the events,
    the addresses yt-dlp was asked for, and the YoutubeDL mock.
    """
    folder = Path(directory)
    job = Job.model_validate(
        {
            "id": "test",
            "track_id": 1,
            "target": directory,
            "created_at": 0,
            "updated_at": 0,
            "meta": Metadata(
                id=1, title="Test song", artist="Test artist", duration=180
            ).model_dump(),
            **(fields or {}),
        }
    )
    (folder / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
    events: list[dict[str, object]] = []
    reported: dict[str, object] = {".m4a": 180.0, ".flac": 180.0, **(lengths or {})}

    def record(kind: str, **values: object) -> None:
        events.append({"kind": kind, **values})

    def probe(path: Path, accurate: bool = False) -> dict[str, object]:
        length = reported[path.suffix]
        if isinstance(length, BaseException):
            raise length
        return {"duration": length, "codec": "test"}

    with (
        patch("sys.argv", ["worker", directory]),
        patch.dict("os.environ", {"MUSIMO_SOURCE_ORDER": "youtube", **(env or {})}),
        patch("backend.worker.configured", return_value=account is not None),
        patch("backend.worker.fetch", side_effect=account),
        patch("backend.worker.probe", side_effect=probe),
        patch("backend.worker.Tagger") as tagger,
        patch("yt_dlp.YoutubeDL") as downloader,
        patch("backend.worker.emit", side_effect=record),
    ):
        tagger.return_value.prepare.side_effect = lambda source, *_: source
        downloader.return_value.extract_info.side_effect = answer or writes_audio(folder, replies)
        main()
        asked = [str(call.args[0]) for call in downloader.return_value.extract_info.call_args_list]
    return events, asked, downloader


def saves(name: str, alternate: bool = False) -> Callable[..., Saved]:
    """A Deezer fetch that saves `name` in the job folder. `alternate` marks Deezer's fallback."""

    def fetch(track_id: int, folder: Path, progress: object = None) -> Saved:
        path = folder / name
        path.write_bytes(b"synthetic account file")
        return Saved(path, alternate)

    return fetch


class WalkTests(unittest.TestCase):
    """What the catalog walk asks, what it skips, and what it files."""

    def test_a_deezer_network_error_still_asks_youtube(self) -> None:
        def unreachable(*_: object) -> Saved:
            raise httpx.ConnectError("Temporary failure in name resolution")

        with tempfile.TemporaryDirectory() as directory:
            events, asked, _ = run_walk(
                directory,
                [{"entries": [MATCH]}, {"id": MATCH["id"], "title": "Test song"}],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                account=unreachable,
            )
            self.assertTrue(asked[0].startswith("ytsearch8:"))
            self.assertEqual(events[-1]["kind"], "ready")

    def test_an_unreadable_deezer_file_is_cleared_before_youtube(self) -> None:
        # The account file stayed behind, and the YouTube download then found two files.
        for reported in (subprocess.CalledProcessError(1, ["ffprobe"]), 0.0):
            with self.subTest(reported=reported), tempfile.TemporaryDirectory() as directory:
                events, _, _ = run_walk(
                    directory,
                    [{"entries": [MATCH]}, {"id": MATCH["id"], "title": "Test song"}],
                    env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                    account=saves("source.flac"),
                    lengths={".flac": reported},
                )
                self.assertEqual(events[-1]["kind"], "ready")
                self.assertFalse((Path(directory) / "source.flac").exists())
                logged = " ".join(str(row["message"]) for row in events if row["kind"] == "log")
                self.assertNotIn("ffprobe", logged)

    def test_deezer_fallback_of_another_recording_gets_the_strict_length_check(self) -> None:
        # The catalog says 180 seconds. 150 is inside the account file's loose rule, but a
        # fallback with another SNG_ID is a different recording, so it is held to 15 seconds.
        for alternate, kept in ((True, False), (False, True)):
            with self.subTest(alternate=alternate), tempfile.TemporaryDirectory() as directory:
                events, asked, _ = run_walk(
                    directory,
                    [{"entries": [MATCH]}, {"id": MATCH["id"], "title": "Test song"}],
                    env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                    account=saves("source.flac", alternate),
                    lengths={".flac": 150.0},
                )
                self.assertEqual(events[-1]["kind"], "ready")
                self.assertEqual(not asked, kept)
                if not kept:
                    logged = [row["message"] for row in events if row["kind"] == "log"]
                    self.assertIn("Deezer file length did not match the catalog", logged)

    def test_a_song_the_account_saves_never_starts_yt_dlp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _, downloader = run_walk(
                directory,
                [],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                account=saves("source.flac"),
            )
            self.assertEqual(events[-1]["kind"], "ready")
            downloader.assert_not_called()

    def test_a_recording_that_fails_for_itself_moves_to_the_next_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked, _ = run_walk(
                directory,
                [
                    {"entries": [MATCH, TOPIC]},
                    RuntimeError(f"ERROR: [youtube] {TOPIC['id']}: Video unavailable"),
                    {"id": MATCH["id"], "title": "Test song"},
                ],
            )
            self.assertEqual(
                asked[1:],
                [
                    f"https://www.youtube.com/watch?v={TOPIC['id']}",
                    f"https://www.youtube.com/watch?v={MATCH['id']}",
                ],
            )
            self.assertEqual(events[-1]["kind"], "ready")

    def test_a_block_or_rate_limit_stops_the_source_and_leaves_backoff_to_the_queue(self) -> None:
        cases = (
            ("Sign in to confirm you are not a bot", "SOURCE_BLOCKED", False, 1),
            ("HTTP Error 429: Too Many Requests", "RATE_LIMITED", True, 0),
            ("Read timed out", "TIMEOUT", True, 0),
        )
        for message, code, retryable, blocks in cases:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                events, asked, _ = run_walk(
                    directory,
                    [RuntimeError(message)] * 4,
                    env={"MUSIMO_MAX_ATTEMPTS": "4"},
                )
                self.assertEqual(len(asked), 1)
                self.assertEqual(events[-1]["code"], code)
                self.assertEqual(events[-1]["retryable"], retryable)
                self.assertEqual(len([row for row in events if row["kind"] == "blocked"]), blocks)
                noted = 1 if code in {"RATE_LIMITED", "TIMEOUT"} else 0
                self.assertEqual(
                    len([row for row in events if row["kind"] == "source_error"]), noted
                )

    def test_a_later_answer_with_no_song_files_the_job_as_no_match(self) -> None:
        cover = {"id": "cover000001", "title": "Test song cover", "channel": "Band"}
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [RuntimeError("HTTP Error 500: Internal Server Error"), {"entries": [cover]}],
                env={"MUSIMO_MAX_ATTEMPTS": "2"},
            )
            self.assertEqual(events[-1]["code"], "NO_MATCH")

    def test_a_wrong_length_is_still_the_reason_when_another_source_had_weak_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [
                    {"entries": [MATCH]},
                    {"id": MATCH["id"], "title": "Test song"},
                    {"entries": [soundcloud("Test song (Remix)", "111111111", "Some DJ")]},
                ],
                env={"MUSIMO_SOURCE_ORDER": "youtube,soundcloud"},
                lengths={".m4a": 400.0},
            )
            self.assertEqual(events[-1]["code"], "DURATION_MISMATCH")
            self.assertIn("YouTube", str(events[-1]["hint"]))

    def test_tries_cover_a_failed_download_on_the_same_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, asked, _ = run_walk(
                directory,
                [
                    {"entries": [MATCH]},
                    RuntimeError("Connection reset by peer"),
                    {"id": MATCH["id"], "title": "Test song"},
                ],
                env={"MUSIMO_TRIES_PER_SOURCE": "2"},
            )
            watch = f"https://www.youtube.com/watch?v={MATCH['id']}"
            self.assertEqual(asked[1:], [watch, watch])
            self.assertEqual(events[-1]["kind"], "ready")

    def test_an_automatic_pick_left_from_a_paused_walk_walks_again(self) -> None:
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        with tempfile.TemporaryDirectory() as directory:
            _, asked, _ = run_walk(
                directory,
                [{"entries": [MATCH]}, {"id": MATCH["id"], "title": "Test song"}],
                fields={"selected": MATCH["id"], "hand_picked": False, "candidates": [stale]},
            )
            self.assertTrue(asked[0].startswith("ytsearch8:"))

    def test_an_automatic_job_resumes_its_saved_file_after_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
            (folder / "download.json").write_text(
                json.dumps({"selected": MATCH["id"], "file": "source.m4a", "artist": "A"}),
                encoding="utf-8",
            )
            events, asked, _ = run_walk(
                directory, [], fields={"selected": "", "hand_picked": False}
            )
            self.assertEqual(asked, [])
            self.assertEqual(events[-1]["kind"], "ready")

    def test_a_soundcloud_first_song_downloads_with_the_soundcloud_client(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _, downloader = run_walk(
                directory,
                [{"entries": [soundcloud("Test artist - Test song")]}, {"id": "123456789"}],
                env={"MUSIMO_SOURCE_ORDER": "soundcloud"},
                fields={"source": "soundcloud"},
            )
            self.assertEqual(events[-1]["kind"], "ready")
            built = [cast(dict[str, object], call.args[0]) for call in downloader.call_args_list]
            allowed = [options.get("allowed_extractors") for options in built]
            self.assertTrue(any(isinstance(row, list) and "soundcloud" in row for row in allowed))

    def test_a_deezer_file_after_a_youtube_try_is_not_filed_under_that_recording(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [{"entries": [MATCH]}, RuntimeError("Connection reset by peer")],
                env={"MUSIMO_SOURCE_ORDER": "youtube,deezer"},
                account=saves("source.flac"),
            )
            self.assertEqual(events[-1]["kind"], "ready")
            last = [row for row in events if row["kind"] == "candidates"][-1]
            self.assertEqual(last["selected"], "")


class WalkFollowUpTests(unittest.TestCase):
    """Cases found when the walk fixes were reviewed again."""

    def test_a_private_or_country_blocked_match_moves_on_without_a_block(self) -> None:
        # A private video reads like expired cookies, and YouTube's country wording matched no
        # geo marker. Both stopped the source or repeated the same match.
        refusals = (
            "Private video. Sign in if you've been granted access to this video. "
            "Use --cookies-from-browser or --cookies for the authentication.",
            "The uploader has not made this video available in your country",
        )
        for refusal in refusals:
            with self.subTest(refusal=refusal), tempfile.TemporaryDirectory() as directory:
                events, asked, _ = run_walk(
                    directory,
                    [
                        {"entries": [MATCH, TOPIC]},
                        RuntimeError(f"ERROR: [youtube] {TOPIC['id']}: {refusal}"),
                        {"id": MATCH["id"], "title": "Test song"},
                    ],
                )
                self.assertEqual(asked[-1], f"https://www.youtube.com/watch?v={MATCH['id']}")
                self.assertEqual(events[-1]["kind"], "ready")
                self.assertEqual([row for row in events if row["kind"] == "blocked"], [])

    def test_a_rate_limit_stays_retryable_when_another_source_failed_last(self) -> None:
        def refuses(*_: object) -> Saved:
            raise DeezerAudioError("Deezer did not return the audio")

        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [RuntimeError("HTTP Error 429: Too Many Requests")],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube", "MUSIMO_MAX_ATTEMPTS": "2"},
                account=refuses,
            )
            self.assertEqual(events[-1]["code"], "RATE_LIMITED")
            self.assertTrue(events[-1]["retryable"])

    def test_a_deezer_timeout_with_no_youtube_song_stays_retryable(self) -> None:
        calls: list[int] = []

        def stalls(*_: object) -> Saved:
            calls.append(1)
            raise httpx.ReadTimeout("The read operation timed out")

        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [{"entries": []}],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube", "MUSIMO_MAX_ATTEMPTS": "3"},
                account=stalls,
            )
            self.assertEqual(events[-1]["code"], "TIMEOUT")
            self.assertEqual(events[-1]["source"], "deezer")
            self.assertTrue(events[-1]["retryable"])
            # A stalled Deezer is not asked again this run, so it cannot use up the budget.
            self.assertEqual(len(calls), 1)

    def test_a_wrapped_deezer_rate_limit_stays_retryable(self) -> None:
        def limited(*_: object) -> Saved:
            request = httpx.Request("GET", "https://media.deezer.com/v1/get_url")
            response = httpx.Response(429, request=request)
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise DeezerAudioError("Deezer did not answer") from exc
            raise AssertionError("unreachable")

        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [{"entries": []}],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                account=limited,
            )
            self.assertEqual(events[-1]["code"], "RATE_LIMITED")
            self.assertTrue(events[-1]["retryable"])

    def test_a_plain_deezer_refusal_is_not_read_as_a_youtube_block(self) -> None:
        def refuses(*_: object) -> Saved:
            raise DeezerAudioError("Deezer answered 403, sign in again")

        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [{"entries": []}],
                env={"MUSIMO_SOURCE_ORDER": "deezer,youtube"},
                account=refuses,
            )
            self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
            self.assertFalse(events[-1]["retryable"])
            self.assertEqual([row for row in events if row["kind"] == "blocked"], [])

    def test_an_earlier_failure_does_not_outrank_a_later_wrong_length(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [
                    {"entries": [MATCH, TOPIC]},
                    RuntimeError("Video unavailable"),
                    RuntimeError("Connection reset by peer"),
                    {"entries": [MATCH, TOPIC]},
                    {"id": MATCH["id"], "title": "Test song"},
                ],
                env={"MUSIMO_MAX_ATTEMPTS": "2"},
                lengths={".m4a": 400.0},
            )
            self.assertEqual(events[-1]["code"], "DURATION_MISMATCH")

    def partial_at_download(self, marked: object) -> list[bool]:
        """Whether an unfinished file left for `marked` is still there when MATCH downloads."""
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "source.m4a.part").write_bytes(b"half a song")
            (folder / "partial.json").write_text(
                json.dumps({"source": "youtube", "id": marked}), encoding="utf-8"
            )
            seen: list[bool] = []

            def answer(address: object, *args: object, **kwargs: object) -> object:
                if "search8:" in str(address):
                    return {"entries": [MATCH]}
                seen.append((folder / "source.m4a.part").exists())
                (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
                return {"id": MATCH["id"], "title": "Test song"}

            events, _, _ = run_walk(directory, [], answer=answer)
            self.assertEqual(events[-1]["kind"], "ready")
        return seen

    def test_a_paused_download_resumes_its_own_partial_file_only(self) -> None:
        # The walk used to clear the folder first, so a paused download started over.
        self.assertEqual(self.partial_at_download(MATCH["id"]), [True])
        # Another recording's unfinished file must not be resumed into this one.
        self.assertEqual(self.partial_at_download("zzzzzzzzzzz"), [False])

    def test_a_resumed_file_restores_its_source_and_match_flag_after_retry(self) -> None:
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "source.m4a").write_bytes(b"synthetic audio placeholder")
            (folder / "download.json").write_text(
                json.dumps(
                    {
                        "selected": MATCH["id"],
                        "file": "source.m4a",
                        "artist": "A",
                        "source": "youtube",
                        "check_match": True,
                    }
                ),
                encoding="utf-8",
            )
            events, asked, _ = run_walk(
                directory,
                [],
                fields={
                    "source": "deezer",
                    "selected": "",
                    "hand_picked": False,
                    "candidates": [stale],
                },
            )
            self.assertEqual(asked, [])
            self.assertIn({"kind": "source", "source": "youtube"}, events)
            picked = [row for row in events if row["kind"] == "candidates"]
            self.assertEqual(picked[-1]["selected"], MATCH["id"])
            self.assertTrue(picked[-1]["check_match"])
            self.assertEqual(events[-1]["kind"], "ready")

    def test_a_hand_pick_from_a_turned_off_source_is_refused(self) -> None:
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        with tempfile.TemporaryDirectory() as directory:
            events, asked, _ = run_walk(
                directory,
                [],
                env={"MUSIMO_DISABLED_SOURCES": "youtube"},
                fields={"selected": MATCH["id"], "hand_picked": True, "candidates": [stale]},
            )
            self.assertEqual(asked, [])
            self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
            self.assertEqual(events[-1]["fix"], "settings:sources")
            self.assertEqual(events[-1]["hint"], "YouTube is turned off in Settings.")

    def test_a_country_block_is_filed_as_one_plain_sentence(self) -> None:
        # The tool's text names the video, so the summary listed one row per blocked track.
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [
                    {"entries": [MATCH]},
                    RuntimeError(
                        f"ERROR: [youtube] {MATCH['id']}: This video is not available due to "
                        "geo restriction"
                    ),
                ],
            )
            self.assertEqual(events[-1]["code"], "GEO_RESTRICTED")
            self.assertNotIn(str(MATCH["id"]), str(events[-1]["message"]))

    def test_a_hand_picked_private_video_is_not_read_as_expired_cookies(self) -> None:
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [
                    RuntimeError(
                        f"ERROR: [youtube] {MATCH['id']}: Private video. Sign in if you've been "
                        "granted access to this video. Use --cookies for the authentication."
                    )
                ],
                fields={"selected": MATCH["id"], "hand_picked": True, "candidates": [stale]},
            )
            self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
            self.assertFalse(events[-1]["retryable"])

    def test_a_hand_picked_recording_that_is_gone_is_not_retried(self) -> None:
        # A removed or region-locked upload will not appear on the next try. The queue's backoff
        # is for a rate limit or a timeout, not for this file.
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        refusals = (
            f"ERROR: [youtube] {MATCH['id']}: Video unavailable",
            f"ERROR: [youtube] {MATCH['id']}: The uploader has not made this video "
            "available in your country",
        )
        for refusal in refusals:
            with self.subTest(refusal=refusal), tempfile.TemporaryDirectory() as directory:
                events, _, _ = run_walk(
                    directory,
                    [RuntimeError(refusal)],
                    fields={"selected": MATCH["id"], "hand_picked": True, "candidates": [stale]},
                )
                self.assertEqual(events[-1]["code"], "DOWNLOAD_FAILED")
                self.assertFalse(events[-1]["retryable"])

    def test_a_hand_picked_sign_in_failure_still_counts_as_expired_cookies(self) -> None:
        # Only the recording's own wording is one file. A plain sign-in failure still pauses.
        stale = Candidate(id=str(MATCH["id"]), title="Test song", source="youtube").model_dump()
        with tempfile.TemporaryDirectory() as directory:
            events, _, _ = run_walk(
                directory,
                [RuntimeError("ERROR: [youtube] sign in required")],
                fields={"selected": MATCH["id"], "hand_picked": True, "candidates": [stale]},
            )
            self.assertEqual(events[-1]["code"], "COOKIES_EXPIRED")
            self.assertFalse(events[-1]["retryable"])

    def test_a_finished_file_without_a_manifest_does_not_block_the_resumed_pick(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            # A stopped worker left Deezer's finished file and this pick's unfinished one.
            (folder / "source.flac").write_bytes(b"synthetic account file")
            (folder / "source.m4a.part").write_bytes(b"half a song")
            (folder / "partial.json").write_text(
                json.dumps({"source": "youtube", "id": MATCH["id"]}), encoding="utf-8"
            )
            events, _, _ = run_walk(
                directory, [{"entries": [MATCH]}, {"id": MATCH["id"], "title": "Test song"}]
            )
            self.assertEqual(events[-1]["kind"], "ready")
            self.assertFalse((folder / "source.flac").exists())
