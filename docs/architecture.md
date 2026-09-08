# Architecture and screen plan

The phase sections below record the implementation sequence. For current behavior, use [search and indexing](search.md), [downloads](downloads.md), [settings](settings.md) and [UI verification](ui-verification.md). Discover remains a [proposal](discover.md). The original phase gates are not a claim that every release acceptance check is complete.

## Stack

Python 3.14, FastAPI, one uvicorn process, SQLite WAL, React 19 with TypeScript strict and Vite. TanStack Router owns page and query URL state; TanStack Query owns server data and cancellation. Tailwind supplies styling. Native form controls and a native modal dialog cover settings and the command palette. TanStack Virtual renders long track lists; React context owns the single preview player. This is a smaller dependency set than the brief: cmdk, shadcn/Base UI and Zustand are not needed for this phase. Mobile queue sheets and Apprise remain later work. A custom Python service is needed for processes and mounted files; the fixed self-hosted Docker requirement rules out a hosted Workers backend.

The main image builds the frontend, serves it from FastAPI, and includes FFmpeg, Chromaprint, Deno, yt-dlp and the matching bgutil plugin. Vite copies `frontend/public` (favicon, manifest) to the dist root. FastAPI serves those files as-is, then `/assets` for the JS/CSS bundle. Only the listed SPA paths fall back to `index.html`. The only helper is a pinned bgutil service with no published port. SQLite lives in a named volume. Music mounts are separately configured. The initial test mount contains no real library files. PUID/PGID ownership changes apply only to application data; never recursively chown music.

## Storage

The [music visualizer](visualizer.md) adds a lazy Three.js renderer and a player-owned Web Audio graph. A separate, bounded Python process uses FFmpeg and librosa for song maps. Its private SQLite index and compressed features live under `visualizer/` in the data directory; its work queue is independent of downloads. Playback never waits for analysis.

Phase 1 creates `settings` and `job_events`. Schema versions use SQLite user_version. One writer connection is protected by a lock; write transactions use BEGIN IMMEDIATE. Snapshot data and event cursor are read under the same lock. Settings and source-health mutations commit with their corresponding events. Library scan status also commits with its event; file-index writes are grouped into throttled progress notifications. This prevents missing state between a snapshot and SSE subscription.

Phase 2 adds `library_roots`, `library_files`, `library_state`, FTS5 and `search_cache`. Preserve multiple paths for the same recording. Cache by Deezer request path, query, result kind and page; L1 LRU with TTL, L2 SQLite. Local filters and sort operate on loaded provider results, so they do not create separate upstream cache entries. No market selection is implemented. Use lightweight batched ownership joins, never file reads from result rendering.

Phase 3 adds `jobs`, `batches`, `sources_health` and artifact manifests. Jobs hold catalog identity, target root, requested quality, selected source, candidates, attempts, desired action, observed stage, progress, final path and codec/bitrate. A partial unique index prevents duplicate active jobs using the specified catalog/id/format/bitrate/root key. Store bitrate as a non-null canonical value to avoid SQLite NULL uniqueness gaps. History persists after the active slot is released.

Events have an increasing ID, type, payload and timestamp. Retain a bounded replay window; a stale or future cursor receives a reset event and must reload the snapshot. SSE heartbeats contain no IDs. One stream per browser tab; no per-track timers. Uvicorn's graceful shutdown is bounded at two seconds so open SSE connections cannot indefinitely hold a restart. File logs and exported diagnostics must redact credentials and token-bearing URLs.

## APIs

Implemented in Phase 1:

- `GET /api/health`: database readiness, app version and uptime. No remote dependency blocks readiness.
- `GET /api/settings`: effective values, origin and lock status.
- `PATCH /api/settings`: validated partial updates, atomic persistence, rejects locked fields.
- `GET /api/snapshot`: settings, jobs and an event cursor from a consistent snapshot.
- `GET /api/events?after=N`: SSE replay and live events; Last-Event-ID wins on reconnect.
- `GET /api/diagnostics`: runtime versions, disk availability, database mode, source status and recent events.
- `POST /api/diagnostics/test/deezer`: real bounded catalog probe, measured latency and persisted result.
- `GET /api/diagnostics/export`: sanitized diagnostics JSON for Phase 1. ZIP log export follows in hardening.

Planned next:

- `GET /api/search`, album, artist and discography resources; cancellable search fan-out within 2.5 s with generation IDs on streamed results.
- `POST /api/imports`, `POST /api/batches`, `POST /api/jobs`; batch expansion is resumable and track jobs remain independent.
- `POST /api/jobs/{id}/{pause,resume,cancel,retry}`, matching-candidate list/selection and matching global/batch commands.
- `GET /api/history` with date/text filters and cursor pagination.
- `POST /api/library/scan`, scan cancellation and lyric backfill jobs.
- Source test, cookie upload, notification test, updater and Navidrome integration endpoints.

Same-origin JSON writes reject cross-origin browser requests. No wildcard CORS. Phase 1 binds loopback and accepts no secrets. Optional password sessions, secret files and encrypted credential storage precede LAN-facing credential features. Arbitrary URLs, output paths, redirects and yt-dlp arguments require allowlists before download APIs ship; deny executable hooks and output overrides.

