# Search and library indexing

Phase 2 runs in the same Docker service as Phase 1. The music folder is read-only for the scanner; search does not start downloads or change audio tags.

## Using search

Type two or more characters in the top bar. Search waits 200 ms after typing and cancels superseded browser requests. Top starts track, album and artist requests together and shows each section as it returns. Each search request has a 2.5-second server deadline, including rate-limit waits. Failed sections have their own Retry action.

Query, tab, filters and sort live in the URL. Refresh restores them and Back returns to previous searches. Filters apply to the loaded page set, not every result in Deezer. More results load automatically as you scroll. The displayed loaded count makes the current loaded set visible. TrackList is virtualized; album and artist card grids scroll with the page.

Deezer search omits release years. Album details fill them asynchronously without delaying initial results. Year filters exclude unknown years. Duration and preview filters apply only to tracks; artist results are unaffected by track filters. The preview filter uses known Deezer clip availability, not speculative iTunes matches. Text sorts are ascending; year, duration and popularity sort descending. An exact artist name remains first when sorting artists by popularity, ahead of larger fuzzy matches.

Album cards fetch details automatically as they mount, in the paginated, naturally sized grid. Background requests share four slots and reserve provider capacity for interactive search. Opening an album reuses the same query cache. Cards show checking/estimated coverage until verification, or Retry coverage after failure. Year/library filters hydrate the loaded album set and use verified counts, so hidden results do not depend on hovering. Album pages show year, label, tracks, time, estimated size and coverage. Artist pages show five popular songs, that artist's albums behind those songs, then a paginated discography that loads more on scroll. Guest appearances remain in popular songs without adding another artist's album to popular albums. The discography defaults to albums and EPs and can be filtered by release type or sorted by year and title. Filter and sort choices stay in the URL. MusicBrainz secondary-type filtering remains planned.

`/` focuses search. Ctrl/Cmd+K opens a native modal command palette; Tab selects commands, Enter opens one, Escape closes it. Space toggles playback when focus is outside text fields and interactive controls; it works for both previews and library playback. There is one audio element across navigation. Failed Deezer clips refresh their URL, then try iTunes. The fallback requires matching normalized artist/title and duration within three seconds. The mini player reports when no preview is available. iTunes is used only for previews.

Preview buttons read Pause while that clip plays. A track row's badge shows Queued, Downloading, Retry scheduled or Download failed, and the download arrow becomes Retry when a download has failed.

The whole album or artist card is a native link. Artist links, preview, coverage retry and download controls remain separate targets. Card downloads sit over the top-right of the art, appear on hover or keyboard focus, and stay visible on touch screens. Card grids grow with the page instead of using a fixed-height inner scroller; only TrackList virtualizes. Album card icons submit missing-only batches using saved settings, show the destination and format before queueing, and show queue feedback without navigation. Album pages display the destination and format and have one download button using the selected format: Download album when no tracks are owned, Download missing (x) for a partial album, or a disabled Download album when verified coverage shows the entire album is in the library. Track rows reuse the shared download action, which is disabled for songs already in the library. For catalog preview tracks, song links open `/albums/{album_id}?track={track_id}`; library tracks link to `/now-playing` and `/library`. URL imports remain unavailable. Original, M4A and Opus estimates assume 160 kbps; MP3 assumes 320 kbps. These are estimates, not promises about source quality.

## Index behaviour

The scanner reads Mutagen tags on a background thread and stores path, modification time, size, normalized identity, duration, ISRC and MusicBrainz recording ID. Unchanged files keep their tags without reopening audio. SQLite indexes serve ownership lookups; FTS5 stores searchable tag text for later local-library browsing. The app preserves every matching file path.

WAV and AIFF files use native ID3 frames for their title, artist, album and recording identifiers. A rescan repairs blank metadata cached by earlier versions for those formats; genuinely untagged WAV/AIFF files are reread while those fields remain empty. Newly indexed paths skip the text-index deletion needed only when replacing existing tags, avoiding a full text-index search for every first insertion.

A page-wide SQL query first recognizes completed catalog jobs whose saved path is still indexed, then matches ISRC, MBID, and normalized artist/title with duration within three seconds. Conflicting ISRCs cannot match through text. Higher-priority matches suppress lower-priority matches for the same result. The `Server-Timing` response header reports cache, queue, provider, catalog parsing and library lookup time separately.

The 7 September cold-search sample against an isolated empty test library remained provider-bound. Provider p95 was 479.55 ms while queue, catalog parsing and library lookup were each below 1.2 ms. Total HTTP p95 was 496.56 ms, so the 400 ms target remains unmet. Chromium added 228.1 ms p95 from input debounce to request and 61.1 ms from response to painted results. The measurements did not justify changing cache or provider budgets. See [release search timing](evidence/release-search-timing.json) and [browser timing](evidence/release-search-browser.json).

Search album cards initially estimate coverage from album tags and never claim a complete album on that basis. Automatic detail checks compare each returned track before reporting complete ownership. An incomplete provider track list cannot produce a complete badge. Ownership is recomputed from the current index even when catalog data is cached. Library-update events invalidate card/detail queries. Tooltip paths identify track matches. Removing a configured root disables its matches while retaining records for later remounting.

