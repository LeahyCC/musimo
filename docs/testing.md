# Testing and CI

The optional [bounded audio-analysis trial](audio-analysis-trial.md) has its own container, dependency lock and reproduction commands under `experiments/audio-trial/`. It reads real music through read-only mounts and writes only ignored experiment output. Its decoder checks use generated audio; recommendation quality requires the listening review. It does not alter the production database or run in the normal application test suite.

Music bot review regressions are recorded in [the review fixes](music-bot-review-fixes.md). They cover explicit follow-up scopes and filter changes, accumulated exclusions, adding songs, a 701-song shuffle restored by Undo, playback past its 500-song window, stalled queue saves followed by edits and Undo, and persistent rejection of stale writes after database reopen. Browser failure cases use mocked endpoints; the opt-in live Ollama flow uses generated WAVs, the scanner, SQLite and actual browser audio. The model benchmark also checks paraphrases, scope switches, artist/decade changes, individual exclusion withdrawals and conflicting filters.

Run these commands from the repository root. Python 3.14 is the container runtime; CI also tests Python 3.12 compatibility. Node 26 builds the frontend. Install FFmpeg and ffprobe for the generated-audio tests. CI installs them so those tests cannot silently disappear from its coverage.

PRs [#1](https://github.com/LeahyCC/musimo/pull/1) and [#2](https://github.com/LeahyCC/musimo/pull/2) were integrated into `fix/download-reliability` on 7 September 2026. Their original CI failures were the Firefox playback check on an older base; the branch includes the subsequent fixture-path and Linux audio-output fixes. Node 26 is currently the Current release, with LTS scheduled for October ([Node release note](https://nodejs.org/en/blog/release/v26.0.0)). It is used for building the frontend and running CI tools; the final server image runs Python.

The combined image built successfully and ran Python 3.14.7. All 41 container tests and 60 browser checks passed (7 September historical counts; PR #29 reported 49 backend and 112 browser tests), as did HTTP/SSE restart, the generated album pause/retry check and the disposable-container SIGKILL recovery check. Both worker checks completed all twelve jobs with no duplicate files. Earlier Python 3.12 measurements remain historical results for that runtime.

## Local checks

GitHub Actions no longer runs on pushes or pull requests (see [GitHub checks](#github-checks)), so these checks run on your machine. `npm ci --prefix frontend` points git at `.githooks/`, which runs `scripts/check.sh fast` (lockfile, Ruff, ESLint and Prettier, about 15 seconds) before each commit and `scripts/check.sh full` (everything below, about a minute) before each push. If you installed before the hooks existed, run `git config core.hooksPath .githooks` once. `scripts/check.sh browser` runs the Docker smoke and Playwright suite from [Browser and container checks](#browser-and-container-checks); it is too slow for a hook, so run it by hand for UI changes. `scripts/check.sh worker` installs the audio worker's own environment (`worker/uv.lock`, which carries librosa and is never installed into the web environment) and runs `worker/tests`; run it by hand after a change under `worker/`. The full check still lints and type-checks `worker/` and checks that `worker/requirements.lock` matches its lock. Skip a hook once with `--no-verify`.

The full check runs:

```sh
uv sync --locked
npm ci --prefix frontend
uv run ruff check backend tests scripts worker
uv run ruff format --check backend tests scripts worker
uv run mypy
uv export --locked --no-header --no-dev --no-emit-project --format requirements-txt   # diffed against requirements.lock
uv export --locked --project worker --no-header --no-emit-project --format requirements-txt   # diffed against worker/requirements.lock
uv run coverage run -m unittest discover -s tests -v
uv run coverage report
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
npm run test:e2e:types --prefix frontend
uv run pip-audit --disable-pip --no-deps -r requirements.lock
uv run pip-audit --disable-pip --no-deps -r worker/requirements.lock
npm audit --prefix frontend --audit-level=high
```

The unittest suite covers persistence, input validation, origin checks, catalog caching, ownership refresh, job idempotency, queue controls, clearing failed downloads, whole-library track browsing, liked-playlist protection, crash recovery, audio tagging, metadata identification, the genre tag mapping and worker failures. Provider requests use mock HTTP transports. FFmpeg generates audio fixtures. No ordinary test needs a provider account or downloads a recording.

`npm run test` runs the frontend unit tests with Vitest. They live next to the module they cover as `frontend/src/**/*.test.ts`, run in Node without a browser, and are for pure TypeScript: maths, formatting and transforms. Anything that needs the DOM, audio or a real browser belongs in the Playwright suite below.

Coverage includes branches and every backend module, including unexecuted modules. The current floor is 70%. Raise it as coverage grows; do not lower it to make a PR pass. Docker smoke and browser checks are additional behavioral checks outside this percentage. Coverage does not establish music-match accuracy or successful provider downloads.

## Browser and container checks

Music bot coverage: `tests/test_music_bot.py` uses generated files, real SQLite and mocked Ollama responses for filters, local-day boundaries, duration shortfalls, reference exclusions, cancellation, response limits, invalid output, the seeded draw and the artist cap. For the draw it checks that a returned seed repeats the selection, that play count ranks only a "more familiar" request, that asking again prefers songs not shown yet and reuses them only when it must, and that a refinement keeps the person's order. `tests/test_selection.py` covers `backend/library/selection.py` with no database: the draw pinned for a seed and a song, an order that ignores input order and other songs, different sets from equally fitting songs over fixed seeds, the overlap of a small pool, shown songs going last but staying, a relevance draw that stays near the top, a ranked pool that fits being listed in rank order, no lean to short or long songs, `need_for`, and the refinement order. `tests/test_music_bot_audio.py` covers [song characteristics](audio-profile-spec.md) in the bot: the refusals while both recipe settings are empty, the tempo and energy gates and their shortfall with a scalar recipe on, calmer and faster against the reference song's own row, a test embedding recipe ranking "more like this" and a sound phrase by cosine with the seed and a repeated title absent, negation-only phrases dropped, the prompt for each combination of recipes, settings that accept only `""` or a registered recipe, `validate` answering 409 for a stale row, and the 500 ms budget for warm cosine scoring plus the gate walk on a synthetic 44,000 by 512 matrix (synthetic, not the live library). `tests/test_audio_profile.py` covers the schema 9 upgrade from a populated version 8 file, a removed song dropping its rows on the next scan, the lease and result rules (token, expiry, changed file, wrong vector length, a second result, three failures or three lapsed leases), freshness and byte-length checks, the percentile bands with the equal-values case, and the enqueue script. `tests/test_audio_worker.py` covers the internal lease routes: the shared token, 404 without one or from a browser, no work while a chat request runs, and the result checks over HTTP. `worker/tests/test_recipe.py` covers `tempo-energy-v1` on generated audio: section starts, the spoken-word skip without decoding, a short file failed without an invented tempo, the FFmpeg command and a short section refused, and with librosa present clicks at 120 BPM measuring near 120 and silence giving no tempo; it runs under `scripts/check.sh worker`, and inside the worker image with `docker run --rm -v "$PWD/worker/tests:/app/tests:ro" musimo-audio-worker:0.4.0 python -m unittest discover -s /app/tests -t /app`. `e2e/music-bot.spec.ts` mocks the bot API while exercising the real browser player, including queue edits, Undo, autoplay refusal, cancellation during validation, and the shown songs it sends (never a seed) and forgets on Clear chat. `e2e/themed-walk.spec.ts` includes the bot page. `e2e/music-bot-pet.spec.ts` covers the pet: it perches clear of the footer controls, opens a labelled chat that takes focus and gives it back on Escape, every result action and Undo with its refusal from the popover, a reply landing with the chat closed (dot, bubble, label), quick replies and a picked scope, the quick menu, pet settings kept across a reload, the hidden pet's sidebar face, the Now Playing spot over a bright and a dark cover, four themes including both Windows 95 halves, reduced motion, and on the 390px phone project the mini player perch, the sheet and the top bar face. It writes review screenshots to `runtime/pet/`. Unit tests next to the code cover the pet's state mapping (`pet-mood.test.ts`), the settings schema, its per-field fallbacks and refused storage (`pet-settings.test.ts`), popover and perch placement (`pet-placement.test.ts`) and the chat's wording, chips, failure mapping and remembered songs (`bot-replies.test.ts`).

To repeat a bot selection from a report, take `plan`, `generation_seed`, `reference_id` and `current_id` from the tab's session storage key `musimo.music-bot.proposal`, and the lists from `musimo.music-bot.shown`. The first list there is that answer's own songs; leave it out, and send the rest flattened, newest first, each once, keeping the first 500 as the browser does. On a copy of the database, build a `Player` with the same music roots and a `MusicBot` on it, and call `bot.resolve(SearchPlan.model_validate(plan), BotRequest(prompt="repro", generation_seed=seed, shown_ids=shown, proposal_ids=proposal, reference_id=reference_id, current_id=current_id))`. `merge_plan(None, plan)` returns the plan unchanged, so Ollama is not involved. `proposal_ids` matters only when the plan has `add_count`; then it is the proposal before that answer. The library state must match: the songs, the Liked playlist, the profile rows, the local day, and the music files at the same paths under an enabled root, because a song whose file is missing is skipped. When three lists were already stored before that answer, the oldest list the request sent is gone, and the repeat may differ.

`e2e/music-bot-live.spec.ts` is opt-in: set `MUSIMO_LIVE_OLLAMA` to an address reachable from the isolated test server (Docker Desktop: `http://host.docker.internal:11434`). Set `MUSIMO_LIVE_MODEL` to select an installed model; it defaults to `qwen2.5-coder:7b`. It uses generated tagged WAVs, the real scanner, SQLite, Ollama and browser playback. It changes and restores the test server's Ollama settings; never point it at a personal installation. The normal suite skips this test when the variable is absent.

For a separate model comparison, run `uv run python -m scripts.music_bot_benchmark --model huihui_ai/qwen3.5-abliterated:9b`. Repeat `--model` to compare installed models. Preflight rejects missing models and records installed digests and thinking metadata. It creates its own temporary library and database, downloads nothing and runs 22 checks per model: six original checks plus sixteen independent cases for paraphrases, scopes, additions, changed filters, conflicts and exclusion withdrawals. Cold means the model was absent from Ollama's `/api/ps` before the first request; all follow-ups are warm. Wall-clock times include discovery, capability lookup, interpretation and search. Raw structured replies, actual request controls and Ollama timing counters are recorded; thinking text is not retained. Results measure the guarded workflow on four generated songs, not general recommendation quality. See [the latest evidence](music-bot-finish-review.md). Run `npm run test:e2e --prefix frontend -- music-bot.spec.ts queue-editing.spec.ts` against the isolated stack for the combined mocked browser regression suite.

`e2e/local-player.spec.ts` exercises the real scanner, player API, SQLite and streamed audio without route mocks. Global setup writes two generated, tagged WAV files into the isolated `/music/e2e-local-player` directory. The test scans them, opens their album, plays, seeks by keyboard, skips, restores the saved queue after reload, and creates, fills and empties a playlist through the UI. It removes its playlist after a successful run; a failed run may leave its timestamped fixture playlist in the test volume. It runs on all four browser projects. Existing mocked specs still cover the broader UI edge cases.

`scripts/player_benchmark.py` builds its own temporary music tree and database, checks the indexed counts, then measures cold and warm player reads. It never opens the live database. The benchmark asserts queue length, album totals and track totals so a fast but incomplete result fails. See [the measured baseline](measurements.md#local-player-baseline-13-october-2026).

```sh
npx --prefix frontend playwright install --with-deps chromium firefox webkit
docker compose -f compose.ci.yaml -p musimo-ci up -d --build --wait --wait-timeout 120
uv run python scripts/smoke.py --url http://127.0.0.1:18765 --restart --compose-file compose.ci.yaml --project-name musimo-ci
npm run test:e2e --prefix frontend
uv run python scripts/benchmark.py --url http://127.0.0.1:18765 --output runtime/ci-benchmark.json
docker compose -f compose.ci.yaml -p musimo-ci down --volumes
```

The explicit Compose file, project name, port 18765 and named test volumes keep these checks separate from a running installation. They do not mount host music or load `compose.override.yaml`. Cleanup removes only this test project's containers and volumes. To run several stacks side by side (parallel branches on one machine), give each its own `MUSIMO_CI_PORT`, `MUSIMO_CI_TAG` and `-p` project name when starting Compose, and point Playwright at it with `PLAYWRIGHT_BASE_URL` and `MUSIMO_CI_PROJECT`:

```sh
MUSIMO_CI_PORT=18801 MUSIMO_CI_TAG=ci-mybranch docker compose -f compose.ci.yaml -p musimo-ci-mybranch up -d --build --wait
PLAYWRIGHT_BASE_URL=http://127.0.0.1:18801 MUSIMO_CI_PROJECT=musimo-ci-mybranch npm run test:e2e --prefix frontend
docker compose -f compose.ci.yaml -p musimo-ci-mybranch down --volumes
```

Run smoke and browser tests sequentially because both change installation settings. Start the test server before Playwright.

Playwright runs Chromium, Firefox, WebKit and a 390px mobile viewport (iPhone 13 on Chromium). Tests cover keyboard search, query/tab/sort persistence, catalog error/retry, saved settings, cross-tab SSE updates, failed saves, queue pause/resume, activity clear, diagnostics export, album ownership, artist selection, library track controls, library search, filter and sort kept in the address, artist filters and favourites, play-to-pause and resume, artist album dates and sorting, podcast search with episode queueing, playlist CRUD and the playlist picker, download card layout with failure grouping, infinite scrolling, failure explanations and retry counts, error hint links to settings or diagnostics, done jobs with warnings showing warning counts, a link job's tag note showing as plain text on the card without counting as a warning, ownership badge states (owned, edition, queued, downloaded earlier), destination and format line, the loading transition check, the Now Playing hover and idle stage (Chromium desktop only), the visualizer's artwork fallback without WebGL 2, its view toggle and preset picker, axe audits, Settings draft preservation/conflict notice/navigation guard, and the readiness panel with destination write test. They also check real audio decoding, seeking, volume, mute, restart and navigation using generated silence served by the test container, and that long titles and names stay inside download cards, failure chips, playlist cards, the playlist picker and the phone-width filter menus.

Catalog records are invented. Album, cards, download-options and podcasts specs serve an empty queue through `queue-fixtures.ts`; download-failures mocks the queue; library, playlist, player and popout specs mock `/api/library/*` and `/api/player/*` through `library-fixtures.ts`. Only `app.spec.ts` and `a11y.spec.ts` read the real queue and visit /downloads, /settings and /diagnostics unmocked. Settings, events, diagnostics and queue controls use the real container API and SQLite. The test container's music mount is not writable by the app user, and the review sheets keep Download off for a folder that cannot be written to, so a spec that queues from a sheet calls `writableDestination` in `queue-fixtures.ts` to report the saved destination as writable. Global setup writes only a generated WAV file into the isolated test container. Provider downloads and music-match accuracy still need separate verification.

A test that touches the Now Playing stage must pin the view rather than rely on the default. `now-playing-popout.spec.ts` sets `musimo.now-playing-view` before the page loads; `visualizer.spec.ts` either removes `window.WebGL2RenderingContext` or presses V. Tests that need the visualizer commands available keep the browser's `WebGL2RenderingContext` and define a stand-in only where an engine has none.

Tests use one worker because settings and queue controls belong to the installation. CI rejects focused tests and fails tests that pass only on retry. The retry collects evidence without hiding flaky tests. Download the `browser-results` artifact from Actions to inspect a failure, or run:

```sh
npm run test:e2e:report --prefix frontend
```

Spec files: `e2e/a11y.spec.ts`, `e2e/album.spec.ts`, `e2e/app.spec.ts`, `e2e/cards.spec.ts`, `e2e/download-failures.spec.ts`, `e2e/download-options.spec.ts`, `e2e/library-controls.spec.ts`, `e2e/now-playing-popout.spec.ts`, `e2e/phone.spec.ts`, `e2e/player.spec.ts`, `e2e/playlists.spec.ts`, `e2e/theme.spec.ts`, `e2e/themed-walk.spec.ts`, `e2e/visualizer.spec.ts`, plus support files `e2e/env.ts`, `e2e/library-fixtures.ts`, `e2e/queue-fixtures.ts`, `e2e/search-fixtures.ts`, `e2e/setup.ts`, `e2e/theme-fixtures.ts`.

`e2e/theme.spec.ts` writes a theme into browser storage before the page loads and checks that `public/theme-boot.js` paints it on the first frame with the app bundle blocked, that the app keeps it once the bundle has run, and that removing the three keys returns the default. Its light fixture theme lives in `e2e/theme-fixtures.ts`; every text pair in it clears WCAG AA, so a later phase can walk each route under it and treat a dark patch as a color that escaped the tokens. The same file covers the personal settings page at `/settings/user`: duplicating the built-in theme and watching the whole app repaint while it is edited, Cancel and leaving the route both putting the saved theme back, Save surviving a reload, a theme exported to a file and imported again, a file that is not a theme refused without changing anything, deleting the active theme falling back to the default, a second tab following a save made in the first, the Change theme palette command, the Server settings guard firing on the switch to Yours, and axe on the picker, the editor and the page under the light fixture theme. It also checks that Windows 95 turns its skin on (square corners on a button), that the boot script alone brings the skin back on a reload, that picking another theme drops it, and axe under both Windows 95 themes.

`e2e/themed-walk.spec.ts` is the light-theme walk: it seeds the light fixture theme, serves invented search, library, player and queue data (`search-fixtures.ts`, `library-fixtures.ts`, `queue-fixtures.ts`, plus a restored two-song queue so the footer player shows), and visits every route on Chromium at 1280x800 and on the phone project at 390x844. On each it checks that the page, the sidebar or bottom bar, the player and the first card or panel no longer paint the default theme's colors, runs axe, and attaches a full-page screenshot. The page's own background is on `html`, not `body`, so it reads the nearest ancestor that paints one. Look at the screenshots in the report after a styling change: a dark patch on the light theme is a color that escaped the tokens.

### Class locators

Prefer a role, label or `data-ui` locator. These class hooks are the ones the suite still uses, kept because the element has no role or name that picks it out on its own, or because the test measures the box itself. Each is a bare class on its element with no rule behind it, unless noted, so renaming one means updating the spec in the same change:

- Shell: `.sidebar` (the bottom bar's box on a phone), `.nav-badge`, `.save-bar`, `footer.live-player` (also carries the phone seek bar rules), `audio.preview-audio`, `audio.library-audio`.
- Search and album: `.track-row`, `.explicit`, `.album-actions`, `.download-target`, `.virtual-list` (also the handwritten list height rule, and `.queue-sheet .virtual-list` shortens it inside the sheet).
- Downloads: `.job-card` and its stage class, `.download-tabs`.
- Library: `.library-grid`, `.library-card`, `.library-card-play`, `.library-card-copy`, `.library-artist-card`, `.library-artist-heading`, `.library-detail`, `.library-count`, `.library-list-row`, `.library-list-open`, `.library-list-actions`, `.library-tracks`, `.library-track-row`, `.library-track-play`, `.playlist-add-list`.
- Playlist picker: `.playlist-picker-row`, `.playlist-picker-songs`.
- Now Playing: `.stage`, `.stage-top`, `.stage-controls` (only in full screen and the popout), `.stage-overlay`, `img.stage-art`, `canvas.stage-visualizer`, and `.popout-body` in the popout. `.stage` and `.popout-body` also carry the fullscreen and popout rules, and the idle hook finds `.stage-overlay` too.
- Settings and Diagnostics: `.readiness-panel`, `.readiness-item`, `.readiness-badge`, `.health-strip`.

`e2e/phone.spec.ts` runs on the mobile project only and covers the phone layout: the five library tabs and five download tabs each fit one row at 360px, the mini player is one row that hands shuffle, repeat and add to playlist to Now Playing, the Settings save bar and the active download count both clear the bottom bar, touch targets are 44px with no text control under 16px (which would make iOS Safari zoom), the format choice sits in the download options popover, the artist download selection is a bottom sheet, and Your settings keeps its color editor in one column inside a 360px screen with the last control clear of the bottom bar. The preview, playlist picker and player checks in the other specs branch on `isMobile` where the phone player hides a control.

Unit test files: `frontend/src/lib/cx.test.ts`, `frontend/src/no-raw-colors.test.ts`, `frontend/src/features/player/player.test.ts`, `frontend/src/ui/class-names.test.ts`, `frontend/src/theme/color.test.ts`, `frontend/src/theme/contrast.test.ts`, `frontend/src/theme/schema.test.ts`, `frontend/src/theme/store.test.ts`, `frontend/src/theme/themes.test.ts`, `frontend/src/features/visualizer/visualizer-presets.test.ts`. The theme five cover the stored and imported theme schema, the built-in registry against the `@theme` block in `style.css`, the WCAG contrast maths, the pairs the theme editor reports (every built-in theme must pass all of them), the skins a built-in names, and the properties handed to the boot script. The visualizer's covers the preset list's default and stepping.

Test files: `tests/test_activity.py`, `tests/test_archive.py`, `tests/test_artist_downloads.py`, `tests/test_downloads.py`, `tests/test_enrichment.py`, `tests/test_errors.py`, `tests/test_foundation.py`, `tests/test_links.py`, `tests/test_player.py`, `tests/test_podcasts.py`, `tests/test_reliability.py`, `tests/test_search.py`, `tests/test_sources.py`, `tests/test_worker.py`, `tests/test_music_bot.py`, `tests/test_music_bot_audio.py`, `tests/test_audio_profile.py`, `tests/test_audio_worker.py`, and `worker/tests/test_recipe.py` in the worker's own environment.

`tests/test_archive.py` covers the Internet Archive from canned yt-dlp info dicts, so it never touches the network: `archive.org` and `www.archive.org` are accepted and look-alikes (`archive.org.example.com`, `web.archive.org`, a user or port in the address) are not; a track in several formats is listed once and the FLAC copy is the one kept; the item's creator, title, date and track order become tags, through the resolver and on to the queued job; yt-dlp's own format selector, run on canned formats, picks FLAC and otherwise the original; and the probe's site list names a real allowed site for every entry, agrees with the site's format, and leaves out the PO token argument for anything but YouTube. `tests/test_links.py` covers the pasted-link road, the tag cleanup before the Deezer lookup, the tag note staying out of `warnings`, and the cover picked from a thumbnail list.

The report links screenshots, video and traces. CI also retains JUnit output, container logs, API benchmarks and coverage XML for 14 days. Linux CI starts PulseAudio with a virtual output so Firefox can decode and play audio without physical speakers. The benchmark's release gate remains deliberately incomplete; ordinary CI checks only measurements the script implements.

## Reliability and indexing checks

Run these opt-in checks from the repository root. They create temporary fixtures and remove their own files afterward. FFmpeg is required. The recovery check also needs Docker and the `musimo:ci` image built with the isolated Compose file above.

```sh
uv run python -m scripts.reliability_smoke --output runtime/batch-check.json
uv run python -m scripts.recovery_smoke --output runtime/recovery-check.json
uv run python -m scripts.index_benchmark --files 50000 --output runtime/index-check.json
uv run python -m scripts.match_benchmark --output runtime/match-benchmark.json
```

The batch check uses generated audio and mock catalog metadata with real worker processes. It verifies duplicate album requests, pause/termination, saved state after reopening SQLite, a transient failure followed by automatic retry, written tags, artifact hashes and ownership after all 12 files finish. Its elapsed time excludes provider downloads.

The recovery check creates its own Docker container, temporary database/music mounts and a random loopback port. It seeds twelve generated 30-second clips, kills the container while work is active, and verifies that the same jobs finish as MP3 after restart, without duplicate files or missing index entries. It removes only its own container and temporary mounts. `--image` can select a separately built test image.

The index benchmark generates distinct title tags in 50,000 short WAVs, in folders of 50 files. It measures one cold tag scan, two unchanged-file scans and 50 batched ownership lookups. This exercises actual files, Mutagen and SQLite, but is not representative of a mixed personal library or a Windows bind mount. `--directory` selects the parent for the temporary library. To reproduce Linux timings, mount `scripts` read-only into a disposable image, set `PYTHONPATH=/app`, and run `/checks/index_benchmark.py` with an output mount.

The match benchmark evaluates the current resolver against the saved [public review corpus](evidence/match-review-corpus.json). It reports linked-reference retrieval separately from accuracy because another upload may contain the same recording. Accuracy stays NOT MEASURED until an independent listener labels every case using the [review method](match-review.md). Add `--release` to make missing labels, fewer than 100 cases or duplicate recording IDs fail the command.

`scripts/download_smoke.py` has three opt-in cases beside each other, chosen with `--case wikimedia|link|bandcamp|all` (the default is all). Give it a dedicated writable test root:

```sh
uv run python -m scripts.download_smoke /path/to/test-root --case link
```

`wikimedia` is the public-domain transport fixture: a downloaded file goes into the regular resume, tag and publish path. `link` takes the whole pasted-link road for one Internet Archive track (the Open Goldberg Variations, a CC0 release of Bach's Goldberg Variations; the reasons it is safe are in `scripts/source_probe_sites.json`). It resolves the item with the real resolver process and expects one entry per track, queues the entry for "Variatio 4 a 1 Clav." (the shortest, under 2 MB), downloads it with the real worker, then checks the tags in the file (artist, album, date, title and track 5 of 32) and that the library index holds it. The Deezer step of the tidy-up runs against a stub that finds nothing, so the written tags are the item's own whatever the catalog holds that day. The Archive's cover is fetched for real, so the job has no cover warning. It needs network access to `archive.org` and fails without it.

`bandcamp` resolves an album of Chris Zabriskie's Short Songs (Creative Commons Attribution 4.0, 60 tracks of 60 seconds), queues track 3 and downloads it with the real worker. It checks the title, artist, album artist, album, date, track 3 of 60 and that the FLAC carries a cover, and that the library indexes it under that artist. It needs network access to `bandcamp.com` and fails without it. The Deezer catalog answers from a stub that finds nothing, and every other request, covers included, goes to the real site.

`scripts/source_probe.py --site-list` makes one attempt against one public URL per allowed site that has a licensed recording, from `scripts/source_probe_sites.json` (Mixcloud, NTS, HearThisAt, BBC Sounds and TuneIn have none, and a test names them), and writes the same report as a single-URL run (with a `site` on each row). `--only <source>` limits it to one site. Each entry gives its own yt-dlp format and says why the item is safe to use; the PO token argument goes only to YouTube URLs. The YouTube entry needs the PO token provider, so outside the container run it with `--only archive`. Results go into [measurements](measurements.md).

The Wikimedia case stays as it was. To verify the library's watcher, run a separate the library instance watching that root with its own data directory and loopback port, then confirm the written title/artist in that instance's index. Do not point these checks at the live library or restart its services.

## GitHub checks

Workflows run only by manual dispatch (Actions, pick the workflow, Run workflow), so pushes, pull requests and spam PRs from forks start no runs. The [local hooks](#local-checks) run the same checks before code leaves your machine. `CI required` still summarises a manual CI run: it fails if Python, frontend, Docker/browser or dependency checks fail or are cancelled. Manual runs have read-only default permissions and no persistent Git credentials. Actions are pinned to upstream commit SHAs; Dependabot opens update PRs. See [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

CodeQL scans Python, JavaScript/TypeScript and Actions when dispatched by hand. Dependency review only runs on pull request events, so it is idle while CI is manual. Python runtime dependencies are audited for known vulnerabilities; npm includes development dependencies and fails at high severity. Dependabot provides ongoing update notifications. Fix findings through reviewed PRs rather than adding blanket audit ignores.

`scripts/check.sh full` verifies that the Python runtime export matches the uv lock:

```sh
uv export --locked --no-header --no-dev --no-emit-project --format requirements-txt --output-file requirements.lock
```

Main requires a pull request and resolved review conversations. Its ruleset blocks deletion and force pushes. It no longer requires status checks or CodeQL results, because nothing runs them automatically. No actor has a bypass. A second maintainer's approval is optional while the project has one maintainer.

Dependency changes include manifests, locks and exports in the same PR. Required status names and protection are maintained on GitHub; update those settings before renaming a required job. There is no automatic merge, release or container publication workflow.

The initial CodeQL review led to allowlisted static filenames and download destinations. Requests cannot select files outside the built frontend or cause arbitrary destination paths to be resolved. Root public files are discovered at startup; dynamic assets remain under `/assets`.

Playback reads files from the music folders. There is no separate playback server and no authentication token for one.
