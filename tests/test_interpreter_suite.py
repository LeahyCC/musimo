"""The 2A interpreter suite in evals/interpreter is labelled data, not code, so these checks keep
the labels honest: every expected filter is one the engine contract accepts, every song a case
names is in the generated library, a follow-up's kept fields really are the previous request's,
and the held-out file still matches its seal. They never read a model or score one."""

import hashlib
import json
import unittest
from pathlib import Path
from typing import TypedDict, cast

from backend.library.engine_contract import Filters
from backend.library.genres import matches_genres

SUITE = Path(__file__).resolve().parent.parent / "evals" / "interpreter"

ACTIONS = {"search", "pause", "resume", "skip", "clarify", "unsupported", "edit"}
SCOPES = {"library", "proposal", "queue"}
FAULTS = {
    "timeout",
    "malformed",
    "schema",
    "truncated",
    "invented_id",
    "offline",
    "truncated_history",
}
OUTCOMES = {"template", "retry", "control"}
RECIPES = {"tempo_energy", "sound"}
COVERS = {
    "entity",
    "ambiguous",
    "genre",
    "duration",
    "song-length",
    "boundary",
    "negation",
    "similar",
    "queue",
    "transport",
    "follow-up",
    "edit",
    "year",
    "history",
    "favourites",
    "count",
    "out-of-scope",
    "mutation-guard",
    "injection",
    "outage",
    "recipes",
}
# Fields whose expected entries may list spellings as "a|b|c", any one of which matches.
SPELLED = {"artists", "exclude_artists", "genres"}


class Edit(TypedDict, total=False):
    kind: str
    count: int
    pinned: list[str]
    ids: list[str]


class Expect(TypedDict, total=False):
    action: str
    scope: str
    filters: dict[str, object]
    keeps: list[str]
    drops: list[str]
    songs: list[str]
    edit: Edit
    outcome: list[str]
    ambiguous: bool
    note: str


class Previous(TypedDict):
    prompt: str
    scope: str
    filters: dict[str, object]
    songs: list[str]


class Case(TypedDict, total=False):
    id: str
    covers: list[str]
    prompt: str
    playing: str
    paused: bool
    queue: list[str]
    recipes: list[str]
    previous: Previous
    fault: str
    expect: Expect


class Split(TypedDict):
    suite: str
    version: int
    split: str
    cases: list[Case]


class Seal(TypedDict):
    file: str
    sha256: str
    cases: int
    sealed: str
    note: str


def read(name: str) -> object:
    with (SUITE / name).open(encoding="utf-8") as handle:
        return cast(object, json.load(handle))


