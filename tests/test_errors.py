"""Test error code guidance."""

import unittest

from backend.errors import error_guidance
from backend.store import Store


class ErrorGuidanceTests(unittest.TestCase):
    def test_all_error_codes_have_guidance(self) -> None:
        """Every error code the backend can raise has a non-empty hint and fix."""
        codes = [
            "DEST_UNWRITABLE",
            "DISK_FULL",
            "MOVE_FAILED",
            "DOWNLOAD_FAILED",
            "CATALOG_FAILED",
            "TIMEOUT",
            "INTERNAL_ERROR",
            "SOURCE_BLOCKED",
            "POT_MISSING",
            "JS_RUNTIME_MISSING",
            "COOKIES_EXPIRED",
            "NO_MATCH",
            "DURATION_MISMATCH",
            "RATE_LIMITED",
            "TRANSCODE_FAILED",
            "TAG_FAILED",
        ]
        for code in codes:
            with self.subTest(code=code):
                hint, fix = error_guidance(code)
                self.assertNotEqual(hint, "", f"{code} has no hint")
                self.assertNotEqual(fix, "", f"{code} has no fix")

    def test_job_summary_includes_hint_and_fix(self) -> None:
        """Store.job_summary carries hint and fix for failed jobs."""
        import tempfile
        from pathlib import Path

        from backend.job_store import Jobs

        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "jobs.sqlite3")
            try:
                jobs = Jobs(store, lambda: None)
                job = jobs.enqueue(1, "original", "/music")
                jobs.update(
                    job.id,
                    stage="failed",
                    error_code="NO_MATCH",
                    error="No sufficiently close recording found",
                    error_hint="No matching recording was found on YouTube.",
                    error_fix="card:pick",
                )
                summary = store.job_summary()
                self.assertEqual(summary["failed"], 1)
                failure_reasons = summary["failure_reasons"]
                assert isinstance(failure_reasons, list)
                self.assertEqual(len(failure_reasons), 1)
                first_reason = failure_reasons[0]
                assert isinstance(first_reason, dict)
                self.assertEqual(first_reason["code"], "NO_MATCH")
                self.assertEqual(
                    first_reason["hint"], "No matching recording was found on YouTube."
                )
                self.assertEqual(first_reason["fix"], "card:pick")
            finally:
                store.db.close()
