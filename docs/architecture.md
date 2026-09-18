# Architecture and screen plan

The phase sections below record the implementation sequence. For current behavior, use [search and indexing](search.md), [downloads](downloads.md), [settings](settings.md) and [UI verification](ui-verification.md). Discover remains a [proposal](discover.md). The original phase gates are not a claim that every release acceptance check is complete.

## Stack

Python 3.14, FastAPI, one uvicorn process, SQLite WAL, React 19 with TypeScript strict and Vite. TanStack Router owns page and query URL state; TanStack Query owns server data and cancellation. Tailwind 4 (`@tailwindcss/vite`, imported from `frontend/src/style.css`) styles the shell and the shared controls; the remaining screens move from semantic classes to utilities in the order [the styling plan](tailwind-migration.md) sets out. Native form controls and native modal dialogs cover settings, the command palette, the queue sheet and the playlist picker. TanStack Virtual renders the download JobList above 6 cards and long track lists; `PlayerProvider` owns preview and library playback, and `PopoutProvider` is a second root context. This is a smaller dependency set than the brief: cmdk, shadcn/Base UI and Zustand are not needed. Apprise remains later work. A custom Python service is needed for processes and mounted files; the fixed self-hosted Docker requirement rules out a hosted Workers backend.

The main image builds the frontend, serves it from FastAPI, and includes FFmpeg, Chromaprint, Deno, yt-dlp and the matching bgutil plugin. Vite copies `frontend/public` (favicon, manifest) to the dist root. FastAPI serves those files as-is, then `/assets` for the JS/CSS bundle. Only the listed SPA paths fall back to `index.html`. The only helper is a pinned bgutil service with no published port. SQLite lives in a named volume. Music mounts are separately configured. The initial test mount contains no real library files. PUID/PGID ownership changes apply only to application data; never recursively chown music.

## Styling

Colors live in the Tailwind 4 `@theme` block at the top of `frontend/src/style.css`, as `--color-*` tokens named for what they do (`canvas`, `raised`, `muted`, `danger-bg`) rather than what they look like. There is no `tailwind.config.js`. Nothing else in the frontend may name a color: no hex, `rgb()`, `hsl()` or named color outside that block, and no arbitrary utility such as `bg-[#17201b]`. A translucent color is an opacity modifier (`bg-accent/20`) or a `color-mix(in oklab, var(--color-x) N%, transparent)`. `frontend/src/no-raw-colors.test.ts` reads the sheet and every component and fails with the file and line if one slips in, which is what makes user themes possible: a theme is a value for each token and nothing else.

Widths use four named breakpoints, `phone` (48rem, 768px), `split` (56.25rem, 900px), `tablet` (68.75rem, 1100px) and `wide` (93.75rem, 1500px), through Tailwind's `max-phone:` and `max-tablet:` variants. The queries that are not about width have custom variants: `coarse:`, `fine:` and `no-hover:`, alongside Tailwind's own `motion-reduce:`. Type sizes, radii and the stacking order are named in the same block. Layout measurements stay plain custom properties on `:root`, because `player.tsx` writes `--player-height` and several `calc()`s add it to `--nav-height` and the `--safe-*` insets.

A theme is a value for each of those tokens and nothing else. `frontend/src/theme/` holds the token list with the labels and groups the editor shows, the built-in registry, the zod schema every stored or imported theme passes through, the contrast helpers and the store. `musimo-dark` is the only built-in, and a unit test parses the `@theme` block and compares it token for token, so the TypeScript copy cannot drift from the sheet. The store owns three browser keys: `musimo.theme` is the active theme's id, `musimo.custom-themes` is the person's own themes with a format version and a cap of fifty, and `musimo.theme-vars` is the resolved properties. Every one of those reads and writes is wrapped, because a private window throws on the first touch of `localStorage`. A `storage` event applies a change made in another tab, and an id that no longer names a theme falls back to the default.

Applying a theme writes each `--color-*` and `color-scheme` onto `<html>` with `setProperty`, never into a style string, and updates `<meta name="theme-color">`. The default removes those inline properties instead of setting them, because the `@theme` block already holds it. The Now Playing popout is a second document and gets the same writes while it is open: `copyStyles` copies stylesheets and cannot see a property set on the opener's `<html>`.

`frontend/public/theme-boot.js` is a small classic script loaded in `<head>` before the module bundle. It reads `musimo.theme-vars` and sets the properties before the first frame, so a saved theme does not flash the default. It is external and classic because the Content-Security-Policy allows scripts from this origin only and because it has to run ahead of the bundle. It accepts only `--color-*` names with six or eight digit hex values and swallows every error, so anything unexpected leaves the default in place. Vite copies it to the dist root with the other public files, where FastAPI serves it as-is.

