# Playlist and action correctness suite, version 1

Part of the separate evaluation suites in issue 179: this one checks that what the server does with a proposal, a commit, an edit, the queue and chat commands is correct. The interpretation suite is in [`evals/interpreter`](../interpreter/README.md). Musical evidence and retrieval have their own suite.

It uses no model, no network and no real library. Each case starts the real app (`backend.main.create_app`) in process on a fresh temporary folder, SQLite database and 12 invented songs, makes HTTP calls in order, and checks the answers and whether the server's state moved.

| File         | What it is                                                      |
| ------------ | --------------------------------------------------------------- |
| `cases.json` | The 12 invented songs (`s01` to `s12`) and the 42 cases         |
| `reports/`   | Per-run JSON and Markdown reports. Git ignored, never committed |

`tests/test_action_eval.py` runs every case, and tests the scorer on a known-good and a known-bad result.

## What it checks

| Area                        | Cases      | What must hold                                                                                                                                                                                  |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previews change nothing     | a01 to a04 | An intent preview, a stored proposal and a chat search or named song change no queue, playlist or play count. A proposal writes only its own tables.                                            |
| Commits                     | a05 to a09 | A playlist save and a queue commit return exactly the approved revision's ids in order. Play, play next, add to queue and replace upcoming each end in a queue holding those ids in that order. |
| Retries                     | a10 to a14 | The same operation id returns the first receipt and saves, records or adds nothing twice. The same id for another target is refused. A second save needs `repeat`.                              |
| Stale and superseded        | a15 to a20 | A superseded revision is refused with 409 and nothing is swapped in. An older revision commits only when named, and is that revision. Missing revisions and proposals are refused.              |
| Songs gone from the library | a21 to a24 | A deleted song makes a queue or playlist commit `proposal_stale` with the song named, instead of being dropped. A read lists it as missing. A refinement leaves it out and says which.          |
| Queue writer                | a25 to a27 | A stale sequence or a replaced epoch gets 409 and the queue stays as it was. A rejected old writer does not block the new one.                                                                  |
| Chat transport              | a28 to a33 | Pause, resume and skip, through the model and with Ollama offline, answer `state_changed` false and change nothing.                                                                             |
| Edits                       | a34 to a37 | Another keeps pinned songs first. Add keeps the earlier songs in order. A removed song stays out of the revision, its commit and later adds. A song not in the revision is refused.             |
| The 500 song limit          | a38 to a42 | More than 500 is refused with the limit stated and nothing is cut. Exactly 500 is accepted.                                                                                                     |

The server has two commit targets, `playlist` and `queue`. Play, play next, add to queue and replace upcoming are one `queue` commit: the browser owns the live queue and composes the result. So cases a06 to a09 commit to `queue`, then write the queue the way the browser would (`PUT /api/player/queue`) and read it back. What they prove is that the receipt's ids and order survive into the queue unchanged, not that the server chose where in the queue to put them.

An edit records its operation id in the same receipts table as a commit (that is how a retried edit is answered once), so an edit moves `receipts` by one. The cases say so.

## A case

```json
{
  "id": "a10",
  "title": "Retrying a playlist commit saves nothing twice and returns the first receipt",
  "covers": ["retry", "playlist"],
  "ollama": "offline",
  "expected_failure": "Why this is a known gap. Left out when the case should pass.",
  "setup": [
    {
      "name": "create",
      "call": "POST /api/music-bot/proposals",
      "json": { "...": "..." },
      "save": { "p": "proposal" },
      "expect": { "status": 200 }
    }
  ],
  "steps": [
    {
      "name": "commit",
      "call": "POST /api/music-bot/proposals/{p.id}/commit",
      "json": { "...": "..." },
      "save": { "r1": "receipt" },
      "expect": { "status": 200, "json": { "replayed": false } }
    }
  ],
  "expect": { "unchanged": ["queue", "plays"], "delta": { "playlists": 1, "receipts": 1 } }
}
```

- `setup` runs first and is checked like `steps`, but the server state is read after it. A case can start from a playing queue or an existing proposal, and the comparison covers only `steps`.
- `ollama` is left out for the default stub (answers `reply`, a canned interpretation), `{ "reply": { ... } }` for a chosen interpretation, or `"offline"` for an unreachable host. Without a `reply`, a chat answers with an empty object.
- A step is `call` (`METHOD /path`), an optional `json` body, optional `save`, and `expect`. `save` keeps `{ "name": "dotted.path" }` from the answer for later steps.
- Names in `{braces}` are replaced in paths and bodies. `{s01}` is the id of song `s01`. A string that is only a name keeps its type, so `"{p.ids}"` is the list. `p.ids.0` is an item, and `entry.*.id` is that field of every item.
- The song ids are real: they come from the scan of the generated files.

Step `expect`:

- `status`: the HTTP status. Default 200.
- `error`, `error_fields`, `message_has`: the contract's error code, its fields, and a phrase in its message.
- `json`: dotted path to an exact value. `false` is not `0`.
- `has`: a phrase inside the text at a path. `len`: the number of items. `starts_with`, `includes`, `excludes`: list checks.

Case `expect`, compared between the state before `steps` and after:

- `unchanged`: any of `queue`, `playlist_rows`, `plays`, `playlists`, `receipts`, `proposals`, `revisions`, `files`. `playback` means `queue`, `playlist_rows` and `plays`. `everything` means all of them.
- `delta`: how much a count moved, for `playlists`, `plays`, `receipts`, `proposals`, `revisions` and `files`.

## Scoring

- A case passes when every step in `setup` and `steps` answers as labelled and the state is as labelled. Any other state change is not checked unless listed, so a case that should change nothing says `unchanged`.
- A case with `expected_failure` is a known gap in the product. It counts as `expected_failure` while it still fails, and the run still exits 0. When it starts to pass it is `unexpected_pass`, which exits 1, so the label gets removed. Do not fix product code in this suite.
- The run exits 1 when any case is `fail` or `unexpected_pass`, 2 when the labels are broken, and 0 otherwise.

## How to run it

```sh
uv run python -m scripts.action_eval
uv run python -m scripts.action_eval --case a10 --case a21
```

It builds each case's library and database in a temporary folder, never the live one. The report is `evals/actions/reports/<date>-actions.json` with a Markdown table beside it. It holds the git SHA, one row per case, and the failing steps. That folder is git ignored.

## Expected failures

| Case | Gap                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a41  | An edit that adds 501 songs is refused as `invalid_request` ("The request is not valid.") and does not say the 500 song limit. A `limit`, `proposal_ids`, `queue_ids` or `keep_ids` over 500 answers `selection_too_large`. |
| a42  | A chat request for 600 songs: the interpreter's schema rejects a limit over 500, so the reply is "The model's answer could not be read. Please try again." and does not say the limit. Nothing is cut, saved or played.     |
