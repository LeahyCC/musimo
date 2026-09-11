# Testing and CI

Run these commands from the repository root. Python 3.14 is the container runtime; CI also tests Python 3.12 compatibility. Node 26 builds the frontend. Install FFmpeg and ffprobe for the generated-audio tests. CI installs them so those tests cannot silently disappear from its coverage.

PRs [#1](https://github.com/LeahyCC/musimo/pull/1) and [#2](https://github.com/LeahyCC/musimo/pull/2) were integrated into `fix/download-reliability` on 7 September 2026. Their original CI failures were the Firefox playback check on an older base; the branch includes the subsequent fixture-path and Linux audio-output fixes. Node 26 is currently the Current release, with LTS scheduled for October ([Node release note](https://nodejs.org/en/blog/release/v26.0.0)). It is used for building the frontend and running CI tools; the final server image runs Python.

The combined image built successfully and ran Python 3.14.7. All 41 container tests and 60 browser checks passed (7 September historical counts; PR #29 reported 49 backend and 112 browser tests), as did HTTP/SSE restart, the generated album pause/retry check and the disposable-container SIGKILL recovery check. Both worker checks completed all twelve jobs with no duplicate files. Earlier Python 3.12 measurements remain historical results for that runtime.

## Local checks

```sh
uv sync --locked
npm ci --prefix frontend
uv run ruff check backend tests scripts
uv run ruff format --check backend tests scripts
uv run mypy
uv run coverage run -m unittest discover -s tests -v
uv run coverage report
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run build --prefix frontend
npm run test:e2e:types --prefix frontend
uv run pip-audit --disable-pip --no-deps -r requirements.lock
npm audit --prefix frontend --audit-level=high
```

The unittest suite covers persistence, input validation, origin checks, catalog caching, ownership refresh, job idempotency, queue controls, clearing failed downloads, whole-library track browsing, liked-playlist protection, crash recovery, audio tagging, metadata identification and worker failures. Provider requests use mock HTTP transports. FFmpeg generates audio fixtures. No ordinary test needs a provider account or downloads a recording.

Coverage includes branches and every backend module, including unexecuted modules. The current floor is 70%. Raise it as coverage grows; do not lower it to make a PR pass. Docker smoke and browser checks are additional behavioral checks outside this percentage. Coverage does not establish music-match accuracy or successful provider downloads.

## Browser and container checks

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

Playwright runs Chromium, Firefox, WebKit and a 390px mobile viewport (iPhone 13 on Chromium). Tests cover keyboard search, query/tab/sort persistence, catalog error/retry, saved settings, cross-tab SSE updates, failed saves, queue pause/resume, activity clear, diagnostics export, album ownership, artist selection, library track controls, play-to-pause and resume, artist album dates and sorting, playlist CRUD and the playlist picker, download card layout with failure grouping, infinite scrolling, failure explanations and retry counts, error hint links to settings or diagnostics, done jobs with warnings showing warning counts, ownership badge states (owned, edition, queued, downloaded earlier), destination and format line, the loading transition check and AudioMuse radio, the Now Playing hover and idle stage (Chromium desktop only), axe audits, Settings draft preservation/conflict notice/navigation guard, and the readiness panel with destination write test. They also check real audio decoding, seeking, volume, mute, restart and navigation using generated silence served by the test container, and that long titles and names stay inside download cards, failure chips, playlist cards, the playlist picker and the phone-width filter menus.

Catalog records are invented. Album, cards and download-options specs serve an empty queue through `queue-fixtures.ts`; download-failures mocks the queue; library, playlist, player and popout specs mock `/api/library/*` and `/api/player/*` through `library-fixtures.ts`. Only `app.spec.ts` and `a11y.spec.ts` read the real queue and visit /downloads, /settings and /diagnostics unmocked. Settings, events, diagnostics and queue controls use the real container API and SQLite. Global setup writes only a generated WAV file into the isolated test container. Provider downloads and music-match accuracy still need separate verification.

Tests use one worker because settings and queue controls belong to the installation. CI rejects focused tests and fails tests that pass only on retry. The retry collects evidence without hiding flaky tests. Download the `browser-results` artifact from Actions to inspect a failure, or run:

```sh
npm run test:e2e:report --prefix frontend
```

Spec files: `e2e/a11y.spec.ts`, `e2e/album.spec.ts`, `e2e/app.spec.ts`, `e2e/cards.spec.ts`, `e2e/download-failures.spec.ts`, `e2e/download-options.spec.ts`, `e2e/library-controls.spec.ts`, `e2e/now-playing-popout.spec.ts`, `e2e/phone.spec.ts`, `e2e/player.spec.ts`, `e2e/playlists.spec.ts`, plus support files `e2e/env.ts`, `e2e/library-fixtures.ts`, `e2e/queue-fixtures.ts`, `e2e/setup.ts`.

`e2e/phone.spec.ts` runs on the mobile project only and covers the phone layout: the five library tabs and four download tabs each fit one row at 360px, the mini player is one row that hands shuffle, repeat and add to playlist to Now Playing, the Settings save bar and the active download count both clear the bottom bar, touch targets are 44px with no text control under 16px (which would make iOS Safari zoom), the format choice sits in the download options popover, and the artist download selection is a bottom sheet. The preview, playlist picker and player checks in the other specs branch on `isMobile` where the phone player hides a control.

Test files: `tests/test_activity.py`, `tests/test_artist_downloads.py`, `tests/test_downloads.py`, `tests/test_enrichment.py`, `tests/test_errors.py`, `tests/test_foundation.py`, `tests/test_player.py`, `tests/test_reliability.py`, `tests/test_search.py`, `tests/test_worker.py`.

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

The existing `scripts/download_smoke.py` remains the opt-in Wikimedia public-domain transport fixture. Give it a dedicated writable test root. To verify Navidrome's watcher, run a separate Navidrome instance watching that root with its own data directory and loopback port, then confirm the written title/artist in that instance's index. Do not point these checks at the live library or restart its services.

## GitHub checks

`CI required` is the stable merge gate. It fails if Python, frontend, Docker/browser or dependency checks fail or are cancelled. Workflows run on pull requests, main pushes and manual dispatch. Fork PRs run without repository secrets, with read-only default permissions and without persistent Git credentials. Actions are pinned to upstream commit SHAs; Dependabot opens update PRs. See [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

CodeQL scans Python, JavaScript/TypeScript and Actions on PRs, main pushes and weekly. Dependency review rejects new high/critical vulnerabilities in PRs. Python runtime dependencies are audited for known vulnerabilities; npm includes development dependencies and fails at high severity. Dependabot provides ongoing update notifications. Fix findings through reviewed PRs rather than adding blanket audit ignores.

CI verifies that the Python runtime export matches the uv lock:

```sh
uv export --locked --no-header --no-dev --no-emit-project --format requirements-txt --output-file requirements.lock
```

Main requires a pull request and resolved review conversations. Its ruleset blocks deletion and force pushes. It requires an up-to-date branch, `CI required`, the three CodeQL jobs and the CodeQL security-finding gate. No actor has a bypass. A second maintainer's approval is optional while the project has one maintainer.

Dependency changes include manifests, locks and exports in the same PR. Required status names and protection are maintained on GitHub; update those settings before renaming a required job. There is no automatic merge, release or container publication workflow.

The initial CodeQL review led to allowlisted static filenames and download destinations. Requests cannot select files outside the built frontend or cause arbitrary destination paths to be resolved. Root public files are discovered at startup; dynamic assets remain under `/assets`.

The Navidrome scan integration has one documented hashing exception: [Subsonic authentication](https://www.subsonic.org/pages/api.jsp) requires `MD5(password + salt)` for its request token. Musimo uses a fresh random salt for each call and does not store that token as a password hash. Replacing the algorithm would break the protocol. This exception applies only to that token calculation, not other hashing or password storage.
