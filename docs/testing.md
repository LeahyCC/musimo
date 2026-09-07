# Testing and CI

Run these commands from the repository root. Python 3.12 is the container runtime; CI also tests Python 3.14. Node 24 builds the frontend. Install FFmpeg and ffprobe for the generated-audio tests. CI installs them so those tests cannot silently disappear from its coverage.

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

The unittest suite covers persistence, input validation, origin checks, catalog caching, ownership refresh, job idempotency, queue controls, crash recovery, audio tagging, metadata identification and worker failures. Provider requests use mock HTTP transports. FFmpeg generates audio fixtures. No ordinary test needs a provider account or downloads a recording.

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

The explicit Compose file, project name, port 18765 and named test volumes keep these checks separate from a running installation. They do not mount host music or load `compose.override.yaml`. Cleanup removes only this test project's containers and volumes. Run smoke and browser tests sequentially because both change installation settings. Start the test server before Playwright.

Playwright runs Chromium, Firefox, WebKit and a 390px mobile viewport. Tests cover keyboard search, query/tab/sort persistence, catalog error/retry, saved settings, cross-tab SSE updates, failed saves, queue pause/resume, activity clear, diagnostics export, album ownership and artist selection. They also check real audio decoding, seeking, volume, mute, restart and navigation using generated silence served by the test container.

Catalog records are invented. Batch responses are mocked to verify UI requests and feedback; Python API tests cover real batch semantics. Settings, events, diagnostics and queue controls use the real container API and SQLite. Global setup writes only a generated WAV file into the isolated test container. Provider downloads and music-match accuracy still need separate verification.

Tests use one worker because settings and queue controls belong to the installation. CI rejects focused tests and fails tests that pass only on retry. The retry collects evidence without hiding flaky tests. Download the `browser-results` artifact from Actions to inspect a failure, or run:

```sh
npm run test:e2e:report --prefix frontend
```

The report links screenshots, video and traces. CI also retains JUnit output, container logs, API benchmarks and coverage XML for 14 days. The benchmark's release gate remains deliberately incomplete; ordinary CI checks only measurements the script implements.

## GitHub checks

`CI required` is the stable merge gate. It fails if Python, frontend, Docker/browser or dependency checks fail or are cancelled. Workflows run on pull requests, main pushes and manual dispatch. Fork PRs run without repository secrets, with read-only default permissions and without persistent Git credentials. Actions are pinned to upstream commit SHAs; Dependabot opens update PRs. See [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

CodeQL scans Python, JavaScript/TypeScript and Actions on PRs, main pushes and weekly. Dependency review rejects new high/critical vulnerabilities in PRs. Python runtime dependencies are audited for known vulnerabilities; npm includes development dependencies and fails at high severity. Dependabot provides ongoing update notifications. Fix findings through reviewed PRs rather than adding blanket audit ignores.

CI verifies that the Python runtime export matches the uv lock:

```sh
uv export --locked --no-header --no-dev --no-emit-project --format requirements-txt --output-file requirements.lock
```

Dependency changes include manifests, locks and exports in the same PR. Required status names and protection are maintained on GitHub; update those settings before renaming a required job. There is no automatic merge, release or container publication workflow.
