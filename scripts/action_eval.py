"""Score the playlist and action correctness suite in `evals/actions`.

The suite is labelled data, not code. Each case is a list of HTTP calls made, in order, against
`backend.main.create_app` running in process on a fresh temporary folder, SQLite database and a
small generated library, plus what must hold afterwards. No model, no network and no real
library: the model is a stub transport that answers with the case's canned interpretation (or
that Ollama is unreachable), and the songs are invented wav files.

    uv run python -m scripts.action_eval
    uv run python -m scripts.action_eval --case a05 --case a12

The report lands in `evals/actions/reports/`, which git ignores. The exit status is 1 when any
case fails, or when a case marked as an expected failure starts to pass.
"""

import argparse
import json
import platform
import re
import sys
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend.core.store import Store
from backend.library.music_bot import MusicBot
from backend.main import create_app
from scripts.interpreter_eval import git_sha, tag, write_wav

SUITE = Path(__file__).resolve().parents[1] / "evals" / "actions"
REPORTS = SUITE / "reports"
CASES = SUITE / "cases.json"
# How long a generated library may take to scan before the run gives up.
SCAN_SECONDS = 30
# Every part of the server state a case can say stayed the same. `playback` is the three that
# a person would call "the music changed": the queue, the playlists and the play counts.
PLAYBACK = ("queue", "playlist_rows", "plays")
STATE_KEYS = (*PLAYBACK, "playlists", "receipts", "proposals", "revisions", "files")
Json = Any
Trace = list[dict[str, Any]]

_WHOLE = re.compile(r"^\{([A-Za-z0-9_.]+)\}$")
_PART = re.compile(r"\{([A-Za-z0-9_.]+)\}")


class SuiteError(RuntimeError):
    """The labels themselves are broken, so nothing was scored."""


# ---------------------------------------------------------------------------
# Labels: loading, variables and paths. Pure, so the scorer can be tested without an app.


def load_suite(path: Path = CASES) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list):
        raise SuiteError(f"{path} must hold an object with a cases list")
    seen: set[str] = set()
    for case in data["cases"]:
        name = str(case.get("id", ""))
        if not name or name in seen:
            raise SuiteError(f"case id {name!r} is missing or repeated")
        seen.add(name)
        if not case.get("steps"):
            raise SuiteError(f"case {name} has no steps")
    return cast(dict[str, Any], data)


def lookup(value: Json, path: str) -> Json:
    """`a.b.0` reads key b of a, then item 0. `a.*.id` reads id of every item of a. A missing
    step raises KeyError."""
    parts = path.split(".")
    for index, part in enumerate(parts):
        if part == "*" and isinstance(value, list):
            rest = ".".join(parts[index + 1 :])
            return [lookup(item, rest) if rest else item for item in value]
        if isinstance(value, list):
            try:
                value = value[int(part)]
            except (ValueError, IndexError) as exc:
                raise KeyError(path) from exc
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise KeyError(path)
    return value


def fill(value: Json, names: dict[str, Any]) -> Json:
    """Replace `{name}` in every string. A string that is only a name keeps its type, so
    `"{p.ids}"` is the list itself."""
    if isinstance(value, str):
        whole = _WHOLE.match(value)
        if whole:
            return lookup(names, whole.group(1))
        return _PART.sub(lambda found: str(lookup(names, found.group(1))), value)
    if isinstance(value, list):
        return [fill(item, names) for item in value]
    if isinstance(value, dict):
        return {key: fill(item, names) for key, item in value.items()}
    return value


def _same(actual: Json, wanted: Json) -> bool:
    # bool is an int in Python, and 1 is not true here.
    return actual == wanted and isinstance(actual, bool) == isinstance(wanted, bool)


