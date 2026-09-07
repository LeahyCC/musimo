# Build a self-hosted music search and download app (replacement for musikat)

You are the lead engineer on a new project. Read all of this before you write anything. Where this document says "decide", I want your own research and your own recommendation, with reasons. Where it says "fixed", do not argue, just build it.

## 0. Owner answers (fill in before starting)

- YouTube Premium account available for cookies: yes / no
- Paid Deezer HiFi, Qobuz or Tidal subscription: none / which
- Soulseek (slskd) acceptable as a source: yes / no / later
- Navidrome version and whether multi-library is in use:
- Library size (rough track count):
- Home server: OS, cores, RAM, and whether the download temp folder is on the same disk as the music folders:
- Reverse proxy and HTTPS on the LAN: none / Caddy / Traefik / nginx / Tailscale
- Phone: Android / iPhone
- Theme: dark only is fine / need light too

If an answer is blank, pick the safest default, state it in your plan, and carry on.

## 1. Mission

Replace musikat with a fast, good looking, self-hosted app that finds music, downloads it, tags it completely, and drops it into a Navidrome library. It is for one person on a home LAN.

The two things that matter most, in this order:

1. Search speed. Typing should feel instant. Results should paint before every source has answered.
2. Download speed and control. Parallel downloads, live progress, pause, stop, retry, and a queue that survives a page refresh and a container restart.

Everything else is secondary to those two.

Fixed decisions:

- Self-hosted, Docker Compose, one main container plus at most one helper container.
- React frontend.
- Navidrome is the library target. Multiple music folders must be supported.
- Single user. No multi-user in v1.

## 2. What exists today and why it is being replaced

musikat is a Python FastAPI monolith (one 1200 line file) with a vanilla JS page. Flow: search Deezer or Spotify for metadata, pick a YouTube Music match with a heuristic score, download with yt-dlp, transcode with FFmpeg, tag with mutagen, copy into a Navidrome folder, call the Subsonic scan endpoint. A background thread walks the music folders every few hours reading tags to mark tracks as "already downloaded".

What is wrong with it, in code terms, so you do not repeat it:

- Search only fires on a button press. No typeahead. No artists tab. No filters or sort.
- "Already downloaded" is one HTTP call per result after the list renders.
- Progress is polled per track with timers. The queue lives in the page and disappears on refresh.
- Downloads run one at a time. No pause, no stop, no global retry, no history.
- No preview playback.
- Metadata is thin. No ISRC, no MusicBrainz IDs, no lyrics, no disc numbers on many tracks.
- Settings are selects on a second tab that load with retry hacks.
- Default output is 128 kbps MP3 transcoded from a lossy source.
- YouTube matching is fragile and the confirm dialog interrupts album downloads.

Do not reuse its code. Do not use the name musikat. Propose three names and pick one.

## 3. Features

### 3.1 Settings (one page, sections with a sticky index, saved to the database, hot reload, no restart)

- Catalog: Deezer (default, keyless) plus optional others (see section 4).
- Download to: list of mounted music folders with labels. Per download override allowed.
- Format and quality: presets plus custom. Be honest in the UI about source ceilings (see 4.2). Default to passthrough of the source container (m4a or opus) so no quality is lost and no CPU is spent.
- Auto retry: max attempts, backoff, and which error classes retry (section 6).
- Concurrency: downloads in parallel per source, plus sleep jitter between YouTube requests.
- Scan library now: button with live progress (files walked, matched, elapsed) and cancel.
- Sources: one card per source with enable toggle, credentials or cookies upload, "Test connection" showing latency and result, and a health chip.
- Naming template for files and folders, Lidarr or beets style, with a live preview.
- Notifications: ntfy, Discord, Telegram, Gotify via a single library (Apprise).
- Advanced: extra yt-dlp arguments, proxy per source, update yt-dlp now, versions of everything.
- Env vars are bootstrap only. Anything set by env is shown locked in the UI with its source.

### 3.2 Search

