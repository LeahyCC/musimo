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
npm run test --prefix frontend
npm run build --prefix frontend
npm run test:e2e:types --prefix frontend
uv run pip-audit --disable-pip --no-deps -r requirements.lock
npm audit --prefix frontend --audit-level=high
```

The unittest suite covers persistence, input validation, origin checks, catalog caching, ownership refresh, job idempotency, queue controls, clearing failed downloads, whole-library track browsing, liked-playlist protection, crash recovery, audio tagging, metadata identification and worker failures. Provider requests use mock HTTP transports. FFmpeg generates audio fixtures. No ordinary test needs a provider account or downloads a recording.

`npm run test` runs the frontend unit tests with Vitest. They live next to the module they cover as `frontend/src/**/*.test.ts`, run in Node without a browser, and are for pure TypeScript: maths, formatting and transforms. Anything that needs the DOM, audio or a real browser belongs in the Playwright suite below.

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

Playwright runs Chromium, Firefox, WebKit and a 390px mobile viewport (iPhone 13 on Chromium). Tests cover keyboard search, query/tab/sort persistence, catalog error/retry, saved settings, cross-tab SSE updates, failed saves, queue pause/resume, activity clear, diagnostics export, album ownership, artist selection, library track controls, artist filters and favourites, play-to-pause and resume, artist album dates and sorting, podcast search with episode queueing, playlist CRUD and the playlist picker, download card layout with failure grouping, infinite scrolling, failure explanations and retry counts, error hint links to settings or diagnostics, done jobs with warnings showing warning counts, a link job's tag note showing as plain text on the card without counting as a warning, ownership badge states (owned, edition, queued, downloaded earlier), destination and format line, the loading transition check, the Now Playing hover and idle stage (Chromium desktop only), the visualizer's artwork fallback without WebGPU and its view toggle where an adapter exists, axe audits, Settings draft preservation/conflict notice/navigation guard, and the readiness panel with destination write test. They also check real audio decoding, seeking, volume, mute, restart and navigation using generated silence served by the test container, and that long titles and names stay inside download cards, failure chips, playlist cards, the playlist picker and the phone-width filter menus.

Catalog records are invented. Album, cards, download-options and podcasts specs serve an empty queue through `queue-fixtures.ts`; download-failures mocks the queue; library, playlist, player and popout specs mock `/api/library/*` and `/api/player/*` through `library-fixtures.ts`. Only `app.spec.ts` and `a11y.spec.ts` read the real queue and visit /downloads, /settings and /diagnostics unmocked. Settings, events, diagnostics and queue controls use the real container API and SQLite. The test container's music mount is not writable by the app user, and the review sheets keep Download off for a folder that cannot be written to, so a spec that queues from a sheet calls `writableDestination` in `queue-fixtures.ts` to report the saved destination as writable. Global setup writes only a generated WAV file into the isolated test container. Provider downloads and music-match accuracy still need separate verification.

A test that touches the Now Playing stage must pin the view rather than let the machine decide it. The stage shows the visualizer wherever WebGPU has an adapter and the artwork where it does not, so the same test lands on a different view headless and headed. `now-playing-popout.spec.ts` sets `musimo.now-playing-view` before the page loads; `visualizer.spec.ts` either removes `navigator.gpu` or presses V. Unpinned, the two selectors fail in opposite directions, which is why neither is safe to assert on bare: headless has no adapter, so `img.stage-art` passes in CI and fails on a real machine, while `canvas.stage-visualizer` does the reverse and fails in CI.

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
- Now Playing: `.stage`, `.stage-top`, `.stage-controls` (only in full screen and the popout), `.stage-overlay`, `img.stage-art`, `canvas.stage-visualizer`, `canvas.stage-hud`, and `.popout-body` in the popout. `.stage` and `.popout-body` also carry the fullscreen and popout rules, and the idle hook finds `.stage-overlay` too.
- Settings and Diagnostics: `.readiness-panel`, `.readiness-item`, `.readiness-badge`, `.health-strip`.

`e2e/phone.spec.ts` runs on the mobile project only and covers the phone layout: the five library tabs and four download tabs each fit one row at 360px, the mini player is one row that hands shuffle, repeat and add to playlist to Now Playing, the Settings save bar and the active download count both clear the bottom bar, touch targets are 44px with no text control under 16px (which would make iOS Safari zoom), the format choice sits in the download options popover, the artist download selection is a bottom sheet, and Your settings keeps its color editor in one column inside a 360px screen with the last control clear of the bottom bar. The preview, playlist picker and player checks in the other specs branch on `isMobile` where the phone player hides a control.

Unit test files: `frontend/src/cx.test.ts`, `frontend/src/no-raw-colors.test.ts`, `frontend/src/player.test.ts`, `frontend/src/ui/class-names.test.ts`, `frontend/src/theme/color.test.ts`, `frontend/src/theme/contrast.test.ts`, `frontend/src/theme/schema.test.ts`, `frontend/src/theme/store.test.ts`, `frontend/src/theme/themes.test.ts`. The theme five cover the stored and imported theme schema, the built-in registry against the `@theme` block in `style.css`, the WCAG contrast maths, the pairs the theme editor reports (every built-in theme must pass all of them), the skins a built-in names, and the properties handed to the boot script. The visualizer's seven went with it into [visimo](https://github.com/LeahyCC/visimo) and run there.

Test files: `tests/test_activity.py`, `tests/test_archive.py`, `tests/test_artist_downloads.py`, `tests/test_downloads.py`, `tests/test_enrichment.py`, `tests/test_errors.py`, `tests/test_foundation.py`, `tests/test_links.py`, `tests/test_player.py`, `tests/test_podcasts.py`, `tests/test_reliability.py`, `tests/test_search.py`, `tests/test_sources.py`, `tests/test_worker.py`.

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

The Wikimedia case stays as it was. To verify Navidrome's watcher, run a separate Navidrome instance watching that root with its own data directory and loopback port, then confirm the written title/artist in that instance's index. Do not point these checks at the live library or restart its services.

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
