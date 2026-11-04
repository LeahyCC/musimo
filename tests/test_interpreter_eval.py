"""The interpreter eval runner's scorer, on a small fixture with known right and wrong answers.

The fixture is not the real held-out set. It exists so the scoring rules can be checked without a
model, a network or the sealed file.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.core.listener import CHOOSE, HEADER
from backend.library.engine_contract import Filters
from backend.main import create_app
from scripts.interpreter_eval import (
    CaseScore,
    SealError,
    _outcome,
    load_split,
    note_engine_ids,
    score_case,
    summarize,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "interpreter_eval"
IDS = {"s01": "tr-0000000000000001", "s02": "tr-0000000000000002"}


def filters(**values: object) -> dict[str, object]:
    return Filters.model_validate(values).model_dump()


def search(filters_value: dict[str, object], **context: object) -> dict[str, object]:
    return {
        "action": "search",
        "scope": "library",
        "ids": [IDS["s01"]],
        "intent": {
            "action": "search",
            "scope": "library",
            "filters": filters_value,
            "context": context,
        },
        "summary": "",
    }


def cases() -> dict[str, dict[str, object]]:
    data = json.loads((FIXTURE / "heldout.json").read_text(encoding="utf-8"))
    return {str(case["id"]): case for case in data["cases"]}


class ScorerTests(unittest.TestCase):
    def test_a_correct_search_passes(self) -> None:
        case = cases()["h001"]
        score = score_case(case, search(filters(genres=["Jazz"])), IDS)
        self.assertTrue(score.action_ok)
        self.assertTrue(score.scope_ok)
        self.assertTrue(score.filters_ok)
        self.assertEqual(score.failures, [])

    def test_a_dropped_constraint_fails(self) -> None:
        case = cases()["h002"]
        result = search(filters(genres=["jazz"]))
        score = score_case(case, result, IDS, previous_ids=[IDS["s01"]])
        self.assertFalse(score.filters_ok)
        self.assertFalse(score.keeps_ok)
        self.assertIn("keeps:year_from", score.failures)
        self.assertIn("keeps:year_to", score.failures)

    def test_an_added_constraint_fails(self) -> None:
        case = cases()["h001"]
        result = search(filters(genres=["jazz"], year_from=1990))
        score = score_case(case, result, IDS)
        self.assertFalse(score.filters_ok)
        self.assertIn("filter:year_from", score.failures)

    def test_an_invented_id_fails_the_gate(self) -> None:
        case = cases()["h001"]
        result = search(filters(genres=["jazz"]), proposal_ids=["tr-ffffffffffffffff"])
        score = score_case(case, result, IDS)
        self.assertTrue(score.invented_id)
        self.assertIn("invented_id", score.failures)

    def test_a_follow_up_that_loses_a_filter_fails(self) -> None:
        case = cases()["h002"]
        result = search(filters(year_from=1990, year_to=1999))
        score = score_case(case, result, IDS, previous_ids=[IDS["s01"]])
        self.assertFalse(score.filters_ok)
        self.assertFalse(score.keeps_ok)
        self.assertIn("keeps:genres", score.failures)

    def test_an_outage_reply_is_scored_by_its_outcome(self) -> None:
        case = cases()["h004"]
        reply: dict[str, object] = {
            "action": "unsupported",
            "summary": "The model timed out. Retry.",
        }
        score = score_case(case, reply, IDS)
        self.assertTrue(score.outage_ok)
        failed = score_case(case, {}, IDS, error="BotError: offline")
        self.assertFalse(failed.outage_ok)
        self.assertIn("outage", failed.failures)

    def test_an_edit_scores_the_applied_revision(self) -> None:
        case = cases()["h003"]
        result: dict[str, object] = {
            "action": "search",
            "scope": "library",
            "ids": [IDS["s01"], IDS["s02"]],
            "stored": {
                "proposal": {
                    "intent": {
                        "action": "search",
                        "scope": "library",
                        "filters": filters(genres=["jazz"]),
                        "context": {
                            "keep_ids": [IDS["s01"]],
                            "pinned_ids": [IDS["s01"]],
                        },
                        "ids": [IDS["s01"], IDS["s02"]],
                    }
                }
            },
        }
        score = score_case(case, result, IDS, previous_ids=[IDS["s01"], IDS["s02"]])
        self.assertTrue(score.edit_ok)
        self.assertTrue(score.action_ok)

    def test_an_edit_that_does_not_pin_fails(self) -> None:
        case = cases()["h003"]
        result: dict[str, object] = {
            "action": "search",
            "scope": "library",
            "ids": [IDS["s01"], IDS["s02"]],
            "stored": {
                "proposal": {
                    "intent": {
                        "action": "search",
                        "scope": "library",
                        "filters": filters(genres=["jazz"]),
                        "context": {"keep_ids": [], "pinned_ids": []},
                        "ids": [IDS["s01"], IDS["s02"]],
                    }
                }
            },
        }
        score = score_case(case, result, IDS, previous_ids=[IDS["s01"], IDS["s02"]])
        self.assertFalse(score.edit_ok)
        self.assertIn("edit", score.failures)

    def test_a_remove_edit_scores_the_songs_it_dropped(self) -> None:
        case = cases()["h007"]
        result: dict[str, object] = {
            "action": "search",
            "scope": "library",
            "ids": [IDS["s01"]],
            "stored": {
                "proposal": {
                    "intent": {
                        "action": "search",
                        "scope": "library",
                        "filters": filters(genres=["jazz"], exclude_ids=[IDS["s02"]]),
                        "context": {"keep_ids": [IDS["s01"]], "add_count": 0},
                        "ids": [IDS["s01"]],
                    }
                }
            },
        }
        score = score_case(case, result, IDS, previous_ids=[IDS["s01"], IDS["s02"]])
        self.assertTrue(score.edit_ok)
        self.assertTrue(score.action_ok)

    def test_a_question_on_a_clear_case_is_counted(self) -> None:
        case = cases()["h001"]
        score = score_case(case, {"action": "clarify", "summary": "Which one?"}, IDS)
        self.assertTrue(score.clear_question)
        self.assertFalse(score.action_ok)

    def test_a_question_on_an_ambiguous_case_is_right(self) -> None:
        case = cases()["h005"]
        score = score_case(case, {"action": "clarify", "summary": "Which one?"}, IDS)
        self.assertTrue(score.ambiguous_ok)
        self.assertTrue(score.action_ok)

    def test_a_usable_reply_is_template_or_retry(self) -> None:
        self.assertEqual(_outcome({"action": "pause"}, None), "control")
        self.assertEqual(
            _outcome({"action": "unsupported", "summary": "Please try again."}, None), "retry"
        )
        self.assertEqual(
            _outcome({"action": "unsupported", "summary": "That failed."}, None), "template"
        )
        self.assertIsNone(_outcome({}, "BotError: offline"))


class SummaryTests(unittest.TestCase):
    def test_interpreter_milliseconds_become_seconds(self) -> None:
        report: dict[str, object] = {
            "rows": [
                {
                    "case": "d001",
                    "stable": True,
                    "runs": [
                        {"interpreter_ms": 30000.0, "engine_ms": 10.0},
                        {"interpreter_ms": 2000.0, "engine_ms": 10.0},
                        {"interpreter_ms": 4000.0, "engine_ms": 10.0},
                    ],
                    "score": {
                        "action_ok": True,
                        "scope_ok": True,
                        "filters_ok": True,
                        "mutation_ok": True,
                        "no_songs": False,
                    },
                }
            ],
            "vram": {"available": False},
        }
        summary = summarize(report)
        timing = summary["timing"]
        assert isinstance(timing, dict)
        self.assertEqual(timing["cold"], 30.0)
        self.assertEqual(timing["interpreter_p50"], 3.0)
        passes = summary["passes"]
        assert isinstance(passes, dict)
        self.assertFalse(passes["warm_p50"])

    def test_a_wrong_scope_is_not_an_action_pass(self) -> None:
        report: dict[str, object] = {
            "rows": [
                {
                    "case": "d002",
                    "stable": True,
                    "runs": [],
                    "score": {
                        "action_ok": True,
                        "scope_ok": False,
                        "filters_ok": True,
                        "mutation_ok": True,
                        "no_songs": False,
                    },
                }
            ],
            "vram": {"available": False},
        }
        summary = summarize(report)
        counts = summary["counts"]
        assert isinstance(counts, dict)
        self.assertEqual(counts["action_scope"], [0, 1])

    def test_a_missing_clock_does_not_pass(self) -> None:
        summary = summarize({"rows": [], "vram": {"available": False}})
        passes = summary["passes"]
        assert isinstance(passes, dict)
        self.assertIsNone(passes["warm_p50"])
        self.assertIsNone(passes["cold"])

    def test_a_question_on_a_filtered_search_is_not_a_hard_fail(self) -> None:
        case = {
            "id": "d001",
            "expect": {"action": "search", "filters": {"artists": ["Harbor Static"]}},
        }
        score = score_case(
            case,
            {"action": "clarify", "scope": "library", "summary": "Which one?"},
            IDS,
        )
        summary = summarize(
            {
                "rows": [
                    {
                        "case": "d001",
                        "stable": True,
                        "runs": [],
                        "score": score.as_dict(),
                    }
                ],
                "vram": {"available": False},
            }
        )
        self.assertEqual(summary["hard_gate_failures"], [])
        counts = summary["counts"]
        assert isinstance(counts, dict)
        self.assertEqual(counts["action_scope"], [0, 1])
        self.assertEqual(counts["clear_question"], [1, 1])

    def test_a_dropped_filter_on_the_right_action_is_a_hard_fail(self) -> None:
        case = {
            "id": "d001",
            "expect": {"action": "search", "filters": {"artists": ["Harbor Static"]}},
        }
        score = score_case(
            case,
            {
                "action": "search",
                "scope": "library",
                "intent": {"action": "search", "scope": "library", "filters": {}},
            },
            IDS,
        )
        summary = summarize(
            {
                "rows": [
                    {
                        "case": "d001",
                        "stable": True,
                        "runs": [],
                        "score": score.as_dict(),
                    }
                ],
                "vram": {"available": False},
            }
        )
        self.assertEqual(summary["hard_gate_failures"], ["d001: constraint"])
        counts = summary["counts"]
        assert isinstance(counts, dict)
        self.assertEqual(counts["action_scope"], [1, 1])

    def test_an_id_that_reached_the_engine_fails_even_when_the_reply_dropped_it(self) -> None:
        score = CaseScore("h001")
        note_engine_ids(
            score,
            [{"context": {"proposal_ids": ["tr-ffffffffffffffff"]}}],
            {"tr-0000000000000001"},
        )
        self.assertTrue(score.invented_id)
        self.assertIn("invented_id", score.failures)


class SealTests(unittest.TestCase):
    def test_the_fixture_seal_matches(self) -> None:
        data = load_split("heldout", FIXTURE)
        self.assertEqual(len(data["cases"]), 7)  # type: ignore[arg-type]

    def test_a_changed_held_out_file_stops_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            copied = Path(folder)
            for name in ("heldout.json", "seal.json"):
                shutil.copy(FIXTURE / name, copied / name)
            data = json.loads((copied / "heldout.json").read_text(encoding="utf-8"))
            data["cases"][0]["expect"]["filters"]["genres"] = ["rock"]
            (copied / "heldout.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(SealError):
                load_split("heldout", copied)


class ChatHeaderTests(unittest.TestCase):
    def test_the_chat_route_needs_a_known_listener_header(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(Path(folder))) as client:
                made = client.post("/api/listeners", json={"name": "Fixture"})
                self.assertEqual(made.status_code, 200)
                listener_id = str(made.json()["id"])
                missing = client.post("/api/music-bot/chat", json={"prompt": "fixture"})
                self.assertEqual(missing.status_code, 401)
                self.assertEqual(missing.json()["detail"], CHOOSE)
                known = client.post(
                    "/api/music-bot/chat",
                    json={"prompt": "fixture"},
                    headers={HEADER: listener_id},
                )
                self.assertNotEqual(known.status_code, 401)


if __name__ == "__main__":
    unittest.main()
