"""Discovery strength: a soft lean inside the eligible pool, from contract version 6.

Balanced is today's walk, exactly. Close and explore only reorder songs that pass every filter,
are seeded and repeatable, and say when they could not lean as far as asked.
"""

import math
import random
import unittest
from collections.abc import Collection, Iterable, Mapping
from pathlib import Path
from typing import Any

import httpx
import test_engine
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.store import Store
from backend.library.duration import TotalLength
from backend.library.engine import Engine, parse_intent
from backend.library.engine_contract import (
    CONTRACT_VERSION,
    DISCOVERY_VERSION,
    ENGINE_VERSION,
    EngineError,
    registry,
)
from backend.library.index import Library
from backend.library.music_bot import ARTIST_CAP, MusicBot
from backend.library.player import Player, StoredSong
from backend.library.selection import (
    RELEVANCE_RATIO,
    Drawn,
    broad_order,
    gumbel,
    sample_key,
)

V5 = {"contract_version": 5, "action": "search"}
V6 = {"contract_version": DISCOVERY_VERSION, "action": "search"}
SEEDS = range(12)
JsonObject = dict[str, Any]


def before_broad_order(
    ids: Iterable[str],
    seed: int,
    need: int,
    relevance: Mapping[str, float] | None,
    shown: Collection[str],
) -> Drawn:
    """`broad_order` as it was before discovery (4cb34d8), kept here so balanced is compared
    with the old code and not with itself."""
    keys = {sid: sample_key(seed, sid) for sid in dict.fromkeys(ids)}

    def fit(sid: str) -> float:
        return relevance[sid] if relevance is not None else 0.0

    base = sorted(keys, key=lambda sid: (-fit(sid), sid in shown, keys[sid], sid))
    count = len(base)
    needed = min(max(need, 1), count)
    sampled = count > needed
    if relevance is None or not sampled:
        return Drawn(base, count, sampled)
    best = fit(base[0])
    floor = max(round(2 * fit(base[needed - 1]) - best, 6), fit(base[min(count, 2 * needed) - 1]))
    width = needed
    while width < min(count, 2 * needed) and fit(base[width]) >= floor:
        width += 1
    window = base[:width]
    spread = best - fit(window[-1])
    scale = spread / math.log(RELEVANCE_RATIO) if spread > 0 else 0.0
    noise = {sid: gumbel(sample_key(seed, sid, b"musimo-gumbel")) for sid in window}

    def score(sid: str) -> float:
        return (fit(sid) - best) / scale + noise[sid] if scale else noise[sid]

    drawn = sorted(window, key=lambda sid: (-score(sid), keys[sid], sid))
    walk = [sid for sid in drawn if sid not in shown] + [sid for sid in drawn if sid in shown]
    return Drawn(walk + base[width:], width, sampled)


