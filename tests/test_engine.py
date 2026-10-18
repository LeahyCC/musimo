"""The versioned engine boundary: canonical intents, the registry, replay and refusals."""

import asyncio
import itertools
import json
import random
import tempfile
import unittest
from collections import Counter
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.audio_recipes import SCALAR_RECIPE, Recipe, registered
from backend.core.store import Store
from backend.library.duration import (
    ABOUT_WINDOW,
    CANDIDATE_CAP,
    WORK_LIMIT,
    Item,
    Mode,
    TotalLength,
    bounds,
    fit,
    length_ms,
    most,
    search,
)
from backend.library.engine import Engine, parse_intent
from backend.library.engine_contract import (
    CONTRACT_VERSION,
    ENGINE_VERSION,
    NOT_BUILT,
    Context,
    EngineError,
    Filters,
    Intent,
    registry,
)
from backend.library.index import Library
from backend.library.music_bot import ARTIST_CAP, BotRequest, Kept, MusicBot, SearchPlan
from backend.library.player import Player
from backend.library.selection import RELEVANCE_RATIO, SEED_LIMIT, SHOWN_LIMIT

SONGS: list[tuple[str, str, int, str]] = [
    ("Echo", "Harbor", 1991, "Rock"),
    ("Echo (Live)", "Harbor", 1992, "Rock"),
    ("Echo (Remix)", "Harbor", 1993, "Rock"),
    ("Echo - 2011 Remaster", "Harbor", 1991, "Rock"),
    ("Dawn", "Orchard", 1994, "Rock"),
    ("Dusk", "Orchard", 1995, "Rock"),
    ("Mist", "Meadow", 1999, "Jazz"),
    ("Fog", "Meadow", 2001, "Jazz"),
    ("Rain", "Quarry", 1989, "Rock"),
    ("Snow", "Quarry", 1990, "Rock"),
    ("Hail", "Ridge", 1988, "Rock"),
    ("Sleet", "Ridge", 1987, "Rock"),
]
PLAIN = {"contract_version": 1, "action": "search"}
V3 = {"contract_version": 3, "action": "search"}
TEXT = Recipe("embed-engine", "embedding", dim=3, text_aligned=True)


