<div align="center">

# musimo

### Your music, at home.

A self-hosted music library companion for Navidrome.

Search tracks, albums, and artists. Hear previews, check your local collection, and queue permitted downloads into your music folders.

[Quick start](#quick-start) · [Features and limits](#features-and-limits) · [Architecture](#architecture-and-api) · [Contributing](#contributing-and-support)

<img src="docs/assets/musimo.png" alt="Musimo search screen with library-aware search and the preview player" width="100%" />

</div>

Musimo keeps discovery close to the library you already own. React provides the interface, FastAPI runs the backend, and SQLite stores settings, the library index, and jobs. Docker Compose builds the app from this repository. No Musimo account or hosted Musimo service is required.

> [!WARNING]
> Musimo is in early development. Search, indexing, download workers, queue controls, album batches, library playback and playlists are implemented, but the project is not a stable release. Read [download verification](docs/downloads.md) and [measurements](docs/measurements.md). The original [brief](docs/brief.md) describes ambitions, not shipped capability.

## Contents

- [Features and limits](#features-and-limits)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Music folders and permissions](#music-folders-and-permissions)
- [Using Musimo](#using-musimo)
- [Audio quality and metadata](#audio-quality-and-metadata)
- [Navidrome](#navidrome)
- [Configuration](#configuration)
- [Backups and updates](#backups-and-updates)
- [Network access and privacy](#network-access-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development and checks](#development-and-checks)
- [Architecture and API](#architecture-and-api)
- [Contributing and support](#contributing-and-support)
- [Licence and permitted use](#licence-and-permitted-use)

## Features and limits

Search and library features:

- Deezer catalog search with Top, Tracks, Albums and Artists views.
- Typeahead, independent result sections, pagination, filters and sorting.
- Search state in the URL, so refresh and browser Back preserve the query.
- Album pages and artist discographies grouped by catalog release type.
- Automatic album coverage checks, with a count and progress bar.
- A persistent index of audio tags. Search does not reopen music files to check coverage.
- One player across navigation for catalog previews and full Navidrome tracks.
- Navidrome library browsing for albums, artists, tracks and playlists, with playlist CRUD, a saved queue, media controls, lyrics, scrobbling, shuffle and repeat.
- A linked liked playlist, thumbs up button, add to playlist picker with inline creation and the artist All songs subpage with a popularity chart.
- Server side Tracks view filters by search, genre, year and sort order.
- LRCLIB lyric fallback when Navidrome has no imported lyrics.
- Now Playing full screen and popout stage for library tracks.
- Optional AudioMuse radio through Navidrome's `sonicSimilarity` extension.
- Background scans, scan cancellation, native or polling watchers and diagnostics.
- A bounded activity feed in Settings and Diagnostics, with persistent clearing.

The download implementation provides persistent track jobs, progress, pause/resume/cancel/retry, alternate-match selection, history, failure explanations with plain language messages, per card and bulk Clear failed, failure grouping by download group and infinite scrolling for results and history. Album card actions queue missing tracks using Settings defaults. External-source availability and the complete file-to-Navidrome journey still require validation for your setup.

These are **not finished features**: personalized Discover, automatic release-edition filters, pasted links/playlists, paid audio sources, notifications, cookie management, built-in login, multiple users and the full release benchmark suite. See [Discover planning](docs/discover.md) and [the roadmap](docs/roadmap.md).

## Requirements

The supported deployment uses Docker Engine with the Compose plugin, or Docker Desktop running Linux containers. You need a recent browser with JavaScript, HTML audio and Server-Sent Events support. The Now Playing popout requires Document Picture in Picture API support, available in desktop Chrome and Edge.

Catalog queries, artwork, previews and enabled sources require internet access. Keep application state on local disk. The music destination needs room for temporary and final files, and the runtime user needs permission to read indexed folders and write to the selected destination.

Navidrome is a separate application. It is optional for search, previews and indexing, and is not included in Compose. No minimum CPU/RAM or maximum library-size guarantee has been established by the full release benchmarks.

The main image includes Python, FFmpeg, Deno, Chromaprint tools and Python dependencies. Host installations of these tools are unnecessary when using Docker. An optional YouTube helper runs as a second container.

## Quick start

Want help with the whole installation? Copy the [setup handoff prompt](docs/setup-handoff.md) into an LLM with access to your computer. It covers music folders, verification, optional Navidrome and private remote access.

```sh
git clone https://github.com/LeahyCC/musimo.git
cd musimo
docker compose up -d --build --wait
```

Open [Musimo](http://127.0.0.1:8765). The initial build can take several minutes.

If Musimo is useful, [star it on GitHub](https://github.com/LeahyCC/musimo).

If you want to support the people who make music possible, [Donate to MUSICARES](https://www.musicares.org/).

1. Search for an artist or track. Catalog access needs no credentials.
2. Open Settings and inspect the library paths and download destination.
3. Mount your collection using the instructions below, then scan it.
4. Preview a result and check its library badge.
5. For a download test, use material you have permission to obtain.

The default music mount is `./runtime/music`, an isolated test folder within the checkout. It does not automatically find your existing collection. SQLite lives in the `musimo-data` named volume.

For the worker's optional YouTube helper:

```sh
docker compose --profile youtube up -d --build --wait
```

The helper and Python plugin use matching pinned versions. Starting them does not guarantee that a source accepts requests. See [YouTube troubleshooting](docs/youtube-troubleshooting.md).

Useful health checks:

```sh
docker compose ps
docker compose logs --tail 100 musimo
curl http://127.0.0.1:8765/api/health
```

Health means the app and database respond. It does not mean every provider works or a file is visible in Navidrome.

## Music folders and permissions

Settings uses **container paths**. Docker mounts connect those to host folders. A library label does not mount, move or rename files.

Create an ignored `compose.override.yaml`. This example indexes a read-only collection and downloads into a separate writable folder:

```yaml
services:
  musimo:
    environment:
      MUSIMO_LIBRARY_ROOTS: /music:/collection
    volumes:
      - type: bind
        source: /absolute/host/music-incoming
        target: /music
      - type: bind
        source: /absolute/host/existing-music
        target: /collection
        read_only: true
```

Replace both host paths with real, existing folders. The `/music` target replaces the base Compose test-folder bind during the merge. Check the result:

```sh
docker compose config
docker compose up -d --wait
```

The merged output may contain environment values. Redact it before sharing.

Add further mounts and list their Linux paths in `MUSIMO_LIBRARY_ROOTS`, separated by colons. Only configured roots can receive downloads. Give Navidrome access to the same host folder if it should play these files.

### Windows and network mounts

Use Compose's long bind syntax and quote a verified absolute Windows source path. Drive letters differ between machines and can change. Do not copy a machine-specific override without checking its paths.

For Windows Docker Desktop binds or network shares that do not deliver filesystem events, set these values in `.env`:

```dotenv
MUSIMO_WATCH_MODE=poll
MUSIMO_POLL_INTERVAL_SECONDS=60
```

Shorter polling intervals use more CPU. Both modes also reconcile periodically. Keep SQLite on the local named volume, not SMB/NFS. Music mounts can be network folders, subject to their permissions and filesystem behavior.

### File permissions

`PUID` and `PGID` default to `1000`. On Linux, choose non-root IDs with access to the mounted folders. The entrypoint adjusts the application data directory and database files, then drops privileges. It does not recursively change ownership of music folders.

Read-only mounts contribute to coverage but cannot receive downloads. Diagnostics shows existence, free space and a permission check. Workers check their destination too. Neither check guarantees a later write will succeed if permissions, free space or the mount change.

## Using Musimo

### Search and album coverage

Enter at least two characters. Search waits about 200 ms after typing and cancels superseded browser requests. Top requests tracks, albums and artists independently.

Filters and sorting apply to **loaded results**, not the entire provider catalog. More results load as you scroll. Unknown years cannot satisfy a year filter. Duration and preview filters apply only to tracks. Long track lists are virtualized; album and artist card grids scroll with the page.

Cards automatically check album details against the local index. Loading shows checking or estimated coverage; complete track lists permit verified counts. Incomplete provider lists stay partial. Failed checks show Retry coverage.

Tracks show distinct badges: "In library" for exact matches, "Another edition in library" when a different album edition is detected, "Queued" for active downloads, and "Downloaded earlier" for completed downloads. Edition matches keep the download button enabled so you can choose to download both versions.

The album download icon queues missing tracks without opening the album. The card shows where files will land and in what format before queueing. It uses the saved format and destination, skips indexed matches and links to the queue after success. A completely indexed album shows a check. Open an album to inspect individual tracks and available album actions. The status line separates owned and queued counts.

Artist release types come from the catalog. A generic album type does not establish whether a recording is live, remixed or a compilation. Library coverage is a file match, not proof of legal rights.

### Card navigation and artist batches

Click an album or artist card to open it. Separate artist links and card controls still work independently. Download sits in the card's top-right corner and appears on hover or keyboard focus; touch screens keep it visible. Card collections scroll with the page.

An artist's **Download all albums** button opens a selection sheet with album/song counts, estimated size, format and destination. Existing library songs are skipped by default, already queued songs are excluded, and you can deselect alternative editions. All album pages are checked before confirmation; singles and EPs are excluded. See [search behavior](docs/search.md#artist-album-downloads).

### Library and playback

Library has Home, Albums, Artists, Tracks and Playlists views. Grid and list layouts are available for collection views and the choice is remembered in the browser under `musimo.library-layout`. The Tracks view offers server side search, genre, year and sort filters that describe the whole library rather than only loaded pages. Its Play all button plays the first 500 songs in the current sort order; Shuffle plays a random 500.

Artist pages include an All songs subpage at `/library/artists/{id}/songs` and a popularity chart plotted from Navidrome play counts when enough data exists. Playlists show song count and can be filtered by public or private status. Inline rename is available for all playlists.

The linked liked playlist is always listed, sorts first, cannot be deleted, and is required for the thumbs up button to work. Its identity is stored in the SQLite table `linked_playlists`. An existing playlist named Liked is adopted when none is stored.

The add to playlist picker appears in the footer player and shows 25 rows with a filter box. The liked playlist is excluded from the picker. Inline New playlist is available with the current song. The Add button toggles to Remove when that song is already in the playlist.

The Now Playing stage offers full screen in the tab and a popout floating window. Both are available for library tracks only; catalog previews show "Nothing playing yet."

### Player controls

Previews are provider clips, not full library playback. Failed Deezer clips refresh their URLs and can fall back to a matching iTunes preview. Some tracks have no playable preview.

- Artwork controls start or pause a preview.
- The player's song title returns to its highlighted track in the album for previews, or links to Now Playing for library tracks.
- Its artist and album names link to their Library pages when playing library tracks, or to the artist page for previews.
- Seek within the clip, restart, mute, adjust volume or close it.
- Volume is remembered in the current browser under `musimo.player-volume`. Mute preserves the chosen level.
- Navigating keeps playback; closing stops audio and cancels a pending lookup.

Library playback adds previous (restarts the current track after 4 seconds of playback), next, shuffle, repeat including repeat one, thumbs up to add or remove from the liked playlist, add to playlist picker, and expand to Now Playing. The queue autosaves every 10 seconds of playback and on pause or close. Now playing scrobbles on play and submits on track end. MediaSession handlers provide play, pause, next and previous for system media controls.

Keyboard controls: `/` focuses search; Ctrl/Cmd+K opens the command palette; Escape closes it. Space toggles playback outside editing fields and interactive controls. Native sliders support keyboard adjustment. Browser autoplay rules can require another press of Play. On the Now Playing stage, F enters full screen, Esc leaves full screen or closes the popout, left and right seek by five seconds, up and down adjust volume, M mutes, and N and P skip tracks. See [Now Playing popout](docs/now-playing-popout.md) for full keyboard reference.

### Downloads and history

Jobs progress through queued, matching, downloading, optional conversion, tagging, moving, scanning and done. Job cards display the destination and format. Low-confidence matches are flagged. Failures retain their stage and error rather than looking like success.

Each failure shows a reason summary with plain language messages. The NO_MATCH message reads "No matching recording was found on YouTube. Nothing was downloaded." Per card attempt counts are shown and reset when retrying. The Failed tab groups failures by download group with reason chips, and offers a bulk Clear failed action. Each finished card also has its own Clear to dismiss it individually. The download arrow on a track becomes Retry with the failure reason in its tooltip.

The floating queue button appears only while a download is active. History and queue load more results on scroll.

Pause/resume and restart recovery depend on the stage and surviving partial files. Cancelling does not remove an already published library file. Clearing finished jobs from the queue is separate from download history.

Validate a new setup by inspecting a permitted test file, its tags and its appearance in Navidrome. A queue acknowledgement confirms submission, not successful publication. Download controls show the destination and format before queueing so you know where files will land. [Measurements](docs/measurements.md) records which acceptance checks have actually passed.

### Recent activity

Settings and Diagnostics show the same scrollable feed. It displays up to 100 recent visible entries. Clear all clears through the snapshot you saw, preserving events that arrive afterward. The clear point survives refresh and restart.

This clears the feed, not music, download history or the bounded live-event replay buffer. It is not a privacy wipe. See [Privacy](PRIVACY.md).

## Audio quality and metadata

`original` is the default. It avoids unnecessary conversion when possible. M4A, Opus and MP3 are also offered. A codec/container mismatch may require remuxing or conversion.

A higher output bitrate cannot recover detail absent from the source. Converting lossy audio into a larger file does not make it lossless. Subscriptions, catalog results and preview URLs do not establish that a permitted full-quality download exists.

Album size figures are estimates from duration and an assumed bitrate. Check the codec and bitrate of the finished file for actual output characteristics.

Tagging uses catalog metadata, artwork and optional MusicBrainz/LRCLIB enrichment. Available fields include titles, artists, album, date, track/disc numbers, genre, label, identifiers and lyrics. Missing or ambiguous data can stay empty; warnings should explain failed optional enrichment. Artwork and lyrics have their own rights and provider conditions.

## Navidrome

Mount the same host music folder into both applications, select it as Musimo's destination, and configure it as a Navidrome library.

The backend supports three modes:

- `off`: no scan integration.
- `watcher`: rely on Navidrome's watcher, which you configure separately.
- `api`: request a Subsonic scan after file publication.

Navidrome must be reachable **from inside the container**. There, `localhost` means Musimo, not the host or another container.

API mode and the player foundation read a mounted JSON credentials file identified by `MUSIMO_NAVIDROME_CREDENTIALS_FILE`. It contains `username` and `password`. Store it outside the checkout, restrict permissions, mount it read-only and prefer a dedicated account. Configure `navidrome_url` and `navidrome_library_id` for the actual server. Never paste credentials into issues or screenshots. See [library player](docs/player.md).

A file can save successfully while a scan request fails. Read its warning and scan Navidrome separately. Watcher-mode visibility has been verified locally with a public-domain fixture. API mode has fixture coverage but still needs a live credentialed check against the chosen server.

## Configuration

Copy `.env.example` to `.env` for Compose deployment values. Both `.env` and `compose.override.yaml` are ignored.

- `MUSIMO_BIND`: host interface, default `127.0.0.1`.
- `MUSIMO_PORT`: host port, default `8765`.
- `PUID`, `PGID`: runtime IDs, default `1000`, both nonzero.
- `MUSIMO_LIBRARY_ROOTS`: container paths, default `/music` in base Compose.
- `MUSIMO_WATCH_MODE`: `native` or `poll`.
- `MUSIMO_POLL_INTERVAL_SECONDS`: polling interval, default `60`.
- `MUSIMO_NAVIDROME_CREDENTIALS_FILE`: optional mounted file for API mode.

Editable settings cover the label, destination, output format, naming template, concurrency, retry limits and Navidrome integration. See [Settings](docs/settings.md) and `backend/models.py` for the current contract.

Setting environment variables are **first-run bootstrap values**. Pass a value such as `MUSIMO_CONCURRENCY=3` through the container's `environment:` block to seed and lock it. Merely adding an arbitrary key to `.env` does not pass it into the container.

Existing database values win on later starts. Removing a bootstrap variable does not unlock its stored setting. The UI/API show the origin and reject writes to locked fields. There is no general unlock UI yet. Do not delete the database to change one preference.

For local development, `MUSIMO_DATA_DIR` and `MUSIMO_STATIC_DIR` select data and built frontend directories. The supported Docker layout keeps application state at `/data`.

## Backups and updates

SQLite stores settings, cached catalog results, indexed tags/paths, jobs/history and events at `/data/musimo.sqlite3`. Download staging lives under `.musimo` within the selected music root, on the same filesystem as publication.

Back up the application volume, music and necessary staging files, private Compose overrides and separately stored credentials. Record the application revision used with each backup.

A simple consistent backup is to stop Musimo, back up the entire application volume and required host folders with your normal backup tool, then start it. Do not copy only a live SQLite main file while omitting its WAL.

Update from a reviewed revision:

```sh
git pull --ff-only
docker compose up -d --build --wait
```

Use the same Compose overrides and optional profiles as installation. Back up before schema changes. `git pull --ff-only` refuses divergence instead of silently merging local edits. A newer database schema may require a matching backup to roll back.

Rebuilds retain named volumes. **Do not add `--volumes` or `-v` to `docker compose down` during an update.** Removing the data volume loses application state. To stop without removal, use `docker compose stop`. Music folders remain your files, not disposable application state.

## Network access and privacy

Loopback is the default. There is no built-in login or separate user permissions. Anyone who can reach an exposed instance may be able to inspect paths, change settings and queue work. Use a trusted network, or authentication and HTTPS at a reverse proxy before broader access. Do not expose a bare unauthenticated port publicly.

Keep UI/API on the same origin. [Reverse proxy instructions](docs/reverse-proxy.md) cover SSE buffering, timeouts and trusted forwarded headers. Those examples do not install authentication.

Self-hosted does not mean offline. Catalog/enrichment providers receive requests from the server. Artwork and preview hosts receive requests from the browser. Musimo has no built-in analytics service, but providers and your own proxy may log requests. [Privacy](PRIVACY.md) describes these flows.

## Troubleshooting

### The page does not open

Check Docker, `docker compose ps`, bind/port settings and service logs. A loopback bind cannot be reached from another device. Health is independent of remote provider availability.

### Search works but downloads fail

Metadata and audio come from different systems. Read the job stage and error. Unavailable recordings, source restrictions, rate limits, missing tools and disk permissions need different remedies. Avoid repeatedly retrying a blocked source. See [YouTube troubleshooting](docs/youtube-troubleshooting.md).

### Coverage is wrong or unknown

Check mounted roots, scan status and tags. Rescan after mount changes. Matches use a priority system: completed downloads first, then ISRC, then MusicBrainz ID, then normalized artist/title and duration. Different editions (same title and artist but different album) are flagged separately with the matched album name shown. Inaccessible files or incomplete provider track lists can produce partial results.

### New files are absent

Confirm both apps see the same host folder. Switch to polling if filesystem events do not cross the mount. Musimo indexing and Navidrome scanning are separate. Wait for scans to finish before comparing counts.

### Settings are locked

Their origin is a bootstrap environment value. Later edits to `.env` do not replace or unlock existing rows. Check the Settings origin field.

### A preview is silent

Check Play, mute, the volume slider and browser/site audio settings. Expired clip URLs may need a new track selection. Some catalog results offer no preview.

### Idle CPU is high

Check active scans, jobs and polling interval. Frequent scans across Windows/network mounts can be costly. [Measurements](docs/measurements.md) records unresolved targets; a short sample does not establish typical idle usage.

### Live updates fail behind a proxy

Disable buffering/caching for `/api/events`, allow long responses, preserve host/scheme, and trust only the real proxy. Reload obtains a new snapshot. See [proxy details](docs/reverse-proxy.md).

### Report a problem

Include version/revision, OS, Docker/Compose versions, screen, reproduction steps, expected behavior and the actual result. Share a short redacted error excerpt. Remove credentials, signed URLs, private hosts, usernames and local paths before posting diagnostics.

## Development and checks

CI uses Python 3.12 and 3.14, Node 26 and uv. Dependencies are locked in `uv.lock` and `frontend/package-lock.json`. See [Testing and CI](docs/testing.md) for isolated browser tests, coverage and required checks.

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

Open Vite's printed address. Its `/api` proxy targets localhost port 8765. A deliberately different backend port requires a local change to `frontend/vite.config.ts`.

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
npm run build --prefix frontend
npm run format:check --prefix frontend
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

Commit the manifest and relevant locks/exports together. Prettier formats frontend/YAML/Markdown; Ruff formats Python. See [Contributing](CONTRIBUTING.md).

## Architecture and API

```text
Browser
  | same-origin HTTP + one event stream
FastAPI
  |-- catalog cache -> metadata and preview providers
  |-- library index -> music folders
  |-- scheduler -> worker -> staging -> music -> Navidrome
  `-- SQLite -> settings, cache, index, jobs and events
```

The backend serves frontend and API on one origin. SQLite uses WAL and a serialized writer. Events have increasing IDs and bounded replay; expired cursors trigger a snapshot refresh.

API groups:

- Health/settings: `/api/health`, `/api/settings` GET and PATCH, `/api/snapshot`.
- Search: `/api/search`, `/api/album-years`, `/api/albums/{id}`, `/api/artists/{id}`, `/api/artists/{id}/top`, `/api/preview/{id}`.
- Index: `/api/library` GET, `/api/library/scan` POST, `/api/library/cancel` POST.
- Player foundation: `/api/player/capabilities`, `/api/player/song/{id}`, `/api/player/queue` GET and PUT, `/api/player/scrobble`, `/api/player/lyrics/{id}`, `/api/player/radio/{id}`, `/api/player/path`, `/api/player/stream/{id}`, `/api/player/art/{id}`. Navidrome-backed library routes at `/api/library/{albums,artists,tracks,playlists}` for browsing; local index routes at `/api/library` GET, `/api/library/scan`, `/api/library/cancel` remain separate.
- Jobs/batches: `/api/naming-preview`, `/api/jobs` GET and POST, `/api/history`, `/api/batches` POST, `/api/batches/{id}/{pause,resume,cancel,retry}`, `/api/jobs/{id}/pick`, `/api/jobs/{id}/{pause,resume,cancel,retry,dismiss}`, `/api/queue/{pause,resume,cancel-queued,retry-failed,clear-finished,clear-failed,resume-source}`.
- Artist downloads: `/api/artists/{id}/download-plan`, `/api/artist-batches`.
- Activity: `/api/activity` GET and DELETE; deletion takes the observed `through` cursor.
- Operations: `/api/events`, `/api/diagnostics`, `/api/diagnostics/test/deezer`, `/api/diagnostics/export`.

Contracts can change before a stable release. The live schema is at `/openapi.json`; interactive Swagger/Redoc pages are disabled. Read [architecture](docs/architecture.md), [search/indexing](docs/search.md) and source for detailed behavior.

Repository layout:

```text
backend/       API, state, catalog, indexing and download services
frontend/src/  React screens, player, queue and shared UI
scripts/       smoke tests and benchmarks
tests/         regression tests
docs/          setup, behavior, evidence and proposals
.github/       checks, contribution templates and ownership
```

## Contributing and support

Read [Contributing](CONTRIBUTING.md) before a large change. Reproducible bug reports, accessibility work, documentation corrections and small fixes are welcome. Use issue templates; security reports follow [Security](SECURITY.md), not public issues.

[Code of conduct](CODE_OF_CONDUCT.md) covers project spaces. [Governance](GOVERNANCE.md) describes maintenance. [Release checks](docs/releasing.md) distinguish repository setup from completed public-release work. There is no paid support agreement or promised response time.

## Licence and permitted use

Musimo's original source uses the [MIT licence](LICENSE). Dependencies and executables retain their own licences; see [third-party notices](THIRD_PARTY_NOTICES.md). The software licence grants no rights to recordings, compositions, lyrics, artwork or provider accounts.

Use Musimo where you have the rights or permission required for the intended copying, downloading, processing and sharing. Possessing a copy or paying for a subscription does not by itself establish those permissions. Read [Terms and responsible use](TERMS.md), [Privacy](PRIVACY.md) and each configured provider's terms.

Musimo is independent of the providers and Navidrome. Names describe integrations, not endorsement. MIT includes warranty and liability provisions; no notice waives rights or liabilities that applicable law does not allow to be waived.