def check_step(expect: dict[str, Any], status: int, body: Json, names: dict[str, Any]) -> list[str]:
    """What is wrong with one answer, in words. Empty means the answer is as labelled."""
    problems: list[str] = []
    wanted_status = int(expect.get("status", 200))
    if status != wanted_status:
        problems.append(f"status {status}, expected {wanted_status}")
    error: dict[str, Any] = {}
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        error = body["error"]
    if "error" in expect and str(error.get("code")) != expect["error"]:
        problems.append(f"error code {error.get('code')!r}, expected {expect['error']!r}")
    if "error_fields" in expect:
        wanted = fill(expect["error_fields"], names)
        if error.get("fields") != wanted:
            problems.append(f"error fields {error.get('fields')!r}, expected {wanted!r}")
    if "message_has" in expect:
        text = str(error.get("message") or (body.get("detail") if isinstance(body, dict) else ""))
        if expect["message_has"] not in text:
            problems.append(f"message {text!r} does not say {expect['message_has']!r}")
    for kind in ("json", "has", "starts_with", "includes", "excludes", "len"):
        for path, raw in expect.get(kind, {}).items():
            wanted = fill(raw, names)
            try:
                actual = lookup(body, path)
            except KeyError:
                problems.append(f"{kind}: {path} is not in the answer")
                continue
            problem = _compare(kind, path, actual, wanted)
            if problem:
                problems.append(problem)
    return problems


def _compare(kind: str, path: str, actual: Json, wanted: Json) -> str:
    if kind == "json":
        return "" if _same(actual, wanted) else f"{path} is {actual!r}, expected {wanted!r}"
    if kind == "has":
        return (
            ""
            if str(wanted) in str(actual)
            else f"{path} is {actual!r}, expected it to say {wanted!r}"
        )
    if kind == "len":
        size = len(actual) if hasattr(actual, "__len__") else -1
        return "" if size == wanted else f"{path} has {size} items, expected {wanted}"
    if not isinstance(actual, list):
        return f"{kind}: {path} is not a list"
    items = wanted if isinstance(wanted, list) else [wanted]
    if kind == "starts_with":
        return "" if actual[: len(items)] == items else f"{path} does not start with {items!r}"
    if kind == "includes":
        missing = [item for item in items if item not in actual]
        return f"{path} lacks {missing!r}" if missing else ""
    found = [item for item in items if item in actual]
    return f"{path} still holds {found!r}" if found else ""


def check_state(expect: dict[str, Any], start: dict[str, Any], end: dict[str, Any]) -> list[str]:
    """Compare the server state before the steps and after them."""
    problems: list[str] = []
    for key in expect.get("unchanged", []):
        for name in PLAYBACK if key == "playback" else STATE_KEYS if key == "everything" else [key]:
            if name not in start:
                problems.append(f"unchanged: {name} is not a state key")
            elif start[name] != end[name]:
                problems.append(f"{name} changed: {start[name]!r} -> {end[name]!r}")
    for name, change in expect.get("delta", {}).items():
        if name not in start:
            problems.append(f"delta: {name} is not a state key")
            continue
        moved = end[name] - start[name]
        if moved != change:
            problems.append(f"{name} moved by {moved}, expected {change}")
    return problems


@dataclass
class CaseResult:
    id: str
    title: str
    covers: list[str]
    # pass, fail, expected_failure (failed as labelled) or unexpected_pass (labelled to fail).
    status: str
    failures: list[str] = field(default_factory=list)
    reason: str = ""
    steps: Trace = field(default_factory=list)
    seconds: float = 0.0

    @property
    def ok(self) -> bool:
        return self.status in ("pass", "expected_failure")


def score_case(
    case: dict[str, Any],
    trace: Trace,
    start: dict[str, Any],
    end: dict[str, Any],
    names: dict[str, Any],
    seconds: float = 0.0,
) -> CaseResult:
    """A case passes when every step answered as labelled and the state is as labelled. A case
    labelled `expected_failure` passes the run only while it still fails."""
    failures = [
        f"{record['name']}: {problem}" for record in trace for problem in record["problems"]
    ]
    failures += check_state(fill(case.get("expect", {}), names), start, end)
    reason = str(case.get("expected_failure") or "")
    if reason:
        status = "expected_failure" if failures else "unexpected_pass"
    else:
        status = "fail" if failures else "pass"
    return CaseResult(
        id=str(case["id"]),
        title=str(case.get("title", "")),
        covers=[str(item) for item in case.get("covers", [])],
        status=status,
        failures=failures,
        reason=reason,
        steps=[
            {key: value for key, value in record.items() if key != "problems"} for record in trace
        ],
        seconds=round(seconds, 3),
    )


# ---------------------------------------------------------------------------
# The run: a real app on a temporary folder, a stub model, and the state before and after.