def intent(**body: object) -> Intent:
    return parse_intent(PLAIN | body)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "state.sqlite3")
        self.store.update({"music_timezone": "Pacific/Honolulu"})
        self.player = Player(self.store, [self.music])
        self.library = Library(self.store, [self.music], asyncio.Event())
        for index, (title, artist, year, genre) in enumerate(SONGS):
            path = self.music / f"{index}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album="Fixture", year=year, genres=[genre])
        self.library.scan()
        self.ids = {str(t["title"]): str(t["id"]) for t in self.player.view().tracks}
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200")
            self.store.db.execute(
                "UPDATE library_files SET play_count=5, last_played='2026-10-01T00:00:00Z' "
                "WHERE song_id IN (?, ?)",
                (self.ids["Dawn"], self.ids["Mist"]),
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        liked = await self.player.linked_playlist()
        for title in ("Dawn", "Mist", "Rain"):
            await self.player.add_playlist_song(str(liked["id"]), self.ids[title])
        self.asked: list[str] = []

        async def transport(request: httpx.Request) -> httpx.Response:
            self.asked.append(str(request.url))
            return httpx.Response(500)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)
        self.engine = Engine(self.bot)
        self.now = datetime(2026, 10, 14, 12, tzinfo=ZoneInfo("Pacific/Honolulu"))

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def run_at(self, query: Intent, now: datetime | None = None) -> dict[str, object]:
        with patch("backend.library.engine.datetime") as clock:
            clock.now.return_value = now or self.now
            return self.engine.run(query)

    def refused(self, body: dict[str, object]) -> EngineError:
        with self.assertRaises(EngineError) as caught:
            self.engine.run(parse_intent(body))
        return caught.exception

    def ids_of(self, result: dict[str, object]) -> list[str]:
        ids = result["ids"]
        assert isinstance(ids, list)
        return [str(sid) for sid in ids]

    def legacy_ids(self, reply: dict[str, object]) -> list[str]:
        tracks = reply["tracks"]
        assert isinstance(tracks, list)
        return [str(track["id"]) for track in tracks]

    def part(self, result: dict[str, object], key: str) -> dict[str, object]:
        found = self.snapshot(result)[key]
        assert isinstance(found, dict)
        return found

    def snapshot(self, result: dict[str, object]) -> dict[str, object]:
        snapshot = result["snapshot"]
        assert isinstance(snapshot, dict)
        return snapshot

    # Contract and refusals

    def test_unknown_field_version_and_malformed_body_are_typed(self) -> None:
        for body, code in [
            ([], "malformed_request"),
            ("search", "malformed_request"),
            ({"action": "search"}, "malformed_request"),
            ({"contract_version": 6, "action": "search"}, "unsupported_version"),
            ({"contract_version": "1", "action": "search"}, "unsupported_version"),
            ({"contract_version": True, "action": "search"}, "unsupported_version"),
            (PLAIN | {"duration_mode": "about"}, "unknown_field"),
            (PLAIN | {"filters": {"duration_comparator": "under"}}, "unknown_field"),
            (PLAIN | {"context": {"file_path": "/music/a.wav"}}, "unknown_field"),
            (PLAIN | {"action": "dance"}, "invalid_intent"),
            (PLAIN | {"filters": {"limit": 0}}, "invalid_intent"),
            (PLAIN | {"filters": {"favourites": "yes"}}, "invalid_intent"),
            (PLAIN | {"seed": SEED_LIMIT}, "invalid_intent"),
            (PLAIN | {"context": {"reference_id": "/music/a.wav"}}, "invalid_intent"),
            (PLAIN | {"filters": {"artists": ["  "]}}, "invalid_intent"),
        ]:
            with self.subTest(body=body):
                with self.assertRaises(EngineError) as caught:
                    parse_intent(body)
                self.assertEqual(caught.exception.code, code)

    def test_unknown_field_error_names_the_field_and_echoes_no_input(self) -> None:
        with self.assertRaises(EngineError) as caught:
            parse_intent(PLAIN | {"filters": {"secret_value": "hunter2"}})
        error = json.dumps(caught.exception.public())
        self.assertIn("filters.secret_value", error)
        self.assertNotIn("hunter2", error)

    def test_conflicting_filters_are_refused_not_repaired(self) -> None:
        for filters in [
            {"year_from": 2000, "year_to": 1990},
            {"min_seconds": 300, "max_seconds": 200},
            {"tempo_min": 140, "tempo_max": 100},
        ]:
            with self.subTest(filters=filters):
                self.assertEqual(self.refused(PLAIN | {"filters": filters}).code, "invalid_intent")

    def test_resolve_rewrites_are_refused_rather_than_loosened(self) -> None:
        # One BPM becomes a window, and tag similarity replaces the artist and genre filters.
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        exact = self.refused(PLAIN | {"filters": {"tempo_min": 120, "tempo_max": 120}})
        self.assertEqual(exact.code, "unsupported_constraint")
        self.store.update({"audio_scalar_recipe": ""})
        for filters in [{"genres": ["jazz"]}, {"artists": ["Meadow"]}]:
            with self.subTest(filters=filters):
                error = self.refused(
                    PLAIN
                    | {
                        "filters": {"similar_to_current": True, **filters},
                        "context": {"reference_id": self.ids["Dawn"]},
                    }
                )
                self.assertEqual(error.code, "unsupported_constraint")

    def test_seed_and_shown_ids_belong_to_a_library_search(self) -> None:
        known = self.ids["Dawn"]
        extras: list[dict[str, object]] = [
            {"seed": 0},
            {"context": {"proposal_ids": [known], "shown_ids": [known]}},
        ]
        for extra in extras:
            with self.subTest(extra=extra):
                body = PLAIN | {"scope": "proposal", "context": {"proposal_ids": [known]}} | extra
                self.assertEqual(self.refused(body).code, "invalid_intent")

    def test_an_unmeasured_reference_is_an_error_not_an_empty_match(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        error = self.refused(
            PLAIN
            | {
                "filters": {"energy_compared": "calmer"},
                "context": {"reference_id": self.ids["Dawn"]},
            }
        )
        self.assertEqual(error.code, "reference_unmeasured")
        self.assertEqual([item.field for item in error.fields], ["filters.energy_compared"])

    def test_a_disabled_folder_changes_the_snapshot(self) -> None:
        before = self.part(self.run_at(intent(seed=1)), "roots")
        with self.store.lock:
            self.store.db.execute("UPDATE library_roots SET enabled=0")
            self.store.db.commit()
        self.assertNotEqual(self.part(self.run_at(intent(seed=1)), "roots"), before)

    def test_fabricated_and_misplaced_songs_are_refused(self) -> None:
        invented = "tr-0123456789abcdef"
        known = self.ids["Dawn"]
        for context, scope, code in [
            ({"reference_id": invented}, "library", "unknown_song"),
            ({"current_id": invented}, "library", "unknown_song"),
            ({"proposal_ids": [known, invented]}, "proposal", "unknown_song"),
            ({"queue_ids": [invented]}, "queue", "unknown_song"),
            ({"proposal_ids": [known]}, "library", "invalid_intent"),
            ({"queue_ids": [known]}, "proposal", "invalid_intent"),
            ({}, "proposal", "no_selection"),
            ({}, "queue", "no_selection"),
        ]:
            with self.subTest(context=context, scope=scope):
                error = self.refused(PLAIN | {"scope": scope, "context": context})
                self.assertEqual(error.code, code)

    def test_a_comparison_needs_a_reference_and_shown_ids_are_only_memory(self) -> None:
        error = self.refused(PLAIN | {"filters": {"similar_to_current": True}})
        self.assertEqual(error.code, "missing_reference")
        gone = "tr-fedcba9876543210"
        result = self.run_at(intent(seed=1, context={"shown_ids": [gone, self.ids["Dawn"]]}))
        self.assertEqual(self.part(result, "shown")["count"], 2)
        self.assertEqual(self.part(result, "shown")["unknown"], 1)

    def test_unavailable_audio_constraints_fail_in_the_open(self) -> None:
        for filters in [
            {"tempo": "fast"},
            {"tempo_min": 100},
            {"energy": "high"},
            {"sound": "dreamy guitar"},
        ]:
            with self.subTest(filters=filters):
                error = self.refused(PLAIN | {"filters": filters})
                self.assertEqual(error.code, "unsupported_capability")
                self.assertTrue(error.fields)

    def test_negated_or_combined_sound_is_refused_not_dropped(self) -> None:
        with registered(TEXT, lambda phrase: [1.0, 0.0, 0.0]):
            self.store.update({"audio_embedding_recipe": TEXT.id})
            try:
                for filters, context in [
                    ({"sound": "no vocals"}, {}),
                    ({"sound": "without"}, {}),
                    ({"sound": "dreamy", "similar_to_current": True}, {"reference_id": "x"}),
                ]:
                    with self.subTest(filters=filters):
                        if "reference_id" in context:
                            context = {"reference_id": self.ids["Dawn"]}
                        error = self.refused(PLAIN | {"filters": filters, "context": context})
                        self.assertEqual(error.code, "unsupported_constraint")
            finally:
                self.store.update({"audio_embedding_recipe": ""})

    def test_a_scalar_filter_is_allowed_once_its_recipe_is_on(self) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        result = self.run_at(intent(filters={"tempo": "fast"}))
        # Nothing is measured, so nothing matches, and the result says so.
        self.assertEqual(self.ids_of(result), [])
        self.assertIn(SCALAR_RECIPE, str(result["summary"]))

    def test_actions_that_search_nothing_take_no_search_fields(self) -> None:
        for action in ("pause", "resume", "skip"):
            result = self.run_at(parse_intent(PLAIN | {"action": action}))
            self.assertEqual(
                (result["action"], result["ids"], result["state_changed"]), (action, [], False)
            )
        asked = self.run_at(
            parse_intent(PLAIN | {"action": "clarify", "explanation": "Which Echo?"})
        )
        self.assertEqual(asked["summary"], "Which Echo?")
        bodies: list[dict[str, object]] = [
            {"action": "pause", "filters": {"genres": ["rock"]}},
            {"action": "skip", "seed": 3},
            {"action": "resume", "scope": "queue"},
            {"action": "search", "explanation": "x"},
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.refused(PLAIN | body).code, "invalid_intent")

    # Registry

    def test_registry_lists_every_field_and_nothing_unbuilt(self) -> None:
        listed = {item.id: item for item in registry(None, None)}
        for name in [*Filters.model_fields, *Context.model_fields]:
            self.assertIn(name, listed, f"{name} is accepted by an intent but not registered")
        for name in ("search", "pause", "resume", "skip", "clarify", "unsupported"):
            self.assertTrue(listed[name].available)
        for item in NOT_BUILT:
            self.assertFalse(listed[item.id].available)
            self.assertNotIn(item.id, Filters.model_fields)
            self.assertNotIn(item.id, Intent.model_fields)
            self.assertNotIn(item.id, Context.model_fields)
        self.assertEqual(
            {item.id for item in NOT_BUILT},
            {
                "audio_certainty",
                "persona",
                "external_catalogue",
            },
        )

    def test_registry_follows_the_recipes_that_are_on(self) -> None:
        def state(scalar: Recipe | None, embedding: Recipe | None) -> dict[str, bool]:
            return {item.id: item.available for item in registry(scalar, embedding)}

        off = state(None, None)
        self.assertEqual(
            [off[n] for n in ("tempo", "tempo_min", "energy", "tempo_compared", "sound")],
            [False] * 5,
        )
        on = state(Recipe("s", "scalar"), TEXT)
        self.assertTrue(all(on[n] for n in ("tempo", "tempo_max", "energy", "sound")))
        plain = state(None, Recipe("e", "embedding", dim=3, text_aligned=False))
        self.assertFalse(plain["sound"])

    async def test_capabilities_route(self) -> None:
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            body = (await client.get("/api/music-bot/capabilities")).json()
        self.assertEqual(body["contract_version"], CONTRACT_VERSION)
        self.assertEqual(body["engine_version"], ENGINE_VERSION)
        self.assertEqual(body["supported_versions"], [1, 2, 3, 4, CONTRACT_VERSION])
        self.assertEqual(CONTRACT_VERSION, 5)
        found = {item["id"]: item["available"] for item in body["capabilities"]}
        self.assertTrue(found["total_length"])
        self.assertNotIn("duration_comparators", found)
        self.assertFalse(found["tempo"])
        self.assertTrue(found["genres"])

    # Adapter: the existing resolver, unchanged

    def legacy(self, query: dict[str, object], **request: object) -> dict[str, object]:
        base: dict[str, object] = {
            "action": "search",
            "scope": "library",
            "change_filters": [],
            "allow_artists": [],
            "add_count": 0,
            "artists": [],
            "exclude_artists": [],
            "genres": [],
            "year_from": None,
            "year_to": None,
            "favourites": False,
            "history": "any",
            "exclude_played_days": 0,
            "min_seconds": 0,
            "max_seconds": None,
            "target_seconds": 0,
            "limit": 500,
            "similar_to_current": False,
            "explanation": "",
        }
        return self.bot.resolve(
            SearchPlan.model_validate(base | query),
            BotRequest(prompt="legacy", **request),  # type: ignore[arg-type]
            self.now,
        )

    def test_the_adapter_gives_the_ids_resolve_gives(self) -> None:
        library_ids = [self.ids[t] for t in ("Dawn", "Mist", "Rain", "Echo")]
        cases: list[tuple[dict[str, object], int]] = [
            ({}, 1),
            ({}, 99),
            ({"favourites": True}, 4),
            ({"genres": ["rock"], "year_from": 1990, "year_to": 1995}, 5),
            ({"history": "familiar"}, 6),
            ({"exclude_played_days": 3, "limit": 4}, 7),
            ({"target_seconds": 600}, 8),
            ({"artists": ["Harbor"]}, 9),
        ]
        for filters, seed in cases:
            with self.subTest(filters=filters, seed=seed):
                result = self.run_at(intent(filters=filters, seed=seed))
                expected = self.legacy(filters, generation_seed=seed)
                self.assertEqual(self.ids_of(result), self.legacy_ids(expected))
                self.assertEqual(result["total_seconds"], expected["total_seconds"])
                self.assertEqual(result["summary"], expected["summary"])
                self.assertEqual(result["seed"], seed)
        queue = intent(
            scope="queue",
            filters={"genres": ["rock"]},
            context={"queue_ids": list(reversed(library_ids))},
        )
        self.assertEqual(
            self.ids_of(self.run_at(queue)),
            self.legacy_ids(
                self.legacy(
                    {"scope": "queue", "genres": ["rock"]}, queue_ids=list(reversed(library_ids))
                )
            ),
        )

    def test_refinement_keeps_the_given_order(self) -> None:
        order = [self.ids[t] for t in ("Rain", "Dawn", "Hail", "Mist")]
        result = self.run_at(
            intent(
                scope="proposal",
                filters={"genres": ["rock"]},
                context={"proposal_ids": order},
            )
        )
        self.assertEqual(self.ids_of(result), [order[0], order[1], order[2]])
        self.assertIsNone(result["seed"])

    def test_seeded_broad_selection_and_the_named_artist_exception(self) -> None:
        broad = self.run_at(intent(seed=11))
        counts: dict[str, int] = {}
        for track in broad["tracks"]:  # type: ignore[attr-defined]
            counts[track["artist"]] = counts.get(track["artist"], 0) + 1
        self.assertLessEqual(max(counts.values()), ARTIST_CAP)
        named = self.run_at(intent(seed=11, filters={"artists": ["Harbor"]}))
        self.assertEqual(len(self.ids_of(named)), 4)

    def test_versions_of_a_title_are_never_merged(self) -> None:
        result = self.run_at(intent(seed=2, filters={"artists": ["Harbor"]}))
        titles = {str(t["title"]) for t in result["tracks"]}  # type: ignore[attr-defined]
        self.assertEqual(titles, {"Echo", "Echo (Live)", "Echo (Remix)", "Echo - 2011 Remaster"})
        ids = self.ids_of(result)
        self.assertEqual(len(set(ids)), 4)
        for sid in ids:
            self.assertRegex(sid, r"^tr-[0-9a-f]{16}$")
        self.assertNotIn(str(self.music), json.dumps(result))

    def test_a_missing_file_is_skipped_as_before(self) -> None:
        before = self.run_at(intent(seed=3, filters={"artists": ["Orchard"]}))
        self.assertEqual(len(self.ids_of(before)), 2)
        (self.music / "4.wav").unlink()
        after = self.run_at(intent(seed=3, filters={"artists": ["Orchard"]}))
        self.assertEqual(self.ids_of(after), [self.ids["Dusk"]])

    # Replay

    def test_the_same_snapshot_returns_the_same_ordered_ids(self) -> None:
        context = {"shown_ids": [self.ids["Dawn"]], "reference_id": self.ids["Dusk"]}
        first = self.run_at(intent(seed=21, context=context, filters={"limit": 6}))
        second = self.run_at(intent(seed=21, context=context, filters={"limit": 6}))
        self.assertEqual(self.ids_of(first), self.ids_of(second))
        self.assertEqual(first["snapshot"], second["snapshot"])
        self.assertEqual(len(self.ids_of(first)), 6)
        # Without a seed one is drawn, reported, and replays the same selection.
        drawn = self.run_at(intent())
        seed = drawn["seed"]
        assert isinstance(seed, int)
        replay = self.run_at(intent(seed=seed))
        self.assertEqual(self.ids_of(drawn), self.ids_of(replay))
        self.assertEqual(self.snapshot(drawn)["id"], self.snapshot(replay)["id"])

    def test_a_seed_alone_is_not_the_snapshot(self) -> None:
        base = self.run_at(intent(seed=5, filters={"limit": 6}))
        ids = self.snapshot(base)["id"]

        def changed(result: dict[str, object], part: str) -> None:
            self.assertNotEqual(self.snapshot(result)["id"], ids, part)
            self.assertNotEqual(self.snapshot(result)[part], self.snapshot(base)[part], part)

        changed(
            self.run_at(
                intent(seed=5, filters={"limit": 6}, context={"shown_ids": [self.ids["Dawn"]]})
            ),
            "shown",
        )
        changed(
            self.run_at(
                intent(seed=5, filters={"limit": 6}, context={"reference_id": self.ids["Dawn"]})
            ),
            "reference_id",
        )
        changed(
            self.run_at(intent(seed=5, filters={"limit": 6}), self.now.replace(day=15)),
            "local_day",
        )
        self.assertNotEqual(
            self.snapshot(self.run_at(intent(seed=6, filters={"limit": 6})))["id"], ids
        )
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET play_count=9 WHERE song_id=?", (self.ids["Fog"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        changed(self.run_at(intent(seed=5, filters={"limit": 6})), "history")
        with registered(TEXT, lambda phrase: [1.0, 0.0, 0.0]):
            self.store.update({"audio_embedding_recipe": TEXT.id})
            try:
                changed(self.run_at(intent(seed=5, filters={"limit": 6})), "audio")
            finally:
                self.store.update({"audio_embedding_recipe": ""})

    async def test_likes_and_the_catalogue_are_part_of_the_snapshot(self) -> None:
        base = self.run_at(intent(seed=5))
        liked = await self.player.linked_playlist()
        await self.player.add_playlist_song(str(liked["id"]), self.ids["Fog"])
        likes = self.run_at(intent(seed=5))
        self.assertNotEqual(self.snapshot(likes)["likes"], self.snapshot(base)["likes"])
        (self.music / "5.wav").unlink()
        self.library.scan()
        gone = self.run_at(intent(seed=5))
        self.assertNotEqual(self.snapshot(gone)["catalogue"], self.snapshot(likes)["catalogue"])

    def test_a_snapshot_that_moves_is_read_again_then_refused(self) -> None:
        real = self.bot.resolve
        calls: list[int] = []

        def moving(
            plan: SearchPlan,
            request: BotRequest,
            now: datetime | None = None,
            total_length: TotalLength | None = None,
            kept: Kept | None = None,
        ) -> dict[str, object]:
            reply = real(plan, request, now, total_length, kept)
            calls.append(1)
            with self.store.lock:
                self.store.db.execute("UPDATE library_files SET play_count=play_count+1")
                self.store.db.commit()
            self.store.bump_library_revision()
            return reply

        with patch.object(self.bot, "resolve", moving):
            error = self.refused(PLAIN | {"seed": 1})
        self.assertEqual((error.code, error.status), ("snapshot_changed", 409))
        self.assertEqual(len(calls), 3)

        calls.clear()

        def once(
            plan: SearchPlan,
            request: BotRequest,
            now: datetime | None = None,
            total_length: TotalLength | None = None,
            kept: Kept | None = None,
        ) -> dict[str, object]:
            reply = real(plan, request, now, total_length, kept)
            if not calls:
                calls.append(1)
                self.store.bump_library_revision()
            return reply

        with patch.object(self.bot, "resolve", once):
            result = self.engine.run(intent(seed=1))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(self.part(result, "catalogue")["revision"], self.store.library_revision())

    # Total length

    def lengths(self, by_title: dict[str, float]) -> None:
        with self.store.lock:
            for title, seconds in by_title.items():
                self.store.db.execute(
                    "UPDATE library_files SET duration=? WHERE song_id=?",
                    (seconds, self.ids[title]),
                )
            self.store.db.commit()
        self.store.bump_library_revision()

    def timed(self, mode: str, seconds: int, **body: object) -> dict[str, object]:
        filters = body.pop("filters", {})
        assert isinstance(filters, dict)
        total = {"total_length": {"mode": mode, "seconds": seconds}}
        return self.run_at(parse_intent(V3 | body | {"filters": filters | total}))

    def report(self, result: dict[str, object]) -> dict[str, object]:
        found = result["duration"]
        assert isinstance(found, dict)
        return found

    def alternative(self, result: dict[str, object]) -> list[str] | None:
        found = self.report(result)["alternative"]
        if found is None:
            return None
        assert isinstance(found, dict) and isinstance(found["ids"], list)
        return [str(sid) for sid in found["ids"]]

    def test_each_mode_on_its_exact_boundary_with_one_song(self) -> None:
        # One song, Hail, of length L against N = 60:00. A met target picks it. An unmet one
        # with a ceiling offers it as the longer alternative and picks nothing; an unmet one
        # with only a floor keeps it as the shorter strict selection.
        hail = [self.ids["Hail"]]
        cases: list[tuple[str, int, bool, list[str], list[str] | None]] = [
            ("under", 3599, True, hail, None),
            ("under", 3600, False, [], hail),
            ("under", 3601, False, [], hail),
            ("at_most", 3599, True, hail, None),
            ("at_most", 3600, True, hail, None),
            ("at_most", 3601, False, [], hail),
            ("at_least", 3599, False, hail, None),
            ("at_least", 3600, True, hail, None),
            ("at_least", 3601, True, hail, None),
            ("over", 3599, False, hail, None),
            ("over", 3600, False, hail, None),
            ("over", 3601, True, hail, None),
            # The five-minute window, both edges and one second past each.
            ("about", 3299, False, hail, None),
            ("about", 3300, True, hail, None),
            ("about", 3600, True, hail, None),
            ("about", 3900, True, hail, None),
            ("about", 3901, False, [], hail),
        ]
        for mode, length, met, ids, alternative in cases:
            with self.subTest(mode=mode, length=length):
                self.lengths({"Hail": length})
                result = self.timed(mode, 3600, filters={"artists": ["Ridge"], "year_from": 1988})
                report = self.report(result)
                self.assertEqual(report["met"], met)
                self.assertEqual(self.ids_of(result), ids)
                self.assertEqual(self.alternative(result), alternative)
                self.assertEqual(report["unmet_reason"], "" if met else "proven")
                self.assertEqual(report["target_seconds"], 3600)
                self.assertEqual(report["mode"], mode)
                self.assertEqual(report["window_seconds"], 300 if mode == "about" else 0)
                self.assertEqual(report["total_seconds"], float(length) if ids else 0.0)
                expected = (float(length) if ids else 0.0) - 3600
                self.assertEqual(report["deviation_seconds"], expected)
                self.assertEqual(result["total_seconds"], report["total_seconds"])

    def test_each_mode_against_every_subset_of_four_songs(self) -> None:
        # Harbor's four songs total 59:59, 60:00 or 60:01. The search's total is checked
        # against every subset, so a correct comparator and a correct best are both needed.
        names = ["Echo", "Echo (Live)", "Echo (Remix)", "Echo - 2011 Remaster"]
        for last in (899, 900, 901):
            lengths = [900, 900, 900, last]
            self.lengths(dict(zip(names, lengths, strict=True)))
            totals = {sum(lengths[i] for i in range(4) if mask >> i & 1) for mask in range(1, 16)}
            oracle = {
                "under": max((t for t in totals if t < 3600), default=None),
                "at_most": max((t for t in totals if t <= 3600), default=None),
                "at_least": min((t for t in totals if t >= 3600), default=None),
                "over": min((t for t in totals if t > 3600), default=None),
                "about": min(
                    (t for t in totals if abs(t - 3600) <= 300),
                    key=lambda t: abs(t - 3600),
                    default=None,
                ),
            }
            for mode, best in oracle.items():
                with self.subTest(total=sum(lengths), mode=mode):
                    report = self.report(self.timed(mode, 3600, filters={"artists": ["Harbor"]}))
                    self.assertEqual(report["met"], best is not None)
                    if best is not None:
                        self.assertEqual(report["total_seconds"], float(best))

    def test_reported_totals_are_the_milliseconds_the_search_compared(self) -> None:
        # Three songs of 1200.0004 s are 3,600,000 ms: at most an hour, not under it. The float
        # sum, 3600.0012, would read as over N, so it must not be what is reported.
        self.lengths(
            {
                "Echo": 1200.0004,
                "Echo (Live)": 1200.0004,
                "Echo (Remix)": 1200.0004,
                "Echo - 2011 Remaster": 9000,
            }
        )
        three = {self.ids[t] for t in ("Echo", "Echo (Live)", "Echo (Remix)")}
        at_most = self.timed("at_most", 3600, filters={"artists": ["Harbor"]})
        report = self.report(at_most)
        self.assertTrue(report["met"])
        self.assertEqual(set(self.ids_of(at_most)), three)
        self.assertEqual((report["total_seconds"], report["deviation_seconds"]), (3600.0, 0.0))
        self.assertEqual(at_most["total_seconds"], 3600.0)
        under = self.timed("under", 3600, filters={"artists": ["Harbor"]})
        report = self.report(under)
        self.assertTrue(report["met"])
        self.assertEqual(len(self.ids_of(under)), 2)
        self.assertEqual((report["total_seconds"], report["deviation_seconds"]), (2400.0, -1200.0))
        # A single song of 3600.0004 s is not under an hour, and its alternative says 60:00.
        self.lengths({"Hail": 3600.0004})
        alone = self.timed("under", 3600, filters={"artists": ["Ridge"], "year_from": 1988})
        report = self.report(alone)
        self.assertFalse(report["met"])
        longer = report["alternative"]
        assert isinstance(longer, dict)
        self.assertEqual((longer["total_seconds"], longer["deviation_seconds"]), (3600.0, 0.0))

    def test_an_unmet_about_target_keeps_the_shorter_strict_selection_and_offers_longer(
        self,
    ) -> None:
        # Dawn alone is 50:00 and both are 66:40: neither is within five minutes of an hour.
        self.lengths({"Dawn": 3000, "Dusk": 1000})
        result = self.timed("about", 3600, filters={"artists": ["Orchard"]})
        report = self.report(result)
        self.assertEqual(self.ids_of(result), [self.ids["Dawn"]])
        self.assertFalse(report["met"])
        self.assertEqual(report["unmet_reason"], "proven")
        self.assertEqual(report["deviation_seconds"], -600.0)
        self.assertEqual(result["shortfall_seconds"], 600.0)
        self.assertEqual(set(self.alternative(result) or []), {self.ids["Dawn"], self.ids["Dusk"]})
        longer = report["alternative"]
        assert isinstance(longer, dict)
        self.assertEqual((longer["total_seconds"], longer["deviation_seconds"]), (4000.0, 400.0))
        self.assertIn("The longer option is 2 songs, 66.7 minutes.", str(result["summary"]))
        self.assertIn("no filters were relaxed", str(result["summary"]))

    def test_one_long_mix_is_offered_and_never_cut(self) -> None:
        self.lengths({"Hail": 7200})
        for mode in ("about", "under", "at_most"):
            with self.subTest(mode=mode):
                result = self.timed(mode, 3600, filters={"artists": ["Ridge"], "year_from": 1988})
                report = self.report(result)
                self.assertEqual(self.ids_of(result), [])
                self.assertEqual(report["total_seconds"], 0.0)
                self.assertFalse(report["met"])
                self.assertEqual(report["unmet_reason"], "proven")
                self.assertEqual(self.alternative(result), [self.ids["Hail"]])
                self.assertIn("Nothing shorter fits", str(result["summary"]))

    def test_an_unknown_zero_or_infinite_length_cannot_count(self) -> None:
        self.lengths({"Mist": 0, "Fog": float("inf")})
        timed = self.timed("about", 600, filters={"genres": ["jazz"]})
        report = self.report(timed)
        self.assertEqual(self.ids_of(timed), [])
        self.assertEqual(report["unknown_length"], 2)
        self.assertFalse(report["met"])
        self.assertEqual(report["unmet_reason"], "proven")
        self.assertIn("2 matching songs have no known length", str(timed["summary"]))
        # With no time constraint they are still found, as before.
        plain = self.run_at(parse_intent(V3 | {"filters": {"genres": ["jazz"]}}))
        self.assertEqual(set(self.ids_of(plain)), {self.ids["Mist"], self.ids["Fog"]})
        self.assertIsNone(plain["duration"])

    async def test_a_stored_nonfinite_length_does_not_break_a_reply(self) -> None:
        # SQLite keeps an infinite length and JSON cannot carry it, so one such row used to
        # turn a bare target_seconds fill (and any reply listing that song) into a 500.
        self.lengths({"Mist": float("inf"), "Fog": float("-inf")})
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for filters in ({"genres": ["jazz"]}, {"target_seconds": 3600}):
                with self.subTest(filters=filters):
                    reply = await client.post(
                        "/api/music-bot/intent", json=PLAIN | {"filters": filters}
                    )
                    self.assertEqual(reply.status_code, 200)
                    durations = [t["duration"] for t in reply.json()["tracks"]]
                    self.assertTrue(all(d == 0 or d == 200 for d in durations))
        filled = self.run_at(intent(filters={"target_seconds": 3600}))
        self.assertNotIn(self.ids["Mist"], self.ids_of(filled))
        self.assertNotIn(self.ids["Fog"], self.ids_of(filled))

    def test_filters_hold_when_the_time_cannot_be_met(self) -> None:
        # Rock songs are long enough to reach an hour; the request asks for jazz.
        self.lengths({"Rain": 1800, "Snow": 1800, "Hail": 1800})
        jazz = self.timed("at_least", 3600, filters={"genres": ["jazz"]})
        self.assertEqual(set(self.ids_of(jazz)), {self.ids["Mist"], self.ids["Fog"]})
        self.assertEqual({str(t["genre"]) for t in jazz["tracks"]}, {"Jazz"})  # type: ignore[attr-defined]
        report = self.report(jazz)
        self.assertEqual((report["met"], report["unmet_reason"]), (False, "proven"))
        self.assertEqual(jazz["shortfall_seconds"], 3200.0)
        self.assertIsNone(report["alternative"])
        without = self.timed("about", 7200, filters={"exclude_artists": ["Quarry", "Ridge"]})
        artists = {str(t["artist"]) for t in without["tracks"]}  # type: ignore[attr-defined]
        self.assertFalse(artists & {"Quarry", "Ridge"})
        self.assertFalse(self.report(without)["met"])

    def test_the_artist_cap_title_rule_and_named_artist_exception_still_apply(self) -> None:
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET title='Echo' WHERE song_id=?", (self.ids["Echo (Live)"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        broad = self.timed("at_least", 86400, seed=4)
        counts: dict[str, int] = {}
        for track in broad["tracks"]:  # type: ignore[attr-defined]
            counts[track["artist"]] = counts.get(track["artist"], 0) + 1
        self.assertEqual(max(counts.values()), ARTIST_CAP)
        named = self.timed("at_least", 86400, seed=4, filters={"artists": ["Harbor"]})
        titles = [str(t["title"]) for t in named["tracks"]]  # type: ignore[attr-defined]
        self.assertEqual(len(titles), 3)
        self.assertEqual(titles.count("Echo"), 1)

    def test_a_capped_search_says_not_found_rather_than_proven(self) -> None:
        # Three songs cannot reach 1,000 seconds, but the library could.
        with patch("backend.library.music_bot.CANDIDATE_CAP", 3):
            result = self.timed("at_least", 1000, seed=1)
        report = self.report(result)
        self.assertEqual((report["candidates"], report["candidates_capped"]), (3, True))
        self.assertEqual((report["met"], report["unmet_reason"]), (False, "not_found"))
        self.assertIn("within the search limit", str(result["summary"]))
        whole = self.report(self.timed("at_least", 1000, seed=1))
        self.assertEqual((whole["met"], whole["candidates_capped"]), (True, False))
        self.assertEqual(whole["total_seconds"], 1000.0)

    def test_the_same_seed_and_snapshot_give_the_same_set(self) -> None:
        self.lengths({"Rain": 151, "Snow": 233, "Hail": 307, "Dawn": 419, "Mist": 97})
        first = self.timed("about", 1000, seed=5)
        second = self.timed("about", 1000, seed=5)
        self.assertEqual(self.ids_of(first), self.ids_of(second))
        self.assertEqual(self.report(first), self.report(second))
        self.assertTrue(self.report(first)["met"])

    def test_a_bare_target_keeps_todays_fill(self) -> None:
        for version in (1, 2, 3, 4, 5):
            with self.subTest(version=version):
                result = self.run_at(
                    parse_intent(
                        {"contract_version": version, "action": "search", "seed": 8}
                        | {"filters": {"target_seconds": 600}}
                    )
                )
                expected = self.legacy({"target_seconds": 600}, generation_seed=8)
                self.assertEqual(self.ids_of(result), self.legacy_ids(expected))
                self.assertEqual(result["summary"], expected["summary"])
                self.assertEqual(result["shortfall_seconds"], expected["shortfall_seconds"])
                self.assertIsNone(result["duration"])
                # The chat's reply has no duration report at all.
                self.assertNotIn("duration", expected)

    def test_total_length_needs_version_three_and_no_target_seconds(self) -> None:
        total = {"total_length": {"mode": "about", "seconds": 600}}
        for version in (1, 2):
            with self.subTest(version=version):
                error = self.refused(
                    {"contract_version": version, "action": "search"} | {"filters": total}
                )
                self.assertEqual(error.code, "unknown_field")
                self.assertEqual(error.fields[0].field, "filters.total_length")
        both = self.refused(V3 | {"filters": total | {"target_seconds": 600}})
        self.assertEqual(both.code, "invalid_intent")
        for bad in (
            {"mode": "roughly", "seconds": 600},
            {"mode": "about", "seconds": 0},
            {"mode": "about", "seconds": 86401},
            {"mode": "about", "seconds": 600, "crossfade": 5},
        ):
            with self.subTest(bad=bad):
                code = self.refused(V3 | {"filters": {"total_length": bad}}).code
                self.assertIn(code, {"invalid_intent", "unknown_field"})

    # No side effects

    def writes(self) -> tuple[int, object]:
        return self.store.db.total_changes, self.store.read_play_queue()

    def test_search_preview_and_errors_change_nothing_and_call_no_model(self) -> None:
        before = self.writes()
        liked = self.player.liked_id()
        self.run_at(intent(seed=1))
        self.run_at(intent(seed=1, filters={"favourites": True}))
        self.run_at(parse_intent(PLAIN | {"action": "pause"}))
        self.run_at(intent(scope="proposal", context={"proposal_ids": [self.ids["Dawn"]]}))
        for body in [
            PLAIN | {"filters": {"tempo": "fast"}},
            PLAIN | {"scope": "queue"},
            PLAIN | {"context": {"reference_id": "tr-0123456789abcdef"}},
        ]:
            self.refused(body)
        self.assertEqual(self.writes(), before)
        self.assertEqual(self.player.liked_id(), liked)
        self.assertEqual(self.asked, [])

    async def test_route_success_errors_and_cancel_write_nothing(self) -> None:
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        before = self.writes()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            ok = await client.post("/api/music-bot/intent", json=PLAIN | {"seed": 4})
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(ok.json()["status"], "ok")
            self.assertEqual(len(ok.json()["ids"]), len(ok.json()["tracks"]))
            for body, status, code in [
                (b"{not json", 400, "malformed_request"),
                (b"[]", 400, "malformed_request"),
                (b"x" * 262145, 413, "malformed_request"),
                (b"[" * 100000, 400, "malformed_request"),
                (
                    json.dumps({"contract_version": 9, "action": "search"}).encode(),
                    422,
                    "unsupported_version",
                ),
                (json.dumps(PLAIN | {"extra": 1}).encode(), 422, "unknown_field"),
                (json.dumps(PLAIN | {"filters": {"limit": 0}}).encode(), 422, "invalid_intent"),
                (
                    json.dumps(PLAIN | {"filters": {"tempo": "fast"}}).encode(),
                    422,
                    "unsupported_capability",
                ),
            ]:
                with self.subTest(code=code):
                    response = await client.post("/api/music-bot/intent", content=body)
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json()["status"], "error")
                    self.assertEqual(response.json()["error"]["code"], code)
            with (
                patch.object(Engine, "run", side_effect=RuntimeError("boom")),
                self.assertLogs("uvicorn.error", "ERROR"),
            ):
                failed = await client.post("/api/music-bot/intent", json=PLAIN)
            self.assertEqual(failed.status_code, 500)
            self.assertEqual(failed.json()["error"]["code"], "internal_error")
            self.assertNotIn("boom", failed.text)
            # The legacy routes beside it still answer.
            legacy = await client.post(
                "/api/music-bot/validate",
                json={"ids": [self.ids["Dawn"]], "plan": self.legacy({})["plan"]},
            )
            self.assertEqual(legacy.status_code, 200)
        self.assertEqual(self.writes(), before)
        self.assertEqual(self.asked, [])

    async def test_a_cancelled_request_returns_499_and_changes_nothing(self) -> None:
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)

        async def gone(_: object) -> None:
            return None

        before = self.writes()
        with patch("backend.api.music_bot_api.until_disconnected", gone):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post("/api/music-bot/intent", json=PLAIN)
        self.assertEqual(response.status_code, 499)
        self.assertEqual(self.writes(), before)

    def test_the_numbers_behind_the_engine_version_are_pinned(self) -> None:
        # A change to any of these changes which songs a seed picks. Bump ENGINE_VERSION with it.
        self.assertEqual(
            (
                ENGINE_VERSION,
                ARTIST_CAP,
                RELEVANCE_RATIO,
                SHOWN_LIMIT,
                SEED_LIMIT,
                ABOUT_WINDOW,
                CANDIDATE_CAP,
                WORK_LIMIT,
            ),
            (4, 2, 4.0, 500, 2**53, 300, 600, 50_000),
        )

    # Kept, pinned and excluded songs (contract version 5)

    def edit_run(self, **body: object) -> dict[str, object]:
        return self.run_at(parse_intent({"contract_version": 5, "action": "search"} | body))

    def edit_refused(self, **body: object) -> EngineError:
        return self.refused({"contract_version": 5, "action": "search"} | body)

    def test_newer_fields_are_unknown_under_an_older_version(self) -> None:
        song = self.ids["Dawn"]
        fields: list[tuple[str, dict[str, object]]] = [
            ("filters.exclude_ids", {"filters": {"exclude_ids": [song]}}),
            ("context.keep_ids", {"context": {"keep_ids": [song]}}),
            ("context.pinned_ids", {"context": {"pinned_ids": [song]}}),
            ("context.add_count", {"context": {"add_count": 0}}),
        ]
        for version in (1, 2, 3, 4):
            for name, body in fields:
                with self.subTest(version=version, field=name):
                    error = self.refused({"contract_version": version, "action": "search"} | body)
                    self.assertEqual((error.code, error.status), ("unknown_field", 422))
                    self.assertEqual([item.field for item in error.fields], [name])
        # An intent that uses none of them is unchanged under every version.
        for version in (1, 2, 3, 4, 5):
            with self.subTest(version=version):
                plain = self.run_at(
                    parse_intent({"contract_version": version, "action": "search", "seed": 1})
                )
                self.assertEqual(len(self.ids_of(plain)), 10)

    def test_kept_songs_come_first_as_they_are_even_when_the_filters_would_drop_them(self) -> None:
        # Mist is Jazz and Dawn was played: neither matches Rock that is unplayed.
        kept = [self.ids["Mist"], self.ids["Dawn"], self.ids["Hail"]]
        result = self.edit_run(
            seed=1,
            filters={"genres": ["Rock"], "history": "unplayed", "limit": 6},
            context={"keep_ids": kept},
        )
        ids = self.ids_of(result)
        self.assertEqual(ids[:3], kept)
        self.assertEqual((len(ids), len(set(ids))), (6, 6))
        # The same ids and the same order, every time.
        again = self.edit_run(
            seed=1,
            filters={"genres": ["Rock"], "history": "unplayed", "limit": 6},
            context={"keep_ids": kept},
        )
        self.assertEqual(self.ids_of(again), ids)

    def test_kept_songs_are_never_cut_by_the_limit_or_a_target(self) -> None:
        kept = [self.ids[title] for title in ("Dawn", "Mist", "Rain", "Hail")]
        small = self.edit_run(seed=1, filters={"limit": 2}, context={"keep_ids": kept})
        self.assertEqual(self.ids_of(small), kept)
        # 600 seconds are reached by three 200 second songs, but all four stay.
        target = self.edit_run(seed=1, filters={"target_seconds": 600}, context={"keep_ids": kept})
        self.assertEqual(self.ids_of(target), kept)
        # With room left, the walk stops as soon as the target is reached.
        room = self.edit_run(
            seed=1,
            filters={"target_seconds": 1000},
            context={"keep_ids": kept[:2]},
        )
        self.assertEqual(self.ids_of(room)[:2], kept[:2])
        self.assertEqual(sum(200 for _ in self.ids_of(room)), 1000)

    def test_a_number_to_add_is_the_most_that_follows_the_kept_songs(self) -> None:
        kept = [self.ids["Dawn"], self.ids["Mist"]]
        for add, size in ((0, 2), (1, 3), (3, 5)):
            with self.subTest(add=add):
                result = self.edit_run(
                    seed=1,
                    filters={"limit": 2},
                    context={"keep_ids": kept, "add_count": add},
                )
                self.assertEqual(self.ids_of(result)[:2], kept)
                self.assertEqual(len(self.ids_of(result)), size)
        # A fill by length adds no more than the number either.
        more = self.edit_run(
            seed=1,
            filters={"target_seconds": 2000},
            context={"keep_ids": kept, "add_count": 2},
        )
        self.assertEqual(len(self.ids_of(more)), 4)
        # With nothing kept, the number is how many songs there are.
        fresh = self.edit_run(seed=1, context={"add_count": 3})
        self.assertEqual(len(self.ids_of(fresh)), 3)
        # A short list says how many it could add.
        only = self.edit_run(
            seed=1,
            filters={"genres": ["Jazz"]},
            context={"keep_ids": [self.ids["Dawn"]], "add_count": 5},
        )
        self.assertEqual(len(self.ids_of(only)), 3)
        self.assertIn("Could only add 2 of 5", str(only["summary"]))

    def test_kept_songs_hold_their_places_in_the_artist_cap(self) -> None:
        kept = [self.ids["Echo"], self.ids["Dawn"], self.ids["Dusk"]]
        result = self.edit_run(seed=1, filters={"limit": 12}, context={"keep_ids": kept})
        stored = self.player.view().stored
        artists = [stored[sid].artist for sid in self.ids_of(result)]
        # Orchard is capped at the two kept, and Harbor has room for one more song only.
        self.assertEqual(artists.count("Orchard"), 2)
        self.assertEqual(artists.count("Harbor"), 2)
        self.assertEqual(self.ids_of(result)[:3], kept)
        # Three of one artist kept stay: the cap limits what is added, never what is kept.
        three = [self.ids[t] for t in ("Echo", "Echo (Live)", "Echo (Remix)")]
        crowded = self.edit_run(seed=1, context={"keep_ids": three})
        self.assertEqual(self.ids_of(crowded)[:3], three)
        self.assertEqual([stored[sid].artist for sid in self.ids_of(crowded)].count("Harbor"), 3)

    def test_excluded_songs_are_never_picked_in_any_scope(self) -> None:
        gone = [self.ids[title] for title in ("Dawn", "Mist", "Echo")]
        library = self.edit_run(seed=1, filters={"limit": 12, "exclude_ids": gone})
        self.assertFalse(set(gone) & set(self.ids_of(library)))
        everything = list(self.ids.values())
        for scope, key in (("proposal", "proposal_ids"), ("queue", "queue_ids")):
            with self.subTest(scope=scope):
                result = self.edit_run(
                    scope=scope, filters={"exclude_ids": gone}, context={key: everything}
                )
                self.assertEqual(
                    self.ids_of(result), [sid for sid in everything if sid not in gone]
                )
        # Excluded songs that are not in the library are harmless: the person may have lost them.
        stale = self.edit_run(seed=1, filters={"exclude_ids": ["tr-0000000000000000"]})
        self.assertEqual(len(self.ids_of(stale)), 10)

    def test_kept_songs_that_do_not_fit_together_or_cannot_play_are_refused(self) -> None:
        dawn, mist = self.ids["Dawn"], self.ids["Mist"]
        cases: list[tuple[dict[str, object], str, int]] = [
            ({"context": {"keep_ids": [dawn, dawn]}}, "invalid_intent", 422),
            ({"context": {"keep_ids": [dawn], "pinned_ids": [mist]}}, "invalid_intent", 422),
            (
                {"context": {"keep_ids": [dawn]}, "filters": {"exclude_ids": [dawn]}},
                "invalid_intent",
                422,
            ),
            (
                {"scope": "proposal", "context": {"proposal_ids": [mist], "keep_ids": [dawn]}},
                "invalid_intent",
                422,
            ),
            (
                {"scope": "proposal", "context": {"proposal_ids": [mist], "add_count": 1}},
                "invalid_intent",
                422,
            ),
            ({"context": {"add_count": 0}}, "invalid_intent", 422),
            ({"context": {"keep_ids": ["tr-0000000000000000"]}}, "unknown_song", 422),
            (
                {"context": {"keep_ids": [dawn], "add_count": 500}},
                "selection_too_large",
                422,
            ),
            (
                {"context": {"keep_ids": [f"tr-{n:016x}" for n in range(501)]}},
                "selection_too_large",
                422,
            ),
            (
                {"filters": {"exclude_ids": [f"tr-{n:016x}" for n in range(1001)]}},
                "invalid_intent",
                422,
            ),
        ]
        for body, code, status in cases:
            with self.subTest(body=str(body)[:80]):
                error = self.edit_refused(**body)
                self.assertEqual((error.code, error.status), (code, status))
        # A file that is gone is a conflict by name, never a song quietly dropped.
        (self.music / "4.wav").unlink()
        gone = self.edit_refused(seed=1, context={"keep_ids": [mist, dawn]})
        self.assertEqual((gone.code, gone.status), ("song_unavailable", 409))
        self.assertEqual([item.field for item in gone.fields], [f"context.keep_ids.{dawn}"])

    def test_a_replay_of_a_kept_selection_is_the_same_selection(self) -> None:
        body = {
            "seed": 3,
            "filters": {"limit": 8},
            "context": {"keep_ids": [self.ids["Rain"], self.ids["Fog"]], "add_count": 4},
        }
        first, second = self.edit_run(**body), self.edit_run(**body)
        self.assertEqual(self.ids_of(first), self.ids_of(second))
        other = self.edit_run(
            **(
                body
                | {"context": {"keep_ids": [self.ids["Fog"], self.ids["Rain"]], "add_count": 4}}
            )
        )
        # The order given is the order kept.
        self.assertEqual(self.ids_of(other)[:2], [self.ids["Fog"], self.ids["Rain"]])

    def test_kept_songs_count_in_a_total_length_and_a_number_adds_greedily(self) -> None:
        kept = [self.ids[t] for t in ("Dawn", "Mist", "Rain")]
        # 600 s are kept. At least 1000 s with two more songs is exact.
        met = self.timed(
            "at_least", 1000, contract_version=5, context={"keep_ids": kept, "add_count": 2}
        )
        self.assertEqual(self.ids_of(met)[:3], kept)
        self.assertEqual((len(self.ids_of(met)), self.report(met)["met"]), (5, True))
        self.assertEqual(self.report(met)["kept"], 3)
        # One song is not enough: 800 s, the kept songs stay, and it says what happened.
        short = self.timed(
            "at_least", 1000, contract_version=5, context={"keep_ids": kept, "add_count": 1}
        )
        self.assertEqual((len(self.ids_of(short)), self.report(short)["met"]), (4, False))
        self.assertIn("Adding 1 song did not make it", str(short["summary"]))
        self.assertNotIn("search limit", str(short["summary"]))
        # A ceiling is kept: of five songs asked for, only those that stay under it are added.
        ceiling = self.timed(
            "at_most", 1000, contract_version=5, context={"keep_ids": kept, "add_count": 5}
        )
        self.assertEqual(
            (len(self.ids_of(ceiling)), self.report(ceiling)["total_seconds"]), (5, 1000.0)
        )
        self.assertTrue(self.report(ceiling)["met"])
        # Without a number the search chooses the closest total around the kept songs.
        free = self.timed("about", 1000, contract_version=5, context={"keep_ids": kept})
        self.assertEqual(self.ids_of(free)[:3], kept)
        self.assertEqual(
            (self.report(free)["total_seconds"], self.report(free)["met"]), (1000.0, True)
        )
        # Kept songs already over a ceiling are proven unmet, and none is dropped.
        over = self.timed("under", 500, contract_version=5, context={"keep_ids": kept})
        self.assertEqual(self.ids_of(over), kept)
        self.assertEqual(
            (self.report(over)["met"], self.report(over)["unmet_reason"]), (False, "proven")
        )
        self.assertIsNone(self.report(over)["alternative"])
        self.assertIn("No selection that keeps those songs", str(over["summary"]))

    def test_a_kept_song_with_no_length_stays_and_is_counted_as_unknown(self) -> None:
        self.lengths({"Dawn": 0})
        kept = [self.ids["Dawn"], self.ids["Mist"]]
        result = self.timed("at_least", 600, contract_version=5, context={"keep_ids": kept})
        self.assertEqual(self.ids_of(result)[:2], kept)
        report = self.report(result)
        self.assertEqual((report["unknown_length"], report["kept"], report["met"]), (1, 2, True))
        self.assertEqual(report["total_seconds"], 600.0)

    def test_a_kept_song_with_no_length_still_holds_its_artist_place(self) -> None:
        # Harbor has four songs. Two are kept, one with no length; the cap of two is full.
        self.lengths({"Echo": 0})
        kept = [self.ids["Echo"], self.ids["Echo (Live)"]]
        harbor = {
            self.ids[t] for t in ("Echo", "Echo (Live)", "Echo (Remix)", "Echo - 2011 Remaster")
        }
        for context in ({"keep_ids": kept}, {"keep_ids": kept, "add_count": 5}):
            with self.subTest(context=context):
                result = self.timed("at_least", 2400, contract_version=5, context=context)
                self.assertEqual(len(harbor & set(self.ids_of(result))), ARTIST_CAP)


