# Search and library indexing

The search service runs in the same Docker service as the rest. The music folder is read-only for the scanner; search does not start downloads or change audio tags.

## Using search

Type two or more characters in the top bar. Search waits 200 ms after typing and cancels superseded browser requests. Top starts track, album and artist requests together and shows each section as it returns. Each search request has a 2.5-second server deadline, including rate-limit waits. Failed sections have their own Retry action.

With nothing typed, the home page shows the hero and, under it, a way back in. "Recent searches" lists the last eight searches as chips (one click searches again) with a Clear link. A search is remembered once it has stood for 1.2 seconds, since the box searches as a person types; a query that only extends the newest one ("dat", then "daft") replaces it, repeats move to the front, and single characters and pasted links are ignored. They are kept in this browser's `localStorage` under `musimo.recent-searches` (`frontend/src/recent-searches.ts`), and a browser with storage off simply remembers nothing. With no remembered searches, four starter artist chips (Daft Punk, Khruangbin, Nina Simone, Radiohead) stand in for them, which is what a new install sees. "Fresh in your library" shows the six newest albums (`library/albums?sort=newest`) with cover, name and artist, each linking to its library album page. It appears only when Navidrome is configured and reachable and the library has albums, and is left out otherwise. Both sections live in `frontend/src/home-shelves.tsx`.

Results open with "Results for" and the query, then the tabs (Top, Tracks, Albums, Artists, Podcasts), then Filters and Sort. On a phone the eyebrow is dropped, "Results for" takes the small heading size, and Filters and Sort share one compact row under the tabs, so the first result row starts in the top half of the screen. The Filters panel holds the help text that used to be a line under the toolbar at every width: filters and sort apply to loaded results, years fill in as album details arrive, and duration and preview filters apply to tracks. Music filters and sort do not apply on the Podcasts tab.

A search with no results at all shows one message, "No results for “query”", not a "No tracks match this search." line under each section. The page reads the same three queries the sections read (`searchResultsQuery` in `frontend/src/search.tsx`), so it can tell when every section has answered with nothing. While any section is still loading or has failed, the sections show as before, and on Top a section that is empty while another has results still says "No artists match this search." (or its kind) with no View all link.

Query, tab, filters and sort live in the URL. Refresh restores them and Back returns to previous searches. Filters apply to the loaded page set, not every result in Deezer. More results load automatically as you scroll. The displayed loaded count makes the current loaded set visible. TrackList is virtualized; album and artist card grids scroll with the page.

Deezer search omits release years. Album details fill them asynchronously without delaying initial results. An artist's popular songs take theirs from the popular albums row, which loads the same album details. Year filters exclude unknown years. Duration and preview filters apply only to tracks; artist results are unaffected by track filters. The preview filter uses known Deezer clip availability, not speculative iTunes matches. Text sorts are ascending; year, duration and popularity sort descending. An exact artist name remains first when sorting artists by popularity, ahead of larger fuzzy matches.

Album cards fetch details automatically as they mount, in the paginated, naturally sized grid. Background requests share four slots and reserve provider capacity for interactive search. Opening an album reuses the same query cache. Cards show checking/estimated coverage until verification, or Retry coverage after failure. Year/library filters hydrate the loaded album set and use verified counts, so hidden results do not depend on hovering. Album pages show year, label, tracks, time, estimated size and coverage. Artist pages show five popular songs, that artist's albums behind those songs, then a paginated discography that loads more on scroll. Guest appearances remain in popular songs without adding another artist's album to popular albums. The discography defaults to albums and EPs and can be filtered by release type or sorted by year and title. Filter and sort choices stay in the URL. MusicBrainz secondary-type filtering remains planned.

`/` focuses search. Ctrl/Cmd+K opens a native modal command palette; Tab selects commands, Enter opens one, Escape closes it. Space toggles playback when focus is outside text fields and interactive controls; it works for both previews and library playback. There is one audio element across navigation. Failed Deezer clips refresh their URL, then try iTunes. The fallback requires matching normalized artist/title and duration within three seconds. The mini player reports when no preview is available. iTunes is used only for previews.

Preview buttons read Pause while that clip plays. A track row's badge shows distinct states: "In library" for exact matches, "Another edition in library (album name)" when a different edition is detected, "Queued" or other job stages for active downloads, and "Downloaded earlier" for completed downloads. A track row on every screen is the badge, Preview, one download button and the options kebab. The format is chosen in the kebab's popover, beside Download to, and the chosen format shows on the download button's tooltip and accessible name ("Download Song to /music · M4A / AAC"). An owned track shows its "In library" badge and no download button, since a disabled tick would repeat the badge. Edition matches keep the download button enabled. The download arrow becomes Retry when a download has failed.