- One search box, always visible, keyboard focus with "/" and a command palette on Ctrl or Cmd plus K.
- Debounce about 200 ms, cancel superseded requests, minimum two characters.
- Tabs: Top, Tracks, Albums, Artists. Top shows a best result card plus a few of each type. Tab and query live in the URL so back and refresh work.
- Filters as chips: explicit, year range, duration range, has preview, in library (all / only missing / only owned). Sort: relevance, title, artist, year, duration, popularity.
- Paste a URL into the same box: Deezer, YouTube, YouTube Music, Spotify, Apple Music track, album, artist or playlist. The app expands it into a queue.
- Result rows: art, title, artist, album, year, duration, explicit badge, in-library badge, inline quality picker, one click download, kebab for "pick a different match", "preview", "open in Navidrome".
- Album cards show coverage, for example "7 of 12 in library", with a thin bar.
- Album view: header with art, year, label, track count, total time, estimated size at the chosen quality. Buttons: Download album, Download missing (n). Track table with per-track preview, in-library tick, and state.
- Artist view: discography grouped by albums, EPs, singles, compilations, live. "Download all albums" opens a confirm sheet listing each album with a toggle, track count and size, plus "skip tracks already in library" and "main releases only" (use MusicBrainz release-group primary and secondary types to hide live, remix, compilation, soundtrack).
- Quick preview: 30 second clip from the Deezer preview URL, iTunes preview as fallback. One global audio element, a mini player in the bottom bar, space toggles when focus is not in an input, hover or focus shows a play overlay on art. Show a clear "no preview" state.
- Complete metadata on every download: title, artist, album artist, album, track and disc numbers with totals, release date, year, genre, label, ISRC, UPC, explicit flag, MusicBrainz track, release, release-group and artist IDs, contributors, cover art embedded at a chosen size plus a folder cover file, and synced lyrics from LRCLIB as both an embedded tag and a .lrc sidecar.
- In-library badge computed from a local index (section 5), never from per-result file checks. Three states: owned, partial, missing. Tooltip shows which file matched.
- Errors and warnings: toast for transient things with a Retry or Undo action, inline banner under the top bar for persistent things (cookies expired, source down, disk low) with a link to the fix, and a Diagnostics page.
- Long lists are virtualised. Skeleton rows only on the very first paint of a new query.

### 3.3 Downloads

- Persistent bottom drawer on desktop, bottom sheet on mobile, plus a full Downloads page. Same data, two presentations. A pill in the bottom bar shows active count and total speed.
- Per item: art, title, artist, stage stepper (queued, matching, downloading, converting, tagging, moving, scanning, done), progress, speed, ETA, and buttons for pause, resume, cancel, retry, pick another match, open folder.
- Global: pause all, resume all, cancel queued, retry failed, clear finished, concurrency stepper.
- Tabs: Queue, Done, Failed, History. History is searchable with a date filter and keeps the final file path, the source used, the real bitrate and codec of the written file, and the error code if any.
- Low confidence matches do not block an album. Download the best guess, flag it "check match" in the list, and let the user swap it later. Show the top three candidates with scores and preview buttons for each.
- Album and artist downloads are batch jobs that expand into track jobs. The track is the unit of work. Batches show grouped progress and can be paused or cancelled as a group.
- Everything survives page refresh (snapshot endpoint) and container restart (jobs table, resumable partial files).

## 4. External APIs and sources: what is possible

I researched this in September 2026. Verify anything marked "check" before you rely on it, and tell me what changed.

### 4.1 Catalog and metadata

