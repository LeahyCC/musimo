# Milestone 1 review fixes

See [the final milestone 1 checks](music-bot-finish-review.md) for capability-aware request controls, updated model results and the complete green browser rerun. The results below are the earlier review record.

The review fixes are ready for review. No commit, merge, deployment or audio indexing. Existing work remains in place.

## Changes

- Follow-ups honour proposal, upcoming queue and library scopes. Adding songs keeps eligible proposal entries and appends distinct matches. Explicit filter changes replace those filters. Artist exclusions accumulate, and withdrawing one does not remove the others. Recent-play exclusions cannot be lifted by a scope change alone. Missing matches remain a shortfall.
- Undo captures the large-library shuffle seed, cursor, total and edited-source state, as well as the queue. Restoring it reinstates the saved fingerprint. Manual queue edits, transport changes and shuffle-toggle changes still invalidate Undo. An abandoned window fetch holds the old deck object and cannot mutate the restored copy.
- Queue persistence has one active request and one latest pending snapshot. Each request times out after eight seconds. SQLite stores the writer epoch and sequence and rejects older saves atomically, including after restart. Another browser taking ownership stops further saves from the replaced browser and prompts a refresh. Failures remain visible; there is no unlimited retry loop.
- Schema 8 adds two queue-ordering columns. The earlier schema assertion now uses the schema constant, with checks for the migrated source pause and playback columns. A populated schema-6 fixture verifies stable song ids, play counts, last-played dates, playlists, queue position and codec defaults through upgrade and reopen. The two old Ruff assertions were formatted without changing their checks.

## Evidence

Backend: 426 tests passed, including 14 bot tests, the queue API ordering check and migration/reopen checks. Coverage: 85.52%. Frontend: 369 unit tests passed, including a hung-save test with 100 intermediate edits coalesced to Undo. Ruff check/format and mypy pass.

The bot and queue-editing browser run finished with 72 passes, three existing drag-test platform skips and one phone test assertion that read local storage before asynchronous validation finished. That assertion now waits for the edit. The corrected 701-song test then passed on Chromium, Firefox, WebKit and phone (four passes). Every bot and queue-editing case has passed on its applicable projects; the combined run itself was not fully green. The hung-save cases passed in all four projects: a save was held past its deadline, further edits and Undo were made, and the stale save was released without changing the restored state.

The separate live Ollama browser flow passed on desktop and phone (two passes), using qwen2.5-coder:7b, generated files, the scanner, SQLite, actual stream URLs and browser audio. It verified the hour request, honest shortage, artist removal, persisted queue and Undo. There were no API route mocks in these two checks. New screenshots: [desktop](assets/music-bot-desktop.png), [phone](assets/music-bot-phone.png). The full-page phone image includes the fixed player at its viewport position.

Production build, ESLint, Prettier and browser-test types pass. The existing build chunk-size warning remains. `git diff --check` passes. A preservation comparison found the seven unrelated initial diffs byte-identical; original additions in shared files remain, allowing the requested assertion formatting and schema-version advance.

The first wider browser run found four WebKit failures in existing queue-editing fixtures: fake media ids bypassed route interception and caused automatic skips. The fixture now opts into the same generated-audio source used by the bot tests. This affects mocked successful-stream checks only. Real streams remain covered separately by the opt-in live spec.

## Live model checks

[Full results and timings](evidence/music-bot-review-models.json): 60 real Ollama calls against four generated WAVs, the real scanner and SQLite. Three original requests ran twice per model, followed by fourteen independent cases covering paraphrases, queue/library scopes, adding songs, changing artists/decades, accumulated exclusions, individual withdrawals and conflicting filters. Clarification is accepted for contradictory requests. No personal library or downloaded music was used.

- llama3.1:8b: 20/20 checks passed.
- qwen2.5-coder:7b: 19/20. It retained the recent-play exclusion after being asked to allow today's songs.
- gpt-oss:20b: 19/20. It retained an artist exclusion after being asked to allow that artist again.

These are results for the guarded service, not raw model accuracy. Both remaining misses returned too few songs rather than admitting excluded songs. Earlier runs exposed omitted optional fields and inconsistent search/clarification actions; the fields are now required and a clarification cannot become a playable search. All failed attempts remain in ignored `runtime/milestone1/review-models*.log`. The final recorded corpus is still small and partly used during development, so it does not establish general recommendation quality or justify an automatic default model.

## Files changed for this review

Backend: `backend/library/music_bot.py`, `backend/api/player_api.py`, `backend/library/player.py`, `backend/core/store.py`.

Frontend: `frontend/src/api.ts`, `frontend/src/features/player/player.tsx`, new `frontend/src/features/player/queue-writer.ts`.

Checks: `tests/test_music_bot.py`, `tests/test_player.py`, `tests/test_player_store.py`, `tests/test_sources.py`, `scripts/music_bot_benchmark.py`, new `frontend/src/features/player/queue-writer.test.ts`, `frontend/e2e/music-bot.spec.ts`, `frontend/e2e/library-fixtures.ts`, `frontend/e2e/queue-editing.spec.ts`.

Docs/evidence: `docs/player.md`, `docs/architecture.md`, `docs/testing.md`, `docs/ai-music-plan.md`, `docs/music-bot-review.md`, this handoff, `docs/evidence/music-bot-review-models.json`, `docs/assets/music-bot-desktop.png` and `docs/assets/music-bot-phone.png`. The original milestone file list remains in [the original handoff](music-bot-review.md).

## Remaining limits

- Model interpretation still needs review before applying. The two recorded withdrawal misses remain. Withdrawal language is deliberately conservative; use explicit wording such as "allow Harbor again" or "allow songs played today" if a model keeps an exclusion.
- Undo and shuffle continuation are local to the browser session. The server still expires shuffle orders after a day without access or a restart; Undo cannot recreate an expired server order.
- A failed latest save remains unsaved until a subsequent save succeeds. Another browser taking queue ownership requires refresh. This is stale-write protection, not synchronized playback across browsers. Legacy unversioned API clients remain supported; their writes cannot be ordered and invalidate tokened writers. The shipped player uses versioned writes.
- Schema 8 is not readable by older binaries. A downgrade requires a pre-upgrade database backup. Migration tests verify data preservation and repeat opens; no production database was migrated in this task.
- No audio analysis, worker or indexing was added. The 5,000-candidate search ceiling and 500-song queue limit remain.

Logs are in ignored `runtime/milestone1/review-*`. The isolated test stack uses port 18814 and disposable volumes; the existing installations are untouched.
