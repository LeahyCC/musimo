import asyncio
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI
from pydantic import ValidationError
from test_player import tag, write_wav

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.models import Settings
from backend.core.store import Store
from backend.library.index import Library
from backend.library.music_bot import BotError, BotRequest, MusicBot, SearchPlan, ValidateSelection
from backend.library.player import Player


def plan(**updates: object) -> SearchPlan:
    return SearchPlan.model_validate(
        {
            "action": "search",
            "change_filters": [],
            "allow_artists": [],
            "add_count": 0,
            "scope": "library",
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
        | updates
    )


def result_ids(result: dict[str, object]) -> list[str]:
    tracks = result["tracks"]
    assert isinstance(tracks, list)
    return [str(track["id"]) for track in tracks]


class MusicBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "state.sqlite3")
        self.store.update({"ollama_model": "fixture", "music_timezone": "Pacific/Honolulu"})
        self.player = Player(self.store, [self.music])
        self.library = Library(self.store, [self.music], asyncio.Event())
        for index, (title, artist, year) in enumerate(
            [
                ("A yesterday", "Harbor", 1991),
                ("B today", "Harbor", 1999),
                ("C unliked", "Harbor", 1995),
                ("D eighties", "Harbor", 1989),
                ("E other", "Orchard", 1994),
                ("F unknown", "Harbor", 0),
            ]
        ):
            path = self.music / f"{index}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album="Fixture", year=year, genres=["Rock"])
        self.library.scan()
        self.ids = {str(t["title"]): str(t["id"]) for t in self.player.view().tracks}
        with self.store.lock:
            self.store.db.execute(
                "UPDATE library_files SET duration=1200, play_count=3, "
                "last_played='2026-10-01T00:00:00Z'"
            )
            self.store.db.execute(
                "UPDATE library_files SET last_played=? WHERE song_id=?",
                ("2026-10-14T09:59:59Z", self.ids["A yesterday"]),
            )
            self.store.db.execute(
                "UPDATE library_files SET last_played=? WHERE song_id=?",
                ("2026-10-14T10:00:00Z", self.ids["B today"]),
            )
            self.store.db.commit()
        self.store.bump_library_revision()
        liked = await self.player.linked_playlist()
        for title, sid in self.ids.items():
            if title != "C unliked":
                await self.player.add_playlist_song(str(liked["id"]), sid)
        self.output: object = plan().model_dump()
        self.metadata: object = {"capabilities": ["completion"]}
        self.chat_bodies: list[dict[str, object]] = []

        async def transport(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "fixture"}]})
            if request.url.path == "/api/show":
                self.assertEqual(json.loads(request.content), {"model": "fixture"})
                return httpx.Response(200, json=self.metadata)
            body = json.loads(request.content)
            self.chat_bodies.append(body)
            self.assertFalse(body["stream"])
            self.assertEqual(body["format"]["additionalProperties"], False)
            self.assertEqual(body["keep_alive"], "60s")
            self.assertEqual(body["options"]["num_ctx"], 8192)
            return httpx.Response(
                200, json={"done": True, "message": {"content": json.dumps(self.output)}}
            )

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.bot = MusicBot(self.store, self.player, self.client)
        self.now = datetime(2026, 10, 14, 12, tzinfo=ZoneInfo("Pacific/Honolulu"))

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def resolve(self, query: SearchPlan, request: BotRequest | None = None) -> dict[str, object]:
        with patch("backend.library.music_bot.datetime") as clock:
            clock.now.return_value = self.now
            clock.fromisoformat.side_effect = datetime.fromisoformat
            return self.bot.resolve(query, request or BotRequest(prompt="fixture"))

    def test_acceptance_and_shortfall_do_not_relax_exclusions(self) -> None:
        query = plan(
            favourites=True,
            year_from=1990,
            year_to=1999,
            exclude_played_days=1,
            target_seconds=3600,
        )
        result = self.resolve(query)
        tracks = result["tracks"]
        assert isinstance(tracks, list)
        self.assertEqual({t["id"] for t in tracks}, {self.ids["A yesterday"], self.ids["E other"]})
        self.assertEqual(result["total_seconds"], 2400)
        self.assertEqual(result["shortfall_seconds"], 1200)
        self.assertIn("no exclusions were relaxed", str(result["summary"]))
        self.assertEqual(self.store.read_play_queue()["song_ids"], [])

    def test_followup_keeps_constraints_and_removes_artist(self) -> None:
        old = plan(
            favourites=True,
            year_from=1990,
            year_to=1999,
            exclude_played_days=1,
            target_seconds=3600,
        )
        request = BotRequest(
            prompt="remove that artist",
            reference_id=self.ids["A yesterday"],
            previous=old,
            proposal_ids=[self.ids["A yesterday"], self.ids["E other"]],
        )
        result = self.resolve(plan(scope="proposal", exclude_artists=["Harbor"]), request)
        tracks = result["tracks"]
        assert isinstance(tracks, list)
        self.assertEqual([t["id"] for t in tracks], [self.ids["E other"]])
        self.assertEqual(result["shortfall_seconds"], 2400)

    def test_history_duration_genre_and_queue_scope(self) -> None:
        query = plan(
            scope="queue", history="familiar", genres=["rock"], min_seconds=1000, max_seconds=1300
        )
        result = self.resolve(query, BotRequest(prompt="familiar", queue_ids=[self.ids["E other"]]))
        tracks = result["tracks"]
        assert isinstance(tracks, list)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(self.resolve(plan(history="unplayed"))["tracks"], [])

    def test_genre_words_match_broad_genres_and_raw_tags(self) -> None:
        self.assertEqual(len(result_ids(self.resolve(plan(genres=["rock music"])))), 6)
        self.assertEqual(len(result_ids(self.resolve(plan(genres=["Rock/Metal"])))), 6)
        self.assertEqual(self.resolve(plan(genres=["metal"]))["tracks"], [])
        self.assertEqual(self.resolve(plan(genres=["hip hop"]))["tracks"], [])

    def test_the_request_text_does_not_become_a_filter(self) -> None:
        result = self.resolve(plan(), BotRequest(prompt="some rock please"))
        self.assertEqual(SearchPlan.model_validate(result["plan"]).genres, [])
        result = self.resolve(plan(), BotRequest(prompt="anything but no rock"))
        self.assertEqual(SearchPlan.model_validate(result["plan"]).genres, [])

    def test_artist_names_match_whole(self) -> None:
        self.assertEqual(self.resolve(plan(artists=["rock"]))["tracks"], [])
        self.assertEqual(self.resolve(plan(artists=["Har"]))["tracks"], [])
        self.assertEqual(len(result_ids(self.resolve(plan(artists=["Harbor"])))), 5)
        self.assertEqual(len(result_ids(self.resolve(plan(artists=["Orchard"])))), 1)
        left_in = self.resolve(plan(exclude_artists=["Orch"]))
        self.assertIn(self.ids["E other"], result_ids(left_in))

    def test_followup_switches_scope_and_adds_without_repeating_or_losing_exclusions(self) -> None:
        old = plan(exclude_played_days=1, year_from=1990, year_to=1999, favourites=True)
        proposal = [self.ids["A yesterday"]]
        result = self.resolve(
            plan(scope="queue"),
            BotRequest(
                prompt="use my upcoming queue instead",
                previous=old,
                proposal_ids=proposal,
                queue_ids=[self.ids["E other"], self.ids["B today"]],
            ),
        )
        self.assertEqual(result_ids(result), [self.ids["E other"]])
        self.assertEqual(SearchPlan.model_validate(result["plan"]).scope, "queue")
        result = self.resolve(
            plan(scope="library", add_count=1),
            BotRequest(prompt="add another song", previous=old, proposal_ids=proposal),
        )
        self.assertEqual(result_ids(result), proposal + [self.ids["E other"]])
        result = self.resolve(
            plan(scope="library", add_count=2),
            BotRequest(prompt="add two songs", previous=old, proposal_ids=proposal),
        )
        self.assertIn("Could only add 1 of 2", str(result["summary"]))

    def test_explicit_filter_changes_and_withdrawals(self) -> None:
        old = plan(
            artists=["Harbor"],
            exclude_artists=["Nobody"],
            exclude_played_days=1,
            year_from=1990,
            year_to=1999,
            favourites=True,
        )
        result = self.resolve(
            plan(artists=["Orchard"], change_filters=["artists"]),
            BotRequest(
                prompt="change the artist to Orchard",
                previous=old,
                proposal_ids=[self.ids["A yesterday"]],
            ),
        )
        self.assertEqual(result_ids(result), [self.ids["E other"]])
        self.assertEqual(SearchPlan.model_validate(result["plan"]).exclude_artists, ["Nobody"])
        self.assertEqual(SearchPlan.model_validate(result["plan"]).exclude_played_days, 1)
        result = self.resolve(
            plan(year_from=1980, year_to=1989, change_filters=["year_from", "year_to"]),
            BotRequest(prompt="use the 80s instead", previous=old),
        )
        self.assertEqual(result_ids(result), [self.ids["D eighties"]])
        result = self.resolve(
            plan(change_filters=["exclude_played_days"]),
            BotRequest(prompt="allow songs played today", previous=old),
        )
        self.assertEqual(set(result_ids(result)), {self.ids["A yesterday"], self.ids["B today"]})
        result = self.resolve(
            plan(artists=["Nobody"], change_filters=["artists"]),
            BotRequest(prompt="only Nobody but keep exclusions", previous=old),
        )
        self.assertEqual(result["tracks"], [])

    def test_artist_exclusions_accumulate_and_only_named_withdrawals_are_removed(self) -> None:
        old = plan(exclude_artists=["Nobody", "Harbor"])
        result = self.resolve(
            plan(exclude_artists=["Orchard"], change_filters=["exclude_artists"]),
            BotRequest(prompt="also exclude Orchard", previous=old),
        )
        self.assertEqual(result["tracks"], [])
        self.assertEqual(
            SearchPlan.model_validate(result["plan"]).exclude_artists,
            ["Nobody", "Harbor", "Orchard"],
        )
        result = self.resolve(
            plan(allow_artists=["Harbor"]),
            BotRequest(prompt="allow Harbor again", previous=old),
        )
        self.assertEqual(SearchPlan.model_validate(result["plan"]).exclude_artists, ["Nobody"])
        self.assertEqual(len(result_ids(result)), 6)
        # A scope switch that does not name the exclusions leaves them in place.
        result = self.resolve(
            plan(scope="queue"),
            BotRequest(
                prompt="use my upcoming queue instead",
                previous=old.model_copy(update={"exclude_played_days": 1}),
                proposal_ids=[],
                queue_ids=list(self.ids.values()),
            ),
        )
        query = SearchPlan.model_validate(result["plan"])
        self.assertEqual(query.exclude_artists, ["Nobody", "Harbor"])
        self.assertEqual(query.exclude_played_days, 1)
        # The fields are the change. The wording of the request is not checked again.
        result = self.resolve(
            plan(allow_artists=["Harbor"], change_filters=["exclude_played_days"]),
            BotRequest(
                prompt="use my upcoming queue instead",
                previous=old.model_copy(update={"exclude_played_days": 1}),
            ),
        )
        query = SearchPlan.model_validate(result["plan"])
        self.assertEqual(query.exclude_artists, ["Nobody"])
        self.assertEqual(query.exclude_played_days, 0)

    def test_withdrawals_keep_the_other_exclusions(self) -> None:
        old = plan(exclude_artists=["Harbor", "Nobody"], exclude_played_days=1)
        for prompt in (
            "Allow Harbor again but keep excluding Nobody.",
            "Stop excluding Harbor. Leave the Nobody exclusion in place.",
        ):
            with self.subTest(prompt=prompt):
                result = self.resolve(
                    plan(allow_artists=["Harbor"]), BotRequest(prompt=prompt, previous=old)
                )
                query = SearchPlan.model_validate(result["plan"])
                self.assertEqual(query.exclude_artists, ["Nobody"])
                self.assertEqual(query.exclude_played_days, 1)
                self.assertNotIn(self.ids["B today"], result_ids(result))
        old = old.model_copy(update={"exclude_artists": ["Orchard"]})
        for prompt in (
            "Allow songs played today now, but keep the other filters.",
            "Drop the played-today exclusion, but still leave out Orchard.",
        ):
            with self.subTest(prompt=prompt):
                result = self.resolve(
                    plan(change_filters=["exclude_played_days"]),
                    BotRequest(prompt=prompt, previous=old),
                )
                query = SearchPlan.model_validate(result["plan"])
                self.assertEqual(query.exclude_artists, ["Orchard"])
                self.assertEqual(query.exclude_played_days, 0)
                self.assertIn(self.ids["B today"], result_ids(result))
                self.assertNotIn(self.ids["E other"], result_ids(result))

    def test_search_plans_are_used_as_given(self) -> None:
        result = self.resolve(
            plan(artists=["Harbor"]),
            BotRequest(
                prompt="remove that artist",
                reference_id=self.ids["A yesterday"],
                proposal_ids=list(self.ids.values()),
            ),
        )
        tracks = result["tracks"]
        assert isinstance(tracks, list)
        self.assertEqual({track["artist"] for track in tracks}, {"Harbor"})
        refused = self.resolve(
            plan(
                action="unsupported", explanation="That needs audio analysis, which is not enabled."
            )
        )
        self.assertEqual(refused["tracks"], [])
        self.assertEqual(SearchPlan.model_validate(refused["plan"]).action, "unsupported")
        # An explanation that asks a question does not change a search into a clarification.
        asked = self.resolve(plan(explanation="These filters contradict. Please clarify."))
        self.assertEqual(SearchPlan.model_validate(asked["plan"]).action, "search")
        self.assertTrue(asked["tracks"])

    def test_suggestions_only_come_with_questions_and_refusals(self) -> None:
        asked = plan(action="clarify", explanation="Which decade?", suggestions=["The 90s"])
        self.assertEqual(
            SearchPlan.model_validate(self.resolve(asked)["plan"]).suggestions, ["The 90s"]
        )
        # A search never carries buttons, even when a model fills the field anyway.
        stray = self.resolve(plan(suggestions=["Something else"]))
        self.assertEqual(SearchPlan.model_validate(stray["plan"]).suggestions, [])
        refused = self.resolve(
            plan(action="unsupported", suggestions=["Songs from my Liked playlist"])
        )
        self.assertEqual(
            SearchPlan.model_validate(refused["plan"]).suggestions,
            ["Songs from my Liked playlist"],
        )
        with self.assertRaises(ValidationError):
            plan(suggestions=["a", "b", "c", "d"])
        with self.assertRaises(ValidationError):
            plan(suggestions=["x" * 61])

    def test_a_chosen_scope_wins_over_the_model(self) -> None:
        proposal = [self.ids["E other"]]
        request = BotRequest(prompt="fixture", proposal_ids=proposal, scope="proposal")
        result = self.resolve(plan(scope="library"), request)
        self.assertEqual(SearchPlan.model_validate(result["plan"]).scope, "proposal")
        self.assertEqual(result_ids(result), proposal)
        # Without a choice the model's reading stands.
        result = self.resolve(plan(scope="library"), BotRequest(prompt="fixture"))
        self.assertEqual(len(result_ids(result)), 6)
        # Choosing a selection that does not exist is refused, never widened to the library.
        with self.assertRaises(BotError):
            self.resolve(plan(), BotRequest(prompt="fixture", scope="queue"))

    def test_full_duration_and_zero_matches(self) -> None:
        result = self.resolve(plan(target_seconds=3600))
        self.assertEqual(result["total_seconds"], 3600)
        self.assertEqual(result["shortfall_seconds"], 0)
        result = self.resolve(plan(artists=["Nobody"], target_seconds=3600))
        self.assertEqual(result["tracks"], [])
        self.assertEqual(result["shortfall_seconds"], 3600)

    def test_recheck_deleted_file_or_new_play(self) -> None:
        sid = self.ids["A yesterday"]
        self.bot.validate(ValidateSelection(ids=[sid], plan=plan()))
        path = self.player.local_file(sid)
        assert path is not None
        path.unlink()
        with self.assertRaises(BotError):
            self.bot.validate(ValidateSelection(ids=[sid], plan=plan()))
        sid = self.ids["E other"]
        self.store.record_play(sid)
        self.store.bump_library_revision()
        with self.assertRaises(BotError):
            self.bot.validate(ValidateSelection(ids=[sid], plan=plan(exclude_played_days=1)))

    async def test_validated_chat_and_invalid_response(self) -> None:
        result = await self.bot.chat(BotRequest(prompt="rock"))
        self.assertIn("tracks", result)
        self.output = {"sql": "SELECT * FROM library_files", "tracks": ["invented"]}
        with self.assertRaisesRegex(BotError, "invalid plan"):
            await self.bot.chat(BotRequest(prompt="rock"))
        self.assertFalse(self.bot.busy)

    async def test_non_thinking_is_selected_only_when_reported_as_supported(self) -> None:
        for metadata, expected in [
            (
                {
                    "capabilities": ["completion", "thinking"],
                    "thinking": {"values": [False, True], "default": True},
                },
                {"think": False},
            ),
            ({"thinking": {"values": [False]}}, {"think": False}),
            ({"capabilities": ["thinking"], "thinking": {"values": ["low", "medium", "high"]}}, {}),
            ({"capabilities": ["thinking"]}, {}),
            ({"capabilities": ["completion"]}, {}),
            ({"thinking": {"values": [0, "false", True]}}, {}),
        ]:
            with self.subTest(metadata=metadata):
                self.metadata = metadata
                before = len(self.chat_bodies)
                await self.bot.chat(BotRequest(prompt="rock"))
                self.assertEqual(len(self.chat_bodies), before + 1)
                body = self.chat_bodies[-1]
                self.assertEqual({key: body[key] for key in ["think"] if key in body}, expected)
        self.metadata = []
        with self.assertRaisesRegex(BotError, "invalid model capabilities"):
            await self.bot.chat(BotRequest(prompt="rock"))

    async def test_cancelling_capability_lookup_never_starts_inference(self) -> None:
        entered = asyncio.Event()
        paths: list[str] = []

        async def transport(request: httpx.Request) -> httpx.Response:
            paths.append(request.url.path)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "fixture"}]})
            entered.set()
            await asyncio.Event().wait()
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            bot = MusicBot(self.store, self.player, client)
            task = asyncio.create_task(bot.chat(BotRequest(prompt="rock")))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(paths, ["/api/tags", "/api/show"])
            self.assertFalse(bot.busy)

    async def test_unavailable_timeout_invalid_json_and_oversized_response(self) -> None:
        for failure in [httpx.ConnectError("offline"), httpx.ReadTimeout("slow")]:

            async def fail(_: httpx.Request, failure: Exception = failure) -> httpx.Response:
                raise failure

            async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
                with self.assertRaises(BotError):
                    await MusicBot(self.store, self.player, client).models()
        for body in [b"not json", b"x" * 131073, b'{"models": [4]}']:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _, body=body: httpx.Response(200, content=body)
                )
            ) as client:
                with self.assertRaises(BotError):
                    await MusicBot(self.store, self.player, client).models()

    async def test_cancellation_releases_busy_slot(self) -> None:
        entered = asyncio.Event()

        async def waiting(_: httpx.Request) -> httpx.Response:
            entered.set()
            await asyncio.Event().wait()
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(waiting)) as client:
            bot = MusicBot(self.store, self.player, client)
            task = asyncio.create_task(bot.chat(BotRequest(prompt="rock")))
            await entered.wait()
            with self.assertRaisesRegex(BotError, "busy"):
                await bot.chat(BotRequest(prompt="rock"))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(bot.busy)

    async def test_routes_validation_and_no_playback_mutations(self) -> None:
        app = FastAPI()
        install_music_bot_routes(app, lambda: self.bot)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/music-bot/chat", json={"prompt": "rock", "queue_ids": ["invented"]}
            )
            self.assertEqual(response.status_code, 422)
            response = await client.post("/api/music-bot/chat", json={"prompt": "rock"})
            self.assertEqual(response.status_code, 200)
            response = await client.post(
                "/api/music-bot/validate",
                json={"ids": [self.ids["E other"]], "plan": plan().model_dump()},
            )
            self.assertEqual(response.status_code, 200)

    def test_settings_validate_address_timezone_and_ranges(self) -> None:
        for values in [
            {"ollama_url": "file:///etc/passwd"},
            {"ollama_url": "http://user:pass@host"},
            {"music_timezone": "bad/zone"},
        ]:
            with self.assertRaises(ValidationError):
                Settings.model_validate(values)
        self.assertEqual(
            Settings(music_timezone="Pacific/Honolulu").music_timezone, "Pacific/Honolulu"
        )
        with self.assertRaises(ValidationError):
            plan(year_from=2000, year_to=1990)
        with self.assertRaises(ValidationError):
            plan(limit=501)
