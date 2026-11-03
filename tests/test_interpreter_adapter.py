"""Tests for the model-output adapter in `backend.library.interpreter`."""

import json
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.library.engine_contract import (
    Capability,
    Intent,
    registry,
)
from backend.library.interpreter import (
    AddEdit,
    AnotherEdit,
    FilterSet,
    Interpretation,
    NamedSong,
    RemoveEdit,
    Reply,
    TotalLengthModel,
    parse_model_output,
    to_intent,
)


@dataclass
class FakeSong:
    title: str
    artist: str
    song_id: str


CATALOGUE = [
    FakeSong("Night Bus", "Orchard", "tr-0000000000000001"),
    FakeSong("Night Bus", "Harbor Static", "tr-0000000000000002"),
    FakeSong("Rock Bottom", "Ada Vance", "tr-0000000000000003"),
    FakeSong("Tidal", "Kestrel Run", "tr-0000000000000004"),
]


EMPTY_REGISTRY = [
    Capability("search", "action", False, ""),
    Capability("library", "scope", False, ""),
    Capability("pause", "action", False, ""),
    Capability("resume", "action", False, ""),
    Capability("skip", "action", False, ""),
]


def fake_registry(
    scalar: bool = False, energy: bool = False, sound: bool = False
) -> list[Capability]:
    """A registry where scalar and sound are off unless asked."""
    from backend.core.audio_recipes import Recipe

    scalar_recipe: Recipe | None = None
    if scalar:
        scalar_recipe = Recipe("scalar", "scalar", energy=energy)
    embedding_recipe: Recipe | None = None
    if sound:
        embedding_recipe = Recipe("embed", "embedding", dim=3, text_aligned=True)
    return registry(scalar_recipe, embedding_recipe)


class ParseModelOutputTests(unittest.TestCase):
    def test_valid_json_returns_interpretation(self) -> None:
        text = json.dumps(
            {
                "action": "search",
                "scope": "library",
                "filters": {"genres": ["jazz"]},
                "named_songs": [],
                "question": "",
                "reason": "",
            }
        )
        result = parse_model_output(text)
        self.assertIsInstance(result, Interpretation)
        assert isinstance(result, Interpretation)
        self.assertEqual(result.action, "search")
        self.assertEqual(result.filters.genres, ["jazz"])

    def test_json_with_surrounding_text_is_extracted(self) -> None:
        text = 'Sure! Here you go: {"action": "pause"} something else'
        result = parse_model_output(text)
        self.assertIsInstance(result, Interpretation)
        self.assertEqual(result.action, "pause")

    def test_malformed_json_returns_reply(self) -> None:
        result = parse_model_output("not json at all")
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_schema_wrong_json_returns_reply(self) -> None:
        result = parse_model_output('{"action": "dance"}')
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_truncated_json_returns_reply(self) -> None:
        text = '{"action": "search", "scope": "library"'
        result = parse_model_output(text)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_empty_text_returns_reply(self) -> None:
        result = parse_model_output("")
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_invented_id_in_named_songs_is_rejected_by_schema(self) -> None:
        text = json.dumps(
            {
                "action": "search",
                "named_songs": [{"title": "Night Bus", "artist": "Orchard", "id": "s99"}],
            }
        )
        result = parse_model_output(text)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_repair_can_fix_malformed_json(self) -> None:
        def repair(text: str) -> str:
            return '{"action": "search", "scope": "library"}'

        result = parse_model_output("broken", repair=repair)
        self.assertIsInstance(result, Interpretation)
        self.assertEqual(result.action, "search")

    def test_repair_failure_returns_reply(self) -> None:
        def repair(text: str) -> str:
            return "still broken"

        result = parse_model_output("broken", repair=repair)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_repair_that_times_out_still_returns_reply(self) -> None:
        def repair(text: str) -> str:
            raise TimeoutError("the model host did not answer")

        result = parse_model_output("broken", repair=repair)
        self.assertIsInstance(result, Reply)

    def test_brace_inside_a_string_is_not_cut_short(self) -> None:
        text = '{"action": "clarify", "question": "Which one} do you mean?"}'
        result = parse_model_output(text)
        assert isinstance(result, Interpretation)
        self.assertEqual(result.question, "Which one} do you mean?")


