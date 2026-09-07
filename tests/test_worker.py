import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.job_models import Job, Metadata
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
            with (
                patch("sys.argv", ["worker", directory]),
                patch("yt_dlp.YoutubeDL") as downloader,
                patch("backend.worker.emit") as emit,
                patch("backend.worker.Tagger") as tagger,
            ):
                downloader.return_value.extract_info.return_value = {
                    "entries": [
                        {"id": "https://untrusted.test", "title": "Test song", "duration": 180},
                        {"id": "abcdefghijk", "title": "Unrelated song", "duration": 900},
                    ]
                }
                main()
                downloader.return_value.extract_info.assert_called_once()
                self.assertFalse(downloader.return_value.extract_info.call_args.kwargs["download"])
                self.assertEqual(emit.call_args.kwargs["code"], "NO_MATCH")
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
