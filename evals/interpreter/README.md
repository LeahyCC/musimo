# 2A interpreter suite, version 1

The labelled prompts that 2A candidates are judged on. The pass marks are in [docs/v2-gates.md](../../docs/v2-gates.md). Nothing here has been run against a model.

| File           | What it is                                                   |
| -------------- | ------------------------------------------------------------ |
| `library.json` | 25 invented songs the cases refer to by key (`s01` to `s25`) |
| `dev.json`     | 72 development cases, for prompt work                        |
| `heldout.json` | 56 held-out cases, sealed                                    |
| `seal.json`    | The SHA-256 of `heldout.json` and its case count             |

`tests/test_interpreter_suite.py` checks the labels: every expected filter passes the engine's own `Filters` model, every song key is in the library, a follow-up's kept fields match the previous request, every area is in both splits, and `heldout.json` still matches its seal.

## The seal

The held-out cases were written and labelled on 17 October 2026, before any candidate ran. Prompt work reads `dev.json` only. The evaluator opens `heldout.json` once per candidate, after that candidate's prompt is frozen, and checks the digest in `seal.json` first. The digest is of the parsed JSON (sorted keys, no spaces), so a formatter cannot break it and any change to a case does. A change to a held-out case means a new suite version and a new seal, never an edit in place.

## A case

```json
{
  "id": "d044",
  "covers": ["follow-up", "duration"],
  "previous": {
    "prompt": "90s hip hop",
    "scope": "library",
    "filters": { "genres": ["hip hop"], "year_from": 1990, "year_to": 1999 },
    "songs": ["s14"]
  },
  "prompt": "make it an hour",
  "expect": {
    "action": "search",
    "filters": {
      "genres": ["hip hop|hip-hop|rap"],
      "year_from": 1990,
      "year_to": 1999,
      "total_length": { "mode": "about", "seconds": 3600 }
    },
    "keeps": ["genres", "year_from", "year_to"]
  }
}
```

State the harness sets up before the prompt. Each is left out when it is the default.

- `playing`: the song playing, or none. `paused`: whether it is paused.
- `queue`: the songs after the playing one.
- `recipes`: the audio recipes turned on (`tempo_energy`, `sound`). `tempo_energy` means the harness turns on both tempo and the `audio_energy` setting, since `tempo_energy` predates their split into `audio_scalar_recipe` (tempo) and `audio_energy` (energy, off by default). None by default: the server ships with analysis off, and the Song analysis page can turn tempo on while energy stays off until `audio_energy` is set.
- `previous`: the open proposal, as its merged filters, scope and songs. Every case is independent: the harness stores this proposal first, so one bad answer cannot spoil the next case.
- `fault`: an outage the harness injects. `timeout`, `malformed` (not JSON), `schema` (JSON in the wrong shape), `truncated` (output cut off), `invented_id` (the model names a song id the library does not have), `offline` (Ollama unreachable) and `truncated_history` (the chat history the model sees is cut, while the stored proposal keeps its filters).

What the request means, in `expect`:

- `action`: `search`, `edit`, `pause`, `resume`, `skip`, `clarify` or `unsupported`.
- `scope`: `library` (the default), `proposal` or `queue`. A follow-up is `proposal` when it points at the open list ("the ones", "from that", "of these"). One that only changes a filter is a new `library` search with the earlier filters carried over.
- `filters`: the merged filters the engine should get, in the version 5 contract's own field names (`backend/library/engine_contract.py`). For a follow-up this is the whole state after the follow-up, not just what changed.
- `keeps`: for a follow-up, the fields it must carry over unchanged. These score "Follow-ups keep untouched constraints".
- `drops`: for a follow-up, earlier fields the person withdrew, which go back to the default. Every earlier filter is kept, changed or dropped, and the test checks that none is just lost.
- `songs`: the songs the request names, after entity lookup. A song to compare with ("songs like Night Bus by Orchard") or a song asked for by name ("play Rock Bottom"). The contract's filters have no title field, so the 2A adapter turns a named song into a one-song preview through `context.proposal_ids`.
- `edit`: an edit of the open proposal. `another` (with `pinned` songs kept in order), `add` with a `count`, or `remove` with `ids`.
- `ambiguous`: true where a question is the only right answer. Every `clarify` is ambiguous and nothing else is.
- `outcome`: for an outage, the replies that count as usable. `template` (a neutral reply saying what failed), `retry` (a clear retry offer) or `control` (the deterministic command still ran).
- `note`: why, where the label is not obvious.

## Scoring rules

These are fixed now, before any run.