- Deezer public API. Keyless. Search, track, album, artist, artist albums, artist related, artist top, playlist tracks, chart. Gives ISRC, UPC, disc and track numbers, release date, label, genre, explicit flag, contributors, 30 second preview MP3, and cover art in several sizes. Rate limit is roughly 50 requests per 5 seconds per IP (check with a prototype). New OAuth apps are no longer issued but the public catalog works. Use this as the default catalog for search.
- MusicBrainz. 1 request per second with a real User-Agent or you get blocked. Gives MBIDs, release groups with primary and secondary types, ISRC lookup, and Cover Art Archive. Use for IDs, "main releases only", and artist monitoring. Cache hard.
- iTunes Search API. Keyless, about 20 requests per minute. 30 second previews and large art via the URL size trick. Preview fallback and art fallback only.
- Spotify Web API. Developer mode has been restricted repeatedly through 2025 and 2026: needs a Premium owner, search limited to 10 results, preview URLs gone, several endpoints removed. Treat Spotify as import only: resolve a pasted playlist or album URL into Deezer tracks by ISRC or artist plus title plus duration. Do not build search on it. Check the current state of the restrictions and pick the least fragile way to read a playlist.
- LRCLIB. Free synced lyrics, one GET. Navidrome shows embedded synced lyrics in its web UI and serves .lrc files to OpenSubsonic clients, so write both.
- ListenBrainz. Free similar artists and fresh releases without auth. Last.fm needs a key; optional.
- AcoustID with Chromaprint. 3 requests per second, non-commercial. Fallback identification when a pasted YouTube link has junk metadata. Needs the fpcalc binary in the image.
- Discogs. 60 requests per minute with a token. Labels, catalogue numbers, credits. Optional enrichment, not v1.

Join key across catalogs is ISRC where present, otherwise normalised artist plus title plus duration within 3 seconds.

### 4.2 Audio sources, ranked

1. YouTube Music and YouTube via yt-dlp. Default and always on. Honest ceilings: AAC 128 kbps (format 140) or Opus roughly 130 to 160 kbps (format 251). 256 kbps AAC (format 141) needs YouTube Premium cookies. FLAC or 320 kbps output from this source is a transcode of a lossy file and the UI must say so. Requirements in 2026: yt-dlp nightly or a recent stable, a JavaScript runtime (Deno) bundled in the image, and a proof of origin token provider. Use the bgutil provider as a sidecar container pinned to the same version as its plugin. Do not use the rustypipe provider (deprecated). Do not hardcode player clients. Residential IP only; VPN and datacenter IPs get blocked. Keep concurrency at 2 or 3 with jittered sleeps. Expect it to break a few times a year and design the UI to explain why.
2. Deezer direct with an ARL token. MP3 320 and FLAC with a HiFi plan. Breaks subscriber terms and circumvents protection. Off by default with a warning. Only wire it up if the owner has the plan.
3. Qobuz and Tidal via a streamrip style client. Lossless and hi-res with a subscription. Same terms issue. Off by default.
4. Soulseek via slskd. Best source for FLAC. Exposes the home IP to peers and uploads to others. Separate opt-in with a plain notice. Later phase.
5. Bandcamp, SoundCloud, Internet Archive, Jamendo. Legitimate, patchy coverage. Nice to have.

Decide: the resolver design. Search enabled sources in parallel, score candidates by title, artist, duration and channel type (prefer "Topic" auto-generated channels on YouTube), apply a minimum score, apply a duration sanity cap, and fall back down the chain when a source fails. Show the score and source in the UI.

### 4.3 Library

- Navidrome reads MusicBrainz tags and ISRC. Write them.
- Navidrome 0.59 and later supports selective scanning: startScan with a target of library id plus folder. Fire it once per batch, not per track, within a second of the last file landing. Check the exact parameter name.
- Navidrome has its own file watcher. Detect whether it is on and skip the explicit scan if so.

## 5. Architecture (recommended, you may change with reasons)

