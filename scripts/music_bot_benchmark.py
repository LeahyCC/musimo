"""Opt-in local Ollama checks against a disposable, generated music library."""

import argparse
import asyncio
import json
import platform
import tempfile
import time
import wave
from datetime import UTC, datetime
from pathlib import Path

import httpx
from mutagen.id3 import TALB, TCON, TDRC, TIT2, TPE1
from mutagen.wave import WAVE

from backend.core.store import Store
from backend.library.index import Library
from backend.library.music_bot import BotRequest, MusicBot, SearchPlan
from backend.library.player import Player


class MeasuredBot(MusicBot):
    """Record request controls and timing without retaining model thinking text."""

    diagnostics: dict[str, object]

    async def _json(self, method: str, path: str, payload: object = None) -> object:
        if path == "/api/tags":
            self.diagnostics = {}
        if path == "/api/chat" and isinstance(payload, dict):
            self.diagnostics["controls"] = {
                key: payload[key] for key in ("think", "keep_alive") if key in payload
            }
        result = await super()._json(method, path, payload)
        if path == "/api/chat" and isinstance(result, dict):
            self.diagnostics.update(
                {
                    key: result[key]
                    for key in (
                        "total_duration",
                        "load_duration",
                        "prompt_eval_count",
                        "prompt_eval_duration",
                        "eval_count",
                        "eval_duration",
                    )
                    if key in result
                }
            )
            message = result.get("message", {})
            if isinstance(message, dict):
                self.diagnostics["thinking_characters"] = len(str(message.get("thinking", "")))
                self.diagnostics["raw_content"] = message.get("content")
        return result


