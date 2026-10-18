"""The shown-song memory: what a library search puts last is the server's, shared by every
device, bounded to the last three presented results and 500 songs, and cleared on its own."""

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import test_engine
from fastapi import FastAPI

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.store import SCHEMA_VERSION, SHOWN_IDS, SHOWN_RESULTS, Store
from backend.library.engine import Engine, parse_intent
from backend.library.engine_contract import Intent
from backend.library.music_bot import MusicBot
from backend.library.proposals import Cancelled, Proposals

PLAIN = {"contract_version": 4, "action": "search"}
JsonObject = dict[str, object]


def payload(response: httpx.Response) -> JsonObject:
    body = response.json()
    assert isinstance(body, dict)
    return body


def part(body: JsonObject, key: str) -> JsonObject:
    found = body[key]
    assert isinstance(found, dict)
    return found


def fake_ids(prefix: int, count: int) -> list[str]:
    return [f"tr-{prefix:04x}{number:012x}" for number in range(count)]


class ShownMemoryTests(unittest.IsolatedAsyncioTestCase):
    # Set by the engine tests' setup.
    root: Path
    store: Store
    bot: MusicBot
    ids: dict[str, str]
    engine: Engine
    asked: list[str]

    async def asyncSetUp(self) -> None:
        await test_engine.EngineTests.asyncSetUp(self)  # type: ignore[arg-type]
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )

    async def asyncTearDown(self) -> None:
        await self.http.aclose()
        await test_engine.EngineTests.asyncTearDown(self)  # type: ignore[arg-type]

    # Helpers

    async def library_result(self, **body: object) -> JsonObject:
        response = await self.http.post("/api/music-bot/proposals", json=PLAIN | body)
        self.assertEqual(response.status_code, 200, response.text)
        return part(payload(response), "proposal")

    async def present(self, proposal: JsonObject) -> JsonObject:
        response = await self.http.post(
            "/api/music-bot/memory/shown",
            json={"proposal_id": proposal["id"], "revision": proposal["revision"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return payload(response)

    async def memory(self) -> JsonObject:
        response = await self.http.get("/api/music-bot/memory")
        self.assertEqual(response.status_code, 200, response.text)
        return payload(response)

    def ids_of(self, proposal: JsonObject) -> list[str]:
        found = proposal["ids"]
        assert isinstance(found, list)
        return [str(sid) for sid in found]

    def other_tables(self) -> dict[str, list[tuple[object, ...]]]:
        """Every row of every table but the memory's own."""
        with self.store.lock:
            names = [
                str(row[0])
                for row in self.store.db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                )
                if str(row[0]) != "bot_memory"
            ]
            return {
                name: [tuple(row) for row in self.store.db.execute(f'SELECT * FROM "{name}"')]
                for name in names
            }

    def snapshot_id(self, result: JsonObject) -> str:
        return str(part(result, "snapshot")["id"])

    # Recording

    async def test_a_new_install_has_an_empty_memory(self) -> None:
        found = await self.memory()
        self.assertEqual(
            (found["profile"], found["revision"], found["results"], found["songs"]),
            ("default", 0, 0, 0),
        )

    async def test_a_presented_library_result_is_remembered_after_a_restart(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        # Making a result is not showing it.
        self.assertEqual((await self.memory())["songs"], 0)
        recorded = await self.present(proposal)
        self.assertEqual(
            (recorded["recorded"], recorded["results"], recorded["songs"]), (True, 1, 4)
        )
        before = self.store.shown_memory()
        self.assertEqual(before[1], self.ids_of(proposal))
        path = self.root / "state.sqlite3"
        self.store.close()
        self.store = Store(path)
        self.bot.store = self.store
        self.assertEqual(self.store.shown_memory(), before)

    async def test_the_same_presentation_twice_is_one_entry(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        first = await self.present(proposal)
        second = await self.present(proposal)
        self.assertEqual((first["recorded"], second["recorded"]), (True, False))
        self.assertEqual((second["results"], second["revision"]), (1, first["revision"]))

    async def test_a_refinement_and_an_unseen_or_missing_result_are_not_recorded(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 6})
        refined = await self.http.post(
            f"/api/music-bot/proposals/{proposal['id']}/revisions",
            json={
                "revision": 1,
                "intent": PLAIN | {"scope": "proposal", "filters": {"exclude_artists": ["Harbor"]}},
            },
        )
        self.assertEqual(refined.status_code, 200, refined.text)
        narrowed = part(payload(refined), "proposal")
        self.assertEqual((await self.present(narrowed))["recorded"], False)
        empty = await self.library_result(seed=1, filters={"artists": ["Nobody"]})
        self.assertEqual(empty["ids"], [])
        self.assertEqual((await self.present(empty))["recorded"], False)
        self.assertEqual((await self.memory())["revision"], 0)
        unknown = await self.http.post(
            "/api/music-bot/memory/shown",
            json={"proposal_id": "pr-0123456789abcdef", "revision": 1},
        )
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(payload(unknown)["error"]["code"], "proposal_not_found")  # type: ignore[index]
        for body in ({}, {"proposal_id": "pr-0123456789abcdef"}, {"proposal_id": 4, "revision": 1}):
            with self.subTest(body=body):
                refused = await self.http.post("/api/music-bot/memory/shown", json=body)
                self.assertEqual(refused.status_code, 422)

    async def test_a_cancelled_presentation_is_not_recorded(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        body = {"proposal_id": proposal["id"], "revision": proposal["revision"]}
        # The route asks just before it writes, so a client that went away leaves nothing.
        with self.assertRaises(Cancelled):
            Proposals(self.bot).present(body, lambda: True)
        self.assertEqual(self.store.shown_memory(), (0, []))
        # The same body, not cancelled, is then recorded once.
        self.assertTrue(Proposals(self.bot).present(body, lambda: False)["recorded"])

    async def test_a_dropped_connection_returns_499(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})

        async def gone(_: object) -> None:
            return None

        with patch("backend.api.music_bot_api.until_disconnected", gone):
            response = await self.http.post(
                "/api/music-bot/memory/shown",
                json={"proposal_id": proposal["id"], "revision": proposal["revision"]},
            )
        self.assertEqual(response.status_code, 499)

    # Bounds and overlapping writes

    def test_the_memory_keeps_three_results_and_five_hundred_songs(self) -> None:
        for number in range(5):
            self.store.record_shown(f"pr-a:{number}", fake_ids(number, 4))
        revision, shown = self.store.shown_memory()
        self.assertEqual(revision, 5)
        self.assertEqual(self.store.shown_state()[1], SHOWN_RESULTS)
        # Newest first, and the two oldest results are gone.
        self.assertEqual(shown, fake_ids(4, 4) + fake_ids(3, 4) + fake_ids(2, 4))
        for number in range(3):
            self.store.record_shown(f"pr-b:{number}", fake_ids(100 + number, 400))
        shown = self.store.shown_memory()[1]
        self.assertEqual(len(shown), SHOWN_IDS)
        self.assertEqual(shown[:400], fake_ids(102, 400))
        # One result is cut to the bound as well, and a song in two results counts once.
        self.store.record_shown("pr-c:1", fake_ids(7, 800))
        self.assertEqual(self.store.shown_memory()[1], fake_ids(7, 500))
        self.store.record_shown("pr-c:2", fake_ids(7, 3) + fake_ids(8, 3))
        self.assertEqual(self.store.shown_memory()[1][:6], fake_ids(7, 3) + fake_ids(8, 3))
        # A late duplicate of a result that has aged out is still the same presentation.
        before = self.store.shown_memory()
        self.assertEqual(
            self.store.record_shown("pr-a:0", fake_ids(0, 4)), (before[0], "duplicate")
        )
        self.assertEqual(self.store.shown_memory(), before)

    def test_overlapping_writes_each_land_whole(self) -> None:
        workers = 12
        start = threading.Barrier(workers)
        failures: list[BaseException] = []

        def write(number: int) -> None:
            try:
                start.wait()
                # Two workers use each key, so the same presentation races itself.
                self.store.record_shown(f"pr-race:{number % 6}", fake_ids(number % 6, 5))
                self.store.shown_memory()
            except BaseException as exc:
                failures.append(exc)

        threads = [threading.Thread(target=write, args=(number,)) for number in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        revision, shown = self.store.shown_memory()
        # Six distinct presentations were recorded once each, and three are kept.
        self.assertEqual(revision, 6)
        self.assertEqual(self.store.shown_state()[1], SHOWN_RESULTS)
        self.assertEqual(len(shown), SHOWN_RESULTS * 5)
        self.assertEqual(len(set(shown)), len(shown))
        with self.store.lock:
            row = self.store.db.execute("SELECT generations FROM bot_memory").fetchone()
        self.assertEqual(len(json.loads(row[0])), SHOWN_RESULTS)

    # Forgetting

    async def test_forgetting_clears_only_the_memory(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        await self.present(proposal)
        # Play history, likes and a saved playlist all exist to be left alone.
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET play_count=3 WHERE song_id=?", (self.ids["Fog"],)
            )
            self.store.db.commit()
        saved = self.store.create_playlist("Kept", [self.ids["Dawn"]])
        before = self.other_tables()
        revision = int(str((await self.memory())["revision"]))
        response = await self.http.delete("/api/music-bot/memory")
        self.assertEqual(response.status_code, 200, response.text)
        cleared = payload(response)
        self.assertEqual((cleared["results"], cleared["songs"]), (0, 0))
        self.assertGreater(int(str(cleared["revision"])), revision)
        self.assertEqual(self.store.shown_memory()[1], [])
        self.assertEqual(self.other_tables(), before)
        kept = self.store.playlist(int(str(saved["id"])))
        assert kept is not None
        self.assertEqual(kept["song_ids"], [self.ids["Dawn"]])
        # Forgetting an empty memory still moves the revision, so a result made before it is
        # told apart from one made after (see the in-flight tests below).
        again = payload(await self.http.delete("/api/music-bot/memory"))
        self.assertEqual(int(str(again["revision"])), int(str(cleared["revision"])) + 1)

    # A result that was on its way when the memory was forgotten

    async def test_a_result_built_before_a_forget_is_not_recorded_after_it(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        built = int(str(part(part(proposal, "snapshot"), "shown")["memory_revision"]))
        # Another device presses Forget while this card is still on its way.
        await self.http.delete("/api/music-bot/memory")
        before = self.store.shown_memory()
        response = await self.http.post(
            "/api/music-bot/memory/shown",
            json={
                "proposal_id": proposal["id"],
                "revision": proposal["revision"],
                "memory_revision": built,
            },
        )
        # An answer, not an error: the result was just not recorded, and the reason says why.
        self.assertEqual(response.status_code, 200, response.text)
        refused = payload(response)
        self.assertEqual((refused["recorded"], refused["reason"]), (False, "forgotten"))
        self.assertEqual((refused["results"], refused["songs"]), (0, 0))
        self.assertEqual(self.store.shown_memory(), before)

    async def test_a_result_built_after_a_forget_is_recorded(self) -> None:
        await self.http.delete("/api/music-bot/memory")
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        built = part(part(proposal, "snapshot"), "shown")["memory_revision"]
        self.assertEqual(built, 1)
        recorded = await self.http.post(
            "/api/music-bot/memory/shown",
            json={
                "proposal_id": proposal["id"],
                "revision": proposal["revision"],
                "memory_revision": built,
            },
        )
        self.assertEqual((payload(recorded)["recorded"], payload(recorded)["reason"]), (True, ""))

    async def test_only_the_last_forget_counts_and_a_result_with_no_revision_is_recorded(
        self,
    ) -> None:
        first = await self.library_result(seed=1, filters={"limit": 4})
        await self.present(first)  # revision 1
        self.assertEqual(self.store.forget_shown(), 2)
        # Made against the revision the forget produced, so it is after the forget.
        self.assertEqual(self.store.record_shown("pr-new:1", ["tr-a"], 2), (3, "recorded"))
        # Made against the revision before it, so it was in flight.
        self.assertEqual(self.store.record_shown("pr-old:1", ["tr-b"], 1), (3, "forgotten"))
        # A later forget moves the line again, past a result that was fine a moment ago.
        self.assertEqual(self.store.forget_shown(), 4)
        self.assertEqual(self.store.record_shown("pr-new:2", ["tr-c"], 3)[1], "forgotten")
        # A result made without the memory (its own list) has no revision to compare.
        self.assertEqual(self.store.record_shown("pr-own:1", ["tr-d"], None)[1], "recorded")

    async def test_a_duplicate_is_still_a_duplicate_not_a_forgotten_result(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        await self.present(proposal)
        again = await self.present(proposal)
        self.assertEqual((again["recorded"], again["reason"]), (False, ""))

    # What a search reads

    async def test_a_library_search_puts_the_remembered_songs_last(self) -> None:
        body = PLAIN | {"seed": 5, "filters": {"limit": 6}}
        plain = self.engine.run(parse_intent(body))
        remembered = self.ids_of(plain)
        self.store.record_shown("pr-seen:1", remembered)
        from_memory = self.engine.run(parse_intent(body))
        own_list = self.engine.run(parse_intent(body | {"context": {"shown_ids": remembered}}))
        self.assertEqual(from_memory["ids"], own_list["ids"])
        # The six it showed go last, so the same seed now draws other songs.
        self.assertNotEqual(set(self.ids_of(from_memory)), set(remembered))
        # A list the request names, even an empty one, is used as given.
        empty = self.engine.run(parse_intent(body | {"context": {"shown_ids": []}}))
        self.assertEqual(empty["ids"], plain["ids"])

    async def test_an_omitted_list_reads_memory_only_from_version_four(self) -> None:
        body = {"action": "search", "seed": 5, "filters": {"limit": 6}}
        plain = self.engine.run(parse_intent(body | {"contract_version": 4}))
        self.store.record_shown("pr-seen:1", self.ids_of(plain))
        for version in (1, 2, 3):
            with self.subTest(version=version):
                old = self.engine.run(parse_intent(body | {"contract_version": version}))
                # The same as an explicit empty list, whatever the memory holds.
                empty = self.engine.run(
                    parse_intent(body | {"contract_version": version, "context": {"shown_ids": []}})
                )
                self.assertEqual(old["ids"], empty["ids"])
                self.assertEqual(old["ids"], plain["ids"])
                self.assertIsNone(part(part(old, "snapshot"), "shown")["memory_revision"])
                self.assertEqual(part(part(old, "snapshot"), "shown")["count"], 0)
        new = self.engine.run(parse_intent(body | {"contract_version": 4}))
        self.assertNotEqual(set(self.ids_of(new)), set(self.ids_of(plain)))
        self.assertEqual(part(part(new, "snapshot"), "shown")["memory_revision"], 1)
        # And the capabilities say which versions are accepted.
        found = await self.http.get("/api/music-bot/capabilities")
        self.assertEqual(payload(found)["supported_versions"], [1, 2, 3, 4, 5])

    async def test_a_different_memory_revision_is_a_different_snapshot(self) -> None:
        body = PLAIN | {"seed": 5, "filters": {"limit": 6}}
        first = self.engine.run(parse_intent(body))
        again = self.engine.run(parse_intent(body))
        self.assertEqual(self.snapshot_id(first), self.snapshot_id(again))
        self.assertEqual(part(part(first, "snapshot"), "shown")["memory_revision"], 0)
        self.store.record_shown("pr-seen:1", [self.ids["Hail"]])
        second = self.engine.run(parse_intent(body))
        self.assertNotEqual(self.snapshot_id(first), self.snapshot_id(second))
        self.assertEqual(part(part(second, "snapshot"), "shown")["memory_revision"], 1)
        # Forgetting is a new revision too, so empty before and empty after are not one state.
        self.store.forget_shown()
        third = self.engine.run(parse_intent(body))
        self.assertEqual(part(part(third, "snapshot"), "shown")["memory_revision"], 2)
        self.assertNotEqual(self.snapshot_id(first), self.snapshot_id(third))

    async def test_a_search_that_reads_no_memory_ignores_its_revision(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 6})
        scoped = PLAIN | {"scope": "proposal", "context": {"proposal_ids": self.ids_of(proposal)}}
        own = PLAIN | {"seed": 2, "context": {"shown_ids": [self.ids["Hail"]]}}
        before = [self.engine.run(parse_intent(body)) for body in (scoped, own)]
        self.store.record_shown("pr-seen:1", self.ids_of(proposal))
        after = [self.engine.run(parse_intent(body)) for body in (scoped, own)]
        for old, new in zip(before, after, strict=True):
            self.assertEqual(self.snapshot_id(old), self.snapshot_id(new))
            self.assertIsNone(part(part(new, "snapshot"), "shown")["memory_revision"])

    async def test_an_approved_proposal_keeps_the_memory_it_was_built_with(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        built = part(proposal, "snapshot")
        self.assertEqual(part(built, "shown")["memory_revision"], 0)
        await self.present(proposal)
        self.store.record_shown("pr-other:1", [self.ids["Hail"]])
        await self.http.delete("/api/music-bot/memory")
        read = await self.http.get(f"/api/music-bot/proposals/{proposal['id']}")
        found = part(payload(read), "proposal")
        self.assertEqual(found["snapshot"], built)
        self.assertEqual(found["ids"], proposal["ids"])
        # The commit never selects again, so a moved memory does not stale it.
        commit = await self.http.post(
            f"/api/music-bot/proposals/{proposal['id']}/commit",
            json={
                "contract_version": 4,
                "revision": 1,
                "operation_id": "op-memory-0001",
                "target": {"kind": "playlist", "name": "Memory test"},
            },
        )
        self.assertEqual(commit.status_code, 200, commit.text)
        receipt = part(payload(commit), "receipt")
        self.assertEqual(receipt["ids"], proposal["ids"])

    async def test_a_refinement_reads_the_memory_as_it_is_then(self) -> None:
        proposal = await self.library_result(seed=1, filters={"limit": 4})
        self.store.record_shown("pr-seen:1", self.ids_of(proposal))
        refined = await self.http.post(
            f"/api/music-bot/proposals/{proposal['id']}/revisions",
            json={"revision": 1, "intent": PLAIN | {"seed": 1, "filters": {"limit": 4}}},
        )
        second = part(payload(refined), "proposal")
        self.assertEqual(part(part(second, "snapshot"), "shown")["memory_revision"], 1)
        self.assertFalse(set(self.ids_of(second)) & set(self.ids_of(proposal)))

    def test_the_intent_echo_keeps_the_memory_default(self) -> None:
        result = self.engine.run(parse_intent(PLAIN | {"seed": 4}))
        echoed = Intent.model_validate(result["intent"])
        self.assertIsNone(echoed.context.shown_ids)

    # Migration

    def test_a_version_11_file_gains_the_memory_and_keeps_its_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.sqlite3"
            store = Store(path)
            playlist = store.create_playlist("Kept", ["tr-aaaaaaaaaaaaaaaa"])
            store.record_shown("pr-a:1", ["tr-aaaaaaaaaaaaaaaa"])
            store.db.executescript("""
                DROP TABLE bot_memory;
                PRAGMA user_version=11;
            """)
            store.close()
            for run in range(2):
                store = Store(path)
                try:
                    version = store.db.execute("PRAGMA user_version").fetchone()[0]
                    self.assertEqual((version, SCHEMA_VERSION), (12, 12))
                    # Created empty: the old copy lived in a browser tab and is not carried over.
                    # The second open must leave what the first one recorded.
                    expected = (0, []) if run == 0 else (1, ["tr-bbbbbbbbbbbbbbbb"])
                    self.assertEqual(store.shown_memory(), expected)
                    if run == 0:
                        store.record_shown("pr-a:2", ["tr-bbbbbbbbbbbbbbbb"])
                    kept = store.playlist(int(str(playlist["id"])))
                    assert kept is not None
                    self.assertEqual(kept["song_ids"], ["tr-aaaaaaaaaaaaaaaa"])
                finally:
                    store.close()

    def test_a_row_deleted_by_hand_reads_empty_and_is_written_back(self) -> None:
        self.store.record_shown("pr-a:1", [self.ids["Dawn"]])
        with self.store.lock:
            self.store.db.execute("DELETE FROM bot_memory")
            self.store.db.commit()
        self.assertEqual(self.store.shown_memory(), (0, []))
        self.assertEqual(self.store.forget_shown(), 1)
        self.assertEqual(self.store.record_shown("pr-a:2", [self.ids["Dusk"]]), (2, "recorded"))
        self.assertEqual(self.store.shown_memory(), (2, [self.ids["Dusk"]]))

    def test_an_older_build_refuses_a_newer_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "new.sqlite3"
            Store(path).close()
            with patch("backend.core.store.SCHEMA_VERSION", SCHEMA_VERSION - 1):
                with self.assertRaises(RuntimeError):
                    Store(path)