- Backend: Python 3.12, FastAPI on uvicorn, one process. An in-process asyncio scheduler dispatches jobs. yt-dlp is Python, so Node or Go would still shell out to it and gain nothing for one user.
- Each download is a child process running a small worker script that imports yt-dlp once and emits JSON progress lines. Pause is SIGTERM and keep the .part file (yt-dlp resumes by default). Stop is SIGTERM, then SIGKILL after 5 seconds, then delete temp files. Post-processing is not resumable, so let it finish or restart only that step.
- Per-job temp dir on the same filesystem as the target library so the final step is an atomic rename.
- Skip FFmpeg when the source container already matches the chosen format.
- Database: one SQLite file in WAL mode with a single writer connection behind a lock and BEGIN IMMEDIATE for writes. No Redis, no Postgres. Tables: settings, jobs, job_events, library_tracks (with FTS5), search_cache, sources_health.
- Job idempotency: unique index on catalog, id, format, bitrate and target folder for active states, so a double click returns the existing job.
- Real time: one Server-Sent Events stream per tab with event ids and Last-Event-ID replay from job_events, throttled to about 5 events per second per job, plus a snapshot endpoint for page load. REST for commands. Document the reverse proxy settings that keep SSE unbuffered.
- Search: asyncio fan-out to sources under a 2.5 second deadline, return the fastest first and stream the rest. L1 in-memory LRU, L2 SQLite cache with TTLs (search 10 minutes, album and artist 24 hours). Prefetch album track lists on hover.
- Library index: a background scanner walks the music folders reading tags, plus a filesystem watcher for new files, plus an immediate upsert after every successful move. Match key is ISRC, then MBID, then normalised artist plus title plus duration bucket.
- Outbound rate limiter per host in one client layer: Deezer 50 per 5 seconds, MusicBrainz 1 per second, iTunes 20 per minute, AcoustID 3 per second.
- Frontend: Vite, React 19, TypeScript strict, TanStack Query (pass the abort signal, keep previous data), TanStack Router (typed search params so filters live in the URL), Zustand for the little UI state, Tailwind plus shadcn/ui, TanStack Virtual, sonner for toasts, cmdk for the palette, react-hotkeys-hook, Vaul for mobile sheets, vite-plugin-pwa. Dark theme first. Bottom tab bar under 768 px. Check current versions; shadcn moved its default primitives in 2026.
- Docker: multi-stage build, node builds the React app, python slim runtime with FFmpeg, Deno copied in, yt-dlp with the default extras and curl-cffi, the PO token plugin. PUID and PGID via gosu limited to the config and temp dirs, never a recursive chown of the music volume. Healthcheck on a health endpoint. One data volume. Optional "update yt-dlp on start" with a YouTube self-test and rollback to the previous wheel. arm64 build.
- Security: same origin, LAN by default, optional single password, secrets from files or encrypted settings, cookies file stays on the data volume with tight permissions.

## 6. Error model

Store one error code per job with a retryable flag, the stage, the raw tail of tool output, and the yt-dlp version. Codes at minimum: NO_MATCH, SOURCE_BLOCKED, RATE_LIMITED, POT_MISSING, JS_RUNTIME_MISSING, COOKIES_EXPIRED, TRANSCODE_FAILED, TAG_FAILED, MOVE_FAILED, DISK_FULL, DEST_UNWRITABLE, TIMEOUT. Map yt-dlp warnings about PO tokens and SABR to codes because they arrive as warnings, not exceptions. Retry with full-jitter backoff (base 2 s, cap 60 s, max 4). Honour Retry-After. If three jobs in a row hit the same blocking code, pause the source globally and show a banner. Never auto-retry DISK_FULL or DEST_UNWRITABLE until the health probe passes.

## 7. Performance targets (acceptance criteria)

Search
- Typeahead p95: 150 ms from cache, 400 ms cold, single catalog.
- Multi-source search: first paint 500 ms p95, complete 1.5 s p95, hard deadline 2.5 s with "timed out" chips and retry.
- Album track list: 300 ms when prefetched, 800 ms cold.
- In-library badge: under 5 ms per 50 results, from the index.

Download
- Click to first progress event: 1.5 s.
- First byte of media: 3 s p95 warm, 6 s cold.
- One track passthrough end to end: 8 s p50, 15 s p95.
- 12 track album, concurrency 3, passthrough: 40 s p95. With MP3 transcode: 60 s p95.
- Pause or stop acknowledged in the UI within 300 ms, process actually stopped within 2 s.
- Dispatch latency after a slot frees: 200 ms.

UI and ops
- Reconnect after a proxy drop with full replay within 3 s. State visible after reload within 300 ms.
- New file indexed within 1 s of the move. Full re-index of 50k tracks within 5 minutes.
- Idle container under 150 MB RSS and 1 percent CPU. Startup to healthy under 10 s.

Write a benchmark script that measures these against a running container and prints a table. Run it before every release.

## 8. Extra features beyond my list, ranked by value for effort

