# Architecture and screen plan

The phase sections below record the implementation sequence. For current behavior, use [search and indexing](search.md), [downloads](downloads.md), [settings](settings.md) and [UI verification](ui-verification.md). Discover remains a [proposal](discover.md). The original phase gates are not a claim that every release acceptance check is complete.

## Stack

Python 3.14, FastAPI, one uvicorn process, SQLite WAL, React 19 with TypeScript strict and Vite. TanStack Router owns page and query URL state; TanStack Query owns server data and cancellation. Tailwind supplies styling. Native form controls and native modal dialogs cover settings, the command palette, the queue sheet and the playlist picker. TanStack Virtual renders the download JobList above 6 cards and long track lists; `PlayerProvider` owns preview and library playback, and `PopoutProvider` is a second root context. This is a smaller dependency set than the brief: cmdk, shadcn/Base UI and Zustand are not needed for this phase. Apprise remains later work. A custom Python service is needed for processes and mounted files; the fixed self-hosted Docker requirement rules out a hosted Workers backend.

The main image builds the frontend, serves it from FastAPI, and includes FFmpeg, Chromaprint, Deno, yt-dlp and the matching bgutil plugin. Vite copies `frontend/public` (favicon, manifest) to the dist root. FastAPI serves those files as-is, then `/assets` for the JS/CSS bundle. Only the listed SPA paths fall back to `index.html`. The only helper is a pinned bgutil service with no published port. SQLite lives in a named volume. Music mounts are separately configured. The initial test mount contains no real library files. PUID/PGID ownership changes apply only to application data; never recursively chown music.

## Storage

Phase 1 creates `settings` and `job_events`. Schema versions use SQLite user_version. One writer connection is protected by a lock; write transactions use BEGIN IMMEDIATE. Snapshot data and event cursor are read under the same lock. Settings and source-health mutations commit with their corresponding events. Library scan status also commits with its event; file-index writes are grouped into throttled progress notifications. This prevents missing state between a snapshot and SSE subscription.

Phase 2 adds `library_roots`, `library_files`, `library_state`, FTS5 and `search_cache`. Preserve multiple paths for the same recording. Cache by Deezer request path, query, result kind and page; L1 LRU with TTL, L2 SQLite. Catalog filters and sort operate on loaded provider results, so they do not create separate upstream cache entries. Library track browsing is the exception: see [library player](player.md) for the bounded whole-library snapshot its filters, sort and totals read from. No market selection is implemented. Use lightweight batched ownership joins, never file reads from result rendering.

Phase 3 adds `jobs`, `batches`, `sources_health` and artifact manifests. Jobs hold catalog identity, target root, requested quality, selected source, candidates, attempts, desired action, observed stage, progress, final path and codec/bitrate. A partial unique index prevents duplicate active jobs using the specified catalog/id/format/bitrate/root key. Store bitrate as a non-null canonical value to avoid SQLite NULL uniqueness gaps. History persists after the active slot is released. The `linked_playlists` table stores the liked playlist link; schema version remains 3.

Events have an increasing ID, type, payload and timestamp. Retain a bounded replay window; a stale or future cursor receives a reset event and must reload the snapshot. SSE heartbeats contain no IDs. One stream per browser tab; no per-track timers. Uvicorn's graceful shutdown is bounded at two seconds so open SSE connections cannot indefinitely hold a restart. File logs and exported diagnostics must redact credentials and token-bearing URLs.

## APIs

Implemented routes:

Main (main.py):

- `GET /api/health`: database readiness, app version and uptime.
- `GET /api/settings`: effective values, origin and lock status.
- `PATCH /api/settings`: validated partial updates, atomic persistence, rejects locked fields.
- `GET /api/snapshot`: settings, jobs and an event cursor from a consistent snapshot.
- `GET /api/events?after=N`: SSE replay and live events; Last-Event-ID wins on reconnect.
- `GET /api/diagnostics`: runtime versions, disk availability, database mode, source status and recent events.
- `POST /api/diagnostics/test/deezer`: real bounded catalog probe, measured latency and persisted result.
- `GET /api/diagnostics/export`: sanitized diagnostics JSON. ZIP log export follows in hardening.

Activity (activity_api.py):

- `GET /api/activity`: activity events with cursor and count.
- `DELETE /api/activity`: clears through the observed cursor.

Search (search_api.py):