async def broaden(
    bot: MeasuredBot, ids: dict[str, str], model: str, rows: list[dict[str, object]]
) -> None:
    """Independent contexts prevent one failed interpretation masking later test coverage."""
    base = SearchPlan(
        change_filters=[],
        allow_artists=[],
        add_count=0,
        action="search",
        scope="library",
        artists=[],
        exclude_artists=[],
        genres=[],
        year_from=1990,
        year_to=1999,
        favourites=True,
        history="any",
        exclude_played_days=1,
        min_seconds=0,
        max_seconds=None,
        target_seconds=3600,
        limit=500,
        similar_to_current=False,
        explanation="",
    )
    artist = base.model_copy(update={"artists": ["Fixture Harbor"]})
    excluded = base.model_copy(update={"exclude_artists": ["Fixture Harbor"]})
    cases: list[tuple[str, str, SearchPlan | None, list[str], list[str], dict[str, object]]] = [
        (
            "accumulate-exclusions",
            "Also exclude Fixture Orchard, keeping the prior exclusions.",
            excluded,
            ["Orchard"],
            [],
            {"exclude_artists": ["Fixture Harbor", "Fixture Orchard"]},
        ),
        (
            "withdraw-one-artist",
            "Allow Fixture Harbor again but keep excluding Nobody.",
            base.model_copy(update={"exclude_artists": ["Fixture Harbor", "Nobody"]}),
            ["Orchard"],
            ["Harbor", "Orchard"],
            {"exclude_artists": ["Nobody"], "scope": "library"},
        ),
        (
            "paraphrase-hour",
            "Give me sixty minutes of liked songs from 1990 to 1999; "
            "leave out anything I listened to today.",
            None,
            ["Harbor"],
            ["Harbor", "Orchard"],
            {"target_seconds": 3600, "favourites": True, "exclude_played_days": 1},
        ),
        (
            "paraphrase-favourites",
            "Build a one-hour selection of my starred nineties tracks. "
            "Nothing already played today, please.",
            None,
            [],
            ["Harbor", "Orchard"],
            {"year_from": 1990, "year_to": 1999, "history": "any"},
        ),
        (
            "queue-scope",
            "use my upcoming queue instead",
            base,
            ["Harbor"],
            ["Orchard"],
            {"scope": "queue", "exclude_played_days": 1},
        ),
        (
            "queue-paraphrase",
            "Apply those filters to the songs lined up next, not the proposed list.",
            base,
            ["Harbor"],
            ["Orchard"],
            {"scope": "queue"},
        ),
        (
            "library-scope",
            "Search the whole library instead of just this proposal.",
            base,
            ["Harbor"],
            ["Harbor", "Orchard"],
            {"scope": "library"},
        ),
        (
            "add-one",
            "add another song",
            base,
            ["Harbor"],
            ["Harbor", "Orchard"],
            {"scope": "library", "add_count": 1, "exclude_played_days": 1},
        ),
        (
            "add-paraphrase",
            "Keep this selection and find one additional matching track.",
            base,
            ["Harbor"],
            ["Harbor", "Orchard"],
            {"add_count": 1},
        ),
        (
            "change-artist",
            "Switch to Fixture Orchard instead of Fixture Harbor. Keep the other filters.",
            artist,
            ["Harbor"],
            ["Orchard"],
            {"artists": ["Fixture Orchard"], "scope": "library", "exclude_played_days": 1},
        ),
        (
            "change-decade",
            "Use the eighties instead of the nineties, keeping my other filters.",
            base,
            ["Harbor", "Orchard"],
            ["Eighties"],
            {"year_from": 1980, "year_to": 1989, "exclude_played_days": 1},
        ),
        (
            "withdraw-recent-exclusion",
            "Allow songs played today now, but keep the other filters.",
            base,
            ["Harbor", "Orchard"],
            ["Harbor", "Orchard", "Today"],
            {"exclude_played_days": 0, "scope": "library"},
        ),
        (
            "conflicting-artist",
            "Only Fixture Harbor, but still exclude Fixture Harbor. Do not relax that exclusion.",
            excluded,
            ["Orchard"],
            [],
            {"artists": ["Fixture Harbor"], "exclude_artists": ["Fixture Harbor"]},
        ),
        (
            "withdraw-artist-paraphrase",
            "Stop excluding Fixture Harbor. Leave the Nobody exclusion in place.",
            base.model_copy(update={"exclude_artists": ["Fixture Harbor", "Nobody"]}),
            ["Orchard"],
            ["Harbor", "Orchard"],
            {"exclude_artists": ["Nobody"], "exclude_played_days": 1},
        ),
        (
            "withdraw-today-paraphrase",
            "Drop the played-today exclusion, but still leave out Fixture Orchard.",
            base.model_copy(update={"exclude_artists": ["Fixture Orchard"]}),
            ["Harbor"],
            ["Harbor", "Today"],
            {"exclude_artists": ["Fixture Orchard"], "exclude_played_days": 0},
        ),
        ("genre-hip-hop", "play some hip hop", None, [], ["Cipher"], {"artists": []}),
        (
            "genre-electronic",
            "make me an electronic playlist",
            None,
            [],
            ["Pulse", "Signal", "Breaks"],
            {},
        ),
        ("genre-trance", "some trance please", None, [], ["Signal"], {}),
        ("genre-drum-and-bass", "some drum and bass", None, [], ["Breaks"], {}),
        (
            "genre-and-decade",
            "rock songs from the 90s",
            None,
            [],
            ["Harbor", "Orchard", "Today"],
            {"artists": [], "year_from": 1990, "year_to": 1999},
        ),
        ("genre-rap-decade", "some rap from the 2000s", None, [], ["Cipher"], {}),
        (
            "conflicting-history",
            "Only songs I have never played, and only songs I have played before.",
            None,
            [],
            [],
            {"action": "clarify"},
        ),
    ]
    for name, prompt, previous, proposal, expected, fields in cases:
        started = time.perf_counter()
        row: dict[str, object] = {
            "model": model,
            "phase": "warm-expanded",
            "case": name,
            "prompt": prompt,
        }
        try:
            result = await bot.chat(
                BotRequest(
                    prompt=prompt,
                    previous=previous,
                    proposal_ids=[ids[name] for name in proposal],
                    queue_ids=[ids["Orchard"], ids["Today"]],
                )
            )
            query = SearchPlan.model_validate(result["plan"])
            tracks = result["tracks"]
            assert isinstance(tracks, list)
            found = {str(track["id"]) for track in tracks}
            correct = found == {ids[name] for name in expected} and all(
                query.model_dump()[key] == value for key, value in fields.items()
            )
            if name.startswith("conflicting-") and query.action == "clarify" and not found:
                correct = True
            row.update(
                correct=correct,
                plan=query.model_dump(),
                summary=result["summary"],
                expected_titles=expected,
                expected_filters=fields,
            )
        except Exception as exc:
            row.update(correct=False, error=str(exc))
        row["seconds"] = round(time.perf_counter() - started, 3)
        row["diagnostics"] = bot.diagnostics
        rows.append(row)
        print(json.dumps(row), flush=True)