Do in v1
- URL import for Deezer, YouTube, YouTube Music, Apple albums via iTunes lookup, Spotify via the least fragile method you find.
- LRCLIB lyrics on every download plus a backfill job for the existing library.
- MusicBrainz IDs and ISRC in every file.
- Download missing tracks for an album or artist.
- Notifications on batch done and on failure.
- Diagnostics page: versions, source health with Test now, disk free per folder, last errors, log tail, export zip.

Do in v2
- Artist monitoring: watch an artist, poll MusicBrainz release groups and Deezer artist albums, notify or auto-download. Seed the watch list from the existing library.
- Wishlist: tracks that failed with NO_MATCH get retried on a schedule.
- Reverse flow: paste any YouTube link, identify via catalog match then AcoustID, tag properly.
- Discovery: similar artists, top tracks, charts, fresh releases via Deezer and ListenBrainz.
- Quiet hours, speed caps, per-source concurrency.
- PWA install and Android share target (needs HTTPS on the LAN).
- Navidrome playlist creation after a playlist import.

Later or never
- Quality upgrade to lossless (only if a paid lossless source exists).
- Soulseek.
- Multi-user.
- Lidarr and beets bridges.

## 9. Things I want you to research and decide yourself

Do this research first, write up what you found with dates and links, then propose a plan. Do not skip it.

1. Current yt-dlp requirements for YouTube Music audio: JS runtime, PO token provider choice (bgutil versus alternatives), which clients still serve audio without cookies, and the real format ceilings with and without Premium cookies. Prototype it in the container and report the error rate over 50 downloads.
2. The current Deezer rate limit and whether the keyless endpoints still return ISRC, contributors and previews.
3. The current Spotify developer restrictions and the least fragile way to read a pasted playlist.
4. Navidrome's selective scan parameters and whether its file watcher makes the explicit scan unnecessary.
5. Whether to run yt-dlp in-process or as a child process. Measure startup overhead and cancel behaviour for both.
6. Whether aria2c as an external downloader helps for 3 to 10 MB audio files or just adds failure modes.
7. Multi-source resolver scoring. Look at how spotDL, tonus, octo and Tubifarry score candidates, then design something better and test it on 100 known tracks. Report precision.
8. The best library index approach for the owner's library size: in-memory versus SQLite FTS5, and watchdog versus periodic walk.
9. Any 2026 newcomers in the self-hosted Navidrome downloader space that I have not listed (music-seeker, tonus, octo, mfui, Tidarr, deemix, streamrip, spotDL, MeTube, Lidarr plus Tubifarry, slskd plus Soularr). Steal their best ideas and list them.
10. Anything in this document you think is wrong. Say so, with evidence, before building.

## 10. Build order

Each phase must run end to end in Docker before the next starts.

1. Skeleton: compose, image, health, settings table, React shell with nav, SSE stream, Diagnostics page.
2. Search: Deezer typeahead with tabs, filters, sort, URL state, previews, library index and badges.
3. Downloads: jobs table, scheduler, yt-dlp worker, progress, drawer, pause, stop, retry, history, tagging with full metadata and lyrics, move, Navidrome scan.
4. Batches: album, artist discography with type filters and "missing only", URL import.
5. Hardening: error model, source health, auto update, notifications, benchmark script, docs.
6. v2 items from section 8.

## 11. Repo rules

- TypeScript strict on the frontend, never `any`. Python typed with mypy or pyright in CI.
- Prettier and ruff. Formatting is the tool's job.
- Comment complex functions with why, not what.
- Keep business rules out of pure helpers. Domain logic lives in a service layer.
- Tests: unit tests for the matcher, the tagger, the naming template, and the state machine. One integration test that downloads a known public domain track end to end in the container.
- Docs: README with a five minute setup, a settings reference, reverse proxy snippets for SSE, and a "why is YouTube failing" page.
- Plain commit messages under the owner's name. No AI attribution anywhere in the repo, branch names, PR bodies or comments.
- MIT licence.

## 12. What I want back from you first

Before code:

1. Your research write-up for section 9, with dates and links.
2. Corrections to this document.
3. A short architecture note: the stack you will use and why, the data model, the API list, and the state machine for a job.
4. The screen list with a rough wireframe description for each.
5. The phase 1 task list.

Then start phase 1.