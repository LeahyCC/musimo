# Changelog

## Unreleased

### Phones, other computers and the dock

- Accept the app's own writes from a phone, another computer or a reverse proxy such as Tailscale Serve. The cross-origin check now trusts the browser's `Sec-Fetch-Site`, which a page cannot fake, and only falls back to comparing Origin with Host for browsers that do not send it. A page on another site is still refused.
- Keep Now Playing's stage controls on screen on a touch screen while music plays, so the visualizer switch and the preset buttons can be tapped. A tap used to hide them before it landed.
- Add a visualizer switch to the Listening room's dock. The dock's cover becomes the live visualizer, with the same choice, preset and Auto / Hold as Now Playing.
- Stop Classic's Now Playing stretching on a tall window: no gap under the art, and the Up next panel ends with the column.
- Give Home's Octive card an "Ask Octive" heading, so it lines up with On repeat beside it.

### Styled dropdowns

- Open every dropdown (Sort, Show, Genre, settings fields, download format and folder, visualizer presets) in a list that follows the theme, instead of the browser's own menu. Keyboard use is the same, and a phone keeps its own picker.

### Final check of the two layouts

- Walk every route in Classic and the Listening room at 1280x800, 390x844 and 360x800, dark and light. `e2e/themed-walk.spec.ts` and `e2e/a11y.spec.ts` now run each route in both layouts.
- Show the page name once in the Listening room. Downloads, Settings, Your settings and Diagnostics kept their own heading under the header's title; it is now for screen readers only.
- Keep focus on the chosen layout when it is changed from the keyboard in Settings, Yours, and label the two layout radios as a group.
- Announce the half of a theme that is on screen when Follow system is on, not the half last chosen for that family.
- Say "Ready to download" with the check counts, and not "All systems ready", on the Diagnostics banner when some checks are only notes.
- Name the Art / MilkDrop switch, not the Visualizer button, in the hint under Show on Now Playing when the Listening room is on.
- Show one toast, not two, when the queue cannot be saved in the Listening room, and take it away once Retry saves the queue.
- Raise the contrast of the song count under a playlist on the Listening room's Home in dark themes.
- Let `scripts/check.sh browser` take `MUSIMO_CI_PROJECT` and `MUSIMO_CI_PORT` from the environment, so two runs do not collide.
- Retake the README screenshots in Classic and add one of the Listening room.
- Show the MilkDrop visualizer in the README as a short animation.

### Search and catalog pages

- Restyle search and the album, artist and podcast pages for both layouts. Search has pill tabs, a top-result card (Classic) or banner (Listening room) showing how much of the best-matching artist is in the library with a button to get the missing albums, and status badges and download icons on every track row. The album, artist and podcast pages open with a hero showing a coverage bar of what is in the library, what is another edition, queued or missing, with the primary action and destination folder. The artist page now lists Popular, Albums and Singles & EPs, and its release filter starts on all releases. A podcast has "Download latest" for its newest episodes

### Music bot

