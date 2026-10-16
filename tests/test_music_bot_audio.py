"""The bot's audio gates: refused while the recipes are off, hard gates once one is on."""

import asyncio
import json
import struct
import tempfile
import time
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from pydantic import ValidationError
from test_music_bot import plan, result_ids
from test_player import tag, write_wav

from backend.core.audio_recipes import RECIPES, SCALAR_RECIPE, Recipe, TextEncoder, registered
from backend.core.models import Settings, SettingsPatch
from backend.core.store import Store
from backend.library.audio_profile import Profile, ProfileSet, percentile_bands
from backend.library.index import Library
from backend.library.music_bot import (
    AudioGates,
    BotError,
    BotRequest,
    MusicBot,
    SearchPlan,
    ValidateSelection,
    negation_only,
    system_prompt,
    widen_single_bpm,
)
from backend.library.player import Player
from backend.library.selection import broad_order

SCALAR = RECIPES[SCALAR_RECIPE]
EMBED = Recipe("embed-test", "embedding", dim=3, text_aligned=True)
PLAIN = Recipe("embed-plain", "embedding", dim=3, text_aligned=False)
# Title, artist, tempo, energy and the embed-test vector. Isle is never measured.
SONGS: list[tuple[str, str, float, float, tuple[float, float, float]]] = [
    ("Anchor", "Harbor", 160.0, 0.020, (0.95, 0.05, 0.0)),
    ("Breaker", "Harbor", 150.0, 0.090, (0.9, 0.1, 0.0)),
    ("Current", "Harbor", 100.0, 0.050, (0.85, 0.15, 0.0)),
    ("Drift", "Harbor", 80.0, 0.030, (0.8, 0.2, 0.0)),
    ("Ember", "Orchard", 145.0, 0.010, (0.0, 1.0, 0.0)),
    ("Fathom", "Orchard", 142.0, 0.012, (0.0, 0.9, 0.1)),
    ("Gale", "Meadow", 95.0, 0.040, (1.0, 0.0, 0.0)),
    ("Harbour", "Meadow", 70.0, 0.070, (0.0, 0.0, 1.0)),
]


def encode(phrase: str) -> list[float]:
    """The test encoder: a dreamy phrase points where Harbour's vector points."""
    return [0.0, 0.0, 1.0] if "dreamy" in phrase else [1.0, 0.0, 0.0]


class AudioBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "state.sqlite3")
        self.store.update({"ollama_model": "fixture"})
        self.player = Player(self.store, [self.music])
        self.library = Library(self.store, [self.music], asyncio.Event())
        for index, (title, artist, *_) in enumerate([*SONGS, ("Isle", "Quarry", 0.0, 0.0, ())]):
            path = self.music / f"{index}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album="Fixture", year=2001, genres=["Rock"])
        self.library.scan()
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200, play_count=1")
            self.store.db.commit()
        self.store.bump_library_revision()
        self.ids = {str(t["title"]): str(t["id"]) for t in self.player.view().tracks}
        self.chat_bodies: list[dict[str, object]] = []

        async def transport(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "fixture"}]})
            if request.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion"]})
            self.chat_bodies.append(json.loads(request.content))
            return httpx.Response(
                200, json={"done": True, "message": {"content": json.dumps(plan().model_dump())}}
            )

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def measure(self, recipe: str = SCALAR_RECIPE, titles: tuple[str, ...] | None = None) -> None:
        """Write done rows straight into the table, measured from the files as they are."""
        stored = self.player.view().stored
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            for title, _, bpm, energy, vector in SONGS:
                if titles is not None and title not in titles:
                    continue
                song = stored[self.ids[title]]
                if recipe == SCALAR_RECIPE:
                    values: tuple[object, ...] = (bpm, energy, 0, None)
                else:
                    values = (None, None, 3, struct.pack("<3f", *vector))
                self.store.db.execute(
                    "INSERT OR REPLACE INTO audio_profile VALUES (?,?,'done',?,?,?,?,?,?,'','t')",
                    (song.song_id, recipe, song.size, song.mtime_ns, *values),
                )
            self.store.db.commit()
        self.bot.profiles.generation += 1

    @contextmanager
    def embedding_on(self, recipe: Recipe, encoder: TextEncoder | None = None) -> Iterator[None]:
        """Register a test recipe and switch it on, switching it off before it goes away."""
        with registered(recipe, encoder):
            self.store.update({"audio_embedding_recipe": recipe.id})
            try:
                yield
            finally:
                self.store.update({"audio_embedding_recipe": ""})

    def resolve(
        self,
        query: SearchPlan,
        reference_id: str | None = None,
        current_id: str | None = None,
        generation_seed: int | None = None,
    ) -> dict[str, object]:
        request = BotRequest(
            prompt="fixture",
            reference_id=reference_id,
            current_id=current_id,
            generation_seed=generation_seed,
        )
        return self.bot.resolve(query, request)

    def titles(self, result: dict[str, object]) -> list[str]:
        names = {sid: title for title, sid in self.ids.items()}
        return [names[sid] for sid in result_ids(result)]

    def test_with_both_settings_empty_audio_fields_are_refused_and_similarity_stays_tags(
        self,
    ) -> None:
        self.measure()
        filled_cases: list[dict[str, object]] = [
            {"energy": "low"},
            {"tempo": "fast"},
            {"tempo_min": 100},
            {"energy_compared": "calmer"},
            {"sound": "dreamy guitar"},
        ]
        for filled in filled_cases:
            with self.subTest(filled=filled):
                refused = self.resolve(plan(**filled))
                query = SearchPlan.model_validate(refused["plan"])
                self.assertEqual(query.action, "unsupported")
                self.assertIn("not enabled", query.explanation)
                self.assertEqual(refused["tracks"], [])
                self.assertFalse(query.uses_scalar())
                self.assertEqual(query.sound, "")
        # "More like this" copies the reference song's genres and says so.
        result = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Gale"])
        self.assertEqual(SearchPlan.model_validate(result["plan"]).genres, ["Rock"])
        self.assertIn("Similarity uses artist or genre tags", str(result["summary"]))
        self.assertNotIn("Gale", self.titles(result))

    def test_tempo_and_energy_are_hard_gates_with_the_shortfall_kept(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.measure()
        fast = self.resolve(plan(tempo="fast"))
        self.assertEqual(set(self.titles(fast)), {"Anchor", "Breaker", "Ember", "Fathom"})
        self.assertIn(
            f"Tempo and energy from {SCALAR_RECIPE}: 8 of 9 songs are measured; "
            "1 match was skipped without a measurement.",
            str(fast["summary"]),
        )
        both = self.resolve(plan(tempo="fast", energy="low", target_seconds=3600))
        self.assertEqual(set(self.titles(both)), {"Ember", "Fathom"})
        query = SearchPlan.model_validate(both["plan"])
        self.assertEqual((query.tempo, query.energy), ("fast", "low"))
        self.assertEqual(both["shortfall_seconds"], 3200)
        self.assertIn("no exclusions were relaxed", str(both["summary"]))
        self.assertEqual(
            set(self.titles(self.resolve(plan(energy="high")))),
            {"Gale", "Current", "Harbour", "Breaker"},
        )
        self.assertEqual(set(self.titles(self.resolve(plan(energy="medium")))), {"Anchor", "Drift"})
        # Bounds are inclusive, and a single named BPM is a window ten either side.
        self.assertEqual(
            set(self.titles(self.resolve(plan(tempo_min=142, tempo_max=150)))),
            {"Breaker", "Ember", "Fathom"},
        )
        window = self.resolve(plan(tempo_min=90, tempo_max=90))
        self.assertEqual(set(self.titles(window)), {"Drift", "Gale", "Current"})
        query = SearchPlan.model_validate(window["plan"])
        self.assertEqual((query.tempo_min, query.tempo_max), (80, 100))
        # A band and a bound both apply.
        self.assertEqual(
            set(self.titles(self.resolve(plan(tempo="fast", tempo_max=150)))),
            {"Breaker", "Ember", "Fathom"},
        )
        # Inside the gate nothing is ranked, neither "faster" nor listening: one seed draws the
        # same songs whatever the play counts say.
        before = self.titles(self.resolve(plan(tempo="fast")))
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET play_count=9 WHERE song_id=?", (self.ids["Fathom"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        self.assertEqual(self.titles(self.resolve(plan(tempo="fast"))), before)

    def test_compared_gates_use_the_reference_songs_own_measurement(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.measure()
        calmer = self.resolve(plan(energy_compared="calmer"), reference_id=self.ids["Fathom"])
        self.assertEqual(self.titles(calmer), ["Ember"])
        # Fathom is in the low band and still louder than Ember, so it is out.
        self.assertEqual(
            self.titles(self.resolve(plan(energy_compared="calmer"), current_id=self.ids["Ember"])),
            [],
        )
        intense = self.resolve(
            plan(energy_compared="more_intense"), reference_id=self.ids["Harbour"]
        )
        self.assertEqual(self.titles(intense), ["Breaker"])
        slower = self.resolve(plan(tempo_compared="slower"), reference_id=self.ids["Current"])
        self.assertEqual(set(self.titles(slower)), {"Drift", "Gale", "Harbour"})
        faster = self.resolve(plan(tempo_compared="faster"), reference_id=self.ids["Breaker"])
        self.assertEqual(self.titles(faster), ["Anchor"])
        with self.assertRaises(BotError):
            self.resolve(plan(energy_compared="calmer"))
        # An unmeasured reference is an honest miss, not a widened search.
        miss = self.resolve(plan(energy_compared="calmer"), reference_id=self.ids["Isle"])
        self.assertEqual(miss["tracks"], [])
        self.assertIn("no tempo-energy-v1 measurement yet", str(miss["summary"]))

    def test_stale_rows_satisfy_no_gate_and_validate_answers_409(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.measure()
        selection = ValidateSelection(ids=[self.ids["Anchor"]], plan=plan(tempo="fast"))
        self.bot.validate(selection)
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET size=size+1 WHERE song_id=?", (self.ids["Anchor"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        self.assertNotIn("Anchor", self.titles(self.resolve(plan(tempo="fast"))))
        with self.assertRaises(BotError) as refused:
            self.bot.validate(selection)
        self.assertEqual(refused.exception.status, 409)
        # A compared gate needs its reference at Play time too.
        compared = plan(energy_compared="calmer")
        self.bot.validate(
            ValidateSelection(
                ids=[self.ids["Ember"]], plan=compared, reference_id=self.ids["Fathom"]
            )
        )
        with self.assertRaises(BotError) as refused:
            self.bot.validate(ValidateSelection(ids=[self.ids["Ember"]], plan=compared))
        self.assertEqual(refused.exception.status, 409)
        # A plan built on analysis that was turned off since is stale as well.
        self.store.update({"audio_scalar_recipe": ""})
        with self.assertRaises(BotError) as refused:
            self.bot.validate(ValidateSelection(ids=[self.ids["Ember"]], plan=plan(tempo="fast")))
        self.assertEqual(refused.exception.status, 409)

    def test_an_embedding_recipe_ranks_more_like_this_by_cosine(self) -> None:
        with self.embedding_on(EMBED, encode):
            self.measure(EMBED.id)
            result = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Gale"])
            titles = self.titles(result)
            query = SearchPlan.model_validate(result["plan"])
            # The reference song's tags are not copied; the seed is absent; Harbor fills two.
            self.assertEqual(query.genres, [])
            self.assertNotIn("Gale", titles)
            self.assertEqual(titles[:2], ["Anchor", "Breaker"])
            self.assertNotIn("Current", titles)
            self.assertNotIn("Drift", titles)
            self.assertEqual(set(titles[2:]), {"Ember", "Fathom", "Harbour"})
            self.assertIn(
                f"Similarity uses the {EMBED.id} sound profile: 8 of 9 songs are measured; "
                "1 match was skipped without a measurement.",
                str(result["summary"]),
            )
            # Asked for three of seven, it draws among the closest only: Anchor, Breaker and
            # Current (Drift, at 0.9701, is further below the third than the third is below the
            # first). Harbor still fills two places, and the closest are shown first.
            pairs, thirds = set(), set()
            for seed in range(30):
                drawn = self.resolve(
                    plan(similar_to_current=True, limit=3),
                    reference_id=self.ids["Gale"],
                    generation_seed=seed,
                )
                titles = self.titles(drawn)
                self.assertEqual(len(titles), 3)
                self.assertTrue(set(titles[:2]) <= {"Anchor", "Breaker", "Current"})
                self.assertIn(titles[2], {"Ember", "Fathom", "Harbour"})
                self.assertNotIn("Drift", titles)
                pairs.add(tuple(titles[:2]))
                thirds.add(titles[2])
                self.assertIn("Picked from the closest of 7 matches.", str(drawn["summary"]))
            self.assertGreaterEqual(len(pairs), 2)
            self.assertGreaterEqual(len(thirds), 2)
            # A named artist is uncapped.
            named = self.resolve(
                plan(similar_to_current=True, artists=["Harbor"]), reference_id=self.ids["Gale"]
            )
            self.assertEqual(self.titles(named), ["Anchor", "Breaker", "Current", "Drift"])
            # The user's own filters still apply.
            jazz = self.resolve(
                plan(similar_to_current=True, genres=["jazz"]), reference_id=self.ids["Gale"]
            )
            self.assertEqual(jazz["tracks"], [])
            # A second copy of the same title and artist is absent.
            with self.store.lock:
                self.store.db.execute(
                    "UPDATE library_files SET title='Anchor' WHERE song_id=?",
                    (self.ids["Breaker"],),
                )
                self.store.db.commit()
            self.store.bump_library_revision()
            again = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Gale"])
            self.assertEqual(self.titles(again)[:2], ["Anchor", "Current"])
            self.assertNotIn("Breaker", self.titles(again))
            # A reference with no fresh vector is an honest miss.
            miss = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Isle"])
            self.assertEqual(miss["tracks"], [])
            self.assertIn("no embed-test sound profile yet", str(miss["summary"]))

    def test_a_sound_phrase_ranks_by_cosine_unless_it_only_negates(self) -> None:
        with self.embedding_on(EMBED, encode):
            self.measure(EMBED.id)
            dreamy = self.resolve(plan(sound="dreamy guitar"))
            self.assertEqual(self.titles(dreamy)[0], "Harbour")
            self.assertEqual(SearchPlan.model_validate(dreamy["plan"]).sound, "dreamy guitar")
            self.assertIn("Similarity uses the embed-test sound profile", str(dreamy["summary"]))
            # Negation alone adds no rank: the plan loses the phrase and the plain draw stands,
            # whatever the play counts say.
            plain = self.titles(self.resolve(plan()))
            with self.store.lock:
                self.store.db.execute(
                    "UPDATE library_files SET play_count=9 WHERE song_id=?", (self.ids["Isle"],)
                )
                self.store.db.commit()
            self.store.bump_library_revision()
            negated = self.resolve(plan(sound="No vocals."))
            self.assertEqual(SearchPlan.model_validate(negated["plan"]).sound, "")
            self.assertEqual(self.titles(negated), plain)
            self.assertNotIn("Similarity", str(negated["summary"]))
            # Genre words are not a sound, and more like this keeps one rank key.
            together = self.resolve(
                plan(similar_to_current=True, sound="dreamy"), reference_id=self.ids["Gale"]
            )
            self.assertEqual(SearchPlan.model_validate(together["plan"]).sound, "")
            self.assertEqual(self.titles(together)[0], "Anchor")
        with self.embedding_on(PLAIN):
            self.measure(PLAIN.id)
            refused = self.resolve(plan(sound="dreamy guitar"))
            query = SearchPlan.model_validate(refused["plan"])
            self.assertEqual(query.action, "unsupported")
            self.assertIn("cannot read a description", query.explanation)
            # Similarity itself still works without text alignment.
            alike = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Gale"])
            self.assertEqual(self.titles(alike)[:2], ["Anchor", "Breaker"])

    def test_the_reply_carries_the_songs_it_was_measured_against(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.measure()
        calmer = self.resolve(plan(energy_compared="calmer"), reference_id=self.ids["Fathom"])
        self.assertEqual(calmer["reference_id"], self.ids["Fathom"])
        self.assertIsNone(calmer["current_id"])
        current = self.resolve(plan(tempo_compared="faster"), current_id=self.ids["Breaker"])
        self.assertEqual(current["current_id"], self.ids["Breaker"])
        refused = self.resolve(plan(action="unsupported", explanation="No."))
        self.assertIn("reference_id", refused)

    def test_a_stale_seed_is_an_honest_miss_and_validate_refuses_it(self) -> None:
        with self.embedding_on(EMBED, encode):
            self.measure(EMBED.id)
            alike = plan(similar_to_current=True)
            self.assertEqual(
                self.titles(self.resolve(alike, reference_id=self.ids["Gale"]))[:2],
                ["Anchor", "Breaker"],
            )
            selection = ValidateSelection(
                ids=[self.ids["Anchor"]], plan=alike, reference_id=self.ids["Gale"]
            )
            self.bot.validate(selection)
            with self.store.lock:
                self.store.db.execute(
                    "UPDATE library_files SET size=size+1 WHERE song_id=?", (self.ids["Gale"],)
                )
                self.store.db.commit()
            self.store.bump_library_revision()
            miss = self.resolve(alike, reference_id=self.ids["Gale"])
            self.assertEqual(miss["tracks"], [])
            self.assertIn("no embed-test sound profile yet", str(miss["summary"]))
            with self.assertRaises(BotError) as refused:
                self.bot.validate(selection)
            self.assertEqual(refused.exception.status, 409)

    def test_audio_fields_are_cleared_on_a_question_while_the_recipes_are_off(self) -> None:
        asked = self.resolve(
            plan(action="clarify", explanation="Which decade?", tempo="fast", sound="dreamy")
        )
        query = SearchPlan.model_validate(asked["plan"])
        self.assertEqual((query.action, query.tempo, query.sound), ("clarify", "", ""))
        # Carried into the next search through merge_plan, the field is gone, so a tag
        # search is not refused for a tempo nobody asked for.
        result = self.bot.resolve(plan(), BotRequest(prompt="fixture", previous=query))
        self.assertEqual(SearchPlan.model_validate(result["plan"]).action, "search")
        self.assertTrue(result["tracks"])

    def test_a_single_bpm_widens_inside_the_field_bounds(self) -> None:
        widened = widen_single_bpm(plan(tempo_min=995, tempo_max=995))
        self.assertEqual((widened.tempo_min, widened.tempo_max), (985, 999))
        SearchPlan.model_validate(widened.model_dump())
        low = widen_single_bpm(plan(tempo_min=4, tempo_max=4))
        self.assertEqual((low.tempo_min, low.tempo_max), (1, 14))
        unchanged = widen_single_bpm(plan(tempo_min=100, tempo_max=120))
        self.assertEqual((unchanged.tempo_min, unchanged.tempo_max), (100, 120))

    def test_each_recipe_counts_its_own_unmeasured_matches(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.measure()
        with self.embedding_on(EMBED, encode):
            self.measure(EMBED.id, titles=tuple(t for t, *_ in SONGS if t != "Harbour"))
            result = self.resolve(
                plan(similar_to_current=True, tempo="fast"), reference_id=self.ids["Gale"]
            )
            summary = str(result["summary"])
            self.assertIn(
                f"Tempo and energy from {SCALAR_RECIPE}: 8 of 9 songs are measured; "
                "1 match was skipped without a measurement.",
                summary,
            )
            self.assertIn(
                f"Similarity uses the {EMBED.id} sound profile: 7 of 9 songs are measured; "
                "0 matches were skipped without a measurement.",
                summary,
            )
            self.assertEqual(set(self.titles(result)), {"Anchor", "Breaker", "Ember", "Fathom"})

    def test_a_copy_of_the_seed_is_absent_and_a_phrase_beside_the_seed_is_dropped(self) -> None:
        with self.embedding_on(EMBED, encode):
            self.measure(EMBED.id)
            with self.store.lock:
                self.store.db.execute(
                    "UPDATE library_files SET title='Gale', artist='Meadow' WHERE song_id=?",
                    (self.ids["Breaker"],),
                )
                self.store.db.commit()
            self.store.bump_library_revision()
            alike = self.resolve(plan(similar_to_current=True), reference_id=self.ids["Gale"])
            self.assertNotIn("Breaker", self.titles(alike))
            self.assertNotIn("Gale", self.titles(alike))
            self.assertEqual(self.titles(alike)[0], "Anchor")
        with self.embedding_on(PLAIN):
            self.measure(PLAIN.id)
            # Not a refusal: the reference song is the one rank key, the phrase is dropped.
            together = self.resolve(
                plan(similar_to_current=True, sound="dreamy guitar"),
                reference_id=self.ids["Gale"],
            )
            query = SearchPlan.model_validate(together["plan"])
            self.assertEqual((query.action, query.sound), ("search", ""))
            self.assertEqual(self.titles(together)[0], "Anchor")

    def test_negation_only_phrases(self) -> None:
        for phrase in (
            "no vocals",
            "No vocals.",
            "nothing explicit",
            "don't",
            "without vocal",
            # Genre words belong in genres, so these name nothing to look for.
            "no rock",
            "No hip hop, no vocals",
        ):
            self.assertTrue(negation_only(phrase), phrase)
        for phrase in ("dreamy guitar", "vocals and piano", "rock", "no dreamy guitar", ""):
            self.assertFalse(negation_only(phrase), phrase)

    def test_the_prompt_follows_the_active_recipes(self) -> None:
        off = system_prompt(None, None)
        self.assertIn("Mood, energy, tempo, instruments and vocals need audio analysis", off)
        self.assertIn('"Calmer music needs audio analysis, which is not enabled."', off)
        self.assertNotIn("energy_compared", off)
        scalar = system_prompt(SCALAR, None)
        self.assertIn('energy_compared "calmer"', scalar)
        self.assertIn(
            "Mood, instruments and vocals need audio analysis that is not enabled", scalar
        )
        self.assertIn("similar_to_current (artist and saved genres only)", scalar)
        self.assertNotIn("goes in sound", scalar)
        text = system_prompt(None, EMBED)
        self.assertIn("goes in sound", text)
        self.assertIn("Energy and tempo need audio analysis that is not enabled", text)
        self.assertIn("make the rest calmer. Use action unsupported", text)
        plain = system_prompt(SCALAR, PLAIN)
        self.assertIn('sound stays ""', plain)
        self.assertIn("measured sound similarity", plain)
        # Asking again is a repeat of the search, whatever analysis is on.
        for prompt in (off, scalar, text, plain):
            self.assertIn('"Another set", "different songs", "something else" or "again"', prompt)

    async def test_chat_sends_the_prompt_for_the_settings(self) -> None:
        await self.bot.chat(BotRequest(prompt="rock"))
        messages = self.chat_bodies[-1]["messages"]
        assert isinstance(messages, list)
        self.assertEqual(messages[0]["content"], system_prompt(None, None))
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        await self.bot.chat(BotRequest(prompt="rock"))
        messages = self.chat_bodies[-1]["messages"]
        assert isinstance(messages, list)
        self.assertEqual(messages[0]["content"], system_prompt(SCALAR, None))
        schema = self.chat_bodies[-1]["format"]
        assert isinstance(schema, dict)
        self.assertIn("energy_compared", schema["properties"])

    def test_settings_accept_empty_and_registered_recipes_only(self) -> None:
        self.assertEqual(Settings().audio_scalar_recipe, "")
        self.assertEqual(
            Settings(audio_scalar_recipe=SCALAR_RECIPE).audio_scalar_recipe, SCALAR_RECIPE
        )
        rejected: list[dict[str, object]] = [
            {"audio_scalar_recipe": "nobody-v9"},
            {"audio_embedding_recipe": SCALAR_RECIPE},
            {"audio_embedding_recipe": "embed-test"},
        ]
        for values in rejected:
            with self.subTest(values=values):
                with self.assertRaises(ValidationError):
                    Settings.model_validate(values)
                with self.assertRaises(ValidationError):
                    SettingsPatch.model_validate(values)
                with self.assertRaises(ValidationError):
                    self.store.update(values)
        self.assertEqual(SettingsPatch(audio_scalar_recipe="").audio_scalar_recipe, "")
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        self.assertEqual(self.store.current().audio_scalar_recipe, SCALAR_RECIPE)
        self.store.update({"audio_scalar_recipe": ""})
        self.assertEqual(self.bot.active_recipes(), (None, None))


@dataclass(frozen=True)
class Song:
    song_id: str
    size: int
    mtime_ns: int


class BudgetTests(unittest.TestCase):
    def test_warm_scoring_and_the_gate_walk_fit_the_budget_on_a_synthetic_library(self) -> None:
        """A synthetic 44,000 by 512 matrix, not the live library: cosine plus every gate."""
        count, dim = 44_000, 512
        rng = np.random.default_rng(7)
        matrix = rng.standard_normal((count, dim), dtype=np.float32)
        matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
        ids = [f"tr-{index:016x}" for index in range(count)]
        songs = [Song(sid, 1, 1) for sid in ids]
        embed = Recipe("embed-budget", "embedding", dim=dim, text_aligned=True)
        vectors = ProfileSet(
            embed,
            {sid: Profile(sid, "done", 1, 1, None, None, dim, dim * 4, "") for sid in ids},
            ids,
            {sid: index for index, sid in enumerate(ids)},
            matrix,
        )
        scalar = ProfileSet(
            SCALAR,
            {
                sid: Profile(
                    sid, "done", 1, 1, 60.0 + index % 120, 0.01 + index % 97 / 1000, 0, 0, ""
                )
                for index, sid in enumerate(ids)
            },
            [],
            {},
            None,
        )
        bands = percentile_bands(
            row.energy for row in scalar.rows.values() if row.energy is not None
        )
        gates = AudioGates(scalar, bands, None, vectors, True)
        query = plan(similar_to_current=True, tempo="fast", energy="low")
        seed = matrix[0]
        vectors.cosine(seed)
        started = time.perf_counter()
        scores = vectors.cosine(seed)
        kept = [song for song in songs if gates.verdict(query, song) == "in"]
        relevance = {song.song_id: round(scores.get(song.song_id, -2.0), 6) for song in kept}
        broad_order(relevance, 7, 100, relevance, frozenset(ids[:500]))
        elapsed = time.perf_counter() - started
        self.assertGreater(len(kept), 1000)
        self.assertLess(elapsed, 0.5, f"{elapsed:.3f} s for {count} songs")