Shared controls live in `frontend/src/ui/` (`Button`, `IconButton`, `TextLink`, `Tag`, `StatusChip`, `Ownership`, `Panel`, `EmptyPanel`, `ErrorBanner`, `InlineError`, `Field`, `FieldSelect`, `Kbd`) and are styled with utilities. Each sets a `data-ui` attribute, and an element dressed by one of the `*ClassName` helpers (a routed link that looks like a button) sets the same attribute by hand, so the sheet's remaining contextual rules and the touch-target test see both. Pass `className` to a primitive for layout only; `cx` joins strings and does not settle a fight between two utilities for the same property.

Tailwind puts utilities in a cascade layer, and a rule outside every layer beats any layered rule whatever its specificity. The sheet's resets for bare elements therefore sit in `@layer base`, where a utility can override them. The class rules for screens that have not converted yet stay unlayered, so a contextual rule such as `.stage-controls [data-ui='icon-button']` still wins over the primitive until its screen converts and the rule is deleted. Handwritten width queries use the same edges as the variants (`width < 48rem`, `< 56.25rem`, `< 68.75rem`, `>= 93.75rem`), so the `:root` layout variables and the utilities always switch together.

The shell, the footer player, the settings save bar, the queue dock, Downloads, Recent activity, Search with its cards, track rows and the album and artist pages, and the album and artist download controls are utilities. The other screens are still painted by semantic classes in that sheet until their phase converts them. [The styling plan](tailwind-migration.md) has the token table, the theme model, the desktop and phone layout contract, what stays handwritten CSS and the order the screens convert in.

## Storage

The database has `settings` and `job_events`. Schema versions use SQLite user_version. One writer connection is protected by a lock; write transactions use BEGIN IMMEDIATE. Snapshot data and event cursor are read under the same lock. Settings and source-health mutations commit with their corresponding events. Library scan status also commits with its event; file-index writes are grouped into throttled progress notifications. This prevents missing state between a snapshot and SSE subscription.

The database also has `library_roots`, `library_files`, `library_state`, FTS5 and `search_cache`. Preserve multiple paths for the same recording. Cache by Deezer request path, query, result kind and page; L1 LRU with TTL, L2 SQLite. Catalog filters and sort operate on loaded provider results, so they do not create separate upstream cache entries. Library track browsing is the exception: see [library player](player.md) for the bounded whole-library snapshot its filters, sort and totals read from. No market selection is implemented. Use lightweight batched ownership joins, never file reads from result rendering.

The database includes `jobs`, `batches`, `sources_health` and artifact manifests. Jobs hold catalog identity, target root, requested quality, selected source, candidates, attempts, desired action, observed stage, progress, final path and codec/bitrate. A partial unique index prevents duplicate active jobs using the specified catalog/id/format/bitrate/root key. Store bitrate as a non-null canonical value to avoid SQLite NULL uniqueness gaps. History persists after the active slot is released. The `linked_playlists` table stores the liked playlist link; schema version remains 3.

Events have an increasing ID, type, payload and timestamp. Retain a bounded replay window; a stale or future cursor receives a reset event and must reload the snapshot. SSE heartbeats contain no IDs. One stream per browser tab; no per-track timers. Uvicorn's graceful shutdown is bounded at two seconds so open SSE connections cannot indefinitely hold a restart. File logs and exported diagnostics must redact credentials and token-bearing URLs.

## APIs

Implemented routes:

Main (main.py):

- `GET /api/health`: database readiness, app version and uptime.
- `GET /api/settings`: effective values, origin and lock status.
- `PATCH /api/settings`: validated partial updates, atomic persistence, rejects locked fields.
- `GET /api/snapshot`: settings, jobs and an event cursor from a consistent snapshot.
- `GET /api/events?after=N`: SSE replay and live events; Last-Event-ID wins on reconnect.
- `GET /api/diagnostics`: runtime versions, disk availability, database mode, source status, library status, queue controls, Navidrome capabilities and last terminal job.
- `POST /api/diagnostics/test/deezer`: real bounded catalog probe, measured latency and persisted result.
- `POST /api/diagnostics/test/destination`: destination write test with elapsed time.
- `GET /api/diagnostics/export`: sanitized diagnostics JSON. ZIP log export is not yet implemented.

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

Errors (errors.py):

- `error_guidance(code)`: 16 code hint and fix table used by worker.py, downloads.py and store.py job_summary. Maps error codes to plain language hints and suggested actions.

Not yet implemented:

- URL imports and pasted-link batches.
- Cookie uploads and source test UI.
- Notification test endpoints.
- Updater controls.
- Lyric backfill jobs.

Same-origin JSON writes reject cross-origin browser requests. No wildcard CORS. The service binds loopback and accepts no secrets. Optional password sessions, secret files and encrypted credential storage precede LAN-facing credential features. Arbitrary URLs, output paths, redirects and yt-dlp arguments require allowlists before download APIs ship; deny executable hooks and output overrides.

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

