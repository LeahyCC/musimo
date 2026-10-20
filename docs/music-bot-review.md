# Music bot: milestone 1 review

This is the original handoff. See [review fixes and current evidence](music-bot-review-fixes.md) for the follow-up scope, shuffle Undo, bounded persistence and migration corrections. The results and remaining issues below describe the earlier version.

Implemented for review on 13 October 2026. No commit, merge, deployment or audio indexing. Existing uncommitted work is preserved.

## What works

Ollama address and time-zone settings, connection test, installed-model selection, bounded session chat, follow-up requests, validated tag searches, playable previews, Play, Play next, Add to queue, Replace upcoming, Save playlist and conditional Undo. The existing player and SQLite remain the owners of playback and saved state.

The live acceptance check used four generated 30-second WAV files and real Ollama. Two liked 90s songs matched; the song played today and the 80s song were excluded. Musimo reported a 59-minute shortfall. Selecting a reference and asking "remove that artist" left one song and a 59.5-minute shortfall. Add to queue played that song through the browser and persisted its real id. Undo restored the empty queue. This passed on desktop Chromium and the 390px phone project.

Screenshots from that live flow: [desktop](assets/music-bot-desktop.png), [phone](assets/music-bot-phone.png). Both show generated fixtures, not personal music. Full-page screenshots include the fixed player at its viewport position. Layout, scrolling, accessibility and light-theme checks also ran in the browser suite.

## Verification

- Backend bot tests: 11 passed. Real generated files and SQLite, mocked Ollama HTTP. Covers a full hour and insufficient/zero matches, favourites, years, local midnight, duration, genre, history, follow-ups, exclusions, stale/deleted files, invalid responses, response limits, unavailable Ollama, timeout and cancellation.
- Full backend suite: 421 tests, 420 passed, one existing failure. Coverage was 85.45%, above the 70% floor. `test_sources.SourceTests.test_old_database_carries_the_youtube_pause_across` expects schema version 6; the pre-existing store changes use 7.
- Frontend unit tests: 367 passed. Production build, ESLint, Prettier, mypy and browser-test types passed. The Docker build used Node 26 and Python 3.14; native checks used Node 24.19 and Python 3.14.
- Wider desktop/phone regression run: 90 passed and 20 platform-specific skips. Two new cases initially failed because their Play locator matched both the preview action and footer control; that locator was corrected and the bot suite rerun separately.
- Bot browser suite: 40 passed across Chromium, Firefox, WebKit and phone. Covers connection settings/model persistence, preview/follow-up, save playlist, Play next, replacing upcoming tracks, direct Pause/Resume/Skip, queue overflow, failed saves, Undo after manual edits, cancellation during interpretation and validation, unavailable Ollama, invalid output, missing tracks and autoplay refusal. The API is mocked for these cases; the browser player and generated audio are real. WebKit's fixture points media directly at the generated asset because its media fetch can bypass page routing.
- Live Ollama browser flow: 2 passed, desktop and phone. No bot/player API route mocks. Generated WAVs, scanner, SQLite, selected model, audio playback, queue persistence and Undo all participate.
- Dependency audits: no known Python or npm vulnerabilities found.
- Repository-wide Ruff check/format still reports the two pre-existing long assertions in `tests/test_player_store.py`, lines 83 and 143. Files added or edited for this milestone pass Ruff. `git diff --check` passes.

Logs are in ignored `runtime/milestone1/`. The saved initial diff is `preexisting.patch`. A comparison confirmed the ten pre-existing changed files outside the shared `api.ts` and `docs/player.md` are unchanged, and every original addition in those two shared files remains.

## Live model checks

Recorded results contain 18 passing guarded-workflow checks: the acceptance request, reference-artist removal and "make the rest calmer", twice for each of three installed models. This is a small fixed corpus, not proof of general recommendation quality.

Acceptance wall-clock times on this Windows PC (Ryzen 9 9900X, RTX 5080): llama3.1:8b took 5.19 seconds cold and 0.64 seconds warm; qwen2.5-coder:7b took 0.69 and 0.71 seconds warm; gpt-oss:20b took 15.46 seconds cold and 1.36 seconds warm. Qwen was already loaded in this final run, so it has no cold measurement there. An earlier run with the final prompt measured 4.08 seconds cold for Qwen. Cold is established by `/api/ps`, without evicting another application's model. Times include model listing, generation and library resolution. Follow-ups are warm even when grouped under the initial cold pass in the JSON.

Earlier prompt versions let models confuse recent-play exclusions with never-played songs, reverse reference exclusions or ignore an unsupported sound request. The prompt was corrected, and the service now independently resolves reference-artist exclusions and refuses known unsupported sound comparisons. The measurements describe the guarded service, not raw model accuracy. No default model is selected automatically or recommended from this small sample.

## Files belonging to this milestone

Backend: `backend/api/music_bot_api.py`, `backend/library/music_bot.py`, `backend/core/models.py`, `backend/main.py`.

Frontend: `frontend/src/features/music-bot/music-bot.tsx`, `frontend/src/features/player/player.tsx`, `frontend/src/features/settings/server-settings.tsx`, `frontend/src/api.ts`, `frontend/src/app/routes.tsx`, `frontend/src/app/shell.tsx`.

Checks: `tests/test_music_bot.py`, `scripts/music_bot_benchmark.py`, `frontend/e2e/music-bot.spec.ts`, `frontend/e2e/music-bot-live.spec.ts`, `frontend/e2e/setup.ts`, `frontend/e2e/themed-walk.spec.ts`.

Dependency: `pyproject.toml`, `uv.lock`, `requirements.lock`, adding pinned `tzdata` for Windows time zones.

Docs/evidence: `docs/ai-music-plan.md` (status only), `docs/player.md`, `docs/settings.md`, `docs/architecture.md`, `docs/testing.md`, this handoff, `docs/assets/music-bot-desktop.png`, `docs/assets/music-bot-phone.png`. The raw results file named in the first draft, `docs/evidence/music-bot-models.json`, was never committed and is lost; the figures above are all that remain.

## Remaining issues and boundaries

- The existing schema-version assertion and Ruff formatting failures remain untouched. They prevent a fully green repository check.
- Arbitrary natural-language interpretation still depends on the selected model. Review the displayed filters and songs before applying. This work does not establish quality across a personal music library or a larger request corpus.
- A restored proposal requires another request before editing the queue. Undo is session-local and refuses after subsequent player/queue changes. Independent browser tabs retain the existing shared server queue's last-writer-wins behavior; there is no cross-tab transaction protocol.
- Search checks at most 5,000 matching candidates and returns at most 500 songs. The preview reports the candidate ceiling when reached. Missing years/durations are not guessed, and explicit recent-play exclusions conservatively reject malformed or unknown dates on previously played songs.
- Only tags and listening records are available. Audio indexing, mood/instrument evidence, permanent taste memory and voice remain outside milestone 1.

The implementation follows the existing [player contract](player.md), [settings contract](settings.md), [testing rules](testing.md) and [UI styling contract](tailwind-migration.md). Ollama integration uses its [chat API](https://docs.ollama.com/api/chat), [model listing](https://docs.ollama.com/api/tags) and [structured output contract](https://docs.ollama.com/capabilities/structured-outputs).