The whole album or artist card is a native link. Artist links, preview, coverage retry and download controls remain separate targets. Card downloads sit over the top-right of the art, appear on hover or keyboard focus, and stay visible on touch screens. Card grids grow with the page instead of using a fixed-height inner scroller; only TrackList virtualizes. Album card icons submit missing-only batches using saved settings and show queue feedback without navigation. Cards do not repeat the destination; each page with album cards says it once above the grid ("Downloads go to /library · Original source quality", with the warning icon and a "not available" link when the destination is not writable). On artist pages the line sits above the first grid, popular albums or else the discography. Album pages display the destination and format in their header and have one download button using the selected format: Download album when no tracks are owned, Download missing (x) for a partial album, or a disabled Download album when verified coverage shows the entire album is in the library. Track rows reuse the shared download action, which is left off for songs already in the library. For catalog preview tracks, song links open `/albums/{album_id}?track={track_id}`; library tracks link to `/now-playing` and `/library`. A pasted link opens a review sheet instead of a search (see Pasted links). Catalog imports from Spotify or Apple Music links remain unavailable. Original, M4A and Opus estimates assume 160 kbps; MP3 assumes 320 kbps. These are estimates, not promises about source quality.

## Pasted links

A single `http` or `https` address in the search box is not a search. Typing one, even half of one, does not search the catalog and does not look anything up; the link is read when it is complete and the person pastes it or presses Enter. Text with anything besides one address still searches as before. Pressing Enter on `https://` alone shows "That is not a whole link" in the sheet instead of searching.

```text
paste or Enter on a whole link
   |
   v
"Checking link" sheet: status line, Cancel  ----- Cancel, Escape or the close button: request abandoned, sheet gone
   |
   +-- refusal ---> the server's own sentence in the sheet, Close. Nothing is queued.
   |
   v
review sheet
   one recording: artwork, title, artist and album, length, date, "In library" badge if owned,
                  where it lands and the format, a note on the audio quality if the site has one,
                  Format and Download to choices, Download
   playlist:      "N of M songs selected", Select all, Select none, a tick list, Download N songs
   profile:       the same list with nothing ticked
   |
   v
Download ---> POST /api/links ---> "N songs queued from <site>. Open downloads"
```

- One lookup is in flight at a time. Pasting another link, cancelling or closing the sheet aborts the request still running, and a late answer to an abandoned request is ignored. The server also allows two lookups at once across every browser and makes a third wait.
- The sheet reuses the artist download sheet's shell, format and destination choices, Select all and Select none and tick rows (`frontend/src/review-sheet.tsx`); the link flow itself is in `frontend/src/links.tsx`. It is a native modal dialog: Escape closes it, focus goes to Cancel while waiting and to the heading when an answer arrives, and closing returns focus to the search box. At phone width it is a bottom sheet.
- A list starts with the songs not in the library ticked and owned ones unticked with an "In library" badge. A profile link (`profile` in the preview) starts with nothing ticked. A lone recording starts ticked even when it is owned. More than 500 entries shows "Only the first 500 are listed."
- A mix or radio show says where it will be filed, under the destination line: "Saved as Mixes/<uploader>/<date> - <title>" for one, and "Saved under Mixes/, in a folder for each uploader" when several ticked entries are mixes (`lands` on each preview entry; songs among them say nothing). The extension is not shown, since it depends on the file the site gives. A date the site does not give shows today's.
- The site's quality note (for example "Bandcamp streams are 128 kbps MP3. ...") sits under the destination line, before anything is queued. When part of a page could not be read in time the list says so and points to a single album or track link. Download is off, with "That folder is missing or read-only. Choose another destination, or fix it in Settings." beside it, when the chosen destination is missing or read-only. The artist review sheet does the same.
- Queueing shows the same floating queue button and job cards as any download. A link job's card names its site ("from YouTube") and never lists a matching stage.
- The status lines, the running count and the queued message are live regions.

## Podcasts

The Podcasts tab searches Apple's public podcast directory, not Deezer. It is not part of Top, so typing does not spend the directory's small request budget (about 20 calls a minute, shared with the iTunes preview fallback). Music filters and sort are hidden on this tab. Search results are cached for ten minutes and episode lists for an hour, in memory only.

A show page at `/podcasts/{id}` lists the latest 200 audio episodes Apple returns, newest first, with date, length and a short description. Video episodes and entries without a web file are left out. A title filter narrows the list in the browser. Each episode has one download button and a badge for its job state: queued or another stage, Downloaded, or Download failed with Retry.

- `GET /api/podcasts?q=...`: up to 50 shows.
- `GET /api/podcasts/{id}`: the show and its episodes.

## Index behaviour

The scanner reads Mutagen tags on a background thread and stores path, modification time, size, normalized identity, duration, ISRC and MusicBrainz recording ID. Unchanged files keep their tags without reopening audio. SQLite indexes serve ownership lookups; FTS5 stores searchable tag text for later local-library browsing. The app preserves every matching file path.

Ownership matching uses a priority system: completed downloads (priority 0), ISRC (priority 1), MusicBrainz recording ID (priority 2), then normalized artist/title with duration within three seconds (priority 3). Edition detection flags priority 3 matches where the normalized album name differs, showing the matched album name in the badge and keeping the download control enabled.

WAV and AIFF files use native ID3 frames for their title, artist, album and recording identifiers. A rescan repairs blank metadata cached by earlier versions for those formats; genuinely untagged WAV/AIFF files are reread while those fields remain empty. Newly indexed paths skip the text-index deletion needed only when replacing existing tags, avoiding a full text-index search for every first insertion.