- `GET /api/search`: cancellable search fan-out with kind, query, index.
- `GET /api/album-years`: batch year hydration for up to 50 albums.
- `GET /api/albums/{id}`: album detail with track list.
- `GET /api/artists/{id}`: artist page with paginated releases.
- `GET /api/artists/{id}/top`: artist's ten most popular songs.
- `GET /api/preview/{id}`: refreshed preview URL with optional fallback.
- `GET /api/library`: index status.
- `POST /api/library/scan`: start scan.
- `POST /api/library/cancel`: cancel scan.

Downloads (download_api.py):

- `GET /api/naming-preview`: live naming template preview.
- `GET /api/jobs`: active jobs.
- `GET /api/history`: job history with filters.
- `POST /api/jobs`: create single track job.
- `POST /api/batches`: create album batch.
- `POST /api/batches/{id}/{pause,resume,cancel,retry}`: batch actions.
- `POST /api/jobs/{id}/pick`: select match candidate.
- `POST /api/jobs/{id}/{pause,resume,cancel,retry,dismiss}`: job actions.
- `POST /api/queue/{pause,resume,cancel-queued,retry-failed,clear-finished,clear-failed,resume-source}`: queue commands.

Artist downloads (artist_downloads.py):

- `GET /api/artists/{id}/download-plan`: checked release list with all_music flag.
- `POST /api/artist-batches`: artist batch creation with selected releases.

Player (player_api.py):

- `GET /api/player/capabilities`: connection, server version and extensions.
- `GET /api/library/albums[/{id}]`: paged albums with detail resource.
- `GET /api/library/artists[/{id}]`: paged artists with detail resource.
- `GET /api/library/artists/{id}/tracks`: all unique tracks from artist's albums.
- `GET /api/library/tracks`: whole-library track browsing with search, genre, year, sort.
- `GET /api/library/tracks/search`: one page of matches for playlist picker.
- `GET /api/library/tracks/selection`: filtered tracks for Play all and Shuffle.
- `GET /api/library/playlists`: playlists visible to the configured account.
- `GET /api/library/playlists/liked`: reads or creates the linked liked playlist.
- `GET /api/library/playlists/{id}`: playlist detail.
- `POST /api/library/playlists`: create playlist.
- `PATCH /api/library/playlists/{id}`: rename playlist.
- `DELETE /api/library/playlists/{id}`: delete playlist (refuses liked).
- `POST /api/library/playlists/{id}/songs`: add or remove song from playlist.
- `GET /api/player/song/{id}`: song details.
- `GET /api/player/queue`: restore queue.
- `PUT /api/player/queue`: save queue.
- `POST /api/player/scrobble`: report now playing and completed listens.
- `GET /api/player/lyrics/{id}`: Navidrome lyrics with LRCLIB fallback.
- `GET /api/player/radio/{id}`: AudioMuse sonic matches.
- `GET /api/player/path`: track-to-track journeys.
- `GET /api/player/stream/{id}`: proxied audio with range forwarding.
- `GET /api/player/art/{id}`: proxied cover artwork.

Not yet implemented:

- URL imports and pasted-link batches.
- Cookie uploads and source test UI.
- Notification test endpoints.
- Updater controls.
- Lyric backfill jobs.

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
Library    | page title                              actions
Downloads  | content
Settings   |
Now Playing|
Diagnostics|
-----------+------------------------------------------------
footer player                         queue count / speed
```

On mobile, navigation moves to a bottom bar; the queue opens as a sheet. Search stays visible on all pages. A route unavailable in the current phase says so rather than showing sample results or fake progress.

- **Search:** “Can I find and preview the right recording?” Typeahead, Top/Tracks/Albums/Artists, filters and sort, results with quality and ownership. Keyboard `/` focuses search, Ctrl/Cmd+K opens the palette. Query and tab survive back/refresh. First new query gets skeletons; subsequent data remains while loading. Preview is one shared audio element.
- **Library:** Home, Albums, Artists, Tracks, Playlists views. Grid and list layouts. Server side Tracks filters. Artist All songs subpage and popularity chart. Linked liked playlist. Playlist CRUD. Add to playlist picker. Play all and Shuffle.
- **Album:** “Which tracks am I missing, and what will this download?” Art/header, coverage, format and estimate, then track table. Download missing chooses only unowned tracks. The next step is a visible batch in the drawer, not a blocking match dialog.
- **Artist:** “Which releases do I want?” Grouped discography; a selection sheet shows release types, missing counts and size before expanding jobs. Unknown release types remain visible as unknown rather than silently excluded.
- **Now Playing:** Artwork stage with full screen and popout. Queue. Lyrics. AudioMuse radio. Library tracks only.
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