class BroadOrderTests(unittest.TestCase):
    def pool(self, rng: random.Random, count: int) -> list[str]:
        return [f"tr-{rng.getrandbits(64):016x}" for _ in range(count)]

    def test_no_lean_is_the_old_order_over_many_seeds_and_shapes(self) -> None:
        rng = random.Random(179)
        for case in range(60):
            ids = self.pool(rng, rng.randint(1, 40))
            ranked = case % 2 == 0
            relevance = {sid: round(rng.choice([0.1, 0.5, 0.9, rng.random()]), 6) for sid in ids}
            shown = set(rng.sample(ids, rng.randint(0, len(ids))))
            need = rng.randint(1, 45)
            seed = rng.getrandbits(52)
            with self.subTest(case=case):
                old = before_broad_order(ids, seed, need, relevance if ranked else None, shown)
                self.assertEqual(
                    broad_order(ids, seed, need, relevance if ranked else None, shown), old
                )
                # A lean that ranks every song the same is no lean either.
                flat = dict.fromkeys(ids, 1)
                self.assertEqual(
                    broad_order(ids, seed, need, relevance if ranked else None, shown, flat), old
                )

    def test_a_lean_only_reorders_within_a_tier_of_fit(self) -> None:
        rng = random.Random(6)
        for case in range(40):
            ids = self.pool(rng, 30)
            relevance = {sid: rng.choice([0.2, 0.6]) for sid in ids}
            prefer = {sid: rng.randint(0, 2) for sid in ids}
            shown = set(ids[:5])
            seed = rng.getrandbits(52)
            ranked = relevance if case % 2 else None
            with self.subTest(case=case):
                walk = broad_order(ids, seed, 30, ranked, shown, prefer).ids
                self.assertEqual(sorted(walk), sorted(ids))
                self.assertEqual(walk, broad_order(ids, seed, 30, ranked, shown, prefer).ids)
                # Need covers every song, so nothing is sampled: fit, then shown, then the lean.
                keys = [
                    (-(ranked[sid] if ranked else 0.0), sid in shown, prefer[sid]) for sid in walk
                ]
                self.assertEqual(keys, sorted(keys))

    def test_inside_a_sampled_window_the_lean_goes_first(self) -> None:
        rng = random.Random(60)
        ids = self.pool(rng, 50)
        relevance = {sid: round(0.5 + rng.random() / 10, 6) for sid in ids}
        prefer = {sid: index % 2 for index, sid in enumerate(ids)}
        drawn = broad_order(ids, 11, 5, relevance, (), prefer)
        window = drawn.ids[: drawn.window]
        leans = [prefer[sid] for sid in window]
        self.assertEqual(leans, sorted(leans))
        # The window holds the same songs with or without the lean when fit has no ties.
        self.assertEqual(
            set(window), set(broad_order(ids, 11, 5, relevance, ()).ids[: drawn.window])
        )


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    # Set by the engine tests' setup.
    root: Path
    music: Path
    store: Store
    player: Player
    library: Library
    client: httpx.AsyncClient
    bot: MusicBot
    engine: Engine
    ids: dict[str, str]

    async def asyncSetUp(self) -> None:
        # The engine tests' twelve songs (Harbor, Orchard, Meadow, Quarry, Ridge; Dawn and Mist
        # played), plus thirty by ten new artists in Rock, Jazz and Folk, a third of them
        # played, with lengths from 150 to 270 seconds.
        await test_engine.EngineTests.asyncSetUp(self)  # type: ignore[arg-type]
        for index in range(30):
            path = self.music / f"wide-{index}.wav"
            write_wav(path)
            tag(
                path,
                title=f"Wide {index}",
                artist=f"Artist {index % 10}",
                album="Fixture",
                year=2000 + index,
                genres=[("Rock", "Jazz", "Folk")[index % 3]],
            )
        self.library.scan()
        self.ids = {str(t["title"]): str(t["id"]) for t in self.player.view().tracks}
        with self.store.lock:
            for index in range(30):
                self.store.db.execute(
                    "UPDATE library_files SET duration=?, play_count=? WHERE song_id=?",
                    (150 + 20 * (index % 7), 3 if index % 3 == 0 else 0, self.ids[f"Wide {index}"]),
                )
            self.store.db.commit()
        self.store.bump_library_revision()
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )

    async def asyncTearDown(self) -> None:
        await self.http.aclose()
        await test_engine.EngineTests.asyncTearDown(self)  # type: ignore[arg-type]

    # Helpers

    def go(self, body: JsonObject, open_ids: list[str] | None = None) -> JsonObject:
        return self.engine.run(parse_intent(body), open_ids or [])

    def refused(self, body: JsonObject) -> EngineError:
        with self.assertRaises(EngineError) as caught:
            self.engine.run(parse_intent(body))
        return caught.exception

    def song_ids(self, result: JsonObject) -> list[str]:
        found = result["ids"]
        assert isinstance(found, list)
        return [str(sid) for sid in found]

    def stored(self) -> dict[str, StoredSong]:
        return self.player.view().stored

    def artists(self, ids: Iterable[str]) -> set[str]:
        stored = self.stored()
        return {stored[sid].artist for sid in ids}

    # Contract

    def test_discovery_is_refused_below_version_six_and_accepted_at_it(self) -> None:
        self.assertEqual((CONTRACT_VERSION, DISCOVERY_VERSION), (6, 6))
        for version in (1, 2, 3, 4, 5):
            for mode in ("close", "explore"):
                with self.subTest(version=version, mode=mode):
                    error = self.refused(
                        {"contract_version": version, "action": "search"}
                        | {"filters": {"discovery": mode}}
                    )
                    self.assertEqual(error.code, "unknown_field")
                    self.assertEqual([f.field for f in error.fields], ["filters.discovery"])
            # Balanced is the default an older intent already means, so saying it is allowed.
            with self.subTest(version=version, mode="balanced"):
                body = {"contract_version": version, "action": "search", "seed": 4}
                self.assertEqual(
                    self.song_ids(self.go(body | {"filters": {"discovery": "balanced"}})),
                    self.song_ids(self.go(body)),
                )
        for mode in ("close", "balanced", "explore"):
            with self.subTest(mode=mode):
                result = self.go(V6 | {"seed": 1, "filters": {"discovery": mode}})
                intent = result["intent"]
                assert isinstance(intent, dict)
                self.assertEqual(intent["filters"]["discovery"], mode)

    def test_unknown_discovery_values_are_refused(self) -> None:
        for value in ("wild", "", "Explore", 1, None, True):
            with self.subTest(value=value):
                with self.assertRaises(EngineError) as caught:
                    parse_intent(V6 | {"filters": {"discovery": value}})
                self.assertEqual(caught.exception.code, "invalid_intent")
                self.assertEqual(caught.exception.fields[0].field, "filters.discovery")

    async def test_the_registry_lists_discovery(self) -> None:
        found = {item.id: item for item in registry(None, None)}
        self.assertTrue(found["discovery"].available)
        self.assertEqual(found["discovery"].group, "filter")
        self.assertIn("Contract version 6", found["discovery"].note)
        response = await self.http.get("/api/music-bot/capabilities")
        body = response.json()
        self.assertEqual(body["supported_versions"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(body["engine_version"], ENGINE_VERSION)
        self.assertIn("discovery", {item["id"] for item in body["capabilities"]})

    def test_a_refinement_refuses_discovery_by_name(self) -> None:
        ids = self.song_ids(self.go(V6 | {"seed": 2, "filters": {"limit": 6}}))
        for scope, context in (("proposal", {"proposal_ids": ids}), ("queue", {"queue_ids": ids})):
            for mode in ("close", "explore"):
                with self.subTest(scope=scope, mode=mode):
                    error = self.refused(
                        V6 | {"scope": scope, "context": context, "filters": {"discovery": mode}}
                    )
                    self.assertEqual(error.code, "invalid_intent")
                    self.assertEqual(
                        [(f.field, f.message) for f in error.fields],
                        [("filters.discovery", "Library scope only")],
                    )
            with self.subTest(scope=scope, mode="balanced"):
                refined = self.go(V6 | {"scope": scope, "context": context})
                self.assertEqual(self.song_ids(refined), ids)

    def test_a_pause_with_discovery_is_refused(self) -> None:
        error = self.refused(
            {"contract_version": 6, "action": "pause"} | {"filters": {"discovery": "explore"}}
        )
        self.assertEqual(error.code, "invalid_intent")

    def test_the_chat_plan_never_carries_discovery(self) -> None:
        plan = self.engine._plan(parse_intent(V6 | {"filters": {"discovery": "explore"}}))
        self.assertNotIn("discovery", plan.model_dump())

    # Balanced is today

    def test_balanced_is_the_version_five_selection_over_seeds_and_shapes(self) -> None:
        shapes: list[JsonObject] = [
            {},
            {"limit": 5},
            {"genres": ["Rock"], "limit": 7},
            {"history": "familiar", "limit": 4},
            {"history": "unplayed", "exclude_artists": ["Harbor"]},
            {"target_seconds": 1500},
            {"total_length": {"mode": "about", "seconds": 1800}},
        ]
        for seed in SEEDS:
            for filters in shapes:
                with self.subTest(seed=seed, filters=filters):
                    old = self.go(V5 | {"seed": seed, "filters": filters})
                    new = self.go(
                        V6 | {"seed": seed, "filters": filters | {"discovery": "balanced"}}
                    )
                    self.assertEqual(self.song_ids(new), self.song_ids(old))
                    self.assertEqual(new["summary"], old["summary"])
                    self.assertNotIn("open", new["snapshot"])

    # Hard constraints hold under every lean

    def test_close_and_explore_keep_every_hard_constraint(self) -> None:
        stored = self.stored()
        excluded_ids = [self.ids["Wide 1"], self.ids["Wide 4"], self.ids["Dusk"]]
        shapes: list[JsonObject] = [
            {"genres": ["Rock"], "limit": 6},
            {"exclude_artists": ["Harbor", "Artist 2"], "limit": 8},
            {"exclude_ids": excluded_ids, "limit": 10},
            {"history": "unplayed", "limit": 6},
            {"history": "played", "limit": 6},
            {"history": "familiar", "limit": 3},
            {"genres": ["Jazz"], "total_length": {"mode": "at_most", "seconds": 700}},
            {"total_length": {"mode": "about", "seconds": 1200}, "exclude_artists": ["Ridge"]},
        ]
        context = {"reference_id": self.ids["Echo"], "shown_ids": [self.ids["Wide 0"]]}
        for mode in ("close", "explore"):
            for seed in SEEDS:
                for filters in shapes:
                    with self.subTest(mode=mode, seed=seed, filters=filters):
                        body = V6 | {
                            "seed": seed,
                            "filters": filters | {"discovery": mode},
                            "context": context,
                        }
                        result = self.go(body)
                        ids = self.song_ids(result)
                        self.assertEqual(len(ids), len(set(ids)))
                        self.assertTrue(ids)
                        balanced = self.go(
                            V6 | {"seed": seed, "filters": filters, "context": context}
                        )
                        if "total_length" not in filters:
                            # Under a total length the count follows the lengths picked.
                            self.assertEqual(len(ids), len(self.song_ids(balanced)))
                        for sid in ids:
                            song = stored[sid]
                            if "genres" in filters:
                                self.assertIn(filters["genres"][0], song.genres)
                            if "exclude_artists" in filters:
                                self.assertNotIn(song.artist, filters["exclude_artists"])
                            self.assertNotIn(sid, excluded_ids if "exclude_ids" in filters else [])
                            if filters.get("history") == "unplayed":
                                self.assertEqual(song.play_count, 0)
                            if filters.get("history") in ("played", "familiar"):
                                self.assertGreater(song.play_count, 0)
                        artists = [stored[sid].artist for sid in ids]
                        self.assertLessEqual(max(artists.count(a) for a in artists), ARTIST_CAP)
                        if "total_length" in filters:
                            length = TotalLength.model_validate(filters["total_length"])
                            report = result["duration"]
                            assert isinstance(report, dict)
                            total = sum(stored[sid].duration for sid in ids)
                            self.assertEqual(report["total_seconds"], total)
                            if length.mode == "at_most":
                                self.assertLessEqual(total, length.seconds)
                            self.assertTrue(report["met"])
                        # Same seed, same snapshot, same songs.
                        again = self.go(body)
                        self.assertEqual(self.song_ids(again), ids)
                        self.assertEqual(again["snapshot"], result["snapshot"])

    # Explore

    def test_explore_prefers_unplayed_songs_by_artists_not_shown_or_in_the_proposal(self) -> None:
        stored = self.stored()
        shown = [self.ids[f"Wide {index}"] for index in (1, 2)]  # Artist 1 and Artist 2
        opened = [self.ids["Echo"], self.ids["Rain"]]  # Harbor and Quarry
        known = self.artists(shown + opened)
        context = {"shown_ids": shown}
        familiar_in_balanced = 0
        for seed in SEEDS:
            with self.subTest(seed=seed):
                explored = self.go(
                    V6
                    | {
                        "seed": seed,
                        "filters": {"limit": 8, "discovery": "explore"},
                        "context": context,
                    },
                    opened,
                )
                ids = self.song_ids(explored)
                self.assertEqual(len(ids), 8)
                for sid in ids:
                    self.assertEqual(stored[sid].play_count, 0)
                    self.assertNotIn(stored[sid].artist, known)
                self.assertNotIn("unfamiliar", str(explored["summary"]))
                balanced = self.song_ids(
                    self.go(V6 | {"seed": seed, "filters": {"limit": 8}, "context": context})
                )
                familiar_in_balanced += sum(
                    1 for sid in balanced if stored[sid].play_count or stored[sid].artist in known
                )
                open_part = explored["snapshot"]["open"]
                self.assertEqual(open_part["count"], 2)
        # The lean changed something: left alone, the draw reaches familiar songs.
        self.assertGreater(familiar_in_balanced, 0)

    def test_explore_falls_back_on_a_small_pool_and_says_so(self) -> None:
        stored = self.stored()
        # Meadow's two jazz songs: Mist is played, Fog is not, and nothing else is Meadow.
        for seed in SEEDS:
            with self.subTest(seed=seed):
                result = self.go(
                    V6
                    | {
                        "seed": seed,
                        "filters": {"artists": ["Meadow"], "discovery": "explore"},
                    }
                )
                ids = self.song_ids(result)
                self.assertEqual(ids[0], self.ids["Fog"])
                self.assertEqual(set(ids), {self.ids["Fog"], self.ids["Mist"]})
                self.assertIn(
                    "Only 1 of 2 picked songs are unfamiliar (not played in Musimo",
                    str(result["summary"]),
                )
                self.assertIn("no filters were relaxed", str(result["summary"]))
        played = self.go(V6 | {"seed": 1, "filters": {"history": "played", "discovery": "explore"}})
        self.assertTrue(all(stored[sid].play_count for sid in self.song_ids(played)))
        self.assertIn("None of the", str(played["summary"]))
        balanced = self.go(V6 | {"seed": 1, "filters": {"artists": ["Meadow"]}})
        self.assertNotIn("unfamiliar", str(balanced["summary"]))

    def test_explore_never_counts_kept_songs_and_reads_them_as_the_proposal(self) -> None:
        kept = [self.ids["Wide 5"]]  # Artist 5
        result = self.go(
            V6
            | {
                "seed": 3,
                "filters": {"limit": 6, "discovery": "explore"},
                "context": {"keep_ids": kept, "shown_ids": []},
            }
        )
        ids = self.song_ids(result)
        self.assertEqual(ids[0], kept[0])
        stored = self.stored()
        self.assertNotIn("Artist 5", {stored[sid].artist for sid in ids[1:]})
        self.assertTrue(all(stored[sid].play_count == 0 for sid in ids[1:]))

    # Close

    def test_close_prefers_the_artists_then_the_genres_in_view(self) -> None:
        stored = self.stored()
        for seed in SEEDS:
            for context in (
                {"reference_id": self.ids["Mist"]},
                {"current_id": self.ids["Mist"]},
            ):
                with self.subTest(seed=seed, context=context):
                    result = self.go(
                        V6
                        | {
                            "seed": seed,
                            "filters": {"limit": 6, "discovery": "close"},
                            "context": context,
                        }
                    )
                    ids = self.song_ids(result)
                    self.assertEqual(len(ids), 6)
                    # Meadow first, capped at two, then only jazz songs by other artists.
                    self.assertEqual(
                        {sid for sid in ids if stored[sid].artist == "Meadow"},
                        {self.ids["Mist"], self.ids["Fog"]},
                    )
                    self.assertTrue(all("Jazz" in stored[sid].genres for sid in ids))
                    self.assertIn("Staying close: 6 of 6", str(result["summary"]))

    def test_close_reads_the_open_proposal_and_keeps_exclusions(self) -> None:
        stored = self.stored()
        opened = [self.ids["Wide 2"], self.ids["Wide 5"]]  # Artist 2 (Folk), Artist 5 (Folk)
        for seed in SEEDS:
            with self.subTest(seed=seed):
                result = self.go(
                    V6
                    | {
                        "seed": seed,
                        "filters": {
                            "limit": 4,
                            "discovery": "close",
                            "exclude_artists": ["Artist 2"],
                        },
                    },
                    opened,
                )
                ids = self.song_ids(result)
                self.assertNotIn("Artist 2", {stored[sid].artist for sid in ids})
                # Artist 5 first (any genre), up to the cap, then songs sharing its Folk tag.
                self.assertEqual([stored[sid].artist for sid in ids[:2]], ["Artist 5"] * 2)
                self.assertTrue(all("Folk" in stored[sid].genres for sid in ids[2:]))

    def test_close_with_nothing_in_view_is_balanced_and_says_nothing(self) -> None:
        for seed in SEEDS:
            with self.subTest(seed=seed):
                close = self.go(V6 | {"seed": seed, "filters": {"limit": 6, "discovery": "close"}})
                balanced = self.go(V6 | {"seed": seed, "filters": {"limit": 6}})
                self.assertEqual(self.song_ids(close), self.song_ids(balanced))
                self.assertEqual(close["summary"], balanced["summary"])

    # Proposals carry it

    async def create(self, **body: object) -> JsonObject:
        response = await self.http.post("/api/music-bot/proposals", json=V6 | body)
        self.assertEqual(response.status_code, 200, response.text)
        found = response.json()
        assert isinstance(found, dict)
        return found

    async def refine(
        self, proposal_id: object, revision: int, intent: JsonObject
    ) -> httpx.Response:
        return await self.http.post(
            f"/api/music-bot/proposals/{proposal_id}/revisions",
            json={"revision": revision, "intent": intent},
        )

    async def edit(
        self, proposal_id: object, revision: int, edit: JsonObject, op: str
    ) -> JsonObject:
        response = await self.http.post(
            f"/api/music-bot/proposals/{proposal_id}/edits",
            json={"contract_version": 6, "revision": revision, "operation_id": op, "edit": edit},
        )
        self.assertEqual(response.status_code, 200, response.text)
        found = response.json()
        assert isinstance(found, dict)
        return found

    def discovery_of(self, body: JsonObject) -> str:
        proposal = body["proposal"]
        assert isinstance(proposal, dict)
        return str(proposal["intent"]["filters"]["discovery"])

    async def test_a_follow_up_keeps_discovery_until_it_is_sent_again(self) -> None:
        created = await self.create(seed=1, filters={"limit": 6, "discovery": "explore"})
        proposal = created["proposal"]
        assert isinstance(proposal, dict)
        pid = proposal["id"]
        first = [str(sid) for sid in proposal["ids"]]
        self.assertEqual(self.discovery_of(created), "explore")
        # Left out: kept. The open proposal (revision 1) is what it leans against.
        kept = (await self.refine(pid, 1, V6 | {"seed": 2, "filters": {"limit": 5}})).json()
        self.assertEqual(self.discovery_of(kept), "explore")
        snapshot = kept["proposal"]["snapshot"]
        self.assertEqual(snapshot["open"]["count"], len(first))
        stored = self.stored()
        for sid in kept["proposal"]["ids"]:
            self.assertNotIn(stored[sid].artist, self.artists(first))
        # Changed: the new value. Balanced is the reset.
        closer = (await self.refine(pid, 2, V6 | {"filters": {"discovery": "close"}})).json()
        self.assertEqual(self.discovery_of(closer), "close")
        reset = (await self.refine(pid, 3, V6 | {"filters": {"discovery": "balanced"}})).json()
        self.assertEqual(self.discovery_of(reset), "balanced")
        self.assertNotIn("open", reset["proposal"]["snapshot"])
        after = (await self.refine(pid, 4, V6 | {"filters": {"limit": 3}})).json()
        self.assertEqual(self.discovery_of(after), "balanced")

    async def test_a_follow_up_at_version_five_or_in_another_scope_does_not_inherit(self) -> None:
        created = await self.create(seed=1, filters={"limit": 6, "discovery": "explore"})
        pid = created["proposal"]["id"]
        older = (await self.refine(pid, 1, V5 | {"seed": 1, "filters": {"limit": 6}})).json()
        self.assertEqual(self.discovery_of(older), "balanced")
        narrowed = await self.refine(pid, 2, V6 | {"scope": "proposal"})
        self.assertEqual(narrowed.status_code, 200, narrowed.text)
        self.assertEqual(self.discovery_of(narrowed.json()), "balanced")
        refused = await self.refine(
            pid, 3, V6 | {"scope": "proposal", "filters": {"discovery": "explore"}}
        )
        self.assertEqual(refused.json()["error"]["code"], "invalid_intent")

    async def test_an_edit_keeps_discovery(self) -> None:
        created = await self.create(seed=4, filters={"limit": 6, "discovery": "explore"})
        pid = created["proposal"]["id"]
        ids = [str(sid) for sid in created["proposal"]["ids"]]
        added = await self.edit(pid, 1, {"kind": "add", "count": 2}, "op-discover-1")
        self.assertEqual(self.discovery_of(added), "explore")
        self.assertEqual(added["proposal"]["ids"][: len(ids)], ids)
        another = await self.edit(pid, 2, {"kind": "another"}, "op-discover-2")
        self.assertEqual(self.discovery_of(another), "explore")
        self.assertIn("open", another["proposal"]["snapshot"])
        removed = await self.edit(
            pid,
            3,
            {"kind": "remove", "ids": [another["proposal"]["ids"][0]]},
            "op-discover-3",
        )
        self.assertEqual(self.discovery_of(removed), "explore")
        # A version 5 edit body works the same way.
        response = await self.http.post(
            f"/api/music-bot/proposals/{pid}/edits",
            json={
                "contract_version": 5,
                "revision": 4,
                "operation_id": "op-discover-4",
                "edit": {"kind": "add", "count": 1},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.discovery_of(response.json()), "explore")

    async def test_a_stored_older_intent_still_reads_and_edits(self) -> None:
        created = (
            await self.http.post(
                "/api/music-bot/proposals",
                json={
                    "contract_version": 4,
                    "action": "search",
                    "seed": 2,
                    "filters": {"limit": 4},
                },
            )
        ).json()
        pid = created["proposal"]["id"]
        read = (await self.http.get(f"/api/music-bot/proposals/{pid}")).json()
        self.assertEqual(read["proposal"]["intent"]["contract_version"], 4)
        self.assertEqual(self.discovery_of(read), "balanced")
        added = await self.edit(pid, 1, {"kind": "add", "count": 1}, "op-discover-5")
        self.assertEqual(self.discovery_of(added), "balanced")
        commit = await self.http.post(
            f"/api/music-bot/proposals/{pid}/commit",
            json={
                "contract_version": 6,
                "revision": 2,
                "operation_id": "op-discover-6",
                "target": {"kind": "queue"},
            },
        )
        self.assertEqual(commit.status_code, 200, commit.text)


if __name__ == "__main__":
    unittest.main()
