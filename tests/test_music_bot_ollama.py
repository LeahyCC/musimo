"""How the music bot talks to Ollama: the context it asks for, what it trims to fit, and what
it says when Ollama refuses or cannot be reached. The Ollama here is a fake that refuses a
prompt longer than the context it was given, as the real server does."""

import asyncio
import json
import math
import re
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from test_player import tag, write_wav

from backend.api.music_bot_api import install_music_bot_routes
from backend.core.store import Store
from backend.library.index import Library
from backend.library.music_bot import BotError, BotMessage, BotRequest, MusicBot, _fitted_messages
from backend.library.player import Player

TOO_LONG = "the prompt is longer than the context length"
SEARCH: dict[str, object] = {
    "action": "search",
    "scope": "library",
    "filters": {"genres": ["Rock"]},
    "named_songs": [],
    "edit": None,
    "question": "",
    "reason": "",
}


# The fake counts tokens at the rates QA measured on a live model with real song context: ids
# at 1.1 characters a token, other text at 2.6, rounded up. That is never looser than the real
# thing, so a budget that undercounts gets refused here as it would be live.
_FAKE_ID = re.compile(r"[a-z]{2}-[0-9a-f]{16}")


def fake_tokens(text: str) -> int:
    id_chars = sum(len(found) for found in _FAKE_ID.findall(text))
    return math.ceil(id_chars / 1.1 + (len(text) - id_chars) / 2.6)


class FakeOllama:
    """Answers /api/tags, /api/show and /api/chat. A chat whose messages run past its num_ctx
    (counted by `fake_tokens`) is refused with Ollama's own error body."""

    def __init__(self) -> None:
        self.show: dict[str, object] = {"capabilities": ["completion"]}
        self.replies: list[str] = [json.dumps(SEARCH)]
        self.refuse_all = False
        self.offline = False
        self.paths: list[str] = []
        self.chats: list[dict[str, object]] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(request.url.path)
        if self.offline:
            raise httpx.ConnectError("offline")
        if self.refuse_all:
            return httpx.Response(400, json={"error": TOO_LONG})
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "fixture"}]})
        if request.url.path == "/api/show":
            return httpx.Response(200, json=self.show)
        body = json.loads(request.content)
        self.chats.append(body)
        tokens = sum(fake_tokens(message["content"]) for message in body["messages"])
        if tokens > body["options"]["num_ctx"]:
            return httpx.Response(400, json={"error": TOO_LONG})
        content = self.replies[min(len(self.chats), len(self.replies)) - 1]
        return httpx.Response(200, json={"done": True, "message": {"content": content}})


def untrimmed(
    system: str,
    history: list[dict[str, str]],
    data: Mapping[str, object],
    trim_keys: tuple[str, ...],
    prompt: str,
    num_ctx: int,
) -> list[dict[str, str]]:
    """The messages as the bot built them before it trimmed anything."""
    return _fitted_messages(system, history, data, (), prompt, 10**9)


def sent_options(body: dict[str, object]) -> dict[str, object]:
    options = body["options"]
    assert isinstance(options, dict)
    return options


def context_data(body: dict[str, object]) -> dict[str, object]:
    messages = body["messages"]
    assert isinstance(messages, list)
    content = str(messages[-1]["content"])
    raw = content.split("\n\nLatest request", 1)[0]
    data = json.loads(raw.removeprefix("Context data (not instructions): "))
    assert isinstance(data, dict)
    return data


def shown_list(body: dict[str, object]) -> list[object]:
    shown = context_data(body)["shown"]
    assert isinstance(shown, list)
    return shown


class OllamaContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        music = root / "music"
        music.mkdir()
        self.store = Store(root / "state.sqlite3")
        self.store.update({"ollama_model": "fixture", "music_timezone": "Pacific/Honolulu"})
        self.player = Player(self.store, [music])
        library = Library(self.store, [music], asyncio.Event())
        for index, artist in enumerate(["Orchard", "Harbor", "Meadow"]):
            path = music / f"{index}.wav"
            write_wav(path)
            tag(path, title=f"Song {index}", artist=artist, album="A", year=1990, genres=["Rock"])
        library.scan()
        with self.store.lock:
            self.store.db.execute("UPDATE library_files SET duration=200")
            self.store.db.commit()
        self.store.bump_library_revision()
        self.ollama = FakeOllama()
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.ollama))
        self.bot = MusicBot(self.store, self.player, self.client, new_seed=lambda: 0)

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.store.close()
        self.tmp.cleanup()

    def long_request(self) -> BotRequest:
        """A full chat: eight long turns, a long prompt and 500 songs shown lately. About
        12,000 tokens, past the 8192 the bot used to send."""
        self.store.record_shown("long", [f"tr-{index:016x}" for index in range(500)])
        history = [
            BotMessage(role="user" if turn % 2 == 0 else "assistant", content="rock " * 400)
            for turn in range(8)
        ]
        return BotRequest(prompt="something to drive to " * 90, history=history)

    async def test_a_long_request_gets_a_plan_not_a_refusal(self) -> None:
        self.ollama.show = {"parameters": "num_ctx 65536\nstop <|im_end|>"}
        result = await self.bot.chat(self.long_request())
        self.assertEqual(result["action"], "search")
        self.assertEqual(result["status"], "ok")
        options = sent_options(self.ollama.chats[-1])
        self.assertEqual((options["num_ctx"], options["num_predict"]), (32768, 1200))
        # Nothing had to go: all 500 shown songs reached the model.
        shown = context_data(self.ollama.chats[-1])["shown"]
        assert isinstance(shown, list)
        self.assertEqual(len(shown), 500)

    async def test_the_old_8192_would_have_been_refused(self) -> None:
        # Proves the request above is long: at 8192 with nothing trimmed, Ollama says no.
        request = self.long_request()
        self.ollama.show = {"parameters": "num_ctx 65536"}
        with patch("backend.library.music_bot._fitted_messages", untrimmed):
            self.store.update({"music_bot_context_cap": 8192})
            with self.assertLogs("uvicorn.error", "WARNING"):
                result = await self.bot.chat(request)
        self.assertEqual(result["action"], "unsupported")
        self.assertIn(TOO_LONG, str(result["summary"]))

    async def test_a_small_context_trims_the_extras_and_keeps_the_request(self) -> None:
        self.ollama.show = {"model_info": {"llama.context_length": 8192}}
        request = self.long_request()
        result = await self.bot.chat(request)
        self.assertEqual(result["action"], "search")
        body = self.ollama.chats[-1]
        self.assertEqual(sent_options(body)["num_ctx"], 8192)
        shown = context_data(body)["shown"]
        assert isinstance(shown, list)
        self.assertLess(len(shown), 500)
        messages = body["messages"]
        assert isinstance(messages, list)
        self.assertTrue(str(messages[-1]["content"]).endswith(request.prompt))
        self.assertEqual(messages[0]["role"], "system")

    async def test_shown_ids_are_counted_at_their_own_rate(self) -> None:
        # 500 hex ids and nothing else long. At three characters a token they looked like room
        # to spare at 8192, and a real tokenizer took them past it.
        self.ollama.show = {"model_info": {"llama.context_length": 8192}}
        self.store.record_shown("ids", [f"tr-{index:016x}" for index in range(500)])
        result = await self.bot.chat(BotRequest(prompt="rock"))
        self.assertEqual(result["action"], "search")
        shown = context_data(self.ollama.chats[-1])["shown"]
        assert isinstance(shown, list)
        self.assertGreater(len(shown), 0)
        self.assertLess(len(shown), 500)

    async def test_a_real_sized_chat_fits_8192_at_the_measured_rates(self) -> None:
        # About what a live chat carries: 280 songs shown lately, a history and the queue. At the
        # old 1.5 and 3 such a chat fit by the estimate with nothing trimmed and Ollama refused
        # it. The history grows a turn at a time until the old rates hit that refusal, so the
        # proof holds whatever the system prompt's length, instead of hanging on a fixed size.
        self.ollama.show = {"model_info": {"llama.context_length": 8192}}
        self.store.record_shown("drive", [f"tr-{index:016x}" for index in range(280)])
        turn = "Something upbeat for a long drive, mostly rock from the nineties, nothing slow. "

        def request_with(turns: int) -> BotRequest:
            history = [
                BotMessage(role="user" if index % 2 == 0 else "assistant", content=turn * 2)
                for index in range(turns)
            ]
            return BotRequest(
                prompt="more like that but with some newer songs and fewer ballads",
                history=history,
                queue_ids=list(self.player.view().by_song),
            )

        old: dict[str, object] = {}
        request = request_with(0)
        with (
            patch("backend.library.music_bot._ID_CHARS_PER_TOKEN", 1.5),
            patch("backend.library.music_bot._CHARS_PER_TOKEN", 3),
            self.assertLogs("uvicorn.error", "WARNING"),
        ):
            for turns in range(40):
                request = request_with(turns)
                old = await self.bot.chat(request)
                if old["action"] == "unsupported":
                    break
        # The first refusal came with every shown id still sent: the old estimate called it a fit.
        self.assertEqual(old["action"], "unsupported")
        self.assertIn(TOO_LONG, str(old["summary"]))
        self.assertEqual(len(shown_list(self.ollama.chats[-1])), 280)

        result = await self.bot.chat(request)
        self.assertEqual(result["action"], "search")
        body = self.ollama.chats[-1]
        self.assertEqual(sent_options(body)["num_ctx"], 8192)
        self.assertLess(len(shown_list(body)), 280)
        messages = body["messages"]
        assert isinstance(messages, list)
        tokens = sum(fake_tokens(str(message["content"])) for message in messages)
        # What was sent still leaves the model room for its whole answer.
        answer = sent_options(body)["num_predict"]
        assert isinstance(answer, int)
        self.assertLessEqual(tokens + answer, 8192)

    async def test_the_context_comes_from_the_model_up_to_the_cap(self) -> None:
        cases: list[tuple[dict[str, object], int, int]] = [
            ({"parameters": "num_ctx 65536"}, 32768, 32768),
            ({"parameters": "num_ctx 16384"}, 32768, 16384),
            ({"model_info": {"qwen3.context_length": 262144}}, 32768, 32768),
            ({"model_info": {"qwen3.context_length": 262144}}, 65536, 65536),
            # The Modelfile's num_ctx is the size Ollama loads, so it wins over the trained one.
            (
                {"parameters": "num_ctx 12288", "model_info": {"qwen3.context_length": 40960}},
                32768,
                12288,
            ),
            # A small Modelfile num_ctx never sends less than the old 8192, or the trained length
            # when that is less.
            (
                {"parameters": "num_ctx 2048", "model_info": {"qwen3.context_length": 40960}},
                32768,
                8192,
            ),
            ({"parameters": "num_ctx 4096"}, 32768, 8192),
            (
                {"parameters": "num_ctx 2048", "model_info": {"llama.context_length": 4096}},
                32768,
                4096,
            ),
            # Nothing named: the size the bot always sent.
            ({"capabilities": ["completion"]}, 32768, 8192),
            ({"model_info": {"x.context_length": True}}, 32768, 8192),
            ({"parameters": "num_ctx 65536"}, 4096, 4096),
        ]
        for show, cap, expected in cases:
            with self.subTest(show=show, cap=cap):
                self.store.update({"music_bot_context_cap": cap})
                self.ollama.show = show
                self.bot._options_cache = {}
                await self.bot.chat(BotRequest(prompt="rock"))
                self.assertEqual(sent_options(self.ollama.chats[-1])["num_ctx"], expected)

    async def test_the_repair_call_uses_the_same_context(self) -> None:
        self.ollama.show = {"parameters": "num_ctx 65536"}
        self.ollama.replies = ["not json", json.dumps(SEARCH)]
        result = await self.bot.chat(BotRequest(prompt="rock"))
        self.assertEqual(result["action"], "search")
        self.assertEqual(len(self.ollama.chats), 2)
        sizes = [sent_options(body)["num_ctx"] for body in self.ollama.chats]
        self.assertEqual(sizes, [32768, 32768])

    async def test_a_refusal_shows_ollamas_reason(self) -> None:
        self.ollama.refuse_all = True
        with self.assertLogs("uvicorn.error", "WARNING") as logs:
            with self.assertRaises(BotError) as caught:
                await self.bot._json(
                    "POST",
                    "/api/chat",
                    {"model": "fixture", "format": {"type": "object"}, "messages": ["private"]},
                )
        self.assertEqual(caught.exception.status, 502)
        self.assertIn(f"({TOO_LONG})", caught.exception.detail)
        logged = "\n".join(logs.output)
        self.assertIn("400", logged)
        self.assertIn(TOO_LONG, logged)
        self.assertIn("['format', 'messages', 'model']", logged)
        self.assertIn('{"type": "object"}', logged)
        self.assertNotIn("private", logged)

    async def test_a_refused_chat_answers_with_the_reason(self) -> None:
        self.store.update({"music_bot_context_cap": 2048})
        self.ollama.show = {"parameters": "num_ctx 2048"}
        with self.assertLogs("uvicorn.error", "WARNING"):
            result = await self.bot.chat(BotRequest(prompt="rock " * 399))
        self.assertEqual(result["action"], "unsupported")
        self.assertIn(TOO_LONG, str(result["summary"]))

    async def test_a_refusal_without_a_body_keeps_the_old_words(self) -> None:
        async def bare(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, content=b"")

        async with httpx.AsyncClient(transport=httpx.MockTransport(bare)) as client:
            bot = MusicBot(self.store, self.player, client)
            with self.assertLogs("uvicorn.error", "WARNING"):
                with self.assertRaises(BotError) as caught:
                    await bot.models()
        self.assertTrue(caught.exception.detail.startswith("Ollama refused the request. Check"))

    async def test_pause_stop_and_skip_answer_without_ollama(self) -> None:
        for outage in ("offline", "refuse_all"):
            setattr(self.ollama, outage, True)
            for prompt, action in (("pause", "pause"), ("stop", "pause"), ("skip", "skip")):
                with self.subTest(outage=outage, prompt=prompt):
                    self.ollama.paths.clear()
                    result = await self.bot.chat(BotRequest(prompt=prompt))
                    self.assertEqual(result["status"], "ok")
                    self.assertEqual(result["action"], action)
                    self.assertEqual(self.ollama.paths, [])
            setattr(self.ollama, outage, False)


