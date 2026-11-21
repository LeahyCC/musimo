"""The action suite in `evals/actions`: every case must pass, and the scorer must tell a right
answer from a wrong one. The scorer tests use made-up answers, so they need no app."""

import tempfile
import unittest
from pathlib import Path

from scripts.action_eval import (
    CaseResult,
    SuiteError,
    check_state,
    check_step,
    fill,
    load_suite,
    lookup,
    markdown,
    run_suite,
    score_case,
    summarize,
    write_report,
)

IDS = ["tr-0000000000000001", "tr-0000000000000002"]
NAMES = {"p": {"ids": IDS, "revision": 1}, "s01": IDS[0]}
CASE = {
    "id": "x01",
    "title": "A commit saves the approved ids",
    "expect": {"unchanged": ["queue"], "delta": {"playlists": 1}},
}
START = {"queue": {"song_ids": []}, "playlists": 1, "plays": 0}


def record(*problems: str) -> dict[str, object]:
    return {"name": "commit", "call": "POST /x", "status": 200, "problems": list(problems)}


class SuiteTests(unittest.TestCase):
    def test_every_case_passes_or_fails_as_labelled(self) -> None:
        results = run_suite(load_suite())
        broken = {result.id: result.failures for result in results if not result.ok}
        self.assertEqual(broken, {})

    def test_the_labels_are_well_formed(self) -> None:
        suite = load_suite()
        keys = {str(song["key"]) for song in suite["library"]}
        self.assertEqual(len(keys), len(suite["library"]))
        for case in suite["cases"]:
            with self.subTest(case=case["id"]):
                self.assertTrue(case["title"])
                self.assertTrue(case["covers"])
                if "expected_failure" in case:
                    self.assertTrue(str(case["expected_failure"]).strip())

    def test_a_missing_or_repeated_case_id_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cases.json"
            path.write_text('{"cases": [{"id": "a", "steps": [1]}, {"id": "a", "steps": [1]}]}')
            with self.assertRaises(SuiteError):
                load_suite(path)


class ScorerTests(unittest.TestCase):
    def test_a_right_answer_passes(self) -> None:
        end = {"queue": {"song_ids": []}, "playlists": 2, "plays": 0}
        result = score_case(CASE, [record()], START, end, NAMES)
        self.assertEqual((result.status, result.failures), ("pass", []))
        self.assertTrue(result.ok)

    def test_a_wrong_state_fails_and_says_what_moved(self) -> None:
        end = {"queue": {"song_ids": ["tr-0000000000000009"]}, "playlists": 3, "plays": 0}
        result = score_case(CASE, [record()], START, end, NAMES)
        self.assertEqual(result.status, "fail")
        self.assertFalse(result.ok)
        self.assertEqual(len(result.failures), 2)
        self.assertIn("queue changed", result.failures[0])
        self.assertIn("playlists moved by 2, expected 1", result.failures[1])

    def test_a_wrong_answer_fails_with_the_step_named(self) -> None:
        end = {"queue": {"song_ids": []}, "playlists": 2, "plays": 0}
        result = score_case(CASE, [record("status 500, expected 200")], START, end, NAMES)
        self.assertEqual(result.status, "fail")
        self.assertEqual(result.failures, ["commit: status 500, expected 200"])

    def test_an_expected_failure_passes_the_run_only_while_it_fails(self) -> None:
        marked = CASE | {"expected_failure": "known gap"}
        end = {"queue": {"song_ids": []}, "playlists": 3, "plays": 0}
        failing = score_case(marked, [record()], START, end, NAMES)
        self.assertEqual(
            (failing.status, failing.ok, failing.reason), ("expected_failure", True, "known gap")
        )
        fixed = score_case(marked, [record()], START, START | {"playlists": 2}, NAMES)
        self.assertEqual((fixed.status, fixed.ok), ("unexpected_pass", False))

    def test_check_step_reads_status_error_and_paths(self) -> None:
        body = {"error": {"code": "proposal_stale", "message": "Nothing was saved.", "fields": []}}
        expect = {"status": 409, "error": "proposal_stale", "message_has": "Nothing was saved"}
        self.assertEqual(check_step(expect, 409, body, NAMES), [])
        wrong = check_step(expect | {"error": "other"}, 200, body, NAMES)
        self.assertEqual(len(wrong), 2)
        answer = {"proposal": {"ids": IDS, "revision": 2}, "replayed": False}
        right = {
            "json": {"proposal.revision": 2, "replayed": False},
            "starts_with": {"proposal.ids": [IDS[0]]},
            "excludes": {"proposal.ids": ["tr-0000000000000009"]},
            "len": {"proposal.ids": 2},
        }
        self.assertEqual(check_step(right, 200, answer, NAMES), [])
        bad = {"json": {"replayed": 0}, "excludes": {"proposal.ids": [IDS[1]]}}
        self.assertEqual(len(check_step(bad, 200, answer, NAMES)), 2)

    def test_false_is_not_zero(self) -> None:
        self.assertEqual(
            len(check_step({"json": {"state_changed": 0}}, 200, {"state_changed": False}, {})), 1
        )

    def test_names_and_paths_resolve(self) -> None:
        self.assertEqual(fill("{p.ids}", NAMES), IDS)
        self.assertEqual(fill("/proposals/{s01}/x", NAMES), f"/proposals/{IDS[0]}/x")
        self.assertEqual(lookup({"entry": [{"id": "a"}, {"id": "b"}]}, "entry.*.id"), ["a", "b"])
        with self.assertRaises(KeyError):
            fill("{p.nope}", NAMES)

    def test_unchanged_everything_covers_the_playback_state(self) -> None:
        whole = START | {
            "playlist_rows": [[], []],
            "receipts": 0,
            "proposals": 0,
            "revisions": 0,
            "files": 12,
        }
        self.assertEqual(check_state({"unchanged": ["everything"]}, whole, dict(whole)), [])
        problems = check_state({"unchanged": ["everything"]}, whole, whole | {"plays": 1})
        self.assertEqual(len(problems), 1)
        self.assertIn("plays changed", problems[0])


class ReportTests(unittest.TestCase):
    def test_the_report_counts_and_lists_each_case(self) -> None:
        results = [
            CaseResult("a01", "Passes", ["x"], "pass"),
            CaseResult("a02", "Fails", ["y"], "fail", ["queue changed"]),
            CaseResult("a03", "Known", ["z"], "expected_failure", ["gap"], "known gap"),
        ]
        self.assertEqual(
            summarize(results),
            {"cases": 3, "pass": 1, "fail": 1, "expected_failure": 1, "unexpected_pass": 0},
        )
        with tempfile.TemporaryDirectory() as folder:
            json_path, md_path = write_report(results, Path(folder))
            self.assertTrue(json_path.is_file())
            table = md_path.read_text(encoding="utf-8")
        self.assertIn("| a02 | fail |", table)
        self.assertIn("Expected failure: known gap", table)
        self.assertEqual(
            markdown(
                {"summary": summarize(results), "git_sha": "", "started": "now"}, results
            ).count("| a0"),
            3,
        )


if __name__ == "__main__":
    unittest.main()
