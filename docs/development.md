# Developing Musimo

Working on Musimo itself: local setup, the checks every change runs, and how the pieces fit together. Read [Contributing](../CONTRIBUTING.md) first.

## Development and checks

For a native Windows installation, follow the [Windows setup guide](windows.md), including the launcher and download helper setup.

Checks run locally: `npm ci --prefix frontend` installs git hooks that run `scripts/check.sh` before each commit and push, and GitHub Actions only runs by hand. Use Python 3.12 or 3.14, Node 26 and uv. Dependencies are locked in `uv.lock` and `frontend/package-lock.json`. See [Testing and CI](testing.md) for isolated browser tests, coverage and required checks.

```sh
uv sync --locked
npm ci --prefix frontend
npm run build --prefix frontend
```

For frontend development:

```sh
docker compose up -d --build --wait
npm run dev --prefix frontend
```

Open Vite's printed address. Its `/api` proxy targets localhost port 8765. Set `MUSIMO_API_TARGET` to use another backend, for example a Musimo on another machine on your network whose `MUSIMO_BIND` lets you reach it, or one behind Tailscale Serve or a reverse proxy over https:

```sh
MUSIMO_API_TARGET=http://other-machine:8765 npm run dev --prefix frontend
MUSIMO_API_TARGET=https://other-machine.tailnet.ts.net npm run dev --prefix frontend
```

Writes through the proxy (saving the queue, scrobbles, settings) work in both cases: over http the browser's Host goes through unchanged, and over https the proxy presents the target's own origin.

For Python work outside Docker, install the worker tools if needed, and set `MUSIMO_DATA_DIR`, `MUSIMO_LIBRARY_ROOTS` and `MUSIMO_STATIC_DIR` to isolated absolute paths:

```sh
uv run python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --reload
```

Build the frontend if Python should serve it. Root lists use the host path separator: semicolon on Windows, colon on Linux. Use one application worker; the scheduler and source budgets are process-local. Test against generated fixtures, not irreplaceable collections.

Required checks:

```sh
uv run ruff check backend tests scripts
uv run ruff format --check backend tests scripts
uv run mypy
uv run coverage run -m unittest discover -s tests
uv run coverage report
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
npm run test:e2e:types --prefix frontend
```

Relevant live checks against an isolated Compose setup:

```sh
uv run python scripts/smoke.py --restart
uv run python scripts/search_smoke.py
uv run python scripts/watcher_smoke.py
uv run python scripts/benchmark.py
```

The restart smoke test restarts this project's container and briefly changes/restores its label. Search smoke uses live catalog/preview endpoints. Watcher smoke generates and removes a one-second audio fixture in the test mount. Read scripts before changing their target.

The benchmark distinguishes measured values from unfinished checks. Its `--release` gate intentionally fails when acceptance work is incomplete. A green build is not a completed release benchmark.

After Python dependency changes, regenerate the runtime export:

```sh
uv export --no-dev --no-emit-project --no-header --format requirements-txt --output-file requirements.lock
```

Commit the manifest and relevant locks/exports together. Prettier formats frontend/YAML/Markdown; Ruff formats Python. See [Contributing](../CONTRIBUTING.md).

## Architecture and API

```text
Browser
  | same-origin HTTP + one event stream
FastAPI
  |-- catalog cache -> metadata and preview providers
  |-- library index -> music folders
  |-- scheduler -> worker -> staging -> music folders
  `-- SQLite -> settings, cache, index, jobs and events
```

The backend serves frontend and API on one origin. SQLite uses WAL and a serialized writer. Events have increasing IDs and bounded replay; expired cursors trigger a snapshot refresh.

API groups:

- Health/settings: `/api/health`, `/api/settings` GET and PATCH, `/api/youtube-cookies` PUT and DELETE, `/api/snapshot`.
- Search: `/api/search`, `/api/album-years`, `/api/albums/{id}`, `/api/artists/{id}`, `/api/artists/{id}/top`, `/api/preview/{id}`.
- Index: `/api/library` GET, `/api/library/scan` POST, `/api/library/cancel` POST.
- Player: `/api/player/capabilities`, `/api/player/song/{id}`, `/api/player/queue` GET and PUT, `/api/player/scrobble`, `/api/player/lyrics/{id}`, `/api/player/stream/{id}`, `/api/player/art/{id}`, `/api/player/waveform/{id}`. Album, artist, track and playlist browsing is `/api/library/{albums,artists,tracks,playlists}`. Scan routes stay at `/api/library` GET, `/api/library/scan` and `/api/library/cancel`.
- Music bot: `/api/music-bot/models` GET, `/api/music-bot/chat` POST, `/api/music-bot/validate` POST, `/api/music-bot/capabilities` GET, `/api/music-bot/intent` POST, and the proposal routes `/api/music-bot/proposals` POST, `/api/music-bot/proposals/{id}` GET, `/api/music-bot/proposals/{id}/revisions` POST and `/api/music-bot/proposals/{id}/commit` POST.
- Jobs/batches: `/api/naming-preview`, `/api/jobs` GET and POST, `/api/history`, `/api/batches` POST, `/api/batches/{id}/{pause,resume,cancel,retry}`, `/api/jobs/{id}/pick`, `/api/jobs/{id}/{pause,resume,cancel,retry,dismiss}`, `/api/queue/{pause,resume,cancel-queued,retry-failed,clear-finished,clear-failed,clear-unmatched,resume-source}`.
- Artist downloads: `/api/artists/{id}/download-plan`, `/api/artist-batches`.
- Podcasts and pasted links: `/api/podcasts`, `/api/podcasts/{id}`, `/api/podcast-episodes` POST, `/api/links/resolve` POST, `/api/links` POST.
- Activity: `/api/activity` GET and DELETE; deletion takes the observed `through` cursor.
- Operations: `/api/events`, `/api/diagnostics`, `/api/diagnostics/test/deezer`, `/api/diagnostics/test/destination`, `/api/diagnostics/export`.

Contracts can change before a stable release. The live schema is at `/openapi.json`; interactive Swagger/Redoc pages are disabled. Read [architecture](architecture.md), [search/indexing](search.md) and source for detailed behavior.

Repository layout:

```text
backend/          API, state, catalog, indexing and download services
  main.py         app setup, middleware and serving the built frontend
  api/            every route module, one per area
  core/           SQLite store, settings and job models, errors, file naming, the site
                  allowlist, text normalizing, secret files
  jobs/           the download pipeline: queue, worker, yt-dlp options, matching, tagging,
                  publishing files, pasted links
  library/        local file index, the player, browse filters, the Navidrome importer
                  and seek bar waveforms
  integrations/   Deezer catalog and audio, MusicBrainz, podcast directory, saved cookies
frontend/src/     React screens, player, queue and shared UI
  main.tsx        mounts the app
  api.ts          every backend call and the zod schema it is read with
  app/            shell, routes, live events, command palette
  features/       one folder per screen or engine: search, library, downloads, links,
                  podcasts, player, now-playing, visualizer, music-bot, settings,
                  diagnostics
  components/     pieces more than one screen uses
  ui/             primitives: Button, Panel, Field and the rest
  theme/          color tokens, built-in themes, the theme store
  lib/            small helpers and hooks
scripts/          smoke tests and benchmarks
tests/            regression tests
docs/             setup, behavior, evidence and proposals
.github/          checks, contribution templates and ownership
```