class ToIntentTests(unittest.TestCase):
    def test_named_song_becomes_a_preview_in_scope_proposal(self) -> None:
        # The engine rejects proposal_ids outside scope proposal, so "play Rock Bottom"
        # must arrive as a one-song preview.
        interp = Interpretation(
            action="search",
            named_songs=[NamedSong(title="Rock Bottom", artist="Ada Vance")],
        )
        result = to_intent(interp, CATALOGUE, fake_registry())
        assert isinstance(result, Intent)
        self.assertEqual(result.action, "search")
        self.assertEqual(result.scope, "proposal")
        self.assertEqual(result.context.proposal_ids, ["tr-0000000000000003"])

    def test_named_song_to_compare_with_becomes_the_reference(self) -> None:
        interp = Interpretation(
            action="search",
            filters=FilterSet(similar_to_current=True),
            named_songs=[NamedSong(title="Night Bus", artist="Orchard")],
        )
        result = to_intent(interp, CATALOGUE, fake_registry())
        assert isinstance(result, Intent)
        self.assertEqual(result.scope, "library")
        self.assertEqual(result.context.reference_id, "tr-0000000000000001")
        self.assertEqual(result.context.proposal_ids, [])

    def test_two_songs_to_compare_with_asks_which(self) -> None:
        interp = Interpretation(
            action="search",
            filters=FilterSet(similar_to_current=True),
            named_songs=[
                NamedSong(title="Night Bus", artist="Orchard"),
                NamedSong(title="Tidal", artist="Kestrel Run"),
            ],
        )
        result = to_intent(interp, CATALOGUE, fake_registry())
        assert isinstance(result, Reply)
        self.assertEqual(result.action, "clarify")

    def test_named_song_inside_a_refinement_is_refused(self) -> None:
        interp = Interpretation(
            action="search",
            scope="queue",
            named_songs=[NamedSong(title="Tidal", artist="Kestrel Run")],
        )
        result = to_intent(interp, CATALOGUE, fake_registry())
        assert isinstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_unknown_song_returns_clarify(self) -> None:
        interp = Interpretation(
            action="search",
            named_songs=[NamedSong(title="Missing Track", artist="No One")],
        )
        reg = fake_registry()
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "clarify")
        self.assertIn("Missing Track", result.explanation)

    def test_ambiguous_title_returns_clarify(self) -> None:
        interp = Interpretation(
            action="search",
            named_songs=[NamedSong(title="Night Bus")],
        )
        reg = fake_registry()
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "clarify")
        self.assertIn("Which version", result.explanation)

    def test_unsupported_filter_returns_reply(self) -> None:
        interp = Interpretation(
            action="search",
            filters=FilterSet(energy="high"),
        )
        reg = fake_registry(scalar=False)
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")
        self.assertIn("energy", result.explanation)

    def test_supported_scalar_filter_becomes_intent(self) -> None:
        interp = Interpretation(
            action="search",
            filters=FilterSet(tempo="fast"),
        )
        reg = fake_registry(scalar=True)
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Intent)
        assert isinstance(result, Intent)
        self.assertEqual(result.filters.tempo, "fast")

    def test_unsupported_total_length_without_capability(self) -> None:
        interp = Interpretation(
            action="search",
            filters=FilterSet(total_length=TotalLengthModel(mode="about", seconds=3600)),
        )
        reg = [
            Capability("search", "action", True, ""),
            Capability("library", "scope", True, ""),
        ]
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")

    def test_transport_action_needs_no_catalogue(self) -> None:
        interp = Interpretation(action="pause")
        reg = fake_registry()
        result = to_intent(interp, [], reg)
        self.assertIsInstance(result, Intent)
        assert isinstance(result, Intent)
        self.assertEqual(result.action, "pause")

    def test_clarify_returns_clarify_reply(self) -> None:
        interp = Interpretation(action="clarify", question="Which one?")
        reg = fake_registry()
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "clarify")
        self.assertEqual(result.explanation, "Which one?")

    def test_unsupported_action_returns_reply(self) -> None:
        interp = Interpretation(action="unsupported", reason="Can't do that.")
        reg = fake_registry()
        result = to_intent(interp, CATALOGUE, reg)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")
        self.assertEqual(result.explanation, "Can't do that.")

    def test_search_unavailable_returns_reply(self) -> None:
        interp = Interpretation(action="search", filters=FilterSet(artists=["Orchard"]))
        result = to_intent(interp, CATALOGUE, EMPTY_REGISTRY)
        self.assertIsInstance(result, Reply)
        self.assertEqual(result.action, "unsupported")


class DevCasesInterpretationTests(unittest.TestCase):
    def test_every_expected_meaning_builds_an_interpretation(self) -> None:
        suite = Path(__file__).resolve().parent.parent / "evals" / "interpreter"
        with (suite / "dev.json").open(encoding="utf-8") as handle:
            data = json.load(handle)
        with (suite / "library.json").open(encoding="utf-8") as handle:
            library = json.load(handle)

        songs = {song["key"]: song for song in library["songs"]}

        for case in data["cases"]:
            with self.subTest(case=case["id"]):
                expect = case["expect"]
                if "action" not in expect:
                    continue
                interp = _interpretation_from_expect(expect, songs)
                self.assertIsInstance(interp, Interpretation)
                self.assertEqual(interp.action, expect["action"])


def _interpretation_from_expect(
    expect: dict[str, Any], songs: dict[str, dict[str, Any]]
) -> Interpretation:
    """Build an adapter interpretation from a dev case's expected meaning."""
    raw_filters = expect.get("filters", {})
    filters: dict[str, Any] = dict(raw_filters)
    if "total_length" in filters:
        tl = filters["total_length"]
        filters["total_length"] = TotalLengthModel(mode=tl["mode"], seconds=tl["seconds"])

    named: list[NamedSong] = []
    for key in expect.get("songs", []):
        song = songs[key]
        named.append(NamedSong(title=song["title"], artist=song["artist"]))

    edit: Any = None
    if "edit" in expect:
        edit_raw = expect["edit"]
        kind = edit_raw["kind"]
        if kind == "another":
            pinned = [
                NamedSong(title=songs[k]["title"], artist=songs[k]["artist"])
                for k in edit_raw.get("pinned", [])
            ]
            edit = AnotherEdit(kind="another", pinned=pinned)
        elif kind == "add":
            edit = AddEdit(kind="add", count=edit_raw["count"])
        elif kind == "remove":
            removed = [
                NamedSong(title=songs[k]["title"], artist=songs[k]["artist"])
                for k in edit_raw["ids"]
            ]
            edit = RemoveEdit(kind="remove", songs=removed)

    return Interpretation(
        action=expect["action"],
        scope=expect.get("scope", "library"),
        filters=FilterSet(**filters),
        named_songs=named,
        edit=edit,
        question=expect.get("note", "") if expect.get("action") == "clarify" else "",
        reason=expect.get("note", "") if expect.get("action") == "unsupported" else "",
    )


if __name__ == "__main__":
    unittest.main()
