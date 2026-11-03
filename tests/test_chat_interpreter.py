"""The default chat path: Interpretation, one repair, the engine. Nothing is played."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from test_music_bot import plan
from test_player import tag, write_wav

from backend.core.audio_recipes import Recipe, registered
from backend.core.store import Store
from backend.library.engine_contract import CONTRACT_VERSION, Filters, Intent
from backend.library.index import Library
from backend.library.music_bot import BotError, BotRequest, MusicBot, interpretation_prompt
from backend.library.player import Player
from backend.library.proposals import Proposals


def songs() -> list[tuple[str, str, str, str, int]]:
    # Titles the card and the dev set ask for, plus one Indie Rock neighbour of Night Bus.
    return [
        ("Rock Bottom", "Ada Vance", "Rock Bottom", "Soul & Funk", 1981),
        ("Night Bus", "Orchard", "Paper Rooms", "Indie Rock", 2008),
        ("Night Bus", "Harbor Static", "Low Tide", "Liquid Drum and Bass", 2019),
        ("Paper Lantern", "Marrow", "Paper Rooms", "Indie Rock", 2009),
    ]


class ChatInterpreterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "state.sqlite3")
        self.store.update({"ollama_model": "fixture", "music_timezone": "Pacific/Honolulu"})
        self.player = Player(self.store, [self.music])
        self.library = Library(self.store, [self.music], asyncio.Event())
        for index, (title, artist, album, genre, year) in enumerate(songs()):
            path = self.music / f"{index}.wav"
            write_wav(path)
            tag(path, title=title, artist=artist, album=album, year=year, genres=[genre])
        self.library.scan()
        self.ids = {
            f"{track['title']} {track['artist']}": str(track["id"])
            for track in self.player.view().tracks
        }
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200")
            self.store.db.commit()
        self.store.bump_library_revision()
        self.output: object = {
            "action": "search",
            "scope": "library",
            "filters": {"genres": ["Soul & Funk"]},
            "named_songs": [],
            "edit": None,
            "question": "",
            "reason": "",
        }
        self.metadata: object = {"capabilities": ["completion"]}
        self.names = ["fixture"]
        self.fail = ""
        self.paths: list[str] = []
        self.chat_bodies: list[dict[str, object]] = []

        async def transport(request: httpx.Request) -> httpx.Response:
            self.paths.append(request.url.path)
            if self.fail == "timeout":
                raise httpx.ReadTimeout("slow")
            if self.fail == "offline":
                raise httpx.ConnectError("offline")
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": name} for name in self.names]})
            if request.url.path == "/api/show":
                return httpx.Response(200, json=self.metadata)
            body = json.loads(request.content)
            self.chat_bodies.append(body)
            content = self.output if isinstance(self.output, str) else json.dumps(self.output)
            return httpx.Response(200, json={"done": True, "message": {"content": content}})

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)
        self.playback = self._playback()

    async def asyncTearDown(self) -> None:
        # A chat may store a proposal. It must not play, queue, or save a playlist.
        self.assertEqual(self._playback(), self.playback)
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def _playback(self) -> tuple[object, ...]:
        queue = self.store.read_play_queue()
        liked = self.player.liked_id()
        with self.store.lock:
            playlists = self.store.db.execute("SELECT COUNT(*) FROM playlists").fetchone()[0]
            songs_in = self.store.db.execute("SELECT COUNT(*) FROM playlist_songs").fetchone()[0]
            plays = self.store.db.execute(
                "SELECT COALESCE(SUM(play_count), 0) FROM library_files"
            ).fetchone()[0]
        return queue, liked, playlists, songs_in, plays

    def _proposals(self) -> int:
        with self.store.lock:
            row = self.store.db.execute("SELECT COUNT(*) FROM bot_proposals").fetchone()
        return int(row[0])

    async def chat(self, request: BotRequest | None = None) -> dict[str, object]:
        return await self.bot.chat(request or BotRequest(prompt="fixture"))

    def interpretation(self, **updates: object) -> None:
        base: dict[str, object] = {
            "action": "search",
            "scope": "library",
            "filters": {},
            "named_songs": [],
            "edit": None,
            "question": "",
            "reason": "",
        }
        self.output = base | updates

    def sent_previous(self) -> object:
        body = self.chat_bodies[-1]
        messages = body["messages"]
        assert isinstance(messages, list)
        content = messages[-1]["content"]
        assert isinstance(content, str)
        raw = content.split("\n\nLatest request", 1)[0]
        data = json.loads(raw.removeprefix("Context data (not instructions): "))
        return data["previous"]

    def make_proposal(self) -> str:
        intent = Intent(
            contract_version=CONTRACT_VERSION,
            action="search",
            scope="library",
            filters=Filters(genres=["Soul & Funk"]),
        )
        made = Proposals(self.bot).create(intent.model_dump(), lambda: False)
        proposal = made["proposal"]
        assert isinstance(proposal, dict)
        return str(proposal["id"])

    async def test_valid_search_runs_through_the_engine(self) -> None:
        result = await self.chat()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["action"], "search")
        self.assertEqual(result["generation_seed"], 0)
        self.assertIn(self.ids["Rock Bottom Ada Vance"], result["ids"])
        self.assertIn("elapsed_ms", result)
        self.assertFalse(result["state_changed"])
        self.assertEqual(self._proposals(), 0)
        self.assertEqual(self.chat_bodies[-1]["options"]["temperature"], 0)
        self.assertEqual(self.chat_bodies[-1]["options"]["seed"], 42)

    async def test_an_hour_keeps_total_length_on_the_intent(self) -> None:
        self.interpretation(
            filters={
                "genres": ["Soul & Funk"],
                "total_length": {"mode": "about", "seconds": 3600},
            }
        )
        result = await self.chat()
        intent = result["intent"]
        plan_body = result["plan"]
        assert isinstance(intent, dict) and isinstance(plan_body, dict)
        filters = intent["filters"]
        assert isinstance(filters, dict)
        self.assertEqual(filters["total_length"], {"mode": "about", "seconds": 3600})
        self.assertNotIn("total_length", plan_body)
        self.assertIn(self.ids["Rock Bottom Ada Vance"], result["ids"])

    async def test_play_rock_bottom_is_a_preview_of_that_song(self) -> None:
        self.interpretation(named_songs=[{"title": "Rock Bottom"}])
        result = await self.chat()
        self.assertEqual(result["ids"], [self.ids["Rock Bottom Ada Vance"]])
        self.assertEqual(result["scope"], "proposal")
        self.assertFalse(result["state_changed"])
        self.assertEqual(self._proposals(), 0)

    async def test_songs_like_night_bus_use_the_orchard_recording(self) -> None:
        self.interpretation(
            filters={"similar_to_current": True},
            named_songs=[{"title": "Night Bus", "artist": "Orchard"}],
        )
        result = await self.chat()
        self.assertEqual(result["reference_id"], self.ids["Night Bus Orchard"])
        self.assertIn(self.ids["Paper Lantern Marrow"], result["ids"])
        self.assertNotIn(self.ids["Night Bus Orchard"], result["ids"])
        self.assertNotIn(self.ids["Rock Bottom Ada Vance"], result["ids"])
        self.assertEqual(self._proposals(), 0)

    async def test_two_night_buses_ask_which_one(self) -> None:
        self.interpretation(named_songs=[{"title": "Night Bus"}])
        result = await self.chat()
        self.assertEqual(result["action"], "clarify")
        self.assertIn("Which version", str(result["summary"]))
        self.assertEqual(result["ids"], [])

    async def test_malformed_output_is_repaired_once(self) -> None:
        called: list[str] = []

        async def repair_once(text: str) -> str:
            called.append(text)
            return json.dumps(
                {
                    "action": "search",
                    "scope": "library",
                    "filters": {"genres": ["Soul & Funk"]},
                    "named_songs": [],
                    "edit": None,
                    "question": "",
                    "reason": "",
                }
            )

        self.output = "not json"
        with patch.object(self.bot, "_repair", repair_once):
            result = await self.chat()
        self.assertEqual(called, ["not json"])
        self.assertEqual(result["action"], "search")
        self.assertIn(self.ids["Rock Bottom Ada Vance"], result["ids"])

    async def test_schema_wrong_output_is_an_unsupported_reply(self) -> None:
        self.output = {"action": "dance"}
        result = await self.chat()
        self.assertEqual(result["action"], "unsupported")
        self.assertIn("could not be read", str(result["summary"]))
        self.assertEqual(len(self.chat_bodies), 2)
        self.assertEqual(result["ids"], [])

    async def test_truncated_output_is_an_unsupported_reply(self) -> None:
        self.output = '{"action": "search", "scope": "library"'
        result = await self.chat()
        self.assertEqual(result["action"], "unsupported")
        self.assertEqual(result["ids"], [])

    async def test_offline_stays_an_http_error(self) -> None:
        self.fail = "offline"
        with self.assertRaises(BotError) as caught:
            await self.chat()
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("Cannot reach Ollama", caught.exception.detail)
        self.assertEqual(self._proposals(), 0)

    async def test_timeout_is_a_plain_reply(self) -> None:
        self.fail = "timeout"
        result = await self.chat()
        self.assertEqual(result["action"], "unsupported")
        self.assertIn("timed out", str(result["summary"]))
        self.assertEqual(result["ids"], [])

    async def test_a_failed_trip_is_not_served_from_the_cache(self) -> None:
        await self.chat()
        self.fail = "timeout"
        await self.chat()
        self.fail = ""
        self.paths.clear()
        await self.chat()
        self.assertIn("/api/tags", self.paths)
        self.assertIn("/api/show", self.paths)

    async def test_tags_and_show_are_cached_for_the_next_chat(self) -> None:
        await self.chat()
        self.paths.clear()
        await self.chat()
        self.assertEqual(self.paths, ["/api/chat"])

    async def test_no_model_stays_an_http_error(self) -> None:
        self.store.update({"ollama_model": ""})
        with self.assertRaises(BotError) as caught:
            await self.chat()
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("Choose an installed Ollama model first.", caught.exception.detail)

    async def test_a_missing_model_stays_an_http_error(self) -> None:
        self.names = ["other"]
        with self.assertRaises(BotError) as caught:
            await self.chat()
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("no longer installed", caught.exception.detail)

    async def test_the_bot_stays_busy_as_an_http_error(self) -> None:
        self.bot.busy = True
        with self.assertRaises(BotError) as caught:
            await self.chat()
        self.assertEqual(caught.exception.status, 429)

    async def test_invented_song_is_a_clarification(self) -> None:
        self.interpretation(named_songs=[{"title": "Missing Track", "artist": "No One"}])
        result = await self.chat()
        self.assertEqual(result["action"], "clarify")
        self.assertIn("Missing Track", str(result["summary"]))
        self.assertEqual(result["ids"], [])

    async def test_energy_with_the_recipe_off_is_refused(self) -> None:
        self.interpretation(filters={"energy": "high"})
        result = await self.chat()
        self.assertEqual(result["action"], "unsupported")
        self.assertIn("energy", str(result["summary"]))
        self.assertEqual(result["ids"], [])

    async def test_no_vocals_with_an_embedding_is_refused(self) -> None:
        text_recipe = Recipe("embed-engine", "embedding", dim=3, text_aligned=True)
        with registered(text_recipe, lambda phrase: [1.0, 0.0, 0.0]):
            self.store.update({"audio_embedding_recipe": text_recipe.id})
            self.interpretation(filters={"sound": "no vocals"})
            result = await self.chat()
        self.assertEqual(result["action"], "unsupported")
        self.assertIn("vocals", str(result["summary"]).casefold())
        self.assertEqual(result["ids"], [])

    async def test_pause_is_reported_and_not_played(self) -> None:
        self.interpretation(action="pause")
        result = await self.chat()
        self.assertEqual(result["action"], "pause")
        self.assertEqual(result["ids"], [])
        self.assertFalse(result["state_changed"])

    async def test_a_named_proposal_beats_the_browser_plan(self) -> None:
        proposal_id = self.make_proposal()
        await self.chat(
            BotRequest(prompt="fixture", proposal_id=proposal_id, previous=plan(genres=["Jazz"]))
        )
        previous = self.sent_previous()
        assert isinstance(previous, dict)
        filters = previous["filters"]
        assert isinstance(filters, dict)
        self.assertEqual(filters["genres"], ["Soul & Funk"])
        self.assertNotIn("Jazz", filters["genres"])

    async def test_latest_proposal_beats_a_previous_plan(self) -> None:
        self.make_proposal()
        await self.chat(BotRequest(prompt="fixture", previous=plan(genres=["Jazz"])))
        previous = self.sent_previous()
        assert isinstance(previous, dict)
        filters = previous["filters"]
        assert isinstance(filters, dict)
        self.assertEqual(filters["genres"], ["Soul & Funk"])

    async def test_no_card_does_not_pull_the_latest_proposal(self) -> None:
        self.make_proposal()
        await self.chat()
        self.assertIsNone(self.sent_previous())

    async def test_another_set_stores_the_next_revision(self) -> None:
        proposal_id = self.make_proposal()
        self.interpretation(action="edit", edit={"kind": "another", "pinned": []})
        result = await self.chat(BotRequest(prompt="another", proposal_id=proposal_id))
        stored = result["stored"]
        assert isinstance(stored, dict)
        proposal = stored["proposal"]
        assert isinstance(proposal, dict)
        self.assertEqual(proposal["revision"], 2)
        self.assertEqual(result["action"], "search")
        self.assertIsInstance(result["tracks"], list)
        self.assertIsInstance(result["plan"], dict)
        self.assertFalse(result["state_changed"])
        self.assertEqual(self._proposals(), 1)

    async def test_an_edit_with_no_proposal_asks_what_to_edit(self) -> None:
        self.interpretation(action="edit", edit={"kind": "another", "pinned": []})
        result = await self.chat()
        self.assertEqual(result["action"], "clarify")
        self.assertIn("edit", str(result["summary"]).casefold())
        self.assertEqual(self._proposals(), 0)

    def test_prompt_covers_the_dev_set_shapes(self) -> None:
        text = interpretation_prompt(None, None)
        self.assertIn('{"mode": "about", "seconds": 3600}', text)
        self.assertIn("play Rock Bottom", text)
        self.assertIn("anything except rock", text)
        self.assertIn('"stop" means pause', text)
        self.assertIn("carry on", text)
