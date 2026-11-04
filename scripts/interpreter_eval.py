"""Score a model against the 2A interpreter suite in `evals/interpreter`.

The suite is labelled data, not code. This runner builds the invented 25-song library in a
temporary folder and database, sends each case through `MusicBot.chat` (the same path the
server uses), and scores the intent the engine received. It never opens the live database and
never prints a case prompt. The held-out split is opened only after its seal matches.

Run it against an installed model on the Ollama host:

    uv run python -m scripts.interpreter_eval --model qwen3.5:9b --split dev
    uv run python -m scripts.interpreter_eval --model qwen3.5:9b --split heldout

The report lands in `evals/interpreter/reports/`, which git ignores.
"""

import argparse
import asyncio
import hashlib
import json
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import httpx
from mutagen.id3 import TALB, TCON, TDRC, TIT2, TPE1
from mutagen.wave import WAVE

from backend.core.audio_recipes import Recipe, registered
from backend.core.store import Store
from backend.library.engine import Engine
from backend.library.engine_contract import CONTRACT_VERSION, Context, Filters, Intent
from backend.library.index import Library
from backend.library.music_bot import BotRequest, MusicBot
from backend.library.player import Player

SUITE = Path(__file__).resolve().parent.parent / "evals" / "interpreter"
REPORTS = SUITE / "reports"
TRANSPORT = {"pause", "resume", "skip"}
SPELLED = {"artists", "exclude_artists", "genres"}
SOUND_RECIPE = Recipe("eval-sound-v1", "embedding", dim=3, text_aligned=True)
SEED = 42
NUM_CTX = 8192

# docs/v2-gates.md, 2A pass marks. Hard gates are all-or-nothing; quality is a rate.
GATES = {
    "action_scope": 0.95,
    "constraints": 0.90,
    "follow_ups": 0.95,
    "ambiguous": 0.80,
    "clear_question": 0.05,
    "warm_p50": 2.5,
    "warm_p95": 5.0,
    "cold": 30.0,
    "vram": 14.0,
}


class SealError(RuntimeError):
    """The held-out file is not the one that was sealed."""


class ModelError(RuntimeError):
    """The model cannot be evaluated as the gates require."""


