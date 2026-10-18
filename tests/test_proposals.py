"""Engine-owned proposals: preview and refine write only their own tables, and a commit saves
exactly the approved revision once, or refuses because something it depends on changed."""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import test_engine
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.audio_recipes import SCALAR_RECIPE
from backend.core.store import SCHEMA_VERSION, Store
from backend.library.index import Library
from backend.library.music_bot import MusicBot
from backend.library.player import Player
from backend.library.proposals import Proposals

PLAIN = {"contract_version": 2, "action": "search"}
PROPOSAL_TABLES = {"bot_proposals", "bot_proposal_revisions", "bot_receipts"}
JsonObject = dict[str, object]


def payload(response: httpx.Response) -> JsonObject:
    body = response.json()
    assert isinstance(body, dict)
    return body


def part(body: JsonObject, key: str) -> JsonObject:
    found = body[key]
    assert isinstance(found, dict)
    return found


def code(response: httpx.Response) -> str:
    return str(part(payload(response), "error")["code"])


class ProposalTests(unittest.IsolatedAsyncioTestCase):
    # Set by the engine tests' setup.
    root: Path
    music: Path
    store: Store
    player: Player
    library: Library
    client: httpx.AsyncClient
    bot: MusicBot
    ids: dict[str, str]
    asked: list[str]

    async def asyncSetUp(self) -> None:
        # The engine tests' library: twelve generated files, real SQLite, Liked holding three
        # songs and a model transport that records any call.
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

    def other_tables(self) -> dict[str, list[tuple[object, ...]]]:
        """Every row of every table but the proposal ones."""
        with self.store.lock:
            names = [
                str(row[0])
                for row in self.store.db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                )
                if str(row[0]) not in PROPOSAL_TABLES
            ]
            return {
                name: [tuple(row) for row in self.store.db.execute(f'SELECT * FROM "{name}"')]
                for name in names
            }

    def count(self, table: str) -> int:
        with self.store.lock:
            return int(self.store.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0])

    def playlists(self) -> list[JsonObject]:
        return self.store.list_playlists()

    async def create(self, **body: object) -> JsonObject:
        response = await self.http.post("/api/music-bot/proposals", json=PLAIN | body)
        self.assertEqual(response.status_code, 200, response.text)
        return payload(response)

    async def refine(self, proposal_id: object, revision: int, **body: object) -> httpx.Response:
        return await self.http.post(
            f"/api/music-bot/proposals/{proposal_id}/revisions",
            json={"revision": revision, "intent": PLAIN | body},
        )

    async def commit(self, proposal_id: object, **body: object) -> httpx.Response:
        return await self.http.post(
            f"/api/music-bot/proposals/{proposal_id}/commit",
            json={"contract_version": 2, "revision": 1, "operation_id": "op-00000001"} | body,
        )

    def song_ids(self, body: JsonObject) -> list[str]:
        found = part(body, "proposal")["ids"]
        assert isinstance(found, list)
        return [str(sid) for sid in found]

    # Overview and sample

    def widen(self, extra: int) -> None:
        """More songs, three artists apiece, so a proposal can pass the short-list limit."""
        for index in range(extra):
            path = self.music / f"extra-{index}.wav"
            write_wav(path)
            tag(
                path,
                title=f"Extra {index}",
                artist=f"Added {index % 4}",
                album="Fixture",
                year=2000 + index,
                genres=["Folk" if index % 2 else "Blues"],
            )
        self.library.scan()
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200 WHERE duration=0")
            self.store.db.commit()
        self.store.bump_library_revision()

    async def test_a_short_proposal_returns_its_whole_list_with_an_overview_from_its_songs(
        self,
    ) -> None:
        created = await self.create(seed=3, filters={"genres": ["Rock"], "limit": 8})
        proposal = part(created, "proposal")
        ids = self.song_ids(created)
        self.assertEqual(part(proposal, "sample"), {"ids": ids, "complete": True})
        overview = part(proposal, "overview")
        measured = part(overview, "measured")
        stored = self.player.view().stored
        self.assertEqual(measured["track_count"], 8)
        self.assertEqual(measured["total_seconds"], sum(stored[sid].duration for sid in ids))
        self.assertEqual(measured["artist_count"], len({stored[sid].artist for sid in ids}))
        self.assertEqual(measured["genres"], [{"name": "Rock", "count": 8}])
        self.assertEqual(part(overview, "requested")["filters"], {"genres": ["Rock"], "limit": 8})
        # No recipe is on, so tempo and energy are absent rather than guessed from "Rock".
        self.assertIsNone(measured["audio"])
        # The same read as the stored revision, so the overview is on read as well.
        read = payload(await self.http.get(f"/api/music-bot/proposals/{proposal['id']}"))
        self.assertEqual(part(read, "proposal")["overview"], overview)

    async def test_a_large_proposal_gets_a_stable_spread_sample_beside_the_full_list(self) -> None:
        self.widen(10)
        created = await self.create(seed=3, filters={"limit": 20})
        proposal = part(created, "proposal")
        ids = self.song_ids(created)
        self.assertGreater(len(ids), 12)
        sample = part(proposal, "sample")
        picked = sample["ids"]
        assert isinstance(picked, list)
        self.assertFalse(sample["complete"])
        self.assertEqual(len(picked), 6)
        self.assertTrue(set(picked) <= set(ids))
        stored = self.player.view().stored
        self.assertGreater(len({stored[str(sid)].artist for sid in picked}), 1)
        read = payload(await self.http.get(f"/api/music-bot/proposals/{proposal['id']}"))
        self.assertEqual(part(read, "proposal")["sample"], sample)
        self.assertEqual(self.song_ids(read), ids)

    async def test_coverage_is_honest_when_some_songs_are_unmeasured_or_have_no_length(
        self,
    ) -> None:
        self.store.update({"audio_scalar_recipe": SCALAR_RECIPE})
        stored = self.player.view().stored
        measured_titles = ("Dawn", "Dusk")
        with self.store.lock:
            for title, bpm in zip(measured_titles, (100.0, 140.0), strict=True):
                song = stored[self.ids[title]]
                self.store.db.execute(
                    "INSERT INTO audio_profile VALUES (?,?,'done',?,?,?,?,0,NULL,'','t')",
                    (song.song_id, SCALAR_RECIPE, song.size, song.mtime_ns, bpm, 0.5),
                )
            self.store.db.execute(
                "UPDATE library_files SET duration=0 WHERE song_id=?", (self.ids["Fog"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        self.bot.profiles.generation += 1
        created = await self.create(seed=3)
        overview = part(part(created, "proposal"), "overview")
        total = len(self.song_ids(created))
        audio = part(part(overview, "measured"), "audio")
        self.assertEqual(audio["tempo"], {"min": 100.0, "max": 140.0})
        self.assertEqual(audio["tempo_coverage"], {"measured": 2, "total": total})
        unknown = part(overview, "unknown")
        self.assertEqual(unknown["tempo_tracks"], total - 2)
        self.assertEqual(unknown["duration_tracks"], 1)
        self.assertEqual(part(overview, "measured")["total_seconds"], 200.0 * (total - 1))

    # Preview and refine

    async def test_create_refine_and_read_write_only_the_proposal_tables(self) -> None:
        before = self.other_tables()
        changes = self.store.db.total_changes
        queue = self.store.read_play_queue()
        liked = self.player.liked_id()
        created = await self.create(seed=7, filters={"genres": ["Rock"], "limit": 6})
        proposal = part(created, "proposal")
        self.assertRegex(str(proposal["id"]), r"^pr-[0-9a-f]{16}$")
        self.assertEqual((proposal["revision"], proposal["latest_revision"]), (1, 1))
        self.assertEqual(len(self.song_ids(created)), 6)
        self.assertEqual([t["id"] for t in created["tracks"]], self.song_ids(created))  # type: ignore[attr-defined]
        self.assertFalse(created["state_changed"])
        narrowed = await self.refine(
            proposal["id"], 1, scope="proposal", filters={"exclude_artists": ["Harbor"]}
        )
        self.assertEqual(narrowed.status_code, 200, narrowed.text)
        second = payload(narrowed)
        self.assertEqual(part(second, "proposal")["revision"], 2)
        # A proposal scope refines the stored revision's songs, in their order.
        kept = [sid for sid in self.song_ids(created) if sid not in self.harbor()]
        self.assertEqual(self.song_ids(second), kept)
        again = await self.refine(proposal["id"], 2, seed=9, filters={"genres": ["Jazz"]})
        self.assertEqual(part(payload(again), "proposal")["revision"], 3)
        first = await self.http.get(f"/api/music-bot/proposals/{proposal['id']}?revision=1")
        self.assertEqual(self.song_ids(payload(first)), self.song_ids(created))
        self.assertEqual(part(payload(first), "proposal")["latest_revision"], 3)
        latest = await self.http.get(f"/api/music-bot/proposals/{proposal['id']}")
        self.assertEqual(part(payload(latest), "proposal")["revision"], 3)
        self.assertEqual(self.other_tables(), before)
        # Three revision rows and one proposal row inserted, two updates of its latest number.
        self.assertEqual(self.store.db.total_changes - changes, 6)
        self.assertEqual(self.store.read_play_queue(), queue)
        self.assertEqual(self.player.liked_id(), liked)
        self.assertEqual(self.asked, [])

    def harbor(self) -> set[str]:
        return {
            self.ids[t] for t in ("Echo", "Echo (Live)", "Echo (Remix)", "Echo - 2011 Remaster")
        }

    async def test_the_drawn_seed_is_stored_and_replays(self) -> None:
        created = await self.create(filters={"limit": 5})
        proposal = part(created, "proposal")
        intent = part(proposal, "intent")
        self.assertEqual(proposal["seed"], 0)
        self.assertEqual(intent["seed"], proposal["seed"])
        replay = await self.http.post("/api/music-bot/intent", json=intent)
        self.assertEqual(payload(replay)["ids"], self.song_ids(created))
        # The intent route echoes the drawn seed too.
        direct = payload(await self.http.post("/api/music-bot/intent", json=PLAIN))
        self.assertEqual(part(direct, "intent")["seed"], direct["seed"])
        self.assertIsNotNone(direct["seed"])

    async def test_refusals_on_create_and_refine(self) -> None:
        cases: list[tuple[JsonObject, str]] = [
            ({"action": "pause"}, "invalid_intent"),
            ({"filters": {"limit": 501}}, "selection_too_large"),
            ({"contract_version": 6}, "unsupported_version"),
            ({"extra": 1}, "unknown_field"),
        ]
        for body, expected in cases:
            with self.subTest(expected=expected):
                response = await self.http.post("/api/music-bot/proposals", json=PLAIN | body)
                self.assertEqual(code(response), expected)
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        given = await self.refine(
            proposal_id, 1, scope="proposal", context={"proposal_ids": [self.ids["Dawn"]]}
        )
        self.assertEqual(code(given), "invalid_intent")
        self.assertEqual(code(await self.refine("pr-0000000000000000", 1)), "proposal_not_found")
        self.assertEqual(code(await self.refine("PR-not-an-id", 1)), "proposal_not_found")
        self.assertEqual(code(await self.refine(proposal_id, 5)), "revision_not_found")
        bad = await self.http.get(f"/api/music-bot/proposals/{proposal_id}?revision=x")
        self.assertEqual(code(bad), "invalid_request")
        self.assertEqual(self.count("bot_proposal_revisions"), 1)

    async def test_the_selection_limit_is_refused_and_says_the_limit(self) -> None:
        too_many = [self.ids["Dawn"]] * 501
        for url, body in [
            ("/api/music-bot/intent", PLAIN | {"filters": {"limit": 501}}),
            ("/api/music-bot/proposals", PLAIN | {"filters": {"limit": 501}}),
            (
                "/api/music-bot/proposals",
                PLAIN | {"scope": "proposal", "context": {"proposal_ids": too_many}},
            ),
        ]:
            with self.subTest(url=url):
                response = await self.http.post(url, json=body)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(code(response), "selection_too_large")
                self.assertIn("500", str(part(payload(response), "error")["message"]))
        self.assertEqual(self.count("bot_proposals"), 0)

    async def test_proposals_and_revisions_are_bounded(self) -> None:
        with (
            patch("backend.core.store.PROPOSAL_LIMIT", 2),
            patch("backend.core.store.REVISION_LIMIT", 2),
        ):
            first = part(await self.create(seed=1), "proposal")["id"]
            for seed in (2, 3):
                await self.create(seed=seed)
            gone = await self.http.get(f"/api/music-bot/proposals/{first}")
            self.assertEqual(gone.status_code, 404)
            self.assertEqual(code(gone), "proposal_not_found")
            self.assertEqual(self.count("bot_proposals"), 2)
            kept = part(await self.create(seed=4), "proposal")["id"]
            for revision in (1, 2):
                await self.refine(kept, revision, seed=revision)
            pruned = await self.http.get(f"/api/music-bot/proposals/{kept}?revision=1")
            self.assertEqual(code(pruned), "revision_not_found")
            # Two of the kept proposal's three, and the one of the proposal before it.
            self.assertEqual(self.count("bot_proposal_revisions"), 3)

    # Commit

    async def test_a_playlist_commit_saves_the_exact_ids_once(self) -> None:
        created = await self.create(seed=5, filters={"limit": 7})
        proposal_id = part(created, "proposal")["id"]
        playlists = len(self.playlists())
        queue = self.store.read_play_queue()
        target = {"kind": "playlist", "name": "  Evening  "}
        response = await self.commit(proposal_id, target=target)
        self.assertEqual(response.status_code, 200, response.text)
        body = payload(response)
        receipt = part(body, "receipt")
        self.assertFalse(body["replayed"])
        self.assertEqual(receipt["status"], "saved")
        self.assertEqual(receipt["ids"], self.song_ids(created))
        self.assertEqual(
            (receipt["proposal_id"], receipt["revision"], receipt["target"]),
            (proposal_id, 1, "playlist"),
        )
        number = int(str(receipt["playlist_id"]).removeprefix("pl-"))
        saved = self.store.playlist(number)
        assert saved is not None
        self.assertEqual(saved["song_ids"], self.song_ids(created))
        self.assertEqual(saved["name"], "Evening")
        # The same operation retried: the first receipt, nothing saved again.
        retried = payload(await self.commit(proposal_id, target=target))
        self.assertTrue(retried["replayed"])
        self.assertEqual(retried["receipt"], receipt)
        self.assertEqual(len(self.playlists()), playlists + 1)
        # The same id for anything else is a conflict, not a second save.
        other = await self.commit(proposal_id, target={"kind": "queue"})
        self.assertEqual(code(other), "operation_conflict")
        renamed = await self.commit(proposal_id, target={"kind": "playlist", "name": "Morning"})
        self.assertEqual((renamed.status_code, code(renamed)), (409, "operation_conflict"))
        self.assertEqual(len(self.playlists()), playlists + 1)
        # A second save of this revision needs a new id and an explicit repeat.
        again = await self.commit(proposal_id, operation_id="op-00000002", target=target)
        self.assertEqual(again.status_code, 409)
        self.assertEqual(code(again), "already_committed")
        repeat = await self.commit(
            proposal_id, operation_id="op-00000002", target=target, repeat=True
        )
        self.assertEqual(repeat.status_code, 200, repeat.text)
        self.assertEqual(len(self.playlists()), playlists + 2)
        self.assertEqual(self.store.read_play_queue(), queue)
        self.assertEqual(self.asked, [])

    async def test_a_queue_commit_hands_back_the_ids_and_writes_no_queue(self) -> None:
        created = await self.create(seed=2, filters={"limit": 5})
        proposal_id = part(created, "proposal")["id"]
        before = self.other_tables()
        response = await self.commit(proposal_id, target={"kind": "queue"})
        receipt = part(payload(response), "receipt")
        self.assertEqual(receipt["status"], "ready_for_player")
        self.assertEqual(receipt["ids"], self.song_ids(created))
        self.assertIsNone(receipt["playlist_id"])
        retried = payload(await self.commit(proposal_id, target={"kind": "queue"}))
        self.assertEqual((retried["receipt"], retried["replayed"]), (receipt, True))
        self.assertEqual(self.count("bot_receipts"), 1)
        # The receipt is the only write: the queue, playlists and history are the browser's.
        self.assertEqual(self.other_tables(), before)
        self.assertNotIn("playing", json.dumps(payload(response)))

    async def test_an_older_revision_is_refused_unless_named(self) -> None:
        created = await self.create(seed=3, filters={"limit": 6})
        proposal_id = part(created, "proposal")["id"]
        await self.refine(proposal_id, 1, scope="proposal", filters={"exclude_artists": ["Ridge"]})
        old = await self.commit(proposal_id, target={"kind": "queue"})
        self.assertEqual(old.status_code, 409)
        self.assertEqual(code(old), "revision_superseded")
        stale_base = await self.refine(proposal_id, 1, seed=8)
        self.assertEqual(code(stale_base), "revision_superseded")
        named = await self.commit(proposal_id, target={"kind": "queue"}, older_revision=True)
        self.assertEqual(part(payload(named), "receipt")["ids"], self.song_ids(created))
        self.assertEqual(part(payload(named), "receipt")["revision"], 1)

    async def test_a_removed_file_or_a_changed_song_is_stale(self) -> None:
        created = await self.create(filters={"artists": ["Orchard"]}, seed=1)
        proposal_id = part(created, "proposal")["id"]
        self.assertEqual(set(self.song_ids(created)), {self.ids["Dawn"], self.ids["Dusk"]})
        (self.music / "4.wav").unlink()  # Dawn
        gone = await self.commit(proposal_id, target={"kind": "playlist", "name": "Orchard"})
        self.assertEqual(gone.status_code, 409)
        self.assertEqual(code(gone), "proposal_stale")
        fields = part(payload(gone), "error")["fields"]
        self.assertEqual(
            fields, [{"field": f"songs.{self.ids['Dawn']}", "message": "The file is unavailable"}]
        )
        write_wav(self.music / "4.wav")
        tag(self.music / "4.wav", title="Dawn", artist="Orchard", year=1994, genres=["Rock"])
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET title='Dusk (Edit)' WHERE song_id=?", (self.ids["Dusk"],)
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        changed = await self.commit(proposal_id, target={"kind": "queue"})
        self.assertEqual(code(changed), "proposal_stale")
        names = [item["field"] for item in part(payload(changed), "error")["fields"]]  # type: ignore[attr-defined]
        self.assertIn(f"songs.{self.ids['Dusk']}", names)
        self.assertEqual(self.count("bot_receipts"), 0)
        self.assertEqual(len(self.playlists()), 1)  # Liked only

    async def test_a_song_deleted_from_the_library_is_stale_for_every_target(self) -> None:
        created = await self.create(filters={"artists": ["Orchard"]}, seed=1)
        proposal_id = part(created, "proposal")["id"]
        dawn = self.ids["Dawn"]
        (self.music / "4.wav").unlink()
        self.library.scan()
        read = payload(await self.http.get(f"/api/music-bot/proposals/{proposal_id}"))
        # The list still names the song; the cards no longer have it.
        self.assertIn(dawn, self.song_ids(read))
        self.assertEqual(read["missing_ids"], [dawn])
        self.assertNotIn(dawn, [str(t["id"]) for t in read["tracks"]])  # type: ignore[attr-defined]
        for number, target in enumerate(({"kind": "queue"}, {"kind": "playlist", "name": "Gone"})):
            with self.subTest(target=target["kind"]):
                gone = await self.commit(
                    proposal_id, operation_id=f"op-gone-{number}", target=target
                )
                self.assertEqual((gone.status_code, code(gone)), (409, "proposal_stale"))
                fields = part(payload(gone), "error")["fields"]
                self.assertEqual(
                    fields, [{"field": f"songs.{dawn}", "message": "Not in the library"}]
                )
        self.assertEqual(self.count("bot_receipts"), 0)
        self.assertEqual(len(self.playlists()), 1)  # Liked only

    async def test_a_song_already_unplayable_when_stored_is_still_refused(self) -> None:
        created = await self.create(filters={"artists": ["Orchard"]}, seed=1)
        proposal_id = part(created, "proposal")["id"]
        dawn = self.ids["Dawn"]
        # A stored check that already says "unplayable" matches what the commit now sees. It
        # still must not be approved, or the receipt would name a song nothing can play.
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT checks FROM bot_proposal_revisions WHERE proposal_id=? AND revision=1",
                (proposal_id,),
            ).fetchone()
            checks = json.loads(str(row["checks"]))
            checks[f"songs.{dawn}"] = "unplayable"
            self.store.db.execute(
                "UPDATE bot_proposal_revisions SET checks=? WHERE proposal_id=? AND revision=1",
                (json.dumps(checks), proposal_id),
            )
            self.store.db.commit()
        (self.music / "4.wav").unlink()
        refused = await self.commit(proposal_id, target={"kind": "queue"})
        self.assertEqual((refused.status_code, code(refused)), (409, "proposal_stale"))
        self.assertEqual(self.count("bot_receipts"), 0)

    async def test_only_what_the_songs_depend_on_is_checked(self) -> None:
        liked = await self.create(filters={"favourites": True}, seed=1)
        plain = await self.create(filters={"artists": ["Meadow"]}, seed=1)
        # A song added elsewhere in the library changes neither proposal's songs.
        write_wav(self.music / "new.wav")
        tag(self.music / "new.wav", title="New", artist="Lake", year=2020, genres=["Pop"])
        self.library.scan()
        # Unliking Mist matters to the favourites proposal only.
        liked_list = await self.player.linked_playlist()
        entry = [str(t["id"]) for t in liked_list["entry"]]  # type: ignore[attr-defined]
        await self.player.remove_playlist_song(str(liked_list["id"]), entry.index(self.ids["Mist"]))
        stale = await self.commit(part(liked, "proposal")["id"], target={"kind": "queue"})
        self.assertEqual(code(stale), "proposal_stale")
        self.assertEqual(
            part(payload(stale), "error")["fields"],
            [{"field": f"songs.{self.ids['Mist']}.liked", "message": "Like changed"}],
        )
        fine = await self.commit(
            part(plain, "proposal")["id"], operation_id="op-plain-01", target={"kind": "queue"}
        )
        self.assertEqual(fine.status_code, 200, fine.text)

    async def test_errors_and_cancels_leave_no_receipt(self) -> None:
        created = await self.create(seed=4, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        playlists = len(self.playlists())
        cases: list[tuple[JsonObject, str]] = [
            ({"contract_version": 1}, "unsupported_version"),
            ({"operation_id": "short"}, "invalid_request"),
            ({"target": {"kind": "speaker"}}, "invalid_request"),
            ({"target": {"kind": "playlist", "name": "  "}}, "invalid_request"),
            ({"target": {"kind": "queue"}, "play": True}, "unknown_field"),
            ({"target": {"kind": "queue"}, "revision": 9}, "revision_not_found"),
        ]
        for body, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(code(await self.commit(proposal_id, **body)), expected)
        missing = await self.commit("pr-0123456789abcdef", target={"kind": "queue"})
        self.assertEqual((missing.status_code, code(missing)), (404, "proposal_not_found"))

        slow_checks = Proposals._checks

        def slow(*args: object) -> dict[str, str]:
            time.sleep(0.2)
            return slow_checks(*args)  # type: ignore[arg-type]

        async def gone(_: object) -> None:
            return None

        with (
            patch("backend.api.music_bot_api.until_disconnected", gone),
            patch.object(Proposals, "_checks", slow),
        ):
            cancelled = await self.commit(proposal_id, target={"kind": "playlist", "name": "X"})
            self.assertEqual(cancelled.status_code, 499)
            create = await self.http.post("/api/music-bot/proposals", json=PLAIN | {"seed": 1})
            self.assertEqual(create.status_code, 499)
            await asyncio.sleep(0.5)  # let the worker threads finish and decline to write
        with patch("backend.library.proposals.Proposals._stale", side_effect=RuntimeError("x")):
            with self.assertLogs("uvicorn.error", "ERROR"):
                failed = await self.commit(proposal_id, target={"kind": "queue"})
        self.assertEqual((failed.status_code, code(failed)), (500, "internal_error"))
        self.assertEqual(self.count("bot_receipts"), 0)
        self.assertEqual(self.count("bot_proposals"), 1)
        self.assertEqual(len(self.playlists()), playlists)

    async def test_proposals_and_receipts_survive_a_restart(self) -> None:
        created = await self.create(seed=6, filters={"limit": 5})
        proposal_id = part(created, "proposal")["id"]
        first = part(payload(await self.commit(proposal_id, target={"kind": "queue"})), "receipt")
        await self.client.aclose()
        self.store.close()
        self.store = Store(self.root / "state.sqlite3")
        self.player = Player(self.store, [self.music])
        self.library = Library(self.store, [self.music], asyncio.Event())
        self.client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(500))
        )
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)
        read = payload(await self.http.get(f"/api/music-bot/proposals/{proposal_id}"))
        self.assertEqual(self.song_ids(read), self.song_ids(created))
        retried = payload(await self.commit(proposal_id, target={"kind": "queue"}))
        self.assertEqual((retried["receipt"], retried["replayed"]), (first, True))

    async def test_a_concurrent_retry_gets_the_first_receipt(self) -> None:
        created = await self.create(seed=5, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        playlists = len(self.playlists())
        slow_checks = Proposals._checks

        def slow(*args: object) -> dict[str, str]:
            # Both requests pass the first receipt lookup before either writes.
            time.sleep(0.2)
            return slow_checks(*args)  # type: ignore[arg-type]

        target = {"kind": "playlist", "name": "Twice"}
        with patch.object(Proposals, "_checks", slow):
            first, second = await asyncio.gather(
                self.commit(proposal_id, target=target), self.commit(proposal_id, target=target)
            )
        self.assertEqual((first.status_code, second.status_code), (200, 200), second.text)
        self.assertEqual(payload(first)["receipt"], payload(second)["receipt"])
        self.assertEqual(sorted([payload(first)["replayed"], payload(second)["replayed"]]), [0, 1])
        self.assertEqual(len(self.playlists()), playlists + 1)

    async def test_a_receipt_outlives_its_pruned_proposal(self) -> None:
        with patch("backend.core.store.PROPOSAL_LIMIT", 2):
            created = await self.create(seed=1, filters={"limit": 4})
            proposal_id = part(created, "proposal")["id"]
            target = {"kind": "playlist", "name": "Kept"}
            first = part(payload(await self.commit(proposal_id, target=target)), "receipt")
            for seed in (2, 3):
                await self.create(seed=seed)
            gone = await self.http.get(f"/api/music-bot/proposals/{proposal_id}")
            self.assertEqual(code(gone), "proposal_not_found")
            retried = payload(await self.commit(proposal_id, target=target))
        self.assertEqual((retried["receipt"], retried["replayed"]), (first, True))
        self.assertEqual([p["name"] for p in self.playlists()].count("Kept"), 1)

    async def test_a_proposal_pruned_during_a_commit_is_not_found(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        playlists = len(self.playlists())
        real_checks = Proposals._checks

        def pruned(*args: object) -> dict[str, str]:
            found = real_checks(*args)  # type: ignore[arg-type]
            with self.store.lock:
                self.store.db.execute("DELETE FROM bot_proposals WHERE id=?", (proposal_id,))
                self.store.db.commit()
            return found

        with patch.object(Proposals, "_checks", pruned):
            response = await self.commit(proposal_id, target={"kind": "playlist", "name": "X"})
        self.assertEqual((response.status_code, code(response)), (404, "proposal_not_found"))
        self.assertEqual(self.count("bot_receipts"), 0)
        self.assertEqual(len(self.playlists()), playlists)

    async def test_receipts_are_bounded(self) -> None:
        with patch("backend.core.store.RECEIPT_LIMIT", 2):
            for seed in (1, 2, 3):
                created = await self.create(seed=seed, filters={"limit": 2})
                await self.commit(
                    part(created, "proposal")["id"],
                    operation_id=f"op-bounded-{seed}",
                    target={"kind": "queue"},
                )
        with self.store.lock:
            kept = [
                str(r[0]) for r in self.store.db.execute("SELECT operation_id FROM bot_receipts")
            ]
        self.assertEqual(sorted(kept), ["op-bounded-2", "op-bounded-3"])

    def test_schema_10_receipts_lose_the_cascade_and_keep_their_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "v10.sqlite3"
            store = Store(path)
            receipt = {"operation_id": "op-v10-0001", "proposal_id": "pr-0123456789abcdef"}
            # The version 10 receipts table, with the cascade.
            store.db.executescript(f"""
                DROP TABLE bot_receipts;
                CREATE TABLE bot_receipts (
                    operation_id TEXT PRIMARY KEY,
                    proposal_id TEXT NOT NULL REFERENCES bot_proposals(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    target TEXT NOT NULL,
                    receipt TEXT NOT NULL
                );
                INSERT INTO bot_proposals VALUES ('pr-0123456789abcdef', 1, 1, 'then');
                INSERT INTO bot_receipts VALUES
                    ('op-v10-0001', 'pr-0123456789abcdef', 1, 'queue', '{json.dumps(receipt)}');
                PRAGMA user_version=10;
            """)
            store.close()
            for _ in range(2):
                store = Store(path)
                try:
                    version = store.db.execute("PRAGMA user_version").fetchone()[0]
                    self.assertEqual((version, SCHEMA_VERSION), (12, 12))
                    keys = store.db.execute("PRAGMA foreign_key_list(bot_receipts)").fetchall()
                    self.assertEqual(keys, [])
                    store.db.execute("DELETE FROM bot_proposals")
                    self.assertEqual(store.proposal_receipt("op-v10-0001"), receipt)
                finally:
                    store.close()

    def test_schema_9_upgrades_and_keeps_its_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.sqlite3"
            store = Store(path)
            playlist = store.create_playlist("Kept", ["tr-aaaaaaaaaaaaaaaa"])
            store.db.executescript("""
                DROP TABLE bot_receipts;
                DROP TABLE bot_proposal_revisions;
                DROP TABLE bot_proposals;
                PRAGMA user_version=9;
            """)
            store.close()
            for _ in range(2):
                store = Store(path)
                try:
                    version = store.db.execute("PRAGMA user_version").fetchone()[0]
                    self.assertEqual((version, SCHEMA_VERSION), (12, 12))
                    tables = {
                        str(row[0]) for row in store.db.execute("SELECT name FROM sqlite_master")
                    }
                    self.assertTrue(PROPOSAL_TABLES <= tables)
                    kept = store.playlist(int(str(playlist["id"])))
                    assert kept is not None
                    self.assertEqual(kept["song_ids"], ["tr-aaaaaaaaaaaaaaaa"])
                finally:
                    store.close()

    async def test_a_total_length_proposal_keeps_its_report_and_commits(self) -> None:
        total = {"total_length": {"mode": "about", "seconds": 600}}
        response = await self.http.post(
            "/api/music-bot/proposals",
            json={"contract_version": 3, "action": "search", "seed": 2, "filters": total},
        )
        self.assertEqual(response.status_code, 200, response.text)
        proposal = part(payload(response), "proposal")
        report = part(proposal, "duration")
        self.assertEqual((report["mode"], report["met"]), ("about", True))
        self.assertEqual(report["total_seconds"], proposal["total_seconds"])
        read = await self.http.get(f"/api/music-bot/proposals/{proposal['id']}")
        self.assertEqual(part(part(payload(read), "proposal"), "duration"), report)
        # A commit body is unchanged since version 2, so every version from 2 commits.
        for version, operation in (
            (2, "op-00000002"),
            (3, "op-00000003"),
            (4, "op-00000004"),
            (5, "op-00000005"),
        ):
            committed = await self.commit(
                proposal["id"],
                contract_version=version,
                operation_id=operation,
                target={"kind": "queue"},
                repeat=True,
            )
            self.assertEqual(committed.status_code, 200, committed.text)
        plain = await self.create(seed=2)
        self.assertIsNone(part(plain, "proposal")["duration"])

    async def test_registry_marks_commit_available(self) -> None:
        body = payload(await self.http.get("/api/music-bot/capabilities"))
        found = {item["id"]: item["available"] for item in body["capabilities"]}  # type: ignore[attr-defined]
        self.assertTrue(found["proposal_commit"])
        self.assertEqual(body["supported_versions"], [1, 2, 3, 4, 5])

    # Edits of the latest revision

    async def edit(
        self,
        proposal_id: object,
        revision: int,
        edit: JsonObject,
        operation_id: str = "op-edit-0001",
        **body: object,
    ) -> httpx.Response:
        return await self.http.post(
            f"/api/music-bot/proposals/{proposal_id}/edits",
            json={
                "contract_version": 5,
                "revision": revision,
                "operation_id": operation_id,
                "edit": edit,
            }
            | body,
        )

    async def edited(
        self,
        proposal_id: object,
        revision: int,
        edit: JsonObject,
        operation_id: str = "op-edit-0001",
    ) -> JsonObject:
        response = await self.edit(proposal_id, revision, edit, operation_id)
        self.assertEqual(response.status_code, 200, response.text)
        return payload(response)

    def intent_of(self, body: JsonObject) -> JsonObject:
        return part(part(body, "proposal"), "intent")

    def filters_without_exclusions(self, body: JsonObject) -> JsonObject:
        filters = dict(part(self.intent_of(body), "filters"))
        filters.pop("exclude_ids")
        return filters

    def draw(self, seed: int) -> None:
        """The seed the next fresh draw uses (the fixtures draw 0 every time otherwise)."""
        self.bot.new_seed = lambda: seed

    def artists(self, ids: list[str]) -> list[str]:
        stored = self.player.view().stored
        return [stored[sid].artist for sid in ids]

    async def test_another_keeps_the_pinned_songs_first_in_their_order_and_redraws_the_rest(
        self,
    ) -> None:
        created = await self.create(seed=1, filters={"limit": 6})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        self.bot.new_seed = lambda: 11
        # Named in the other order: the revision's order is the one protected.
        pins = [ids[0], ids[2], ids[3], ids[5]]
        second = await self.edited(proposal_id, 1, {"kind": "another", "pinned_ids": pins[::-1]})
        new = self.song_ids(second)
        proposal = part(second, "proposal")
        self.assertEqual(new[:4], pins)
        self.assertEqual((len(new), len(set(new))), (6, 6))
        self.assertEqual(
            (proposal["revision"], proposal["seed"], second["replayed"]), (2, 11, False)
        )
        context = part(self.intent_of(second), "context")
        self.assertEqual(context["keep_ids"], pins)
        self.assertEqual(context["pinned_ids"], pins)
        self.assertIsNone(context["add_count"])
        # The pinned songs count towards the artist cap.
        for artist in set(self.artists(new)):
            self.assertLessEqual(self.artists(new).count(artist), 2)

    async def test_another_without_a_list_keeps_the_old_pins_and_an_empty_list_clears_them(
        self,
    ) -> None:
        created = await self.create(seed=1, filters={"limit": 6})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        self.bot.new_seed = lambda: 11
        pinned = await self.edited(
            proposal_id, 1, {"kind": "another", "pinned_ids": [ids[2], ids[0]]}, "op-edit-0001"
        )
        self.bot.new_seed = lambda: 12
        again = await self.edited(proposal_id, 2, {"kind": "another"}, "op-edit-0002")
        self.assertEqual(self.song_ids(again)[:2], [ids[0], ids[2]])
        self.assertEqual(part(self.intent_of(again), "context")["pinned_ids"], [ids[0], ids[2]])
        self.bot.new_seed = lambda: 13
        cleared = await self.edited(
            proposal_id, 3, {"kind": "another", "pinned_ids": []}, "op-edit-0003"
        )
        context = part(self.intent_of(cleared), "context")
        self.assertEqual((context["keep_ids"], context["pinned_ids"]), ([], []))
        self.assertEqual(len(self.song_ids(cleared)), 6)
        self.assertEqual(len(self.song_ids(pinned)), 6)

    async def test_add_keeps_every_song_in_order_and_adds_new_ones_that_fit_the_filters(
        self,
    ) -> None:
        created = await self.create(seed=1, filters={"genres": ["Rock"], "limit": 4})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        self.assertEqual(len(ids), 4)
        second = await self.edited(proposal_id, 1, {"kind": "add", "count": 2})
        added = self.song_ids(second)
        self.assertEqual((added[:4], len(added), len(set(added))), (ids, 6, 6))
        stored = self.player.view().stored
        self.assertEqual({stored[sid].genre for sid in added}, {"Rock"})
        context = part(self.intent_of(second), "context")
        self.assertEqual((context["keep_ids"], context["add_count"]), (ids, 2))
        # The count is of songs, and a bare add means one.
        third = await self.edited(proposal_id, 2, {"kind": "add"}, "op-edit-0002")
        self.assertEqual(self.song_ids(third)[:6], added)
        self.assertEqual(len(self.song_ids(third)), 7)
        for artist in set(self.artists(self.song_ids(third))):
            self.assertLessEqual(self.artists(self.song_ids(third)).count(artist), 2)

    async def test_add_says_so_when_fewer_songs_fit_than_were_asked_for(self) -> None:
        created = await self.create(seed=1, filters={"genres": ["Jazz"], "limit": 1})
        self.assertEqual(len(self.song_ids(created)), 1)
        second = await self.edited(part(created, "proposal")["id"], 1, {"kind": "add", "count": 5})
        # Only two Jazz songs exist, and the filters were not relaxed to find more.
        self.assertEqual(len(self.song_ids(second)), 2)
        self.assertIn("Could only add 1 of 5", str(part(second, "proposal")["summary"]))

    async def test_a_retry_whose_first_attempt_lands_between_its_reads_is_replayed(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        first = await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-race-0001")
        real = Store.proposal_receipt
        reads: list[str] = []

        def late(store: Store, operation_id: str) -> JsonObject | None:
            # The retry's first receipt read happens just before the first attempt's write.
            reads.append(operation_id)
            return None if len(reads) == 1 else real(store, operation_id)

        with patch.object(Store, "proposal_receipt", late):
            retry = await self.edit(proposal_id, 1, {"kind": "add", "count": 2}, "op-race-0001")
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertTrue(payload(retry)["replayed"])
        self.assertEqual(self.song_ids(payload(retry)), self.song_ids(first))
        self.assertEqual(part(payload(retry), "proposal")["revision"], 2)

    async def test_a_remove_that_leaves_a_total_short_says_nothing_was_added(self) -> None:
        total = {"total_length": {"mode": "at_least", "seconds": 800}}
        created = await self.create(contract_version=5, seed=1, filters=total)
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        removed = await self.edited(proposal_id, 1, {"kind": "remove", "ids": [ids[0]]})
        summary = str(part(removed, "proposal")["summary"])
        self.assertIn("The songs left are not at least 13.3 minutes", summary)
        self.assertNotIn("Adding 0", summary)

    async def test_remove_keeps_the_rest_in_order_and_never_picks_the_removed_again(self) -> None:
        created = await self.create(seed=1, filters={"limit": 6})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        gone = [ids[3], ids[2]]
        second = await self.edited(proposal_id, 1, {"kind": "remove", "ids": gone})
        self.assertEqual(self.song_ids(second), [ids[0], ids[1], ids[4], ids[5]])
        intent = self.intent_of(second)
        self.assertEqual(part(intent, "filters")["exclude_ids"], gone)
        self.assertEqual(part(intent, "context")["add_count"], 0)
        self.assertEqual(intent["seed"], part(created, "proposal")["seed"])
        # A later draw in this proposal may not bring them back.
        revision = 2
        added = await self.edited(proposal_id, revision, {"kind": "add", "count": 6}, "op-add-0001")
        self.assertFalse(set(gone) & set(self.song_ids(added)))
        for number in range(3):
            self.draw(20 + number)
            revision += 1
            more = await self.edited(
                proposal_id, revision, {"kind": "another"}, f"op-another-{number}1"
            )
            self.assertFalse(set(gone) & set(self.song_ids(more)))
        self.assertEqual(part(self.intent_of(more), "filters")["exclude_ids"], gone)

    async def test_removing_a_pinned_song_unpins_it(self) -> None:
        created = await self.create(seed=1, filters={"limit": 6})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        pinned = await self.edited(
            proposal_id, 1, {"kind": "another", "pinned_ids": [ids[1], ids[2]]}, "op-edit-0001"
        )
        mine = self.song_ids(pinned)
        removed = await self.edited(
            proposal_id, 2, {"kind": "remove", "ids": [mine[0]]}, "op-edit-0002"
        )
        self.assertEqual(part(self.intent_of(removed), "context")["pinned_ids"], [mine[1]])
        self.assertEqual(self.song_ids(removed), mine[1:])

    async def test_remove_works_on_a_revision_made_under_any_contract_version(self) -> None:
        for version in (1, 2, 3, 4, 5):
            with self.subTest(version=version):
                created = await self.create(contract_version=version, seed=1, filters={"limit": 5})
                ids = self.song_ids(created)
                self.assertEqual(self.intent_of(created)["contract_version"], version)
                second = await self.edited(
                    part(created, "proposal")["id"],
                    1,
                    {"kind": "remove", "ids": [ids[0]]},
                    f"op-version-{version}",
                )
                # Kept and excluded songs are version 5 fields, so the stored intent says 5.
                self.assertEqual(self.intent_of(second)["contract_version"], 5)
                self.assertEqual(self.song_ids(second), ids[1:])

    async def test_removing_from_a_refined_list_refines_what_is_left_in_its_order(self) -> None:
        created = await self.create(seed=1, filters={"limit": 8})
        proposal_id = part(created, "proposal")["id"]
        narrowed = payload(
            await self.refine(
                proposal_id, 1, scope="proposal", filters={"exclude_artists": ["Harbor"]}
            )
        )
        ids = self.song_ids(narrowed)
        self.assertGreater(len(ids), 2)
        third = await self.edited(proposal_id, 2, {"kind": "remove", "ids": [ids[1]]})
        intent = self.intent_of(third)
        self.assertEqual(self.song_ids(third), [ids[0], *ids[2:]])
        self.assertEqual(intent["scope"], "proposal")
        self.assertEqual(part(intent, "filters")["exclude_artists"], ["Harbor"])
        self.assertEqual(part(intent, "filters")["exclude_ids"], [ids[1]])
        self.assertEqual(part(intent, "context")["proposal_ids"], [ids[0], *ids[2:]])
        # The queue's list is edited the same way, and then belongs to the proposal.
        queued = await self.create(scope="queue", context={"queue_ids": ids})
        from_queue = await self.edited(
            part(queued, "proposal")["id"], 1, {"kind": "remove", "ids": [ids[0]]}, "op-edit-0002"
        )
        self.assertEqual(self.song_ids(from_queue), ids[1:])
        self.assertEqual(self.intent_of(from_queue)["scope"], "proposal")
        self.assertEqual(part(self.intent_of(from_queue), "context")["queue_ids"], [])

    async def test_another_and_add_need_a_library_search(self) -> None:
        created = await self.create(seed=1, filters={"limit": 8})
        proposal_id = part(created, "proposal")["id"]
        await self.refine(proposal_id, 1, scope="proposal", filters={"exclude_artists": ["Harbor"]})
        receipts = self.count("bot_receipts")
        edits: list[JsonObject] = [{"kind": "another"}, {"kind": "add", "count": 2}]
        for number, edit in enumerate(edits):
            with self.subTest(edit=edit["kind"]):
                refused = await self.edit(proposal_id, 2, edit, f"op-edit-000{number}")
                self.assertEqual((refused.status_code, code(refused)), (422, "edit_unsupported"))
        self.assertEqual(self.count("bot_receipts"), receipts)
        self.assertEqual(self.count("bot_proposal_revisions"), 2)

    async def test_an_edit_that_names_a_song_not_in_the_revision_or_removes_all_is_refused(
        self,
    ) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        outside = next(sid for sid in self.ids.values() if sid not in ids)
        cases: list[JsonObject] = [
            {"kind": "remove", "ids": [outside]},
            {"kind": "another", "pinned_ids": [outside]},
            {"kind": "remove", "ids": ids},
        ]
        for edit in cases:
            with self.subTest(edit=edit):
                refused = await self.edit(proposal_id, 1, edit)
                self.assertEqual((refused.status_code, code(refused)), (422, "invalid_edit"))
        self.assertEqual(self.count("bot_proposal_revisions"), 1)
        self.assertEqual(self.count("bot_receipts"), 0)

    async def test_every_edit_carries_the_filters_and_scope_untouched(self) -> None:
        filters = {
            "genres": ["Rock"],
            "exclude_artists": ["Ridge"],
            "year_from": 1987,
            "min_seconds": 100,
            "limit": 6,
        }
        created = await self.create(seed=1, filters=filters)
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        wanted = self.filters_without_exclusions(created)
        revision = 1
        edits: list[JsonObject] = [
            {"kind": "another", "pinned_ids": [ids[0]]},
            {"kind": "add", "count": 1},
            {"kind": "remove", "ids": [ids[0]]},
        ]
        for number, edit in enumerate(edits):
            with self.subTest(edit=edit["kind"]):
                made = await self.edited(proposal_id, revision, edit, f"op-carried-{number}")
                revision += 1
                self.assertEqual(self.filters_without_exclusions(made), wanted)
                self.assertEqual(self.intent_of(made)["scope"], "library")
                self.assertEqual(self.intent_of(made)["explanation"], "")

    async def test_kept_songs_count_towards_a_total_length_and_are_never_dropped(self) -> None:
        total = {"mode": "at_least", "seconds": 1000}
        created = await self.create(
            contract_version=3, seed=1, filters={"limit": 8, "total_length": total}
        )
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        self.assertEqual(len(ids), 5)
        # One more song on a floor that is met already stays met.
        added = await self.edited(proposal_id, 1, {"kind": "add", "count": 1})
        report = part(part(added, "proposal"), "duration")
        self.assertEqual(self.song_ids(added)[:5], ids)
        self.assertEqual(
            (report["kept"], report["met"], report["total_seconds"]), (5, True, 1200.0)
        )
        # Taking two away leaves the floor unmet, and no other song is swapped in or out.
        removed = await self.edited(
            proposal_id, 2, {"kind": "remove", "ids": self.song_ids(added)[:2]}, "op-edit-0002"
        )
        report = part(part(removed, "proposal"), "duration")
        self.assertEqual(len(self.song_ids(removed)), 4)
        self.assertEqual(
            (report["kept"], report["met"], report["total_seconds"]), (4, False, 800.0)
        )
        self.assertEqual(report["unmet_reason"], "not_found")
        summary = str(part(removed, "proposal")["summary"])
        self.assertIn("nothing was added in their place", summary)
        self.assertNotIn("search limit", summary)

    async def test_another_with_pinned_songs_meets_a_total_length_around_them(self) -> None:
        total = {"mode": "about", "seconds": 1000}
        created = await self.create(
            contract_version=3, seed=1, filters={"limit": 8, "total_length": total}
        )
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        self.bot.new_seed = lambda: 5
        second = await self.edited(
            proposal_id, 1, {"kind": "another", "pinned_ids": [ids[2], ids[0]]}
        )
        report = part(part(second, "proposal"), "duration")
        self.assertEqual(self.song_ids(second)[:2], [ids[0], ids[2]])
        self.assertEqual((report["kept"], report["met"]), (2, True))
        self.assertEqual(report["total_seconds"], 200.0 * len(self.song_ids(second)))

    async def test_adding_to_a_length_that_has_a_ceiling_adds_only_what_stays_under_it(
        self,
    ) -> None:
        total = {"mode": "at_most", "seconds": 1000}
        created = await self.create(
            contract_version=3, seed=1, filters={"limit": 8, "total_length": total}
        )
        ids = self.song_ids(created)
        self.assertEqual(len(ids), 5)
        second = await self.edited(part(created, "proposal")["id"], 1, {"kind": "add", "count": 2})
        # The five kept songs fill it, so no song fits, and none is dropped for one.
        self.assertEqual(self.song_ids(second), ids)
        report = part(part(second, "proposal"), "duration")
        self.assertEqual(
            (report["kept"], report["met"], report["total_seconds"]), (5, True, 1000.0)
        )
        self.assertIn("Could only add 0 of 2", str(part(second, "proposal")["summary"]))

    async def test_a_retried_operation_returns_the_revision_it_made_and_adds_nothing_twice(
        self,
    ) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        first = await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-retry-0001")
        self.assertFalse(first["replayed"])
        again = await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-retry-0001")
        self.assertTrue(again["replayed"])
        self.assertEqual(self.song_ids(again), self.song_ids(first))
        self.assertEqual(part(again, "proposal")["revision"], 2)
        self.assertEqual(self.count("bot_proposal_revisions"), 2)
        self.assertEqual(self.count("bot_receipts"), 1)
        # Still the same answer after the proposal moved on.
        await self.edited(proposal_id, 2, {"kind": "add", "count": 1}, "op-retry-0002")
        late = await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-retry-0001")
        self.assertEqual(self.song_ids(late), self.song_ids(first))
        self.assertEqual(
            (part(late, "proposal")["revision"], part(late, "proposal")["latest_revision"]), (2, 3)
        )
        self.assertEqual(self.count("bot_proposal_revisions"), 3)

    async def test_an_operation_id_used_for_something_else_is_a_conflict(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        other = await self.create(seed=2, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-used-0001")
        different: list[tuple[object, int, JsonObject]] = [
            (proposal_id, 1, {"kind": "add", "count": 3}),
            (proposal_id, 1, {"kind": "another"}),
            (part(other, "proposal")["id"], 1, {"kind": "add", "count": 2}),
        ]
        for target, revision, edit in different:
            with self.subTest(edit=edit):
                refused = await self.edit(target, revision, edit, "op-used-0001")
                self.assertEqual((refused.status_code, code(refused)), (409, "operation_conflict"))
        # A commit and an edit do not share an operation id either way.
        commit = await self.commit(
            part(other, "proposal")["id"], operation_id="op-used-0001", target={"kind": "queue"}
        )
        self.assertEqual(code(commit), "operation_conflict")
        await self.commit(
            part(other, "proposal")["id"], operation_id="op-used-0002", target={"kind": "queue"}
        )
        refused = await self.edit(part(other, "proposal")["id"], 1, {"kind": "add"}, "op-used-0002")
        self.assertEqual(code(refused), "operation_conflict")
        self.assertEqual(self.count("bot_proposal_revisions"), 3)

    async def test_the_same_edit_sent_twice_at_once_lands_once(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        slow_checks = Proposals._checks

        def slow(*args: object) -> dict[str, str]:
            # Both requests read the receipt and the revision before either writes.
            time.sleep(0.2)
            return slow_checks(*args)  # type: ignore[arg-type]

        with patch.object(Proposals, "_checks", slow):
            first, second = await asyncio.gather(
                self.edit(proposal_id, 1, {"kind": "add", "count": 2}, "op-both-0001"),
                self.edit(proposal_id, 1, {"kind": "add", "count": 2}, "op-both-0001"),
            )
        self.assertEqual((first.status_code, second.status_code), (200, 200), second.text)
        self.assertEqual(sorted([payload(first)["replayed"], payload(second)["replayed"]]), [0, 1])
        self.assertEqual(self.song_ids(payload(first)), self.song_ids(payload(second)))
        self.assertEqual(self.count("bot_proposal_revisions"), 2)
        self.assertEqual(self.count("bot_receipts"), 1)

    async def test_two_different_edits_of_one_revision_cannot_both_land(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        slow_checks = Proposals._checks

        def slow(*args: object) -> dict[str, str]:
            time.sleep(0.2)
            return slow_checks(*args)  # type: ignore[arg-type]

        with patch.object(Proposals, "_checks", slow):
            first, second = await asyncio.gather(
                self.edit(proposal_id, 1, {"kind": "add", "count": 2}, "op-race-0001"),
                self.edit(proposal_id, 1, {"kind": "remove", "ids": [ids[0]]}, "op-race-0002"),
            )
        self.assertEqual(sorted([first.status_code, second.status_code]), [200, 409])
        lost = first if first.status_code == 409 else second
        self.assertEqual(code(lost), "revision_superseded")
        self.assertEqual(self.count("bot_proposal_revisions"), 2)
        # Only the edit that landed has a receipt, so the other can be sent again.
        self.assertEqual(self.count("bot_receipts"), 1)

    async def test_an_edit_of_an_older_revision_is_refused_and_writes_nothing(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        await self.edited(proposal_id, 1, {"kind": "add"}, "op-edit-0001")
        stale = await self.edit(proposal_id, 1, {"kind": "add"}, "op-edit-0002")
        self.assertEqual((stale.status_code, code(stale)), (409, "revision_superseded"))
        self.assertEqual(self.count("bot_proposal_revisions"), 2)
        self.assertEqual(self.count("bot_receipts"), 1)
        missing = await self.edit(proposal_id, 9, {"kind": "add"}, "op-edit-0003")
        self.assertEqual((missing.status_code, code(missing)), (404, "revision_not_found"))
        nothing = await self.edit("pr-0123456789abcdef", 1, {"kind": "add"}, "op-edit-0004")
        self.assertEqual((nothing.status_code, code(nothing)), (404, "proposal_not_found"))

    async def test_a_kept_song_that_cannot_play_is_named_and_never_dropped(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        stored = self.player.view().stored
        titles = [song[0] for song in test_engine.SONGS]
        lost = ids[1]
        (self.music / f"{titles.index(stored[lost].title)}.wav").unlink()
        edits: list[JsonObject] = [{"kind": "add"}, {"kind": "another", "pinned_ids": [lost]}]
        for number, edit in enumerate(edits):
            with self.subTest(edit=edit["kind"]):
                refused = await self.edit(proposal_id, 1, edit, f"op-edit-000{number}")
                self.assertEqual((refused.status_code, code(refused)), (409, "song_unavailable"))
                fields = part(payload(refused), "error")["fields"]
                self.assertEqual(
                    fields,
                    [{"field": f"context.keep_ids.{lost}", "message": "The file is unavailable"}],
                )
        # Removing a different song keeps it, so that is refused too; removing it clears the way.
        keeping = await self.edit(
            proposal_id, 1, {"kind": "remove", "ids": [ids[0]]}, "op-edit-0002"
        )
        self.assertEqual(code(keeping), "song_unavailable")
        self.assertEqual(self.count("bot_proposal_revisions"), 1)
        self.assertEqual(self.count("bot_receipts"), 0)
        done = await self.edited(proposal_id, 1, {"kind": "remove", "ids": [lost]}, "op-edit-0003")
        self.assertEqual(self.song_ids(done), [ids[0], *ids[2:]])

    async def test_edits_write_only_the_proposal_tables(self) -> None:
        created = await self.create(seed=1, filters={"limit": 5})
        proposal_id = part(created, "proposal")["id"]
        ids = self.song_ids(created)
        before = self.other_tables()
        queue = self.store.read_play_queue()
        await self.edited(proposal_id, 1, {"kind": "add", "count": 2}, "op-edit-0001")
        await self.edited(
            proposal_id, 2, {"kind": "another", "pinned_ids": [ids[0]]}, "op-edit-0002"
        )
        await self.edited(proposal_id, 3, {"kind": "remove", "ids": [ids[0]]}, "op-edit-0003")
        self.assertEqual(self.other_tables(), before)
        self.assertEqual(self.store.read_play_queue(), queue)
        self.assertEqual(self.asked, [])

    async def test_a_badly_formed_edit_is_refused(self) -> None:
        created = await self.create(seed=1, filters={"limit": 4})
        proposal_id = part(created, "proposal")["id"]
        whole = {
            "contract_version": 5,
            "revision": 1,
            "operation_id": "op-edit-0001",
            "edit": {"kind": "add"},
        }
        sent: list[tuple[JsonObject, str]] = [
            (whole | {"contract_version": 4}, "unsupported_version"),
            (whole | {"edit": {"kind": "add", "extra": 1}}, "unknown_field"),
            (whole | {"edit": {"kind": "swap"}}, "invalid_request"),
            (whole | {"edit": {"kind": "add", "count": 0}}, "invalid_request"),
            (whole | {"edit": {"kind": "remove", "ids": []}}, "invalid_request"),
            (whole | {"operation_id": "short"}, "invalid_request"),
        ]
        for body, expected in sent:
            with self.subTest(body=body):
                refused = await self.http.post(
                    f"/api/music-bot/proposals/{proposal_id}/edits", json=body
                )
                self.assertEqual((refused.status_code, code(refused)), (422, expected))
        self.assertEqual(self.count("bot_receipts"), 0)
        registry = payload(await self.http.get("/api/music-bot/capabilities"))
        found = {item["id"]: item["available"] for item in registry["capabilities"]}  # type: ignore[attr-defined]
        for name in ("proposal_edit", "exclude_ids", "keep_ids", "pinned_ids", "add_count"):
            self.assertTrue(found[name], name)


if __name__ == "__main__":
    unittest.main()