## Job state machine

```text
queued -> matching -> downloading -> converting? -> tagging -> moving -> scanning -> done
   |          |            |
   +----------+------------+-> pausing -> paused -> queued (resume artifact)
   |          |            |
   +----------+------------+-> cancelling -> cancelled

any active stage -> retry_wait -> queued
any active stage -> failed -> queued (manual retry)
```

Conversion is skipped when possible; remuxing is recorded distinctly from lossy encoding. A pause during tagging either finishes that artifact or restarts tagging later, never continues a corrupt partial tag write. Pause intent remains durable through process exit and container restart. A restart reconciles active stages against the manifest before dispatch. Errors retain stage, code, retryability, a redacted tool tail and tool version. Three consecutive blocking errors pause a source, not unrelated healthy sources. Disk-full/unwritable jobs require a successful destination probe before retry.

## Screens and flow

Desktop shell:

```text
Musimo     | [ Search music or paste a link                / ]
Search     | persistent source or disk warning, when present
Downloads  | page title                              actions
Settings   | content
Diagnostics|
-----------+------------------------------------------------
preview controls                      queue count / speed
```

On mobile, navigation moves to a bottom bar; the queue opens as a sheet. Search stays visible on all pages. A route unavailable in the current phase says so rather than showing sample results or fake progress.

- **Search:** “Can I find and preview the right recording?” Typeahead, Top/Tracks/Albums/Artists, filters and sort, results with quality and ownership. Keyboard `/` focuses search, Ctrl/Cmd+K opens the palette. Query and tab survive back/refresh. First new query gets skeletons; subsequent data remains while loading. Preview is one shared audio element.
- **Album:** “Which tracks am I missing, and what will this download?” Art/header, coverage, format and estimate, then track table. Download missing chooses only unowned tracks. The next step is a visible batch in the drawer, not a blocking match dialog.
- **Artist:** “Which releases do I want?” Grouped discography; a selection sheet shows release types, missing counts and size before expanding jobs. Unknown release types remain visible as unknown rather than silently excluded.
- **Downloads:** “What is running, and can I control it?” Shared queue state in drawer and full page, batches expand to track rows. Queue/Done/Failed/History views. Control acknowledgement updates immediately, then actual process state follows. Retry retains the selected target and requested quality.
- **Settings:** “Where will files go, and how will they sound?” Sticky section index for library, audio, queue, sources and advanced. Explicit save state, inline errors, locked values with env origin. Format text explains source quality. Destination choice returns to the same search or queue context.
- **Diagnostics:** “What broke, and what fixes it?” App/database readiness, runtime versions, source latency, disk free and recent errors. Test now, refresh and export. Source not yet tested is neither healthy nor broken. The path back to settings is one click.

The Phase 1 journey is open app -> inspect readiness -> change unlocked settings -> see save acknowledgement -> refresh/restart -> observe the same values -> test Deezer -> export diagnostics. Search, previews and the Phase 3 download flow now work; the verification limits are recorded in [measurements](measurements.md).

## Phase 1 tasks and exit gate

1. Build the main image and optional second bgutil container with pinned versions, healthcheck, non-root runtime and persistent data.
2. Implement settings validation, first-run env origins/locks, transactions and schema initialization.
3. Implement consistent snapshots, persisted events, bounded replay and reconnect/reset handling.
4. Build a responsive React shell with working navigation, editable settings and real diagnostics.
5. Add typed Python checking, ruff, TypeScript build, Prettier, MIT licence and CI.
6. Run Docker smoke tests for health, SPA routes, settings persistence, locked fields, invalid input, same-origin writes and SSE replay across a container restart.
7. Record the baseline benchmark and open research gates. Do not start Phase 2 until the Phase 1 container passes.

Later phases retain the order in the original brief. A passing skeleton is not a completed downloader or evidence that the music accuracy and throughput targets are met.

## Phase 2 implementation

See [search and indexing](search.md) for API contracts, cache limits, ownership matching, watcher behaviour and the tested journey. Phase 2 uses independent concurrent track/album/artist HTTP requests. Each section paints when its request completes; catalog results do not need an additional SSE protocol. The existing SSE stream carries durable library updates. Version 0.3 enables track downloads, album batches and reviewed artist album selections; URL imports remain later work.

## Phase 3 implementation

See [downloads](downloads.md) for durable job state, worker control, publication and verification. Each job owns a child process group. SQLite records the full state and replay event in one transaction; completed audio is published without overwriting existing files. The local Docker Desktop mount uses the tested hard-link fallback because it rejects Linux no-replace rename flags.

## Library player

See [library player](player.md). Navidrome is the playback data plane rather than duplicating streaming, artwork and playable IDs in Musimo. One backend client owns Subsonic authentication, capability discovery, library browsing, media proxying, queue persistence, lyrics, scrobbles and selective scans. Browser code never receives Navidrome credentials. One browser audio element switches explicitly between catalog preview and library playback.

AudioMuse-AI remains optional. Standard sonic radio and path features route through Navidrome's advertised OpenSubsonic `sonicSimilarity` extension. AudioMuse-specific natural-language and alchemy features remain behind a later adapter.
