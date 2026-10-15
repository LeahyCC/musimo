# Music bot final milestone 1 checks

## Changes

Every Ollama chat now sends `keep_alive: "60s"`. The service checks `/api/show` before inference and sends `think: false` only when the reported `thinking.values` includes boolean false. Missing metadata and models with named thinking levels omit the control. GPT-OSS still thinks; this change does not claim otherwise. Capability lookup has the existing eight-second HTTP bound and is cancellable. The inference limit remains 90 seconds.

The schema and prompt now explain the two different withdrawal operations: artist names belong in `allow_artists`, while withdrawing a recent-play exclusion requires `exclude_played_days: 0` and that field in `change_filters`. Tests verify that either withdrawal leaves unrelated exclusions intact. The service's exclusion protections were not weakened.

The benchmark now rejects missing models before inference, records installed digests and thinking metadata, and retains actual request controls, structured output and Ollama timing counters. It does not save thinking text. Two added withdrawal paraphrases bring the corpus to 22 checks per model. The live browser spec accepts `MUSIMO_LIVE_MODEL`.

## Investigation

The earlier Qwen 2.5 miss changed `history` instead of withdrawing `exclude_played_days`. The earlier GPT-OSS miss omitted the artist from `allow_artists`. The guarded service therefore kept the exclusions in both cases. Before the prompt clarification, this session's [repeat of the original corpus](evidence/music-bot-finish-baseline.json) passed 20/20 for each model. Those old failures are intermittent; a successful repeat is not proof they are gone. The historical [60-call evidence](evidence/music-bot-review-models.json) remains unchanged.

The first combined browser run finished with 72 passes, three existing platform drag skips and one WebKit failure. Its trace shows all UI assertions completed, then context teardown disposed an API response while the snapshot route handler was still reading it after reload. The bot spec now waits for active route handlers with `unrouteAll({ behavior: 'wait' })` before context disposal. It does not suppress errors. The whole bot and queue suite was rerun after this change.

## Live comparison

[Comparison results](evidence/music-bot-finish-comparison.json) contain every call, including failures. These three runs preceded the final worked artist-withdrawal example added for Qwen 3.5 below. They were not rerun with that last prompt change. Each model ran the same 22 cases once, with the original three cases repeated within that corpus. Times are wall-clock seconds for the guarded service, not raw model throughput. Warm statistics exclude the first call and include failures.

| Installed model                   | Passed        | Cold first call | Warm median | Warm range    |
| --------------------------------- | ------------- | --------------- | ----------- | ------------- |
| qwen2.5-coder:7b                  | 21/22 (95.5%) | 7.827 s         | 1.013 s     | 0.805–1.354 s |
| gpt-oss:20b                       | 21/22 (95.5%) | 15.193 s        | 3.397 s     | 1.282–7.579 s |
| huihui_ai/gemma-4-abliterated:12b | 21/22 (95.5%) | 49.992 s        | 2.348 s     | 1.799–7.878 s |

Qwen 2.5 emitted an included artist but omitted `artists` from `change_filters` for a contradictory include/exclude request. The service inherited the old inclusion filter, yielding Orchard instead of an empty result. GPT-OSS used its entire 1,200-token budget on thinking for the new artist-withdrawal paraphrase and returned empty content. Gemma returned malformed JSON during the artist-switch case. Both malformed replies were rejected without applying a change. All three passed the two original withdrawal phrases; the new GPT-OSS miss shows why those successes are not a general guarantee.

Gemma advertised boolean thinking controls, received `think: false`, and returned no thinking text. Qwen 2.5 advertised no thinking metadata and GPT-OSS advertised only named levels, so both omitted `think`. Every recorded call sent `keep_alive: "60s"`. These comparison timings overlapped the Qwen download and mocked browser tests; they are not an idle-machine performance benchmark.

## Qwen 3.5 verification

The abliterated Qwen download finished on 13 October at 23:21 HST. Before any inference, the pull log reported SHA-256 verification and success, `/api/tags` listed the installed model, and the pull process had exited. [Installation evidence](evidence/music-bot-qwen-install.json) records digest `92a443adb124f5e805bbdee23fdb38fcd22a7bf00a1016b53f764e741369c600`, size 6,594,474,755 bytes, and supported thinking values `[false, true]`.