Startup and thirty-minute reconciliation scans walk configured roots. Settings provides manual scan and cancel buttons; SSE delivers progress and final counts. A cancelled or unreadable scan does not prune unseen entries. Files outside the resolved root and symlinks are skipped. Watcher refreshes and scans are serialized so generation-based pruning cannot race with an upsert. Unsupported or malformed audio counts as a scan error without stopping other files.

Hidden files and directories, including `.musimo` staging, are excluded from scans and watcher updates. Artwork, lyrics and manifest writes do not trigger a full scan. Moving a staged recording into a visible music folder still triggers indexing. Publication uses the same scan lock as watcher updates so a concurrent scan cannot prune a just-published recording's index entry.

Native watchdog events are the default. Docker Desktop did not forward Windows host writes in the live test, so this machine uses `MUSIMO_WATCH_MODE=poll`. Polling checks each mount every 60 seconds by default, then applies changes after a short settling interval. `MUSIMO_POLL_INTERVAL_SECONDS` changes this deployment setting; shorter intervals cost more idle CPU. A native mode test failed to observe a host-created fixture within 12 seconds; polling passed. The earlier five-second setting used about 7.7% of one CPU core. The longer default reduces repeated metadata reads across the Windows mount. The final idle sample still missed the 1% CPU target; see the measurements note. Phase 3 will upsert immediately after its own successful file moves.

Machine-specific mounts belong in the ignored `compose.override.yaml`. The portable Compose file contains no host drive letter. Use read-only binds for collections that only contribute to the index, and a writable bind for the selected download destination. Verify the host paths on each machine.

## Cache and provider budgets

One shared async HTTP client handles catalog traffic. Deezer is limited to 50 requests per five seconds. Background year lookups use at most four concurrent requests and leave ten request slots in the shared window for interactive use. iTunes has a separate 20-per-minute budget. Deezer HTTP 429 responses and API rate-limit errors produce recoverable errors and backoff. A request can time out while waiting for its quota; it does not bypass the quota.

Search cache TTL is ten minutes; album and artist TTL is 24 hours. The memory cache holds 128 responses. SQLite holds at most 3,000 responses and prunes expired entries on writes. Keys are provider request paths, including query, result kind and page. Preview refresh bypasses cached track details. Signed clip URLs are refreshed on playback failure.

## API and verification

- `GET /api/search?q=...&kind=track|album|artist&index=0`: normalized results, total, next page index, cache status and ownership.
- `GET /api/album-years?ids=...`: up to 50 album years under a separate 12-second deadline.
- `GET /api/albums/{id}`: album, track list, label, total duration and coverage completeness. `background=true` shares the background request budget for automatic card hydration.
- `GET /api/artists/{id}?index=0`: artist and a page of releases.
- `GET /api/artists/{id}/top`: the artist's ten most popular catalog songs.
- `GET /api/preview/{id}?fallback=false`: refreshed preview URL or explicit unavailable state.
- `GET /api/library`, `POST /api/library/scan`, `POST /api/library/cancel`: index status and commands.

`scripts/search_smoke.py` checks live catalog results, album detail, year hydration, artist detail, a ranged preview request and reloadable routes. `scripts/watcher_smoke.py` generates a one-second fixture in the isolated test mount and verifies addition and deletion. It removes its fixture afterward. Unit tests cover persistent cache reuse, safe pagination, null provider artwork, shared rate limits, the hard search deadline, exact album coverage, identity priority, cancelled-scan preservation, unchanged-file caching and iTunes fallback matching.

Browser coverage for these UI changes is recorded in [UI verification](ui-verification.md). Production compilation and API tests alone do not establish browser behavior. Cold catalog performance, a 50,000-file scan and acquisition benchmarks remain separate acceptance work; see [measurements](measurements.md).

## Preview navigation and controls

The player lives within the root router and persists while routes change. Song links open `/albums/{album_id}?track={track_id}`; the album scrolls its virtual list to that recording and highlights it. Artist links open the artist page. Missing catalog identifiers remain text rather than invalid links.

Volume, mute, seeking, restart and close remain available on narrow screens. Volume is stored under `musimo.player-volume`, default 70%; blocked storage does not prevent playback. Seeking is disabled until media metadata is ready. Closing pauses audio, removes its source, cancels lookups and clears the track. Playback errors retain the provider fallback behavior.

## Artist downloads

Download all albums opens a review sheet containing albums and alternative album editions. Singles and EPs are excluded. Download all music opens the same sheet with every release type, including singles, EPs and compilations. Both choices load complete track lists, compare them with the library index and select every valid release by default.

The sheet shows the releases and unique catalog songs that will be added, songs skipped as owned or already queued, and an estimated size. Songs sharing an ISRC across releases are counted and queued once. Skip-owned is enabled by default. Release checkboxes, select all/none, format and destination can change the plan. Incomplete releases are excluded with an error and retry action. Closing without submitting writes no jobs.

Confirmation rechecks membership and ownership before creating one durable group. All selected track lists must resolve before the transaction, so a catalog failure cannot leave a half-created selection. Existing active jobs with the same format and target are excluded. Download counts may decrease if another task queues a song while the sheet is open; the success message reports actual additions.

`GET /api/artists/{id}/download-plan` returns the checked release list. `all_music=true` includes every release type; the default remains albums only. `POST /api/artist-batches` accepts the same `all_music` flag with artist ID, selected release IDs, missing-only, format and target. The existing group pause/resume/cancel controls apply to the result. Playlist imports and automatic exclusion of live/remix editions remain separate work.