- **Search:** "Can I find and preview the right recording?" Typeahead, Top/Tracks/Albums/Artists, filters and sort, results with quality and ownership. Keyboard `/` focuses search, Ctrl/Cmd+K opens the palette. Query and tab survive back/refresh. First new query gets skeletons; subsequent data remains while loading. Preview is one shared audio element.
- **Library:** Home, Albums, Artists, Tracks, Playlists views. Grid and list layouts. Server side Tracks filters. Artist All songs subpage and popularity chart. Linked liked playlist. Playlist CRUD. Add to playlist picker. Play all and Shuffle.
- **Album:** "Which tracks am I missing, and what will this download?" Art/header, coverage, format and estimate, then track table. Download missing chooses only unowned tracks. The next step is a visible batch in the drawer, not a blocking match dialog.
- **Artist:** "Which releases do I want?" Grouped discography; a selection sheet shows release types, missing counts and size before expanding jobs. Unknown release types remain visible as unknown rather than silently excluded.
- **Now Playing:** Artwork stage with full screen and popout. Queue. Lyrics. AudioMuse radio. Library tracks only.
- **Downloads:** "What is running, and can I control it?" Shared queue state in drawer and full page, batches expand to track rows. Queue/Done/Failed/History views. Control acknowledgement updates immediately, then actual process state follows. Retry retains the selected target and requested quality.
- **Settings:** "Where will files go, and how will they sound?" Sticky section index for library, audio, queue and sources. Explicit save state, inline errors, locked values with env origin. Readiness summary line at top. Per row "Changed elsewhere" conflict notice. Unsaved draft navigation guard. Format text explains source quality. Destination choice returns to the same search or queue context.
- **Your settings:** "Make it yours." `/settings/user`, reached from the same Settings entry through a Server / Yours switch. Theme cards, a live-preview editor with its own preview strip and sticky save bar, import, export, delete and reset. Everything on it stays in the browser; see [settings](settings.md).
- **Diagnostics:** "What broke, and what fixes it?" System readiness panel: library roots, destination with Test write through `/api/diagnostics/test/destination`, scan, Navidrome, YouTube helper, last download. App/database readiness, runtime versions, source latency, disk free and recent errors. Test now, refresh and export. Source not yet tested is neither healthy nor broken. `#sources` and `#disk` anchors. The path back to settings is one click.

The journey is open app -> inspect readiness -> change unlocked settings -> see save acknowledgement -> refresh/restart -> observe the same values -> test Deezer -> export diagnostics. Search, previews and the download flow now work; the verification limits are recorded in [measurements](measurements.md).

## Foundation tasks

1. Build the main image and optional second bgutil container with pinned versions, healthcheck, non-root runtime and persistent data.
2. Implement settings validation, first-run env origins/locks, transactions and schema initialization.
3. Implement consistent snapshots, persisted events, bounded replay and reconnect/reset handling.
4. Build a responsive React shell with working navigation, editable settings and real diagnostics.
5. Add typed Python checking, ruff, TypeScript build, Prettier, MIT licence and CI.
6. Run Docker smoke tests for health, SPA routes, settings persistence, locked fields, invalid input, same-origin writes and SSE replay across a container restart.
7. Record the baseline benchmark and open research gates.

A passing skeleton is not a completed downloader or evidence that the music accuracy and throughput targets are met.

## Search and catalog implementation

See [search and indexing](search.md) for API contracts, cache limits, ownership matching, watcher behaviour and the tested journey. Search uses independent concurrent track/album/artist HTTP requests. Each section paints when its request completes; catalog results do not need an additional SSE protocol. The existing SSE stream carries durable library updates. Track downloads, album batches and reviewed artist album selections are available; URL imports remain later work.

## Download worker implementation

See [downloads](downloads.md) for durable job state, worker control, publication and verification. Each job owns a child process group. SQLite records the full state and replay event in one transaction; completed audio is published without overwriting existing files. The local Docker Desktop mount uses the tested hard-link fallback because it rejects Linux no-replace rename flags.

## Library player

See [library player](player.md). Navidrome is the playback data plane rather than duplicating streaming, artwork and playable IDs in Musimo. One backend client owns Subsonic authentication, capability discovery, library browsing, media proxying, queue persistence, lyrics, scrobbles and selective scans. Browser code never receives Navidrome credentials. Catalog previews and library playback have separate browser audio elements, and only the library one is routed through Web Audio for the visualizer, because provider preview media has no CORS headers and would be silenced by it. Only one of the two plays at a time.

AudioMuse-AI remains optional. Standard sonic radio and path features route through Navidrome's advertised OpenSubsonic `sonicSimilarity` extension. AudioMuse-specific natural-language and alchemy features remain behind a later adapter.