The [first corpus](evidence/music-bot-finish-qwen-before.json) passed 20/22 (90.9%). Both artist-withdrawal phrases failed: the JSON omitted `allow_artists` even though its explanation claimed the artist was allowed. The service correctly retained that exclusion. The cold first call took 13.941 seconds; the remaining calls had a 1.973-second median and 1.647–2.578-second range.

The prompt now includes a worked withdrawal using generic Artist A and Artist B, with the required arrays shown explicitly. The [complete rerun](evidence/music-bot-finish-qwen.json) passed 22/22 (100%), including both artist withdrawals, both played-today withdrawals, paraphrases, scope changes, added songs and contradictory filters. All 22 calls were warm: median 2.255 seconds, range 1.762–3.197 seconds. Every call sent `think: false` and `keep_alive: "60s"`; none returned thinking text. The 17 bot unit tests also passed again after this last prompt change.

These are small, partly development-used service corpora, not independent raw-model accuracy estimates. The failures remain available beside the rerun. No default model was changed, and no general accuracy claim follows from 22/22.

## Server configuration

The per-request controls above are implemented and require no Ollama restart. The running server is Ollama 0.40.3. Its startup log already reports `OLLAMA_NUM_PARALLEL=1`; `OLLAMA_MAX_LOADED_MODELS` is still 0. Both user environment values are saved as 1, so only max-loaded-models activation remains pending restart. Ollama was not restarted. The cancelled standard `qwen3.5:9b` download is no longer planned, and was not resumed.

Control semantics follow [Ollama's thinking metadata](https://docs.ollama.com/capabilities/thinking) and [chat request fields](https://docs.ollama.com/api/chat).

## Automated checks

- Backend: 429 tests passed, 85.55% coverage. This includes 17 bot tests, capability negotiation, cancellation during capability lookup, exclusion withdrawals, migration preservation and stale queue writes.
- Frontend: 369 unit tests passed. Ruff check/format, mypy, ESLint and browser-test types pass. The isolated Docker production build passed with the existing large-chunk warning.
- Combined bot and queue browser suite: 73 passed, three existing drag-test platform skips, no retries. Chromium, Firefox, WebKit and the 390 × 844 phone viewport were run together. These use mocked bot responses and generated successful-stream audio. They cover large-library Undo/continuation, stalled saves, manual queue edits, cancellation, unavailable Ollama, invalid output and autoplay refusal.
- Live Qwen 3.5 browser flow: two passes, desktop Chromium and phone, after rebuilding with the final prompt. Real Ollama, generated WAV files, scanner, SQLite and stream URLs verified the hour request, honest 59-minute shortage, artist removal, playback, persisted queue and Undo. No API route mocks. Screenshots: [desktop](assets/music-bot-qwen-desktop.png), [phone](assets/music-bot-qwen-phone.png). Full-page images retain the fixed player at the viewport position.

The failed first browser run and trace remain in ignored `runtime/milestone1/finish-browser.log` and `finish-first-webkit-trace.zip`; the successful full rerun is `finish-browser-final.log`. Backend, build and unit logs use the same `finish-` prefix.

## Scope

All generated music and databases belong to disposable checks. No personal library, selected production model, deployment or audio-indexing work was changed. No commit was made. The earlier [review limitations](music-bot-review-fixes.md#remaining-limits) still apply apart from model results superseded here.

## Changed files in this follow-up

- Service and checks: `backend/library/music_bot.py`, `tests/test_music_bot.py`, `scripts/music_bot_benchmark.py`, `frontend/e2e/music-bot.spec.ts`, `frontend/e2e/music-bot-live.spec.ts`.
- Docs: `docs/ai-music-plan.md`, `docs/architecture.md`, `docs/testing.md`, `docs/music-bot-review-fixes.md`, this report.
- Evidence: five `docs/evidence/music-bot-finish-*.json` / `music-bot-qwen-install.json` files and the two `docs/assets/music-bot-qwen-*.png` screenshots.

Remaining issues: interpretation errors remain possible, particularly on the comparison models; max-loaded-models still awaits a later Ollama restart; the existing build chunk-size warning and three platform drag-test skips remain. All unrelated files were compared with their starting hashes and preserved.