async def measure(url: str, models: list[str]) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    async with httpx.AsyncClient(timeout=8) as client:
        installed = (await client.get(url.rstrip("/") + "/api/tags")).json()["models"]
        selected = [item for item in installed if item["name"] in models]
        missing = set(models) - {item["name"] for item in selected}
        if missing:
            raise ValueError(f"Models are not fully installed: {sorted(missing)}")
        for item in selected:
            metadata = (
                await client.post(url.rstrip("/") + "/api/show", json={"model": item["name"]})
            ).json()
            item["thinking"] = metadata.get("thinking")
    with tempfile.TemporaryDirectory(prefix="musimo-bot-") as folder:
        root = Path(folder)
        music = root / "music"
        music.mkdir()
        # The genre fixtures sit outside the 1980s and 1990s, so year-filtered cases ignore them.
        for index, (title, artist, year, genres) in enumerate(
            [
                ("Harbor", "Fixture Harbor", 1992, ["Rock"]),
                ("Orchard", "Fixture Orchard", 1996, ["Rock"]),
                ("Today", "Fixture Harbor", 1998, ["Rock"]),
                ("Eighties", "Fixture Orchard", 1985, ["Rock"]),
                ("Cipher", "Fixture Cipher", 2005, ["Rap/Hip Hop"]),
                ("Pulse", "Fixture Pulse", 2012, ["Electro", "Dance"]),
                ("Signal", "Fixture Signal", 2015, ["Trance"]),
                ("Breaks", "Fixture Breaks", 2018, ["Drum and Bass"]),
            ]
        ):
            path = music / f"{index}.wav"
            with wave.open(str(path), "wb") as stream:
                stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                stream.writeframes(bytes(30 * 8000 * 2))
            audio = WAVE(path)
            audio.add_tags()
            assert audio.tags is not None
            for frame in [
                TIT2(text=title),
                TPE1(text=artist),
                TALB(text="Bot fixture"),
                TDRC(text=str(year)),
                TCON(text=genres),
            ]:
                audio.tags.add(frame)
            audio.save()
        store = Store(root / "state.sqlite3")
        try:
            store.update({"ollama_url": url, "music_timezone": "Pacific/Honolulu"})
            library = Library(store, [music], asyncio.Event())
            await asyncio.to_thread(library.scan)
            player = Player(store, [music])
            ids = {song.title: song.song_id for song in player.view().stored.values()}
            liked = await player.linked_playlist()
            for sid in ids.values():
                await player.add_playlist_song(str(liked["id"]), sid)
            await player.scrobble(ids["Today"], True)
            async with httpx.AsyncClient() as client:
                bot = MeasuredBot(store, player, client)
                for model in models:
                    store.update({"ollama_model": model})
                    # Do not evict models used by other local applications. Only label a call
                    # cold if Ollama's running-model list proves this model was absent.
                    running = (await client.get(url.rstrip("/") + "/api/ps")).json()
                    loaded = {item.get("name") for item in running.get("models", [])}
                    for phase in ["warm" if model in loaded else "cold", "warm-repeat"]:
                        previous: SearchPlan | None = None
                        proposal: list[str] = []
                        for name, prompt in [
                            (
                                "acceptance",
                                "Queue an hour of my favourite 90s music, "
                                "excluding songs played today.",
                            ),
                            ("follow-up", "remove that artist"),
                            ("audio-required", "make the rest calmer"),
                        ]:
                            started = time.perf_counter()
                            row: dict[str, object] = {"model": model, "phase": phase, "case": name}
                            try:
                                result = await bot.chat(
                                    BotRequest(
                                        prompt=prompt,
                                        previous=previous,
                                        proposal_ids=proposal,
                                        current_id=ids["Harbor"],
                                        reference_id=ids["Harbor"],
                                    )
                                )
                                query = SearchPlan.model_validate(result["plan"])
                                tracks = result["tracks"]
                                assert isinstance(tracks, list)
                                found = [str(track["id"]) for track in tracks]
                                expected = (
                                    [ids["Harbor"], ids["Orchard"]]
                                    if name == "acceptance"
                                    else [ids["Orchard"]]
                                )
                                correct = (
                                    query.action == "unsupported"
                                    if name == "audio-required"
                                    else set(found) == set(expected)
                                    and query.target_seconds == 3600
                                    and query.favourites
                                    and query.exclude_played_days == 1
                                    and query.year_from == 1990
                                    and query.year_to == 1999
                                )
                                row.update(
                                    correct=correct,
                                    plan=query.model_dump(),
                                    summary=result["summary"],
                                )
                                previous, proposal = query, found
                            except Exception as exc:
                                row.update(correct=False, error=str(exc))
                            row["seconds"] = round(time.perf_counter() - started, 3)
                            row["diagnostics"] = bot.diagnostics
                            rows.append(row)
                            print(json.dumps(row), flush=True)
                    await broaden(bot, ids, model, rows)
        finally:
            store.close()
    return {
        "timestamp": datetime.now(UTC).isoformat(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "installed_models": selected,
        "fixture": "Eight generated 30-second WAVs, real scanner and SQLite. No personal music.",
        "timing": (
            "Wall clock includes model listing, generation and library resolution. "
            "Cold means absent from /api/ps; follow-ups are warm regardless of phase label."
        ),
        "results": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:11434")
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--output", type=Path, default=Path("runtime/music-bot-benchmark.json"))
    args = parser.parse_args()
    result = asyncio.run(measure(args.url, args.model))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