class SolverTests(unittest.TestCase):
    """The search alone, with no library: lengths in milliseconds."""

    def test_unusable_lengths_have_no_milliseconds(self) -> None:
        for seconds in (0.0, -1.0, 0.0004, float("inf"), float("-inf"), float("nan")):
            with self.subTest(seconds=seconds):
                self.assertIsNone(length_ms(seconds))
        self.assertEqual(length_ms(200.25), 200250)

    def test_the_work_limit_stops_the_search_and_is_not_a_proof(self) -> None:
        # Twenty 1,000 second songs: one is under the window of about 1,500, two are over it.
        items = [Item(1_000_000) for _ in range(20)]
        stopped = search(items, 500, 2, 1_200_000, 1_800_001, 1_500_000, 3)
        self.assertEqual((stopped.picked, stopped.complete, stopped.work), ([], False, 3))
        short = fit("about", 1500, items, items, False, 500, 2, work_limit=3)
        self.assertEqual((short.met, short.unmet, short.complete), (False, "not_found", False))
        full = fit("about", 1500, items, items, False, 500, 2)
        self.assertEqual((full.met, full.unmet, full.complete), (False, "proven", True))
        self.assertEqual((full.picked, full.alternative), ([0], [0, 1]))

    def test_the_longest_total_follows_the_group_and_key_rules(self) -> None:
        items = [
            Item(5, "a", ("x", "a")),
            Item(9, "a", ("x", "a")),
            Item(4, "a", ("y", "a")),
            Item(3, "a", ("z", "a")),
            Item(7),
            Item(1),
        ]
        # One of the two x titles (the 9), then a's cap of two (9 and 4), then 7 and 1.
        self.assertEqual(most(items, 500, 2), 21)
        self.assertEqual(most(items, 2, 2), 16)

    def test_a_tie_keeps_the_earlier_songs(self) -> None:
        items = [Item(400_000), Item(300_000), Item(300_000), Item(100_000)]
        found = fit("at_most", 700, items, items, False, 500, 2)
        self.assertEqual((found.picked, found.total_ms), ([0, 1], 700_000))

    def test_kept_songs_already_in_range_make_picking_nothing_a_valid_answer(self) -> None:
        kept = [Item(400_000)]
        # The floor is met by the kept songs alone: nothing is added to reach it.
        met = fit("at_least", 400, [Item(100_000)], [Item(100_000)], False, 500, 2, taken=kept)
        self.assertEqual((met.met, met.picked, met.total_ms), (True, [], 400_000))
        # A floor they do not reach is met from the bounds relative to them.
        more = [Item(100_000), Item(100_000), Item(100_000)]
        reach = fit("at_least", 600, more, more, False, 500, 2, taken=kept)
        self.assertEqual((reach.met, reach.picked, reach.total_ms), (True, [0, 1], 600_000))
        # A ceiling counts them too: 400 + 300 is the most that stays at or under 700.
        ceiling = fit(
            "at_most",
            700,
            [Item(300_000), Item(400_000)],
            [Item(300_000)] * 2,
            False,
            500,
            2,
            taken=kept,
        )
        self.assertEqual((ceiling.met, ceiling.total_ms), (True, 700_000))

    def test_kept_songs_at_or_past_a_ceiling_are_proven_unmet_with_no_alternative(self) -> None:
        items = [Item(100_000)]
        cases: list[tuple[Mode, int, int]] = [
            ("under", 300, 300_000),
            ("at_most", 299, 300_000),
            ("about", 100, 700_000),
        ]
        for mode, seconds, kept_ms in cases:
            with self.subTest(mode=mode):
                past = fit(mode, seconds, items, items, False, 500, 2, taken=[Item(kept_ms)])
                self.assertEqual((past.met, past.unmet), (False, "proven"))
                self.assertEqual(
                    (past.picked, past.alternative, past.total_ms), ([], None, kept_ms)
                )
        # "At most 300" is met by exactly 300 of kept songs.
        edge = fit("at_most", 300, items, items, False, 500, 2, taken=[Item(300_000)])
        self.assertEqual((edge.met, edge.picked), (True, []))

    def test_a_shortage_with_kept_songs_names_only_the_songs_added(self) -> None:
        items = [Item(100_000), Item(100_000)]
        short = fit("at_least", 1000, items, items, False, 500, 2, taken=[Item(100_000)])
        # 100 + 200 is all there is: proven, the longest below the floor, and the kept song is
        # in the total but not in `picked`.
        self.assertEqual((short.met, short.unmet, short.complete), (False, "proven", True))
        self.assertEqual((short.picked, short.total_ms), ([0, 1], 300_000))
        # A long mix is offered on top of the kept songs, never cut.
        mix = [Item(1_000_000)]
        offered = fit("about", 600, mix, mix, False, 500, 2, taken=[Item(100_000)])
        self.assertEqual((offered.picked, offered.total_ms), ([], 100_000))
        self.assertEqual((offered.alternative, offered.alternative_ms), ([0], 1_100_000))

    def test_kept_songs_hold_their_places_in_the_cap_the_key_rule_and_the_limit(self) -> None:
        # Two songs of artist "a" are kept, so no other "a" song may join them.
        items = [Item(100_000, "a"), Item(100_000, "b")]
        kept = [Item(100_000, "a"), Item(100_000, "a")]
        found = search(items, 500, 2, 0, None, 1_000_000, 1000, kept)
        self.assertEqual(found.picked, [1])
        # The title of a kept song is not picked again.
        titled = [Item(100_000, None, ("x", "a")), Item(100_000, None, ("y", "a"))]
        again = search(titled, 500, 2, 0, None, 1_000_000, 1000, [Item(100_000, None, ("x", "a"))])
        self.assertEqual(again.picked, [1])
        # `limit` is the number of songs that may join them.
        some = [Item(100_000) for _ in range(5)]
        limited = search(some, 2, 2, 0, None, 10_000_000, 1000, [Item(100_000)])
        self.assertEqual(len(limited.picked), 2)

    def test_fit_with_kept_songs_agrees_with_trying_every_selection(self) -> None:
        # A fixed pseudo-random set of small cases, compared with a search of every subset.
        rng = random.Random(7)
        modes: tuple[Mode, ...] = ("under", "at_most", "at_least", "over", "about")

        def allowed(kept: list[Item], candidates: list[Item], chosen: tuple[int, ...]) -> bool:
            groups = Counter(item.group for item in kept if item.group is not None)
            keys = {item.unique for item in kept if item.unique is not None}
            for index in chosen:
                item = candidates[index]
                if item.group is not None:
                    groups[item.group] += 1
                    if groups[item.group] > 2:
                        return False
                if item.unique is not None:
                    if item.unique in keys:
                        return False
                    keys.add(item.unique)
            return True

        def song() -> Item:
            return Item(
                rng.randint(1, 12) * 1000,
                rng.choice([None, "a", "b"]),
                rng.choice([None, (rng.randint(0, 3), "t")]),
            )

        for case in range(400):
            mode = rng.choice(modes)
            seconds = rng.randint(1, 40)
            candidates = [song() for _ in range(rng.randint(0, 7))]
            kept = [song() for _ in range(rng.randint(0, 3))]
            limit = rng.randint(0, 5)
            found = fit(mode, seconds, candidates, candidates, False, limit, 2, taken=kept)
            floor, ceiling, _ = bounds(mode, seconds)
            base = sum(item.ms for item in kept)

            possible = any(
                allowed(kept, candidates, chosen)
                and floor <= base + sum(candidates[i].ms for i in chosen)
                and (ceiling is None or base + sum(candidates[i].ms for i in chosen) < ceiling)
                for size in range(min(limit, len(candidates)) + 1)
                for chosen in itertools.combinations(range(len(candidates)), size)
            )
            with self.subTest(case=case, mode=mode):
                self.assertEqual(found.met, possible)
                if found.met:
                    self.assertTrue(allowed(kept, candidates, tuple(found.picked)))
                    self.assertLessEqual(len(found.picked), limit)
                    self.assertEqual(
                        found.total_ms, base + sum(candidates[i].ms for i in found.picked)
                    )
                    self.assertGreaterEqual(found.total_ms, floor)
                    self.assertTrue(ceiling is None or found.total_ms < ceiling)
                elif found.unmet == "proven":
                    self.assertFalse(possible)


if __name__ == "__main__":
    unittest.main()