A page-wide SQL query first recognizes completed catalog jobs whose saved path is still indexed, then matches ISRC, MBID, and normalized artist/title with duration within three seconds. Conflicting ISRCs cannot match through text. Higher-priority matches suppress lower-priority matches for the same result. The `Server-Timing` response header reports cache, queue, provider, catalog parsing and library lookup time separately.

The 7 September cold-search sample against an isolated empty test library remained provider-bound. Provider p95 was 479.55 ms while queue, catalog parsing and library lookup were each below 1.2 ms. Total HTTP p95 was 496.56 ms, so the 400 ms target remains unmet. Chromium added 228.1 ms p95 from input debounce to request and 61.1 ms from response to painted results. The measurements did not justify changing cache or provider budgets. See [release search timing](evidence/release-search-timing.json) and [browser timing](evidence/release-search-browser.json).

Search album cards initially estimate coverage from album tags and never claim a complete album on that basis. Automatic detail checks compare each returned track before reporting complete ownership. An incomplete provider track list cannot produce a complete badge. Ownership is recomputed from the current index even when catalog data is cached. Library-update events invalidate card/detail queries. Tooltip paths identify track matches. Removing a configured root disables its matches while retaining records for later remounting.

Startup and thirty-minute reconciliation scans walk configured roots. Settings provides manual scan and cancel buttons; SSE delivers progress and final counts. A cancelled or unreadable scan does not prune unseen entries. Files outside the resolved root and symlinks are skipped. Watcher refreshes and scans are serialized so generation-based pruning cannot race with an upsert. Unsupported or malformed audio counts as a scan error without stopping other files.

Hidden files and directories, including `.musimo` staging, are excluded from scans and watcher updates. Artwork, lyrics and manifest writes do not trigger a full scan. Moving a staged recording into a visible music folder still triggers indexing. Publication uses the same scan lock as watcher updates so a concurrent scan cannot prune a just-published recording's index entry.

Native watchdog events are the default. Docker Desktop did not forward Windows host writes in the live test, so this machine uses `MUSIMO_WATCH_MODE=poll`. Polling checks each mount every 60 seconds by default, then applies changes after a short settling interval. `MUSIMO_POLL_INTERVAL_SECONDS` changes this deployment setting; shorter intervals cost more idle CPU. A native mode test failed to observe a host-created fixture within 12 seconds; polling passed. The earlier five-second setting used about 7.7% of one CPU core. The longer default reduces repeated metadata reads across the Windows mount. The final idle sample still missed the 1% CPU target; see the measurements note. Publication indexing already exists and is described at docs/downloads.md ~45 and search.md ~37.

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

The player lives within the root router and persists while routes change. Song links open `/albums/{album_id}?track={track_id}`; the album scrolls its virtual list to that recording, highlights it with `aria-current="true"` and focuses it using a roving tabindex (`tabIndex={focusable ? 0 : -1}`) with `focus({ preventScroll: true })`. The focused row shows a visible focus outline. ArrowUp, ArrowDown, Home and End move focus through the track list (`role="region"` labelled Tracks); focus is kept across virtual unmount. Artist links open the artist page. Missing catalog identifiers remain text rather than invalid links.

Album and artist pages show a "Back to results" link when reached from search. The link restores the last search query, tab, sort and filters from sessionStorage. Direct visits or links from elsewhere fall back to the search home.

Preview state is tracked per track. Tracks with no available preview show a disabled button and "No preview" label after lookup completes. The art overlay aria-label matches the row state.

Volume, mute, seeking, restart and close remain available on narrow screens. Volume is stored under `musimo.player-volume`, default 70%; blocked storage does not prevent playback. Seeking is disabled until media metadata is ready. Closing pauses audio, removes its source, cancels lookups and clears the track. Playback errors retain the provider fallback behavior.

## Artist downloads

Download all albums opens a review sheet containing albums and alternative album editions. Singles and EPs are excluded. Download all music opens the same sheet with every release type, including singles, EPs and compilations. Both choices load complete track lists, compare them with the library index and select every valid release by default.

The sheet shows the releases and unique catalog songs that will be added, songs skipped as owned or already queued, and an estimated size. Songs sharing an ISRC across releases are counted and queued once. Skip-owned is enabled by default. Release checkboxes, select all/none, format and destination can change the plan. Incomplete releases are excluded with an error and retry action. Closing without submitting writes no jobs.

Confirmation rechecks membership and ownership before creating one durable group. All selected track lists must resolve before the transaction, so a catalog failure cannot leave a half-created selection. Existing active jobs with the same format and target are excluded. Download counts may decrease if another task queues a song while the sheet is open; the success message reports actual additions.

`GET /api/artists/{id}/download-plan` returns the checked release list. `all_music=true` includes every release type; the default remains albums only. `POST /api/artist-batches` accepts the same `all_music` flag with artist ID, selected release IDs, missing-only, format and target. The existing group pause/resume/cancel controls apply to the result. Playlist imports and automatic exclusion of live/remix editions remain separate work.