- Keep a refined list usable after one of its songs is deleted. Refresh preview, Remove and a chat follow-up leave the deleted song out and say how many were dropped, where they used to fail every time (#200)
- Pin songs, replace the rest, add a song and remove one from a result card as edits of the same proposal. A library search shows a Pin toggle per song, Another set (Replace the rest while some songs are pinned) and Add a song, each a new revision the server picks, and Remove makes a new revision that keeps the song from coming back. A chat follow-up keeps removed songs out, and keeps pinned ones first when it is a library search. A preview refined elsewhere says it changed and offers Refresh preview instead of starting a new proposal, and an edit whose reply was lost is sent again with the same operation id while the chat waits. Refresh preview leaves a kept song that left the library out of the request and says so, and a kept song that cannot play is named and can be removed
- Edit a proposal's songs from the structured entry point (contract version 5): `POST /api/music-bot/proposals/{id}/edits` gives another set (the songs you pinned stay, in their order, and the rest are drawn again), adds up to N songs that fit the same filters, or removes songs and never draws them again in that proposal. The filters and length carry over untouched. Kept songs are not cut by the limit, a length target or the artist cap, and one that can't play is a named error instead of being dropped. A retried operation id returns the revision it made and adds nothing twice. New intent fields `filters.exclude_ids` and `context.keep_ids`, `pinned_ids` and `add_count`. "Less aggressive, keep the tempo" still needs energy measurements, which are off, so it is refused
- Store a length a broken file reports as infinite or not a number as unknown when scanning, and read one an older scan stored the same way. One such song used to make a chat fill to a length, or any reply listing it, fail with a server error. A fill to a length now skips it
- Keep the songs the chat has shown on the server instead of in the tab: the last three presented library results and at most 500 songs, for one default listener profile shared by every device, kept across restarts (schema 12, `bot_memory`, with a revision that rises on every change). A result is recorded once, when its card is shown, and never for a cancelled or superseded answer, a refinement or a question. Library searches read it, the engine snapshot names the memory revision it read so the same seed over another memory is another snapshot, and an approved proposal keeps the revision it was built with. Chat settings has Forget shown songs, which clears only this memory on every device and leaves play history, likes and playlists alone. Clear chat no longer clears it. It is suggestion memory, not a taste score, and the profile key is not authentication. The browser no longer sends `shown_ids`, and its `musimo.music-bot.shown` copy is removed. This is contract version 4: an intent that says 4 and omits `context.shown_ids` reads the memory, and one that says 3 or lower still means an empty list. A result still on its way when Forget is pressed on another device is not recorded after it, and the reply says so without an error. The memory starts empty after the upgrade
- Preview and confirm in the chat: a result is now stored on the server as a revision of a proposal, and its card shows what the songs add up to (length, artists, genres, years, and what could not be read) with about six representative songs for a long list and the whole list one press away. A short list is shown whole. A follow-up becomes the next revision. Play, Play next, Add to queue, Replace upcoming and Save as playlist commit that exact revision with an operation id made once per press, so confirming never searches again and a double click or a retry cannot add or save twice. A stale preview says what changed and offers Refresh preview; no song is swapped without saying so. If a confirmation's answer is lost, the browser asks again with the same id and offers nothing new until it knows. Play says "Loaded, not playing yet" when the browser blocks autoplay. A card restored from an earlier session makes a preview before its first save. Pause, resume and skip are unchanged. The browser sends contract version 5. The card keeps the approved total as its total and labels the length the songs add up to now when it differs, and a song the library no longer has is named and refreshed away before anything is confirmed. A commit refuses a song that is gone or unplayable even when the stored check says the same. If a queue confirmation is recorded but cannot be applied, the card says the queue was not changed. A success reply that cannot be read is treated as an unknown outcome and asked again with the same id. Taking a song off a card waits while another request runs.
- Return an overview and a sample with each proposal revision: the track count, whole-track length, artists, genres, year range and how many songs have no length, with what was asked kept apart from what was measured and what is unknown. Tempo and energy appear only from fresh measurements with their coverage, never from a genre name. A proposal over 12 songs gets about six songs spread over its artists, genres and lengths, the same for one revision, and the full list stays beside it. The chat is unchanged
- Ask the structured entry point for a total length with `filters.total_length` (contract version 3): under, at most, at least, over or about an hour, say, where about means the closest total within five minutes. Length is the sum of stored song lengths. When the target can't be met no filter is loosened: you get the shorter selection, or a longer one to accept, and a single long mix is offered whole. The reply reports the target, mode, actual total, deviation, whether it was met, and whether a miss is proven or only not found within the search limit (600 songs, 50,000 steps, no clock). Songs with no known length are counted and left out. `target_seconds` and the chat work as before
- Keep a structured search as a proposal you can refine and then commit: the server stores each revision with its drawn seed, ordered songs and snapshot, and a commit saves exactly that revision as a playlist, or hands its songs to the browser's player with a receipt, once per operation id. A commit that finds a song gone or changed is refused as stale instead of swapping songs, and an older revision has to be named on purpose. A request for more than 500 songs is refused and says the limit. Schemas 10 and 11 add the proposal and receipt tables. The chat is unchanged
- Add a structured entry point beside the chat: `POST /api/music-bot/intent` takes a versioned intent and returns real song ids with a snapshot of everything the selection depended on, with no model call and no change to playback, the queue or playlists. An unknown field, an unsupported version or a constraint the engine cannot enforce is refused with a typed error. `GET /api/music-bot/capabilities` lists what the resolver supports. The chat is unchanged
- The structured entry point now refuses what the chat would quietly rewrite: an exact BPM, artist or genre filters beside tag-based similarity, a seed or shown list outside a library search, and a blank artist or genre name. A reference with no measurement is a typed `reference_unmeasured` error instead of an empty list, deeply nested JSON is a 400, an unexpected failure keeps the error envelope, and the snapshot now covers which music folders are enabled
- Pick among equally fitting songs at random for a broad library request, under a seed the reply returns, so asking again gives a different set. Play count ranks only a "more familiar" request. Refining a proposal or the queue keeps your order. Asking again prefers songs the chat has not just shown, remembered for its last three library answers (refinements and questions are not recorded; the memory first lived in the tab and is now kept by the server, below). The bot keeps one copy of a repeated title by the same artist and gives an artist at most two places unless the request names it. Broad requests used to be an alphabetical slice of the first 5,000 matches in scan order
- Add song characteristics behind empty settings: schema 9 stores measured tempo and energy per song, an optional analysis worker container (`docker compose --profile analysis`, 2 GB, one core, read-only music) leases one queued song at a time through an internal token-protected route, and the bot can gate on tempo, energy and sound once a recipe is named under Music bot in Settings. Both settings ship empty, nothing is queued or analysed by default, and the bot still refuses mood, energy and tempo requests until then

### Search and downloads

- Restyle the Downloads page for both layouts. Classic has underline tabs with counts, a header that says where files go, and one card per job with its stage, one bar and the source. The Listening room has four number tiles as tabs and groups its queue by album or artist download, with a segment per track and the five step bar per job. Done shows the path, a match badge when the job has a score and Play. No match shows the sources that answered and Pick a match. Errors are grouped by cause with the fix link on the group, Retry all and Clear errors. History has a heading per day. The overflow menu is gone: each clean-up lives on its tab
- Show a problem for every download source in Settings, Diagnostics and the queue, not only a YouTube failure or a paused SoundCloud row. A dropped connection is its own error and does not pause the source. A finished download clears that source's error. A Deezer account download keeps its own row, apart from the catalog probe. A song with no match no longer marks the whole install as needing attention
- Count a saved download toward the pause between groups before the queue starts the next one. A SoundCloud match links to the public page, not the API address. A saved file drops the tool's failed lookup lines. A name lookup miss is retried instead of being called a missing recording
- Pause between groups of downloads from Settings: a track count, then a wait in minutes, so a long queue does not keep the connection busy the whole time
- Remove a stopped worker's YouTube cookie copy when Windows launched Python through another process, so the filename's process id is the interpreter's, not the launcher's
- Start the file download while lyrics, MusicBrainz, remaining catalog tags and the cover are still loading, and tag once they arrive. Album and artist batches keep the listing's title, artist and length so matching does not wait on another catalog call per track. A catalog miss keeps those listing tags instead of waiting out a Deezer cooldown, and a later catalog response keeps lyrics already found. Fragmented audio downloads four pieces at a time, and yt-dlp reuses a player cache in the data directory
- Name a queued catalog song with the first source that can run, so the card is right before a worker starts
- Save a catalog track from a Deezer account when the cookie is set, then name and tag it like any other download. A miss falls back to the YouTube match
- Paste a YouTube cookies.txt file in Settings so an age-restricted video can download
- List the download sources in Settings, with a switch for each and a box to replace the Deezer cookie
- Order catalog sources in Settings, try each a set number of times, then go around the list again up to Times around the list. A block pauses the source that raised it, and a list where every row is off fails the song instead of leaving it queued
- Keep a source block on the source that failed, walk the list again on Retry, and show when a row in the order will be skipped
- Search podcasts from a new Podcasts tab, open a show's latest episodes and download them straight from the publisher's file into `Podcasts/<show>`
- Pause each download source on its own after repeated blocking errors, and give match candidates their own source and link
- Search SoundCloud for a catalog track when YouTube has no match, or while YouTube is paused, behind a new off-by-default setting; matches there need a higher score, a job that takes one moves to SoundCloud for pausing and errors, and review candidates name their site
- Put tracks with no close recording on their own Downloads tab, and keep Retry and Clear for real failures
- Search YouTube for label uploads instead of "official audio", which matched 89 of the 100 corpus songs instead of 78, and treat bass boosted, 8D, nightcore, reverb, lofi, acoustic, extended and karaoke-label uploads as different versions

### Pasted links

- Add a server API that previews a pasted YouTube link and queues the ticked entries, checked against a site allowlist
- Paste a link into the search box to review it before it downloads: one recording, or a tick list for a playlist or profile with owned songs unticked; job cards name the site and the queue shows a resume line for each paused site
- Tidy the tags of a pasted music link from the Deezer catalog when the match is certain, say which tags a job used, and stop a link lookup when the browser cancels it
- Download tracks from a pasted Internet Archive item, one row per track with FLAC kept and the item's artist, album, date and track order as tags; clean upload titles before the Deezer lookup, pick a larger cover, and show a link job's tag note as a note instead of a warning
- Download from pasted Bandcamp, SoundCloud, Audius and Jamendo links (Audiomack is listed but yt-dlp cannot read it yet) with a bitrate note and a read-only destination check on the review sheet; a Bandcamp album lands like a catalog album, and the Internet Archive keeps its own tags and gets its cover
- Download DJ mixes and radio shows from pasted Mixcloud, NTS, HearThisAt and BBC Sounds links, and SoundCloud tracks over 20 minutes, into `Mixes/<uploader>/<date> - <title>` with the uploader as artist and no catalog tidy-up; the review sheet shows the landing path, a UK-only BBC show says so, and Audiomack and TuneIn are switched off while yt-dlp cannot read them
- Say plainly when a profile or list page took too long to read instead of offering a retry that cannot work, take a HearThisAt artist from a "Name - Title" heading when the address gives only an account code, and use the show name a station gives rather than splitting the episode title

### Library and playback

- Keep each library view's search, filters and sort in the address, and bring that view's last choice back from a tab or a back link
- Answer as soon as the process starts. The folder check takes its first look in the background, leftover download folders are cleared after that, and the library list is built before the first page asks for it, then again after the index changes
- Open Tracks from the index. Cover images are remembered when the library is scanned, so the list does not walk the music folders
- Play from the music folders. Playback no longer uses a separate server. Playlists, favourites, play counts, and the saved queue from that server do not carry over. Rolling back after the version 6 upgrade needs the backup taken before it
- Change the MilkDrop preset on the beat. A drop gets a harder picture and a quiet stretch a calmer one, and the changes come closer together as the song goes on
- Check a polled music folder every five minutes instead of every minute
- Read the library's album list four pages at a time, the same way tracks are read
- Give library playback its own audio element and a Web Audio analyser for the coming visualizer, keeping catalog previews off it (#51)
- Extract bands, energy, onsets, a beat pulse and tempo from library playback in a worker, ready for the visualizer (#52)
- Draw a WebGPU particle field on the Now Playing stage, with a view toggle, a debug overlay and a particle count setting; browsers without WebGPU keep the artwork (#53)
- Keep the visualizer running across the Now Playing popout round trip on one device, with its frame time reported in the popout window too (#54)
- Tune the particle field on real music and stop the tempo guess reading half-time (#56)
- Draw the visualizer through a post stack of feedback trails, bloom, beat-driven chromatic aberration, a tonemap and grain, so loud passages no longer clip to white (#57)
- Add a fluid scene to the visualizer, with a scene select in the stage's top bar (#58)
- Add a raymarched fractal scene to the visualizer, folded by the bass and detailed by the treble, with a step cap in the stage's top bar (#59)
- Add six visualizer presets, two per scene, each naming which feature drives which parameter, with a picker in the stage's top bar and `[` and `]` to cycle (#60)
- Cut the particle and raymarch visualizer scenes and their four presets, leaving the fluid and hiding the scene select while there is one scene to pick (#61)
- Move the visualizer into [visimo](https://github.com/LeahyCC/visimo) and consume it as a dependency, so scenes and presets can be tuned against a dropped track instead of a library
- Add visimo's Kaleidoscope scene and its Prism preset to the visualizer, which brings the scene select back to the stage's top bar
- Lay out the Artists grid like the Albums grid: big round picture, name and album count below, play on hover
- Show an artist's newest album cover in place of the library's star when it has no photo of them
- Filter the Artists tab by genre, year, favourites and played or never played, sort it by recently added, and mark an artist as a favourite from their page
- Filter and sort Albums on the server, so genre and year cover the whole library instead of the albums already scrolled past
- Browse libraries up to 50,000 songs on the Tracks tab (it stopped at 10,000), keeping only the fields the page reads so the larger cap costs less memory than the old one
- Shuffle on the Tracks tab plays every matching song once, in a random order, and refills the 500-song queue as it goes
- Lay Now Playing out as two columns that fit the window: the stage with the title and every player control under it, and one tabbed panel of Up next and Lyrics beside it (under the controls on a phone), so neither starts below the fold. Up next now lists only what follows the playing track and says where the queue came from
- Follow synced lyrics on Now Playing: the current line is highlighted and kept in view, a line can be clicked to seek there, timing can be nudged half a second at a time and is remembered per track, and `L` opens a large lyrics view that takes over the content area, with the track and its controls in a strip along the bottom. Lyrics with no times say so, and a track with none can be searched again
- Edit the play queue: Play next and Add to queue from a song's row menu (and for a whole album or playlist), remove, drag or use the move buttons and Alt with an arrow to reorder Up next, Clear queue, and Save as playlist. Every change is saved to the library, and adding past its 500 song limit is refused with a message instead of dropping songs
- Say "1 album" and "1 song" on an artist page instead of "1 ALBUMS"
- Show the release year on an artist's popular songs instead of a "…" that never filled in
- Draw the track's waveform as the Now Playing seek bar, worked out once with ffmpeg and cached in SQLite (a new `waveforms` table, schema version unchanged), with the plain bar while it loads or when there is none
- Replace the visimo visualizer with MilkDrop, through butterchurn 3.0 beta and its base pack of 107 presets; it needs WebGL 2 rather than WebGPU, so most browsers get it, and the scene and fluid grid settings are gone. The pickers list presets by title, A to Z, and hovering one shows the full name with its authors. Change with the music follows the beat, unless it is switched off

### Testing and CI

- Add the 2A interpreter suite: 128 labelled music bot requests against an invented library, the held-out part sealed by checksum, and a test that checks every label against the engine contract (#199)
- Add a Vitest unit test runner for the frontend (#49)
- Pin the stage view in the Now Playing popout test, which passed headless and failed on any machine with a WebGPU adapter (#62)
- Keep prettier out of `.git` and the agent worktrees under `.claude`, so `npm run format` finishes instead of dying on a plugin it cannot resolve (#62)

### Infrastructure and fixes

- Update React and its types together to 19.3.0, Vite to 8.3.0, TanStack Virtual to 3.14.11 and Ruff to 0.16.7
- Update the bgutil plugin and helper together to 2.0.0, including the exported runtime lock and native Windows setup instructions
- Let the dev proxy target another backend with `MUSIMO_API_TARGET`, and keep writes through it from being refused as cross-origin (#50)
- Let the dev proxy reach an https backend such as Tailscale Serve and still save (#55)
- Stop passing the library's error for a missing item on as broken artwork, and stop sending a compressed length with a decoded body

### UI and accessibility

- Finish the Tailwind migration: the last handwritten screen rules are gone, so a theme now reaches every page, and a new browser check walks every route at desktop and phone width under a light theme
- Settings and Diagnostics now share one "is the system ready" rule, so a finished library scan no longer reads "Some components need attention" on Settings while Diagnostics says "All systems ready"
- Show the Settings save bar only while there are unsaved changes, after a failed save, or just after a save, instead of an idle "Settings are up to date" bar with a Save button
- Keep Parallel, Pause all and Cancel queued in view on Downloads and move Retry failed, Clear failed and Clear all finished into a menu that lists only what has something to act on; Clear all finished asks first
- Collapse a run of the same event in the activity feed into one row with a count and time range that opens to its events
- Show recent searches (kept in this browser, up to eight, clearable) and the newest library albums under the home page hero, keeping the four starter artists for a new install
- Drop the meaningless track number column from Library Tracks sorted A to Z, and stop a long album name there taking more than two lines
- Number a library playlist's rows by their place in the playlist instead of each song's number on its own album

- Make every screen work on a phone: mini player, bottom-bar download count, safe-area insets, 44px touch targets, no focus zoom, tabs and sheets that fit (#48)
- Add a personal settings page at `/settings/user` where you pick a theme, build your own from the color tokens with the whole app as a live preview, and export or import one as a file. Settings is now a Server and Yours switch, and the command palette has Change theme
- Ship eleven more built-in themes: Musimo light, and Slate, Sunset, Violet, Graphite and Windows 95, each in light and dark
- Give the Windows 95 themes the whole look, not only its colors: the real Windows Standard and High Contrast Black schemes, square corners, raised and sunken bevels, a navy title bar, the W95FA pixel font, grey scrollbars and Windows 95 check boxes, drop-downs and track bars
- Make the selected sidebar item readable in Sunset light, Violet light, Graphite light and Windows 95, and add it, sidebar text and the downloads badge to the theme editor's readability report

## 0.4.0 (2026-09-10)

First tagged release of Musimo. This release provides search, library indexing, download workers, queue controls, album batches, library playback and playlist management.

### Library and playback

- Add library player and playlist tools (#13)
- Add artist songs subpage and track view mode (#18)
- Add playlist queue actions and liked playlist support (#19)
- Clean up library navigation and playback (#16)
- Fix flicker when starting library playback (#21)

### Search and catalog

- Keep artist results accurate (#9)
- Add popular music to artist pages (#8)
- Improve release checks and artist pages (#7)

### Downloads and queue

- Fix download recovery and update container runtimes (#5)
- Fix download options and document complete setup (#4)
- Improve download failures and infinite scrolling (#14)
- Explain failed downloads and show retry counts (#15)

### UI and accessibility

- Make long lists usable by keyboard, touch and screen reader (#44)
- Walk every screen at desktop and phone width and fix what is broken (#43)
- Fix mobile player overflow and queue button overlap (#32)
- Full screen and popout for Now Playing's artwork (#31)
- Fix library, playlist and download UI bugs (#29)

### Diagnostics and settings

- Add a readiness panel to Diagnostics that probes instead of assumes (#41)
- Add draft preservation and conflict detection to Settings (#42)
- Link every download failure to the setting or guide that fixes it (#40)

### User feedback

- Tell apart in library, already queued and another edition (#39)
- Show the destination and format before an album or track is queued (#37)
- Focus the highlighted track and give album pages a way back (#35)

### Infrastructure and fixes

- Fix 21 bugs from code audit (#38)
- Harden file selection and fix Linux audio tests (#3)
- Bump python from 3.12-slim-bookworm to 3.14-slim-bookworm (#1)
- Bump node from 24-bookworm-slim to 26-bookworm-slim (#2)

### Documentation

- Fix the last documentation drift before tagging 0.4.0 (#47)
- Prepare the 0.4.0 release cut (#45)
- Bring the docs in line with the code after PRs 13 to 34 (#36)
- Refresh README with product screenshot (#10)
- Fix README screenshot asset (#11)
- Add MUSICARES donation link (#12)
- Create FUNDING.yml (#6)

### Testing and CI

- Let several browser test stacks run side by side (#34)
- Pause pull request CI for the first release cut (#33)
- Serve an empty download queue from the browser fixtures (#30)

### Known limitations

From docs/measurements.md:

- Cold search latency misses 400ms target: ten distinct uncached queries had median 416.95 ms and p95 496.56 ms (measurements.md line 88)
- Sustained idle CPU misses 1% target: 120 samples over 737.9 seconds averaged 2.349% of one CPU core with the deployed 60-second polling watcher (measurements.md line 92)
- Music match accuracy corpus exists (100 distinct MusicBrainz recordings) but independent labels pending (measurements.md line 86)
- Fifty distinct permitted music downloads not measured (measurements.md line 94)
- Native arm64 emulated build passes but native ARM hardware and performance not measured (measurements.md line 90)
- Representative 50k mixed-format library not tested: current index is 3,681 files (measurements.md line 94)
- Provider album throughput not measured (measurements.md line 94)
- Document Picture in Picture (Now Playing popout) requires desktop Chrome or Edge
- No built-in login or multi-user support
- Catalog results do not guarantee permitted full-quality downloads exist
- Different album editions are flagged but worker appends job ID to avoid overwrites instead of replacing
- Some filesystem events do not cross Docker Desktop mounts on Windows, requiring polling mode

## 0.3.0 and earlier

Early development work integrated the FastAPI backend, React frontend, SQLite state, Docker composition, Deezer catalog search, library indexing, download workers with yt-dlp, the library integration, queue controls and settings persistence. The brief and initial planning covered ambitions for the eventual feature set.