def read_json(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return cast(object, json.load(handle))


def digest(path: Path) -> str:
    """The SHA-256 of parsed JSON, sorted and without spaces, the same as the suite test."""
    canonical = json.dumps(
        read_json(path), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_split(split: str, suite: Path = SUITE) -> dict[str, object]:
    """Load a split, checking the held-out seal before its cases are read into the report."""
    path = suite / f"{split}.json"
    if split == "heldout":
        seal = cast(dict[str, object], read_json(suite / "seal.json"))
        if digest(path) != seal.get("sha256"):
            raise SealError("The held-out file does not match seal.json. Nothing was run.")
    data = read_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a suite file")
    return cast(dict[str, object], data)


def first_spelling(filters: dict[str, object]) -> dict[str, object]:
    """A concrete intent: take the first spelling of each genre or artist alternative."""
    out = dict(filters)
    for name in SPELLED & out.keys():
        values = out[name]
        if isinstance(values, list):
            out[name] = [str(value).split("|")[0] for value in values]
    return out


def _spell_match(expected: object, actual: object) -> bool:
    """Lists compare as sets, and "a|b" matches either spelling."""
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return False
        left = [{part.casefold() for part in str(item).split("|")} for item in expected]
        for value in actual:
            hit = next((each for each in left if str(value).casefold() in each), None)
            if hit is None:
                return False
            left.remove(hit)
        return True
    return expected == actual


def _defaults() -> dict[str, object]:
    return Filters().model_dump()


def compare_filters(
    expected: dict[str, object], actual: dict[str, object], limit_listed: bool
) -> list[str]:
    """Fields that differ from the expected filters. Every unlisted field must be default."""
    default = _defaults()
    wanted = default | expected
    given = default | {name: value for name, value in actual.items() if name in default}
    failed: list[str] = []
    for name in default:
        if name == "limit" and not limit_listed:
            continue
        if name in SPELLED:
            same = _spell_match(wanted[name], given[name])
        else:
            same = wanted[name] == given[name]
        if not same:
            failed.append(name)
    return failed


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _ids(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def actual_intent(result: dict[str, object]) -> dict[str, object]:
    """The intent the chat result carries. An edit keeps it under `stored.proposal`."""
    stored = _as_dict(result.get("stored"))
    proposal = _as_dict(stored.get("proposal"))
    found = _as_dict(proposal.get("intent"))
    if found:
        return found
    return _as_dict(result.get("intent"))


def result_ids(result: dict[str, object]) -> list[str]:
    return _ids(result.get("ids"))


def _named_ids(intent: dict[str, object]) -> set[str]:
    context = _as_dict(intent.get("context"))
    found = {str(context.get("reference_id") or "")}
    found.update(_ids(context.get("proposal_ids")))
    found.discard("")
    return found


def _edit_from_intent(
    previous_ids: list[str], previous_filters: dict[str, object], intent: dict[str, object]
) -> dict[str, object]:
    """The edit an intent applied, read from the revision it stored."""
    context = _as_dict(intent.get("context"))
    filters = _as_dict(intent.get("filters"))
    add_count = context.get("add_count")
    if isinstance(add_count, int) and not isinstance(add_count, bool) and add_count > 0:
        return {"kind": "add", "count": add_count}
    # A remove adds its ids to exclude_ids. An "another" draw may also drop songs from the
    # revision, so the new exclusions, not the missing ids, are what identify a remove.
    before = set(_ids(previous_filters.get("exclude_ids")))
    after = [song for song in _ids(filters.get("exclude_ids")) if song not in before]
    if after:
        return {"kind": "remove", "ids": after}
    keep = _ids(context.get("keep_ids"))
    pinned = [song for song in previous_ids if song in keep]
    return {"kind": "another", "pinned": pinned}


def _outcome(result: dict[str, object], error: str | None) -> str | None:
    """The usable reply an outage ended in, or None when it ended in an error."""
    if error is not None:
        return None
    action = str(result.get("action") or "")
    if action in TRANSPORT:
        return "control"
    if action in {"unsupported", "clarify"}:
        text = str(result.get("summary") or "").casefold()
        return "retry" if "retry" in text or "try again" in text else "template"
    return None


def _intent_unknown(intent: dict[str, object], library: set[str]) -> bool:
    """Whether an id outside the library sits anywhere in an intent."""
    context = _as_dict(intent.get("context"))
    filters = _as_dict(intent.get("filters"))
    found = {str(context.get("current_id") or ""), str(context.get("reference_id") or "")}
    for name in ("proposal_ids", "queue_ids", "keep_ids", "pinned_ids"):
        found.update(_ids(context.get(name)))
    found.update(_ids(filters.get("exclude_ids")))
    found.discard("")
    return bool(found - library)


def _check_ids(result: dict[str, object], intent: dict[str, object], library: set[str]) -> bool:
    """Whether an id outside the library reached the reply or its intent."""
    return bool(set(result_ids(result)) - library) or _intent_unknown(intent, library)


@dataclass
class CaseScore:
    case_id: str
    action_ok: bool | None = None
    scope_ok: bool | None = None
    filters_ok: bool | None = None
    songs_ok: bool | None = None
    edit_ok: bool | None = None
    keeps_ok: bool | None = None
    drops_ok: bool | None = None
    ambiguous_ok: bool | None = None
    clear_question: bool = False
    outage_ok: bool | None = None
    mutation_ok: bool = True
    invented_id: bool = False
    no_songs: bool = False
    dropped: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    def constraint_ok(self) -> bool | None:
        parts = [
            value
            for value in (
                self.filters_ok,
                self.songs_ok,
                self.edit_ok,
                self.keeps_ok,
                self.drops_ok,
            )
            if value is not None
        ]
        return all(parts) if parts else None

    def key(self) -> tuple[object, ...]:
        return (
            self.action_ok,
            self.scope_ok,
            self.filters_ok,
            self.songs_ok,
            self.edit_ok,
            self.keeps_ok,
            self.drops_ok,
            self.ambiguous_ok,
            self.outage_ok,
            self.invented_id,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "case": self.case_id,
            "action_ok": self.action_ok,
            "scope_ok": self.scope_ok,
            "filters_ok": self.filters_ok,
            "songs_ok": self.songs_ok,
            "edit_ok": self.edit_ok,
            "keeps_ok": self.keeps_ok,
            "drops_ok": self.drops_ok,
            "ambiguous_ok": self.ambiguous_ok,
            "clear_question": self.clear_question,
            "outage_ok": self.outage_ok,
            "mutation_ok": self.mutation_ok,
            "invented_id": self.invented_id,
            "no_songs": self.no_songs,
            "dropped": self.dropped,
            "failures": self.failures,
        }


def score_case(
    case: dict[str, object],
    result: dict[str, object],
    ids: dict[str, str],
    previous_ids: list[str] | None = None,
    error: str | None = None,
    mutated: bool = False,
) -> CaseScore:
    """Score one chat result against its labelled case. No prompt is read or printed."""
    expect = _as_dict(case.get("expect"))
    case_id = str(case.get("id", ""))
    score = CaseScore(case_id)
    intent = actual_intent(result)
    action = str(result.get("action") or "")
    expected_action = str(expect.get("action") or "")
    library = set(ids.values())

    score.invented_id = _check_ids(result, intent, library)
    if score.invented_id:
        score.failures.append("invented_id")

    if "outcome" in expect:
        wanted = {str(item) for item in _ids(expect.get("outcome"))}
        ended = _outcome(result, error)
        score.outage_ok = ended in wanted
        if not score.outage_ok:
            score.failures.append("outage")
    else:
        previous = _as_dict(case.get("previous"))
        previous_filters = _as_dict(previous.get("filters"))
        previous_song_ids = previous_ids or []
        edit = _as_dict(expect.get("edit"))

        if expected_action == "edit":
            applied = _edit_from_intent(previous_song_ids, previous_filters, intent)
            edit_ok = str(applied.get("kind")) == str(edit.get("kind"))
            if edit_ok and edit.get("kind") == "another":
                wanted_pins = [ids[key] for key in _ids(edit.get("pinned")) if key in ids]
                edit_ok = _ids(applied.get("pinned")) == wanted_pins
            elif edit_ok and edit.get("kind") == "add":
                edit_ok = applied.get("count") == edit.get("count")
                kept = set(_ids(_as_dict(intent.get("context")).get("keep_ids")))
                edit_ok = edit_ok and set(previous_song_ids) <= kept
            elif edit_ok and edit.get("kind") == "remove":
                wanted_gone = {ids[key] for key in _ids(edit.get("ids")) if key in ids}
                edit_ok = set(_ids(applied.get("ids"))) == wanted_gone
            # An edit carries every earlier filter over untouched. A remove is the one edit
            # that changes exclude_ids, so that field is not part of the carried check.
            carried = compare_filters(
                {name: value for name, value in previous_filters.items() if name != "exclude_ids"},
                {
                    name: value
                    for name, value in _as_dict(intent.get("filters")).items()
                    if name != "exclude_ids"
                },
                "limit" in previous_filters,
            )
            edit_ok = edit_ok and not carried
            score.edit_ok = edit_ok
            score.action_ok = str(applied.get("kind")) == str(edit.get("kind"))
            if not edit_ok:
                score.failures.append("edit")
        else:
            score.action_ok = action == expected_action
            if not score.action_ok:
                score.failures.append("action")

            if expected_action == "search":
                score.scope_ok = str(result.get("scope") or "library") == str(
                    expect.get("scope") or "library"
                )
                if not score.scope_ok:
                    score.failures.append("scope")

            expected_filters = _as_dict(expect.get("filters"))
            failed = compare_filters(
                expected_filters,
                _as_dict(intent.get("filters")),
                "limit" in expected_filters,
            )
            score.filters_ok = not failed
            default = _defaults()
            score.dropped = [
                name
                for name in failed
                if expected_filters.get(name, default[name]) != default[name]
            ]
            if failed:
                score.failures.extend(f"filter:{name}" for name in failed)

            if "songs" in expect:
                wanted = {ids[key] for key in _ids(expect.get("songs")) if key in ids}
                score.songs_ok = _named_ids(intent) == wanted
                if not score.songs_ok:
                    score.failures.append("songs")

            if "keeps" in expect:
                failed_keeps: list[str] = []
                given = _as_dict(intent.get("filters"))
                for name in _ids(expect.get("keeps")):
                    if not _spell_match(previous_filters.get(name), given.get(name)):
                        failed_keeps.append(name)
                score.keeps_ok = not failed_keeps
                if failed_keeps:
                    score.failures.extend(f"keeps:{name}" for name in failed_keeps)

            if "drops" in expect:
                default = _defaults()
                given = _as_dict(intent.get("filters"))
                failed_drops = [
                    name
                    for name in _ids(expect.get("drops"))
                    if given.get(name) != default.get(name)
                ]
                score.drops_ok = not failed_drops
                if failed_drops:
                    score.failures.extend(f"drops:{name}" for name in failed_drops)

        if expect.get("ambiguous") is True:
            score.ambiguous_ok = action == "clarify"
            if not score.ambiguous_ok:
                score.failures.append("ambiguous")
        else:
            score.clear_question = action == "clarify"

        expected_mutation = expected_action if expected_action in TRANSPORT else None
        actual_mutation = action if action in TRANSPORT else None
        score.mutation_ok = mutated is False and (
            actual_mutation is None or actual_mutation == expected_mutation
        )
        if not score.mutation_ok:
            score.failures.append("mutation")

    score.no_songs = not result_ids(result)
    return score


# ---------------------------------------------------------------------------
# The live run: a temporary library, a fault-injecting transport, timings and VRAM.


def write_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\0\0" * 800)


def tag(path: Path, song: dict[str, object]) -> None:
    audio = WAVE(path)
    audio.add_tags()
    assert audio.tags is not None
    for frame in [
        TIT2(text=str(song["title"])),
        TPE1(text=str(song["artist"])),
        TALB(text=str(song["album"])),
        TDRC(text=str(song["year"])),
        TCON(text=[str(song["genre"])]),
    ]:
        audio.tags.add(frame)
    audio.save()


def _timestamp(days_ago: int | None) -> str | None:
    if days_ago is None:
        return None
    when = datetime.now(UTC) - timedelta(days=days_ago)
    return when.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def build_library(root: Path) -> tuple[Store, Player, dict[str, str]]:
    """The invented library, scanned into its own temp folder and sqlite database."""
    data = cast(dict[str, list[dict[str, object]]], read_json(SUITE / "library.json"))
    songs = data["songs"]
    music = root / "music"
    music.mkdir()
    for song in songs:
        path = music / f"{song['key']}.wav"
        write_wav(path)
        tag(path, song)
    store = Store(root / "state.sqlite3")
    store.update({"music_timezone": "UTC"})
    library = Library(store, [music], asyncio.Event())
    library.scan()
    player = Player(store, [music])
    found = {
        (str(track["title"]), str(track["artist"])): str(track["id"])
        for track in player.view().tracks
    }
    ids = {str(song["key"]): found[(str(song["title"]), str(song["artist"]))] for song in songs}
    with store.lock:
        for song in songs:
            store.db.execute(
                "UPDATE library_files SET duration=?, play_count=?, last_played=? WHERE song_id=?",
                (
                    float(str(song["seconds"])),
                    int(str(song["plays"])),
                    _timestamp(
                        int(str(song["played_days_ago"]))
                        if song["played_days_ago"] is not None
                        else None
                    ),
                    ids[str(song["key"])],
                ),
            )
        store.db.commit()
    store.bump_library_revision()
    liked = await player.linked_playlist()
    for song in songs:
        if song["favourite"] is True:
            await player.add_playlist_song(str(liked["id"]), ids[str(song["key"])])
    return store, player, ids


class FaultTransport(httpx.AsyncBaseTransport):
    """A proxy in front of Ollama that injects the README's faults and records the controls."""

    def __init__(self, upstream: httpx.AsyncBaseTransport):
        self.upstream = upstream
        self.fault = ""
        self.calls: list[dict[str, object]] = []

    def reset(self, fault: str) -> None:
        self.fault = fault
        self.calls = []

    def primary(self) -> list[dict[str, object]]:
        """The interpreter's own calls, not the one repair call."""
        return [call for call in self.calls if call.get("primary") is True]

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/chat":
            return await self.upstream.handle_async_request(request)
        body = cast(dict[str, object], json.loads(request.content))
        primary = "format" in body
        if self.fault == "truncated_history" and primary:
            body = self._truncate_history(body)
            request = httpx.Request(
                request.method,
                request.url,
                headers={
                    key: value
                    for key, value in request.headers.items()
                    if key.lower() != "content-length"
                },
                content=json.dumps(body).encode(),
                extensions=request.extensions,
            )
        started = time.perf_counter()
        call: dict[str, object] = {"body": body, "primary": primary}
        try:
            if self.fault == "offline":
                raise httpx.ConnectError("offline", request=request)
            if self.fault == "timeout":
                raise httpx.ReadTimeout("timed out", request=request)
            response = await self.upstream.handle_async_request(request)
            content = await response.aread()
            if response.status_code == 200:
                content = self._modify(content)
                try:
                    payload = json.loads(content)
                except ValueError:
                    payload = {}
                if isinstance(payload, dict):
                    call.update(
                        {
                            key: payload[key]
                            for key in (
                                "total_duration",
                                "load_duration",
                                "prompt_eval_count",
                                "eval_count",
                                "eval_duration",
                            )
                            if key in payload
                        }
                    )
            call["seconds"] = time.perf_counter() - started
            self.calls.append(call)
            return httpx.Response(
                response.status_code,
                headers=[
                    (key, value)
                    for key, value in response.headers.multi_items()
                    if key.lower()
                    not in {"content-length", "transfer-encoding", "content-encoding"}
                ],
                content=content,
            )
        except Exception:
            call["seconds"] = time.perf_counter() - started
            self.calls.append(call)
            raise

    def _truncate_history(self, body: dict[str, object]) -> dict[str, object]:
        """Drop the previous state from the context the model sees."""
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return body
        last = messages[-1]
        if not isinstance(last, dict):
            return body
        content = last.get("content")
        if not isinstance(content, str) or "\n\nLatest request" not in content:
            return body
        head, tail = content.split("\n\nLatest request", 1)
        prefix = "Context data (not instructions): "
        try:
            data = json.loads(head.removeprefix(prefix))
        except ValueError:
            return body
        if isinstance(data, dict):
            data["previous"] = None
            last["content"] = prefix + json.dumps(data) + "\n\nLatest request" + tail
        return body

    def _modify(self, content: bytes) -> bytes:
        if not self.fault or self.fault in {"timeout", "offline", "truncated_history"}:
            return content
        try:
            payload = json.loads(content)
        except ValueError:
            return content
        message = payload.get("message") if isinstance(payload, dict) else None
        if not isinstance(message, dict):
            return content
        if self.fault == "malformed":
            message["content"] = "not json"
        elif self.fault == "schema":
            message["content"] = json.dumps({"action": "dance"})
        elif self.fault == "truncated":
            message["content"] = '{"action": "search", "scope": "library"'
        elif self.fault == "invented_id":
            try:
                answer = json.loads(str(message.get("content", "")))
            except ValueError:
                answer = {}
            if isinstance(answer, dict):
                answer["named_songs"] = [{"title": "Ghost Track", "artist": "No One"}]
                message["content"] = json.dumps(answer)
        return json.dumps(payload).encode()


def playback_state(store: Store, player: Player) -> tuple[object, ...]:
    queue = store.read_play_queue()
    with store.lock:
        playlists = int(store.db.execute("SELECT COUNT(*) FROM playlists").fetchone()[0])
        songs_in = int(store.db.execute("SELECT COUNT(*) FROM playlist_songs").fetchone()[0])
        plays = int(
            store.db.execute("SELECT COALESCE(SUM(play_count), 0) FROM library_files").fetchone()[0]
        )
    return (
        str(queue.get("current") or ""),
        tuple(_ids(queue.get("song_ids"))),
        int(str(queue.get("position") or 0)),
        player.liked_id(),
        playlists,
        songs_in,
        plays,
    )


def reset_case(store: Store, case: dict[str, object], ids: dict[str, str]) -> str | None:
    """Make one case independent: clear proposals and the queue, then set its state."""
    with store.lock:
        store.db.execute("DELETE FROM bot_receipts")
        store.db.execute("DELETE FROM bot_proposal_revisions")
        store.db.execute("DELETE FROM bot_proposals")
        store.db.commit()
    store.forget_shown()
    recipes = {str(item) for item in _ids(case.get("recipes"))}
    store.update(
        {
            "audio_scalar_recipe": "tempo-beat-v1" if "tempo_energy" in recipes else "",
            "audio_energy": "tempo_energy" in recipes,
            "audio_embedding_recipe": SOUND_RECIPE.id if "sound" in recipes else "",
        }
    )
    playing = str(case.get("playing") or "")
    queue = _ids(case.get("queue"))
    song_ids = ([ids[playing]] if playing else []) + [ids[key] for key in queue]
    store.write_play_queue(song_ids, ids[playing] if playing else "", 0)
    proposal_id: str | None = None
    previous = _as_dict(case.get("previous"))
    if previous:
        previous_ids = [ids[key] for key in _ids(previous.get("songs"))]
        scope = str(previous.get("scope") or "library")
        context = Context(proposal_ids=previous_ids) if scope != "library" else Context()
        intent = Intent(
            contract_version=CONTRACT_VERSION,
            action="search",
            scope=scope,  # type: ignore[arg-type]
            filters=Filters.model_validate(first_spelling(_as_dict(previous.get("filters")))),
            context=context,
        )
        saved = store.save_proposal(
            None,
            0,
            {
                "intent": intent.model_dump(),
                "seed": 0,
                "ids": previous_ids,
                "snapshot": {},
                "checks": [],
                "totals": {
                    "total_seconds": 0,
                    "shortfall_seconds": 0,
                    "duration": None,
                    "summary": "",
                    "dropped_ids": [],
                },
            },
        )
        if isinstance(saved, tuple):
            proposal_id = saved[0]
    return proposal_id


def request_for(
    case: dict[str, object], ids: dict[str, str], proposal_id: str | None
) -> BotRequest:
    playing = str(case.get("playing") or "")
    current = ids[playing] if playing else None
    return BotRequest(
        prompt=str(case.get("prompt") or ""),
        proposal_id=proposal_id,
        current_id=current,
        reference_id=current,
        queue_ids=[ids[key] for key in _ids(case.get("queue"))],
    )


@contextmanager
def engine_timer(sink: list[float], intents: list[dict[str, object]]) -> Iterator[None]:
    """Record every `Engine.run`, so interpreter and engine time are reported apart and an
    id outside the library cannot pass unseen."""
    original = Engine.run

    def timed(self: Engine, intent: Intent) -> dict[str, object]:
        started = time.perf_counter()
        try:
            return original(self, intent)
        finally:
            sink.append(time.perf_counter() - started)
            intents.append(intent.model_dump())

    Engine.run = timed  # type: ignore[method-assign]
    try:
        yield
    finally:
        Engine.run = original  # type: ignore[method-assign]


def _query_vram() -> float | None:
    tool = shutil.which("nvidia-smi")
    if tool is None:
        return None
    try:
        done = subprocess.run(
            [tool, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    values = [int(line.strip()) for line in done.stdout.splitlines() if line.strip().isdigit()]
    return float(sum(values)) if values else None


class VramSampler:
    def __init__(self) -> None:
        self.peak: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            value = _query_vram()
            if value is not None and (self.peak is None or value > self.peak):
                self.peak = value
            self._stop.wait(0.5)

    def stop(self) -> float | None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        return self.peak


def _percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((percent / 100) * len(ordered) + 0.999999) - 1))
    return ordered[index]


def _thinking_supported(metadata: dict[str, object]) -> bool:
    thinking = metadata.get("thinking")
    capabilities = metadata.get("capabilities")
    return isinstance(thinking, dict) or (
        isinstance(capabilities, list) and "thinking" in capabilities
    )


def _off_switch(metadata: dict[str, object]) -> bool:
    thinking = metadata.get("thinking")
    if isinstance(thinking, dict):
        values = thinking.get("values")
        if isinstance(values, list) and any(value is False for value in values):
            return True
        return False
    capabilities = metadata.get("capabilities")
    return isinstance(capabilities, list) and "thinking" in capabilities


async def model_info(url: str, model: str) -> dict[str, object]:
    async with httpx.AsyncClient(timeout=10) as client:
        tags = await client.get(url.rstrip("/") + "/api/tags")
        tags.raise_for_status()
        installed = {
            str(row.get("name")): str(row.get("digest") or "")
            for row in tags.json().get("models", [])
            if isinstance(row, dict)
        }
        if model not in installed:
            raise ModelError(f"{model} is not installed on {url}.")
        show = await client.post(url.rstrip("/") + "/api/show", json={"model": model})
        show.raise_for_status()
        metadata = cast(dict[str, object], show.json())
        if not metadata.get("digest"):
            metadata["digest"] = installed[model]
    if _thinking_supported(metadata) and not _off_switch(metadata):
        raise ModelError(
            f"{model} thinks but /api/show lists no off switch, so thinking cannot be turned "
            "off. It was not evaluated."
        )
    return metadata


async def unload(url: str, model: str) -> None:
    """Ask Ollama to unload the model so the first request is a real cold load."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                url.rstrip("/") + "/api/generate",
                json={"model": model, "keep_alive": 0},
            )
    except httpx.HTTPError:
        pass


async def ps_info(url: str, model: str) -> dict[str, object] | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            rows = (await client.get(url.rstrip("/") + "/api/ps")).json().get("models", [])
    except (httpx.HTTPError, ValueError):
        return None
    for row in rows:
        if isinstance(row, dict) and str(row.get("name")) == model:
            return row
    return None


def git_sha() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=SUITE.parent.parent,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _model_slug(model: str) -> str:
    return "".join(char if char.isalnum() or char in ".-" else "-" for char in model)


async def evaluate(args: argparse.Namespace) -> dict[str, object]:
    data = load_split(args.split)
    cases = cast(list[dict[str, object]], data.get("cases"))
    if args.case:
        wanted = set(args.case)
        cases = [case for case in cases if str(case.get("id")) in wanted]
    metadata = await model_info(args.ollama_url, args.model)
    digest_value = str(metadata.get("digest") or "")
    thinking = _thinking_supported(metadata)
    controls: dict[str, object] = {}
    controls_ok = True
    primary_bodies: list[dict[str, object]] = []

    with tempfile.TemporaryDirectory(prefix="musimo-interpreter-") as folder:
        store, player, ids = await build_library(Path(folder))
        store.update(
            {
                "ollama_url": args.ollama_url,
                "ollama_model": args.model,
                "music_bot_legacy_chat": False,
            }
        )
        transport = FaultTransport(httpx.AsyncHTTPTransport())
        async with httpx.AsyncClient(transport=transport, timeout=120) as client:
            bot = MusicBot(store, player, client, new_seed=lambda: 0)
            with registered(SOUND_RECIPE, lambda phrase: [1.0, 0.0, 0.0]):
                await unload(args.ollama_url, args.model)
                idle = _query_vram()
                sampler = VramSampler()
                sampler.start()
                rows: list[dict[str, object]] = []
                try:
                    for case in cases:
                        case_id = str(case.get("id") or "")
                        previous_ids = [
                            ids[key] for key in _ids(_as_dict(case.get("previous")).get("songs"))
                        ]
                        runs: list[dict[str, object]] = []
                        scores: list[CaseScore] = []
                        for run in range(args.runs):
                            proposal_id = reset_case(store, case, ids)
                            request = request_for(case, ids, proposal_id)
                            transport.reset(str(case.get("fault") or ""))
                            engine_ms: list[float] = []
                            engine_intents: list[dict[str, object]] = []
                            before = playback_state(store, player)
                            result: dict[str, object] = {}
                            error: str | None = None
                            started = time.perf_counter()
                            try:
                                with engine_timer(engine_ms, engine_intents):
                                    result = await bot.chat(request)
                            except Exception as exc:  # an outage must still be scored, not crash
                                error = f"{type(exc).__name__}: {exc}"
                            wall_ms = (time.perf_counter() - started) * 1000
                            after = playback_state(store, player)
                            primary = transport.primary()
                            interpreter_ms = sum(
                                float(str(call.get("seconds") or 0)) for call in transport.calls
                            )
                            for call in primary:
                                body = _as_dict(call.get("body"))
                                options = _as_dict(body.get("options"))
                                if not controls:
                                    controls = {
                                        "think": body.get("think"),
                                        "temperature": options.get("temperature"),
                                        "seed": options.get("seed"),
                                        "num_ctx": options.get("num_ctx"),
                                        "keep_alive": body.get("keep_alive"),
                                    }
                                primary_bodies.append(body)
                                if thinking and body.get("think") is not False:
                                    raise ModelError(
                                        "The interpreter did not turn thinking off. "
                                        "Nothing was scored."
                                    )
                                if (
                                    options.get("temperature") != 0
                                    or options.get("seed") != SEED
                                    or options.get("num_ctx") != NUM_CTX
                                ):
                                    raise ModelError(
                                        "The interpreter did not send temperature 0, seed 42 "
                                        "and num_ctx 8192. Nothing was scored."
                                    )
                            score = score_case(
                                case,
                                result,
                                ids,
                                previous_ids=previous_ids,
                                error=error,
                                mutated=before != after,
                            )
                            scores.append(score)
                            runs.append(
                                {
                                    "run": run + 1,
                                    "error": error,
                                    "action": result.get("action"),
                                    "scope": result.get("scope"),
                                    "ids": result_ids(result),
                                    "score": score.as_dict(),
                                    "interpreter_ms": round(interpreter_ms, 1),
                                    "engine_ms": round(sum(engine_ms) * 1000, 1),
                                    "wall_ms": round(wall_ms, 1),
                                    "load_duration": next(
                                        (
                                            call.get("load_duration")
                                            for call in primary
                                            if call.get("load_duration") is not None
                                        ),
                                        None,
                                    ),
                                }
                            )
                        stable = all(run["score"] == runs[0]["score"] for run in runs[1:])
                        rows.append(
                            {
                                "case": case_id,
                                "fault": case.get("fault"),
                                "stable": stable,
                                "runs": runs,
                                "score": scores[0].as_dict() if scores else {},
                            }
                        )
                finally:
                    peak = sampler.stop()
                    store.close()

    ps = await ps_info(args.ollama_url, args.model)
    return {
        "suite": data.get("suite"),
        "version": data.get("version"),
        "split": args.split,
        "timestamp": datetime.now(UTC).isoformat(),
        "git_sha": git_sha(),
        "model": args.model,
        "model_digest": digest_value,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "settings": {
            "ollama_url": args.ollama_url,
            "temperature": 0,
            "seed": SEED,
            "num_ctx": NUM_CTX,
            "runs": args.runs,
        },
        "controls": controls,
        "controls_ok": controls_ok,
        "rows": rows,
        "vram": {
            "idle_mb": idle,
            "peak_mb": peak,
            "rise_mb": (peak - idle) if peak is not None and idle is not None else None,
            "ps": ps,
            "no_cpu_offload": bool(
                isinstance(ps, dict)
                and ps.get("size") is not None
                and ps.get("size_vram") == ps.get("size")
            ),
            "available": idle is not None,
        },
    }


def summarize(report: dict[str, object]) -> dict[str, object]:
    """Count the quality measures and hard gates from the first run of each case."""
    rows = cast(list[dict[str, object]], report.get("rows"))
    action_total = action_ok = 0
    constraint_total = constraint_ok = 0
    follow_total = follow_ok = 0
    ambiguous_total = ambiguous_ok = 0
    clear_total = clear_bad = 0
    no_songs: list[str] = []
    unstable: list[str] = []
    failing: dict[str, list[str]] = {}
    hard: list[str] = []
    interpreter_warm: list[float] = []
    engine_warm: list[float] = []
    cold: float | None = None
    first_run = True

    def fail(case: str, measure: str) -> None:
        failing.setdefault(measure, []).append(case)

    for row in rows:
        case_id = str(row.get("case") or "")
        runs = cast(list[dict[str, object]], row.get("runs"))
        score = cast(dict[str, object], row.get("score"))
        if row.get("stable") is False:
            unstable.append(case_id)
        # An injected fault is not a normal interpreter call, so it does not set the clock.
        if not row.get("fault"):
            for run in runs:
                interpreter = run.get("interpreter_ms")
                engine = run.get("engine_ms")
                if isinstance(interpreter, (int, float)):
                    if first_run:
                        cold = float(interpreter)
                    else:
                        interpreter_warm.append(float(interpreter))
                if isinstance(engine, (int, float)) and not first_run:
                    engine_warm.append(float(engine))
                first_run = False
        outage = "outage_ok" in score and score.get("outage_ok") is not None
        if score.get("no_songs") is True:
            no_songs.append(case_id)
        if not score.get("mutation_ok", True):
            hard.append(f"{case_id}: mutation")
            fail(case_id, "mutation")
        if score.get("invented_id") is True:
            hard.append(f"{case_id}: invented_id")
            fail(case_id, "invented_id")
        if outage:
            if score.get("outage_ok") is not True:
                hard.append(f"{case_id}: outage")
                fail(case_id, "outage")
            continue
        action_total += 1
        if score.get("action_ok") is True:
            action_ok += 1
        else:
            fail(case_id, "action_scope")
        if score.get("scope_ok") is False:
            fail(case_id, "action_scope")
        constraint = score.get("filters_ok")
        if constraint is None:
            constraint = score.get("edit_ok")
        if constraint is not None:
            constraint_total += 1
            if (
                score.get("filters_ok") is not False
                and score.get("songs_ok") is not False
                and score.get("edit_ok") is not False
                and score.get("keeps_ok") is not False
                and score.get("drops_ok") is not False
            ):
                constraint_ok += 1
            else:
                fail(case_id, "constraints")
                dropped = cast(list[str], score.get("dropped") or [])
                if (
                    dropped
                    or score.get("songs_ok") is False
                    or score.get("edit_ok") is False
                    or score.get("keeps_ok") is False
                    or score.get("drops_ok") is False
                ):
                    hard.append(f"{case_id}: constraint")
        if score.get("keeps_ok") is not None:
            follow_total += 1
            if score.get("keeps_ok") is True:
                follow_ok += 1
            else:
                fail(case_id, "follow_ups")
        if score.get("ambiguous_ok") is not None:
            ambiguous_total += 1
            if score.get("ambiguous_ok") is True:
                ambiguous_ok += 1
            else:
                fail(case_id, "ambiguous")
        else:
            clear_total += 1
            if score.get("clear_question") is True:
                clear_bad += 1
                fail(case_id, "clear_question")

    vram = cast(dict[str, object], report.get("vram"))
    peak = vram.get("peak_mb")
    peak_gb = float(str(peak)) / 1024 if isinstance(peak, (int, float)) else None
    rates = {
        "action_scope": (action_ok / action_total) if action_total else None,
        "constraints": (constraint_ok / constraint_total) if constraint_total else None,
        "follow_ups": (follow_ok / follow_total) if follow_total else None,
        "ambiguous": (ambiguous_ok / ambiguous_total) if ambiguous_total else None,
        "clear_question": (clear_bad / clear_total) if clear_total else None,
    }
    interpreter_p95 = _percentile(interpreter_warm, 95)
    engine_p95 = _percentile(engine_warm, 95)
    timing = {
        "interpreter_p50": statistics.median(interpreter_warm) / 1000 if interpreter_warm else None,
        "interpreter_p95": interpreter_p95 / 1000 if interpreter_p95 is not None else None,
        "engine_p50": statistics.median(engine_warm) / 1000 if engine_warm else None,
        "engine_p95": engine_p95 / 1000 if engine_p95 is not None else None,
        "cold": cold / 1000 if cold is not None else None,
    }
    passes = {
        "action_scope": (rates["action_scope"] or 0) >= GATES["action_scope"],
        "constraints": (rates["constraints"] or 0) >= GATES["constraints"],
        "follow_ups": (rates["follow_ups"] or 0) >= GATES["follow_ups"],
        "ambiguous": (rates["ambiguous"] or 0) >= GATES["ambiguous"],
        "clear_question": (rates["clear_question"] or 0) <= GATES["clear_question"],
        "warm_p50": (timing["interpreter_p50"] or 0) <= GATES["warm_p50"],
        "warm_p95": (timing["interpreter_p95"] or 0) <= GATES["warm_p95"],
        "cold": (timing["cold"] or 0) <= GATES["cold"],
        "vram": (
            None
            if not vram.get("available")
            else peak_gb is not None and peak_gb <= GATES["vram"] and vram.get("no_cpu_offload")
        ),
    }
    return {
        "rates": rates,
        "timing": timing,
        "vram_gb": peak_gb,
        "passes": passes,
        "hard_gate_failures": hard,
        "failing": failing,
        "no_songs": no_songs,
        "unstable": unstable,
        "counts": {
            "action_scope": [action_ok, action_total],
            "constraints": [constraint_ok, constraint_total],
            "follow_ups": [follow_ok, follow_total],
            "ambiguous": [ambiguous_ok, ambiguous_total],
            "clear_question": [clear_bad, clear_total],
        },
    }


def markdown(report: dict[str, object], summary: dict[str, object]) -> str:
    rates = cast(dict[str, object], summary["rates"])
    timing = cast(dict[str, object], summary["timing"])
    counts = cast(dict[str, list[int]], summary["counts"])
    passes = cast(dict[str, bool], summary["passes"])
    vram = cast(dict[str, object], report["vram"])
    settings = cast(dict[str, object], report["settings"])
    no_songs = cast(list[str], summary["no_songs"])
    vram_gb = summary.get("vram_gb")
    vram_text = f"{float(vram_gb):.2f} GB" if isinstance(vram_gb, (int, float)) else "n/a"

    def rate(name: str) -> str:
        value = rates.get(name)
        found = counts.get(name, [0, 0])
        if not isinstance(value, float):
            return "n/a"
        return f"{value * 100:.1f}% ({found[0]}/{found[1]})"

    def seconds(value: object) -> str:
        return f"{float(value):.2f} s" if isinstance(value, (int, float)) else "n/a"

    def mark(ok: object) -> str:
        if ok is None:
            return "SKIP"
        return "PASS" if ok else "FAIL"

    lines = [
        f"# Interpreter evaluation: {report['model']}",
        "",
        f"- Split: {report['split']}",
        f"- Git SHA: `{report['git_sha']}`",
        f"- Model digest: `{report['model_digest']}`",
        f"- Settings: temperature {settings['temperature']}, seed {settings['seed']}, "
        f"num_ctx {settings['num_ctx']}, {settings['runs']} runs per case",
        f"- Controls: `{json.dumps(report['controls'], sort_keys=True)}`",
        "",
        "| Measure | Result | Pass mark | Status |",
        "| --- | --- | --- | --- |",
        f"| Action and scope | {rate('action_scope')} | "
        f"at least 95% | {mark(passes['action_scope'])} |",
        f"| Hard constraints | {rate('constraints')} | "
        f"at least 90% | {mark(passes['constraints'])} |",
        f"| Follow-ups keep | {rate('follow_ups')} | at least 95% | {mark(passes['follow_ups'])} |",
        f"| Ambiguous question | {rate('ambiguous')} | "
        f"at least 80% | {mark(passes['ambiguous'])} |",
        f"| Clear question | {rate('clear_question')} | "
        f"at most 5% | {mark(passes['clear_question'])} |",
        f"| Warm interpreter p50 | {seconds(timing['interpreter_p50'])} | "
        f"at most 2.5 s | {mark(passes['warm_p50'])} |",
        f"| Warm interpreter p95 | {seconds(timing['interpreter_p95'])} | "
        f"at most 5 s | {mark(passes['warm_p95'])} |",
        f"| Warm engine p50 / p95 | {seconds(timing['engine_p50'])} / "
        f"{seconds(timing['engine_p95'])} | reported apart | |",
        f"| Cold load | {seconds(timing['cold'])} | at most 30 s | {mark(passes['cold'])} |",
        f"| Peak VRAM | {vram_text} | at most 14 GB, no CPU offload | {mark(passes['vram'])} |",
        f"| Idle VRAM / rise | {vram.get('idle_mb')} MB / {vram.get('rise_mb')} MB | recorded | |",
        f"| No CPU offload (`/api/ps`) | {vram.get('no_cpu_offload')} | true | |",
        "",
        f"Cases that came back with no songs (not a pass mark): {len(no_songs)} "
        f"{', '.join(no_songs)}",
        "",
    ]
    hard = cast(list[str], summary["hard_gate_failures"])
    failing = cast(dict[str, list[str]], summary["failing"])
    unstable = cast(list[str], summary["unstable"])
    if not vram.get("available"):
        lines += ["nvidia-smi was not available, so the VRAM gate was skipped.", ""]
    if unstable:
        lines += ["## Cases whose scored fields changed between runs", ""]
        lines += [f"- {case_id}" for case_id in unstable] + [""]
    if hard:
        lines += ["## Hard gate failures", ""] + [f"- {item}" for item in hard] + [""]
    if failing:
        lines += ["## Failing cases", ""]
        for measure, case_ids in sorted(failing.items()):
            lines.append(f"- {measure}: {', '.join(case_ids)}")
        lines.append("")
    if not hard and not failing:
        lines += ["No failing cases.", ""]
    return "\n".join(lines)


def write_report(report: dict[str, object]) -> tuple[Path, Path]:
    REPORTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y-%m-%d")
    stem = f"{stamp}-{_model_slug(str(report['model']))}"
    json_path = REPORTS / f"{stem}.json"
    md_path = REPORTS / f"{stem}.md"
    summary = summarize(report)
    report = report | {"summary": summary}
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(markdown(report, summary) + "\n", encoding="utf-8")
    return json_path, md_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--split", choices=("dev", "heldout"), default="dev")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--case", action="append", help="Run only these case ids (repeatable).")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    try:
        report = asyncio.run(evaluate(args))
    except SealError as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        return 2
    except ModelError as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        print("Open item: the run did not use the required interpreter controls.", file=sys.stderr)
        return 2
    json_path, md_path = write_report(report)
    summary = summarize(report)
    print(json.dumps({key: summary[key] for key in ("rates", "timing", "hard_gate_failures")}))
    print(f"Report: {json_path}")
    print(f"Table: {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