class Stub:
    """Stands in for Ollama. It answers the model list and one canned interpretation, or says
    the host is unreachable. It never reaches a network."""

    def __init__(self, reply: object, offline: bool) -> None:
        self.reply = reply
        self.offline = offline
        self.chats = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("offline")
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "fixture"}]})
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion"]})
        self.chats += 1
        text = self.reply if isinstance(self.reply, str) else json.dumps(self.reply)
        return httpx.Response(200, json={"done": True, "message": {"content": text}})


def snapshot(store: Store) -> dict[str, Any]:
    """Everything a case may say did or did not change."""
    queue = store.read_play_queue()
    with store.lock:
        db = store.db

        def count(sql: str) -> int:
            return int(db.execute(sql).fetchone()[0])

        return {
            "queue": queue,
            "playlist_rows": [
                [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY 1, 2")]
                for table in ("playlists", "playlist_songs")
            ],
            "playlists": count("SELECT count(*) FROM playlists"),
            "plays": count("SELECT coalesce(sum(play_count), 0) FROM library_files"),
            "receipts": count("SELECT count(*) FROM bot_receipts"),
            "proposals": count("SELECT count(*) FROM bot_proposals"),
            "revisions": count("SELECT count(*) FROM bot_proposal_revisions"),
            "files": count("SELECT count(*) FROM library_files"),
        }


def build_music(music: Path, songs: list[dict[str, Any]]) -> None:
    music.mkdir()
    for song in songs:
        path = music / f"{song['key']}.wav"
        write_wav(path)
        tag(path, song)


@contextmanager
def running(case: dict[str, Any], suite: dict[str, Any]) -> Iterator[tuple[TestClient, MusicBot]]:
    """The real app, started and scanned, with the case's model stub in place."""
    songs: list[dict[str, Any]] = suite["library"]
    ollama = case.get("ollama", {})
    offline = ollama == "offline"
    stub = Stub({} if offline else ollama.get("reply", {}), offline)
    made: list[MusicBot] = []

    def bot_with_stub(store: Store, player: Any, _: httpx.AsyncClient, profiles: Any) -> MusicBot:
        bot = MusicBot(
            store,
            player,
            httpx.AsyncClient(transport=httpx.MockTransport(stub)),
            profiles,
            new_seed=lambda: 0,
        )
        made.append(bot)
        return bot

    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        build_music(root / "music", songs)
        with (
            patch.dict("os.environ", {"MUSIMO_LIBRARY_ROOTS": str(root / "music")}),
            patch("backend.main.runtime_versions", return_value={}),
            patch("backend.main.MusicBot", bot_with_stub),
            TestClient(create_app(root / "data", root / "static")) as client,
        ):
            bot = made[0]
            wait_for_scan(client)
            prepare(bot.store, songs)
            yield client, bot


def wait_for_scan(client: TestClient) -> None:
    until = time.monotonic() + SCAN_SECONDS
    while client.get("/api/library").json()["status"] == "scanning":
        if time.monotonic() > until:
            raise SuiteError("the generated library did not finish scanning")
        time.sleep(0.02)


def prepare(store: Store, songs: list[dict[str, Any]]) -> None:
    """Lengths and play counts the files cannot carry, as the engine tests set them."""
    store.update({"ollama_model": "fixture", "music_timezone": "UTC"})
    with store.lock:
        for song in songs:
            store.db.execute(
                "UPDATE library_files SET duration=?, play_count=? WHERE title=? AND artist=?",
                (float(song["seconds"]), int(song["plays"]), song["title"], song["artist"]),
            )
        store.db.commit()
    store.bump_library_revision()


def song_ids(client: TestClient, songs: list[dict[str, Any]]) -> dict[str, Any]:
    """The id each song key got when the library was scanned."""
    found = {
        (str(track["title"]), str(track["artist"])): str(track["id"])
        for track in client.get("/api/library/tracks", params={"size": 200}).json()["items"]
    }
    return {str(song["key"]): found[(str(song["title"]), str(song["artist"]))] for song in songs}


def run_step(client: TestClient, step: dict[str, Any], names: dict[str, Any]) -> dict[str, Any]:
    """Make one call, save what the step asks to keep, and say what was wrong with the answer."""
    record: dict[str, Any] = {"name": str(step.get("name", step["call"])), "problems": []}
    try:
        method, path = str(step["call"]).split(" ", 1)
        path = fill(path, names)
        body = fill(step["json"], names) if "json" in step else None
        record["call"] = f"{method} {path}"
        response = client.request(method, path, json=body)
        record["status"] = response.status_code
        answer: Json = response.json() if response.content else None
        for name, source in step.get("save", {}).items():
            names[name] = lookup(answer, source)
        record["problems"] = check_step(step.get("expect", {}), response.status_code, answer, names)
    except KeyError as exc:
        record["problems"].append(f"unknown name or path {exc}")
    return record


def run_case(case: dict[str, Any], suite: dict[str, Any]) -> CaseResult:
    started = time.monotonic()
    with running(case, suite) as (client, bot):
        names: dict[str, Any] = song_ids(client, suite["library"])
        trace: Trace = []
        # Setup runs before the state is read, so a case can start from a queue that is not empty.
        for step in case.get("setup", []):
            trace.append(run_step(client, step, names))
        start = snapshot(bot.store)
        for step in case["steps"]:
            trace.append(run_step(client, step, names))
        end = snapshot(bot.store)
    return score_case(case, trace, start, end, names, time.monotonic() - started)


def run_suite(suite: dict[str, Any], only: set[str] | None = None) -> list[CaseResult]:
    cases = [case for case in suite["cases"] if not only or str(case["id"]) in only]
    if only and len(cases) != len(only):
        raise SuiteError(f"no such case: {sorted(only - {str(case['id']) for case in cases})}")
    return [run_case(case, suite) for case in cases]


# ---------------------------------------------------------------------------
# The report.


def summarize(results: list[CaseResult]) -> dict[str, int]:
    counts = {"cases": len(results)}
    for status in ("pass", "fail", "expected_failure", "unexpected_pass"):
        counts[status] = sum(1 for result in results if result.status == status)
    return counts


def markdown(report: dict[str, Any], results: list[CaseResult]) -> str:
    counts = report["summary"]
    lines = [
        "# Action suite report",
        "",
        f"Git SHA `{report['git_sha'] or 'unknown'}`, run {report['started']}.",
        "",
        f"{counts['cases']} cases: {counts['pass']} passed, {counts['fail']} failed, "
        f"{counts['expected_failure']} expected failures, "
        f"{counts['unexpected_pass']} unexpected passes.",
        "",
        "| Case | Result | Covers | Title |",
        "| ---- | ------ | ------ | ----- |",
    ]
    for result in results:
        lines.append(
            f"| {result.id} | {result.status.replace('_', ' ')} | "
            f"{', '.join(result.covers)} | {result.title} |"
        )
    problems = [result for result in results if result.failures or result.status != "pass"]
    for result in problems:
        lines += ["", f"## {result.id}: {result.status.replace('_', ' ')}"]
        if result.reason:
            lines.append(f"Expected failure: {result.reason}")
        lines += [f"- {failure}" for failure in result.failures]
    return "\n".join(lines)


def write_report(results: list[CaseResult], folder: Path = REPORTS) -> tuple[Path, Path]:
    now = datetime.now(UTC)
    report: dict[str, Any] = {
        "suite": "actions",
        "git_sha": git_sha(),
        "python": platform.python_version(),
        "started": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summarize(results),
        "cases": [vars(result) for result in results],
    }
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{now.strftime('%Y-%m-%d')}-actions"
    json_path = folder / f"{stem}.json"
    md_path = folder / f"{stem}.md"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(markdown(report, results) + "\n", encoding="utf-8")
    return json_path, md_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", help="Run only these case ids (repeatable).")
    args = parser.parse_args(argv)
    try:
        results = run_suite(load_suite(), set(args.case) if args.case else None)
    except SuiteError as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        return 2
    json_path, md_path = write_report(results)
    for result in results:
        if result.status not in ("pass", "expected_failure"):
            print(f"{result.id} {result.status}: {result.title}")
            for failure in result.failures:
                print(f"  {failure}")
    print(json.dumps(summarize(results)))
    print(f"Report: {json_path}")
    print(f"Table: {md_path}")
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