def digest(name: str) -> str:
    """The SHA-256 of the file's parsed content, so a formatter's whitespace cannot break the
    seal while any change to a case or label does."""
    canonical = json.dumps(read(name), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def first_spelling(filters: dict[str, object]) -> dict[str, object]:
    """The filters as one concrete intent, taking the first spelling of each alternative."""
    out = dict(filters)
    for name in SPELLED & out.keys():
        values = out[name]
        assert isinstance(values, list)
        out[name] = [str(value).split("|")[0] for value in values]
    return out


def matches(expected: object, given: object) -> bool:
    """A previous request's value against an expected one, allowing listed spellings."""
    if isinstance(expected, list) and isinstance(given, list):
        if len(expected) != len(given):
            return False
        # Lists compare as sets: each given value uses up one expected entry it spells.
        left = [{part.casefold() for part in str(item).split("|")} for item in expected]
        for value in given:
            hit = next((each for each in left if str(value).casefold() in each), None)
            if hit is None:
                return False
            left.remove(hit)
        return True
    return expected == given


SPLITS: dict[str, Split] = {name: cast(Split, read(f"{name}.json")) for name in ("dev", "heldout")}
SONGS = {
    str(song["key"]): song
    for song in cast(dict[str, list[dict[str, object]]], read("library.json"))["songs"]
}
LIBRARY = set(SONGS)
CASES = [(split, case) for split, data in SPLITS.items() for case in data["cases"]]


class InterpreterSuiteTests(unittest.TestCase):
    def test_the_split_sizes_are_the_ones_signed_off(self) -> None:
        dev = len(SPLITS["dev"]["cases"])
        held = len(SPLITS["heldout"]["cases"])
        # docs/v2-gates.md: about 120 cases, about 70 development and about 50 held out.
        self.assertTrue(110 <= dev + held <= 130, dev + held)
        self.assertTrue(60 <= dev <= 80, dev)
        self.assertTrue(45 <= held <= 60, held)

    def test_ids_are_unique_and_name_their_split(self) -> None:
        seen: set[str] = set()
        for split, case in CASES:
            self.assertNotIn(case["id"], seen)
            seen.add(case["id"])
            self.assertTrue(case["id"].startswith("d" if split == "dev" else "h"), case["id"])

    def test_every_case_uses_only_the_documented_fields(self) -> None:
        for _, case in CASES:
            with self.subTest(case=case.get("id")):
                self.assertLessEqual({"id", "covers", "prompt", "expect"}, case.keys())
                self.assertTrue({"action", "outcome"} & case["expect"].keys())
                self.assertLessEqual(case.keys(), Case.__annotations__.keys())
                self.assertLessEqual(case["expect"].keys(), Expect.__annotations__.keys())
                self.assertTrue(case["prompt"].strip())
                self.assertTrue(case["covers"])
                self.assertLessEqual(set(case["covers"]), COVERS)
                self.assertLessEqual(set(case.get("recipes", [])), RECIPES)
                if "previous" in case:
                    self.assertEqual(case["previous"].keys(), Previous.__annotations__.keys())

    def test_expected_filters_are_ones_the_engine_contract_accepts(self) -> None:
        for _, case in CASES:
            with self.subTest(case=case["id"]):
                Filters.model_validate(first_spelling(case["expect"].get("filters", {})))
                if "previous" in case:
                    Filters.model_validate(case["previous"]["filters"])
                    self.assertIn(case["previous"]["scope"], SCOPES)

    def test_actions_scopes_and_outages_are_consistent(self) -> None:
        for _, case in CASES:
            expect = case["expect"]
            with self.subTest(case=case["id"]):
                if "fault" in case:
                    self.assertIn(case["fault"], FAULTS)
                if "outcome" in expect:
                    # An outage is scored by the reply it ends in, not by an interpretation.
                    self.assertIn("fault", case)
                    self.assertNotIn("action", expect)
                    self.assertLessEqual(set(expect["outcome"]), OUTCOMES)
                    continue
                self.assertIn(expect["action"], ACTIONS)
                self.assertIn(expect.get("scope", "library"), SCOPES)
                # A question is right only where the request is truly ambiguous, and there it is
                # the only right answer.
                self.assertEqual(expect["action"] == "clarify", expect.get("ambiguous", False))
                if expect.get("scope") == "proposal":
                    self.assertIn("previous", case)
                if expect.get("scope") == "queue":
                    self.assertTrue(case.get("queue"))
                if expect["action"] in {"pause", "resume", "skip"}:
                    self.assertIn("playing", case)
                if expect["action"] not in {"search", "edit"}:
                    # A question, a refusal or a transport command carries no search.
                    self.assertFalse(expect.get("filters") or expect.get("songs"))
                if expect["action"] == "edit":
                    self.assertFalse(expect.get("filters"))

    def test_every_genre_label_leads_with_a_spelling_the_engine_matches(self) -> None:
        tags = [(str(song["genre"]),) for song in SONGS.values()]
        for _, case in CASES:
            for genre in case["expect"].get("filters", {}).get("genres", []):  # type: ignore[attr-defined]
                first = str(genre).split("|")[0]
                with self.subTest(case=case["id"], genre=first):
                    self.assertTrue(any(matches_genres((first,), tag) for tag in tags))

    def test_songs_named_anywhere_are_in_the_library(self) -> None:
        for _, case in CASES:
            expect = case["expect"]
            edit = expect.get("edit", Edit())
            named = [
                *([case["playing"]] if "playing" in case else []),
                *case.get("queue", []),
                *expect.get("songs", []),
                *edit.get("pinned", []),
                *edit.get("ids", []),
                *(case["previous"]["songs"] if "previous" in case else []),
            ]
            with self.subTest(case=case["id"]):
                self.assertLessEqual(set(named), LIBRARY)

    def test_edits_name_songs_from_the_open_list(self) -> None:
        for _, case in CASES:
            expect = case["expect"]
            if expect.get("action") != "edit":
                continue
            with self.subTest(case=case["id"]):
                listed = set(case["previous"]["songs"])
                edit = expect["edit"]
                self.assertIn(edit["kind"], {"another", "add", "remove"})
                self.assertLessEqual(set(edit.get("pinned", [])), listed)
                self.assertLessEqual(set(edit.get("ids", [])), listed)
                if edit["kind"] == "add":
                    self.assertGreaterEqual(edit["count"], 1)
                # Pinned songs keep the card's order.
                pinned = edit.get("pinned", [])
                self.assertEqual(
                    pinned, [song for song in case["previous"]["songs"] if song in pinned]
                )

    def test_a_follow_up_keeps_what_the_previous_request_had(self) -> None:
        for _, case in CASES:
            expect = case["expect"]
            if "previous" not in case or expect.get("action") != "search":
                continue
            with self.subTest(case=case["id"]):
                before = case["previous"]["filters"]
                after = expect.get("filters", {})
                # Every earlier filter is kept, changed or withdrawn on purpose, never just lost.
                for name in before:
                    self.assertTrue(name in after or name in expect.get("drops", []), name)
                for name in expect.get("drops", []):
                    self.assertIn(name, before)
                    self.assertNotIn(name, after)
                for name in expect.get("keeps", []):
                    self.assertIn(name, before)
                    self.assertIn(name, after)
                    self.assertTrue(matches(after[name], before[name]), name)

    def test_every_area_is_in_both_splits(self) -> None:
        for split, data in SPLITS.items():
            covered = {tag for case in data["cases"] for tag in case["covers"]}
            with self.subTest(split=split):
                self.assertEqual(covered, COVERS)

    def test_the_held_out_file_matches_its_seal(self) -> None:
        seal = cast(Seal, read("seal.json"))
        self.assertEqual(digest(seal["file"]), seal["sha256"])
        self.assertEqual(len(SPLITS["heldout"]["cases"]), seal["cases"])


if __name__ == "__main__":
    unittest.main()
