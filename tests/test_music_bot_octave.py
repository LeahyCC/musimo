"""Half and double tempo in Octive's gates (docs/audio-profile-spec.md, "Half and double
tempo"), and the unsure tempo-beat-v1 rows: each case on the gate itself, then end to end."""

import asyncio
import functools
import json
import tempfile
import unittest
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import httpx
from test_music_bot import plan, result_ids
from test_player import tag, write_wav

from backend.core.audio_recipes import BEAT_RECIPE, RECIPES
from backend.core.store import Store
from backend.library.audio_profile import Profile, ProfileSet
from backend.library.engine_contract import registry
from backend.library.index import Library
from backend.library.music_bot import (
    AudioGates,
    BotRequest,
    MusicBot,
    SearchPlan,
    ValidateSelection,
    same_octave,
    system_prompt,
    widen_single_bpm,
)
from backend.library.player import Player

BEAT = RECIPES[BEAT_RECIPE]
# Low is below 0.02, medium from 0.02 up to 0.05, high from 0.05.
BANDS = (0.02, 0.05)
LOW, MEDIUM, HIGH = 0.01, 0.03, 0.08


@dataclass(frozen=True)
class Song:
    song_id: str
    size: int = 1
    mtime_ns: int = 1


def gates(
    rows: Mapping[str, tuple[float | None, float]], reference: str | None = None
) -> AudioGates:
    profiles = {
        sid: Profile(sid, "done", 1, 1, bpm, energy, 0, 0, "")
        for sid, (bpm, energy) in rows.items()
    }
    found = ProfileSet(BEAT, profiles, [], {}, None)
    return AudioGates(found, BANDS, profiles.get(reference or ""))