- Text matches ignore case and repeated spaces. In `artists`, `exclude_artists` and `genres`, an entry like `"liquid drum and bass|liquid dnb|liquid"` matches any one spelling, and the lists compare as sets. The first spelling of every genre is one `backend/library/genres.py` matches against the library today, and the test checks that. The others mean the same thing and now find the same songs: `dnb`, `drum & bass` and `trip hop` fold onto their tags, and `liquid` matches the liquid drum and bass tag (fixed in 3e4d5af, so #198 is closed). The interpretation score accepts them; the run report counts separately how many cases came back with no songs.
- Every filter not listed in `expect.filters` must be the contract default. An added constraint the person never asked for is as wrong as a dropped one. `limit` is free unless the case lists it, and so is the reply's wording.
- A case's hard constraints are correct when every listed filter, `songs` and `edit` match and nothing else was added.
- A mutation is any change to playback, the queue or a playlist. Only `pause`, `resume` and `skip` cases may cause one, and only that one. Chat text never commits a proposal: saving and queueing stay the card's buttons (cases `d063` and `h045`), so the right answer is `unsupported` with a pointer to the button. Today's prompt treats "playlist" and "queue" words as a preview search instead. That is not a mutation, so it passes the hard gate, but it scores as the wrong action.
- No song id outside the library may reach the engine, in any case.
- Duration words follow the decisions in #179. "Under" is strict and "at most" is inclusive, for the whole list (`total_length`) and for each song (`max_seconds`, `min_seconds`, both inclusive in the engine, so "under 4 minutes" each is `max_seconds` 239). "About", "roughly", "give or take" and a bare "an hour of" mean `about`, the closest total within five minutes. `target_seconds` stays 0. The per-song fields are whole seconds, so "under 4 minutes" leaves out a 239.5 s song. That is the nearest the contract can say.
- A request the engine cannot express is `unsupported`, never a search with the hard part dropped. Today that covers genre exclusions ("anything except rock"), vocals, mood and tempo with the recipes off, volume, skipping a count of songs, going back and shuffling.

## How to run it

`scripts/interpreter_eval.py` is the harness. It builds the 25 invented songs in a temporary folder and SQLite database, never the live one, then sends each case through `MusicBot.chat`, the same path the server uses. It scores the intent the engine received, not the reply text, and records the outgoing `/api/chat` controls, timings, VRAM and failing case ids. It prints no prompts.

```sh
# Development split, against the PAIR proxy Musimo already calls.
uv run python -m scripts.interpreter_eval --model qwen3.5:9b --split dev

# The held-out split, once the prompt is frozen. The seal is checked first.
uv run python -m scripts.interpreter_eval --model qwen3.5:9b --split heldout

# Only some cases, while working on a prompt.
uv run python -m scripts.interpreter_eval --model qwen3.5:9b --case d001 --case d044
```

Options: `--ollama-url` defaults to `http://127.0.0.1:11434` (the PAIR proxy; Ollama itself listens on `127.0.0.1:11435`), `--runs` defaults to 3, and `--case` may be repeated. The model must be installed on that host.

The run stops before scoring when the model thinks and `/api/show` lists no off switch, or when an interpreter request does not send `think: false`, temperature 0, seed 42 and `num_ctx` 8192. A model that thinks by default with no off switch cannot be evaluated as the gates require.

The report is written to `evals/interpreter/reports/<date>-<model>.json` with a short Markdown table beside it. That folder is git ignored. The table has the git SHA, model digest, recorded settings, each measure against its pass mark in [docs/v2-gates.md](../../docs/v2-gates.md), and the failing case ids with the measure that failed.

The runner injects the faults from a transport in front of Ollama, so `interpreter.py` and `music_bot.py` are not changed to fake them. `timeout` and `offline` fail the call, `malformed`, `schema` and `truncated` replace the model's answer (including the one repair), `invented_id` names a song the library does not have, and `truncated_history` removes the previous state from the context the model sees while the stored proposal keeps its filters.

`X-Musimo-Listener` is needed only on the HTTP route. The timed cases call `MusicBot.chat` in process, which is the server clock the gates mean, including the hop to Ollama. A missing or unknown header on `/api/music-bot/chat` is a 401; `tests/test_interpreter_eval.py` covers that.

VRAM is read from `nvidia-smi` (idle, then peak during the run), not from `/api/ps`. `/api/ps` is used only for the no-CPU-offload check, which passes when `size_vram` equals `size` for the model under test. If `nvidia-smi` is missing, the VRAM gate is skipped and the report says so.

## Coverage

| Area                                             | Dev | Held-out |
| ------------------------------------------------ | --: | -------: |
| Entity lookup and ambiguous titles               |   7 |        7 |
| Fine and broad genre                             |   7 |        4 |
| Whole-list duration modes and boundary words     |   8 |        6 |
| Each song's length                               |   4 |        2 |
| Negation                                         |   5 |        3 |
| Similar songs                                    |   5 |        4 |
| Queue scope and transport                        |   7 |        6 |
| Follow-ups that must keep earlier constraints    |  12 |        9 |
| Edits: another set, keep these, add, remove      |   4 |        4 |
| Years, history, favourites and counts            |   5 |        3 |
| Out of scope, mutation guard and injected titles |   4 |        4 |
| Outages                                          |   4 |        4 |
| Total                                            |  72 |       56 |

Most cases cover more than one area. The table counts each case once, under the first tag in its `covers`. Five cases in each split are truly ambiguous.