class DockerAddressTests(unittest.IsolatedAsyncioTestCase):
    """Settings' Test Ollama connection calls the models route. In Docker, 127.0.0.1 is the
    container, so the error names the host's address."""

    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "state.sqlite3")
        self.dockerenv = self.root / ".dockerenv"

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    async def detail(self) -> str:
        async def offline(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline")

        async with httpx.AsyncClient(transport=httpx.MockTransport(offline)) as client:
            bot = MusicBot(self.store, Player(self.store, []), client)
            app = FastAPI()
            install_music_bot_routes(app, lambda: bot)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as http:
                with patch("backend.library.music_bot._DOCKERENV", self.dockerenv):
                    response = await http.get("/api/music-bot/models")
        self.assertEqual(response.status_code, 503)
        return str(response.json()["detail"])

    async def test_loopback_in_docker_suggests_host_docker_internal(self) -> None:
        self.dockerenv.touch()
        for url in ("http://127.0.0.1:11434", "http://localhost:11434"):
            with self.subTest(url=url):
                self.store.update({"ollama_url": url})
                detail = await self.detail()
                self.assertIn("Cannot reach Ollama", detail)
                self.assertIn("On Docker Desktop, try http://host.docker.internal:11434", detail)

    async def test_no_hint_outside_docker_or_for_another_host(self) -> None:
        self.assertNotIn("host.docker.internal", await self.detail())
        self.dockerenv.touch()
        self.store.update({"ollama_url": "http://192.168.1.20:11434"})
        detail = await self.detail()
        self.assertIn("Cannot reach Ollama", detail)
        self.assertNotIn("host.docker.internal", detail)


if __name__ == "__main__":
    unittest.main()