class GateTests(unittest.TestCase):
    def verdict(self, query: SearchPlan, bpm: float | None, energy: float) -> str:
        return gates({"tr-a": (bpm, energy)}).verdict(widen_single_bpm(query), Song("tr-a"))

    def test_fast_at_half_needs_medium_or_high_energy(self) -> None:
        fast = plan(tempo="fast")
        self.assertEqual(self.verdict(fast, 150.0, LOW), "in")
        self.assertEqual(self.verdict(fast, 72.0, HIGH), "octave")
        self.assertEqual(self.verdict(fast, 72.0, MEDIUM), "octave")
        self.assertEqual(self.verdict(fast, 72.0, LOW), "out")
        # 60 doubled is 120, which is not fast either way.
        self.assertEqual(self.verdict(fast, 60.0, HIGH), "out")

    def test_slow_at_double_needs_low_or_medium_energy(self) -> None:
        slow = plan(tempo="slow")
        self.assertEqual(self.verdict(slow, 80.0, HIGH), "in")
        self.assertEqual(self.verdict(slow, 168.0, LOW), "octave")
        self.assertEqual(self.verdict(slow, 168.0, MEDIUM), "octave")
        self.assertEqual(self.verdict(slow, 168.0, HIGH), "out")

    def test_a_bpm_range_works_the_same_way(self) -> None:
        around = plan(tempo_min=120, tempo_max=120)
        self.assertEqual(self.verdict(around, 125.0, LOW), "in")
        self.assertEqual(self.verdict(around, 61.0, MEDIUM), "octave")
        self.assertEqual(self.verdict(around, 61.0, LOW), "out")
        self.assertEqual(self.verdict(around, 244.0, LOW), "octave")
        self.assertEqual(self.verdict(around, 244.0, HIGH), "out")
        # A band and a bound together: both must fit the same reading.
        both = plan(tempo="fast", tempo_max=150)
        self.assertEqual(self.verdict(both, 74.0, HIGH), "octave")
        self.assertEqual(self.verdict(both, 80.0, HIGH), "out")

    def test_other_gates_stay_hard(self) -> None:
        self.assertEqual(self.verdict(plan(tempo="fast", energy="low"), 72.0, LOW), "out")
        self.assertEqual(self.verdict(plan(tempo="fast", energy="high"), 72.0, HIGH), "octave")

    def test_no_bands_means_no_octave_matches(self) -> None:
        found = gates({"tr-a": (72.0, HIGH)})
        bare = AudioGates(found.scalar, None, None)
        self.assertEqual(bare.verdict(plan(tempo="fast"), Song("tr-a")), "out")

    def test_an_unsure_tempo_is_not_covered_but_its_energy_is_used(self) -> None:
        self.assertEqual(self.verdict(plan(tempo="fast"), None, HIGH), "missing_scalar")
        self.assertEqual(self.verdict(plan(tempo_min=100), None, HIGH), "missing_scalar")
        self.assertEqual(self.verdict(plan(energy="high"), None, HIGH), "in")

    def test_faster_and_slower_compare_in_the_seeds_octave_when_energy_agrees(self) -> None:
        rows = {
            "tr-seed": (100.0, MEDIUM),
            "tr-double": (200.0, MEDIUM),
            "tr-half": (50.0, MEDIUM),
            "tr-55": (55.0, MEDIUM),
            "tr-150": (150.0, MEDIUM),
            "tr-150-high": (150.0, HIGH),
            "tr-55-low": (55.0, LOW),
            "tr-120-low": (120.0, LOW),
        }
        found = gates(rows, reference="tr-seed")

        def check(compared: str, sid: str) -> str:
            return found.verdict(plan(tempo_compared=compared), Song(sid))

        # Exactly double or half, in the same band, is the same pace: neither.
        for sid in ("tr-double", "tr-half"):
            self.assertEqual(check("faster", sid), "out")
            self.assertEqual(check("slower", sid), "out")
        # 55 with medium energy is read as 110: faster, but only by the fold.
        self.assertEqual(check("faster", "tr-55"), "octave")
        self.assertEqual(check("slower", "tr-55"), "out")
        # 150 with medium energy is read as 75: slower by the fold.
        self.assertEqual(check("slower", "tr-150"), "octave")
        # Bands differ: compared as it is.
        self.assertEqual(check("faster", "tr-150-high"), "in")
        self.assertEqual(check("slower", "tr-55-low"), "in")
        self.assertEqual(check("faster", "tr-120-low"), "in")
        self.assertEqual(found.verdict(plan(tempo_compared="faster"), Song("tr-seed")), "out")

    def test_the_fold_follows_the_energy_direction(self) -> None:
        rows = {"tr-seed": (100.0, HIGH), "tr-150": (150.0, HIGH), "tr-70": (70.0, HIGH)}
        found = gates(rows, reference="tr-seed")
        # High energy does not back a halving, so 150 stays faster than 100.
        self.assertEqual(found.verdict(plan(tempo_compared="faster"), Song("tr-150")), "in")
        # It does back a doubling: 70 is compared at 140.
        self.assertEqual(found.verdict(plan(tempo_compared="faster"), Song("tr-70")), "octave")
        low = gates({"tr-seed": (100.0, LOW), "tr-55": (55.0, LOW)}, reference="tr-seed")
        self.assertEqual(low.verdict(plan(tempo_compared="slower"), Song("tr-55")), "in")

    def test_same_octave(self) -> None:
        self.assertEqual(same_octave(200.0, 100.0), 100.0)
        self.assertEqual(same_octave(50.0, 100.0), 100.0)
        self.assertEqual(same_octave(141.0, 100.0), 141.0)
        self.assertEqual(same_octave(142.0, 100.0), 71.0)
        self.assertEqual(same_octave(70.0, 100.0), 140.0)
        self.assertEqual(same_octave(0.0, 100.0), 0.0)


# Title, artist, tempo (None is an unsure reading), energy. Every artist differs, so the cap
# never decides a test. Rest is never measured. The library's bands come out as: low Dune and
# Grove, medium Hollow and Arrow, high Blaze, Comet, Echo and Flint.
SONGS: list[tuple[str, str, float | None, float]] = [
    ("Arrow", "A1", 150.0, 0.021),
    ("Blaze", "B1", 145.0, 0.080),
    ("Comet", "C1", 72.0, 0.081),
    ("Dune", "D1", 74.0, 0.005),
    ("Echo", "E1", None, 0.082),
    ("Flint", "F1", 100.0, 0.083),
    ("Grove", "G1", 110.0, 0.006),
    ("Hollow", "H1", 60.0, 0.020),
]


class OctaveBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        music = root / "music"
        music.mkdir()
        self.store = Store(root / "state.sqlite3")
        self.store.update(
            {"ollama_model": "fixture", "audio_scalar_recipe": BEAT_RECIPE, "audio_energy": True}
        )
        self.player = Player(self.store, [music])
        library = Library(self.store, [music], asyncio.Event())
        for index, (title, artist, *_) in enumerate([*SONGS, ("Rest", "R1", None, 0.0)]):
            path = music / f"{index}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album="Fixture", year=2001, genres=["Rock"])
        library.scan()
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200")
            self.store.db.commit()
        self.store.bump_library_revision()
        self.ids = {str(t["title"]): str(t["id"]) for t in self.player.view().tracks}
        stored = self.player.view().stored
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            for title, _, bpm, energy in SONGS:
                song = stored[self.ids[title]]
                self.store.db.execute(
                    "INSERT INTO audio_profile VALUES (?,?,'done',?,?,?,?,0,NULL,?,'t')",
                    (
                        song.song_id,
                        BEAT_RECIPE,
                        song.size,
                        song.mtime_ns,
                        bpm,
                        energy,
                        json.dumps({"bpm": 141.0, "sure": False}) if bpm is None else "{}",
                    ),
                )
            self.store.db.commit()

        async def transport(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def titles(self, query: SearchPlan, reference: str | None = None) -> tuple[list[str], str]:
        result = self.bot.resolve(
            query,
            BotRequest(prompt="fixture", reference_id=self.ids[reference] if reference else None),
        )
        names = {sid: title for title, sid in self.ids.items()}
        return [names[sid] for sid in result_ids(result)], str(result["summary"])

    def test_direct_matches_rank_first_and_the_reply_counts_octave_ones(self) -> None:
        # Comet (72) and Flint (100) have high energy, so they fit "fast" at double. Dune and
        # Grove have low energy and stay out; Hollow doubled is 120, not fast.
        for seed in range(5):
            self.bot.new_seed = functools.partial(int, seed)
            titles, summary = self.titles(plan(tempo="fast"))
            self.assertEqual(set(titles[:2]), {"Arrow", "Blaze"})
            self.assertEqual(set(titles[2:]), {"Comet", "Flint"})
        self.assertIn("2 of these matched at half or double their measured tempo.", summary)
        one, said = self.titles(plan(tempo="fast", tempo_max=150))
        self.assertEqual(one[2:], ["Comet"])
        self.assertIn("1 of these matched at half or double its measured tempo.", said)
        # Echo's tempo is unsure: like Rest, which was never measured, it is counted as not
        # covered and never matched.
        self.assertIn(
            f"Tempo and energy from {BEAT_RECIPE}: 7 of 9 songs are measured; "
            "2 matches were skipped without a measurement.",
            summary,
        )
        self.assertNotIn("Echo", titles)

    def test_energy_only_requests_use_unsure_rows(self) -> None:
        titles, summary = self.titles(plan(energy="high"))
        self.assertIn("Echo", titles)
        self.assertIn("8 of 9 songs are measured", summary)
        self.assertNotIn("half or double", summary)

    def test_an_unsure_reference_tempo_is_an_honest_miss(self) -> None:
        titles, summary = self.titles(plan(tempo_compared="faster"), reference="Echo")
        self.assertEqual(titles, [])
        self.assertIn(f"no sure {BEAT_RECIPE} tempo", summary)
        # Calmer only needs its energy.
        calmer, _ = self.titles(plan(energy_compared="calmer"), reference="Echo")
        self.assertIn("Arrow", calmer)

    def test_with_energy_off_tempo_works_alone(self) -> None:
        self.store.update({"audio_energy": False})
        # Energy words are refused, the fields cleared, and nothing searched.
        for filled in ({"energy": "high"}, {"energy_compared": "calmer"}):
            refused = self.bot.resolve(
                plan(**filled), BotRequest(prompt="fixture", reference_id=self.ids["Arrow"])
            )
            query = SearchPlan.model_validate(refused["plan"])
            self.assertEqual(query.action, "unsupported")
            self.assertIn("Energy is not measured well enough", query.explanation)
            self.assertEqual((query.energy, query.energy_compared), ("", ""))
            self.assertEqual(refused["tracks"], [])
        # Tempo still works, with no bands to back a half or double reading.
        titles, summary = self.titles(plan(tempo="fast"))
        self.assertEqual(set(titles), {"Arrow", "Blaze"})
        self.assertNotIn("half or double", summary)
        faster, _ = self.titles(plan(tempo_compared="faster"), reference="Flint")
        self.assertEqual(set(faster), {"Arrow", "Blaze", "Grove"})
        scalar, embedding = self.bot.active_recipes()
        assert scalar is not None
        prompt = system_prompt(scalar, embedding)
        self.assertIn("energy and energy_compared stay", prompt)
        self.assertIn("Energy, mood, instruments and vocals need audio analysis", prompt)
        self.assertIn('"Calmer music needs audio analysis, which is not enabled."', prompt)
        available = {c.id: c.available for c in registry(scalar, embedding)}
        self.assertTrue(available["tempo"])
        self.assertFalse(available["energy"])
        self.assertFalse(available["energy_compared"])

    def test_validate_accepts_an_octave_match(self) -> None:
        self.bot.validate(ValidateSelection(ids=[self.ids["Comet"]], plan=plan(tempo="fast")))


if __name__ == "__main__":
    unittest.main()
