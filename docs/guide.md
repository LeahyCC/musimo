# Using Musimo

Everything Musimo does, screen by screen, and what it does not do yet. To install it, see [Install and run](install.md).

> [!NOTE]
> Version 0.4.0 is Musimo's first tagged release, and the version the app reports. That tag has search, library indexing, download workers, queue controls, album batches, library playback and playlist management. Current main also plays from the music folders with no separate server, draws a MilkDrop visualizer on Now Playing, and builds queues from the library with the music bot. The database on main is version 8. The release is tested but still early. Known limitations are in the [changelog](../CHANGELOG.md) and [measurements](measurements.md). Read [download verification](downloads.md) before use. The original [brief](brief.md) describes future ambitions beyond shipped features.

## Features and limits

Search and library features:

- Deezer catalog search with Top, Tracks, Albums and Artists views.
- Podcast search and episode downloads from Apple's podcast directory, saved under `Podcasts/<show>`.
- Paste a link into the search box to review it and download it directly. It works with YouTube, the Internet Archive, Bandcamp, SoundCloud, Audius, Jamendo, Mixcloud, NTS, HearThisAt and BBC Sounds. DJ mixes and radio shows are saved under `Mixes/<uploader>`.
- Typeahead, independent result sections, pagination, filters and sorting.
- Search state in the URL, so refresh and browser Back preserve the query.
- Album pages and artist discographies grouped by catalog release type.
- Automatic album coverage checks, with a count and progress bar.
- A persistent index of audio tags. Search does not reopen music files to check coverage.
- One player across navigation. Catalog previews and library tracks use separate audio elements, and only one plays at a time. Library tracks hand over without a gap. Consecutive tracks from one album do not crossfade. Other joins can, from 1 to 12 seconds, off by default. A sleep timer can stop at the end of the track, the end of the queue, or after 15, 30, 45 or 60 minutes.
- Library browsing for albums, artists, tracks and playlists, with playlist CRUD, a saved queue, media controls, lyrics, scrobbling, shuffle and repeat. Albums, Artists and Tracks filter and sort on the server, and each view keeps its search, filters and sort in the address.
- A linked liked playlist, thumbs up button, add to playlist picker with inline creation and the artist All songs subpage with a popularity chart.
- LRCLIB lyric fallback when the library has no imported lyrics. On Now Playing, synced lines follow playback, and choosing a line seeks there.
- Now Playing for a library track: a sidebar entry while one is loaded, a waveform on the seek bar, and a stage that shows the artwork or a MilkDrop visualizer. The visualizer needs WebGL 2 and draws presets from the butterchurn base pack. It can change preset with the music, or stay on the one you picked. The stage goes full screen in the tab or pops out into its own window. Up next can be reordered. Lyrics, About and History sit with it.
- A music bot that builds a queue from the library you already have. A pet on the player opens the chat, and the same chat is a page. It needs a local Ollama model. A result stays a preview until you play it, queue it or save it as a playlist. It matches tags, play history and the liked playlist. It does not analyse how a recording sounds.
- An importer for listening state from a Navidrome 0.63.2 database: manual playlists, likes, artist favourites, play counts and last played. See [the importer](player.md#import-listening-state-from-navidrome).
- Background scans, scan cancellation, native or polling watchers and diagnostics.
- A bounded activity feed in Settings and Diagnostics, with persistent clearing.
- Personal settings with a theme picker and editor, stored in your browser and movable between browsers as a file.

The download implementation provides persistent track jobs, progress, pause/resume/cancel/retry, alternate-match selection, history, failure explanations with plain language messages, per card clear and bulk Retry errors, Clear errors and Clear no match, failure grouping by download group and infinite scrolling for results and history. Album card actions queue missing tracks using Settings defaults. Each error links to the relevant setting or diagnostic. Settings lists each source with its own switch, order and retry count. A block pauses that source and leaves the others running. After a set number of finished tracks, the queue can wait before the next group. With a Deezer cookie, a catalog track is saved from that account first, and a miss continues with the other sources. Download verification requires testing with your chosen provider and the library setup.

A name on this browser picks whose queue, likes and counts you see. It is not a login. These are **not finished features**: personalized Discover, automatic release-edition filters, Spotify and Apple Music link imports, paid audio sources other than a Deezer account, notifications, cookie management beyond pasting a YouTube cookies file or a Deezer cookie, built-in login and complete release benchmarks (cold search latency, match accuracy labeling, permitted-music throughput, representative 50k library, native arm64 performance). See [Discover planning](discover.md), [the roadmap](roadmap.md) and [known limitations](../CHANGELOG.md#known-limitations).

## Search and album coverage

The Search page with nothing typed reads "Find it. Make room for it." With no recent searches it offers Daft Punk, Khruangbin, Nina Simone and Radiohead. This browser keeps up to eight recent searches, and clearing them brings those four back. Newest library albums appear under that row once the library has some.

Enter at least two characters in the search box at the top of every page. Search waits about 200 ms after typing and cancels superseded browser requests. Top requests tracks, albums and artists independently. Pasting or submitting a link there opens a review sheet and does not search. A link placed in the search page's address is not searched either.

Filters and sorting apply to **loaded results**, not the entire provider catalog. More results load as you scroll. Unknown years cannot satisfy a year filter. Duration and preview filters apply only to tracks. Long track lists are virtualized; album and artist card grids scroll with the page.

Cards automatically check album details against the local index. Loading shows checking or estimated coverage; complete track lists permit verified counts. Incomplete provider lists stay partial. Failed checks show Retry coverage.

Tracks show distinct badges: "In library" for exact matches, "Another edition in library" when a different album edition is detected, "Queued" for active downloads, and "Downloaded earlier" for completed downloads. Edition matches keep the download button enabled so you can choose to download both versions.

The album download icon queues missing tracks without opening the album. The card shows where files will land and in what format before queueing. It uses the saved format and destination, skips indexed matches and links to the queue after success. A completely indexed album shows a check. Open an album to inspect individual tracks and available album actions. The status line separates owned and queued counts.

Artist release types come from the catalog. A generic album type does not establish whether a recording is live, remixed or a compilation. Library coverage is a file match, not proof of legal rights.

## Card navigation and artist batches

Click an album or artist card to open it. Separate artist links and card controls still work independently. Download sits in the card's top-right corner and appears on hover or keyboard focus; touch screens keep it visible. Card collections scroll with the page.

An artist's **Download all albums** button opens a selection sheet with album/song counts, estimated size, format and destination. Existing library songs are skipped by default, already queued songs are excluded, and you can deselect alternative editions. All album pages are checked before confirmation; singles and EPs are excluded. See [search behavior](search.md#artist-downloads).

## Library and playback

Library has Home, Albums, Artists, Tracks and Playlists views. Grid and list layouts are available for collection views and the choice is remembered in the browser under `musimo.library-layout`. Albums, Artists and Tracks run search, genre, year and sort on the server, so they describe the whole library rather than the pages already loaded. Each view keeps that choice in its address, and a tab or the back link opens the last choice again. On Tracks, Play all plays the first 500 songs in the current sort order. Shuffle plays every matching song once, in a random order, and past 500 songs the queue refills as it plays.

Artist pages include an All songs subpage at `/library/artists/{id}/songs` and a popularity chart plotted from the library play counts when enough data exists. Playlists show song count and can be filtered by public or private status. Inline rename is available for all playlists.

Each name has their own liked playlist. It is always listed, sorts first, cannot be deleted, and is required for the thumbs up button to work. Its identity is stored in the SQLite table `linked_playlists`. An existing playlist named Liked is adopted when none is stored for that name.

The add to playlist picker opens from the footer player, or from Now Playing, where the footer steps aside, and shows 25 rows with a filter box. The liked playlist is excluded from the picker. Inline New playlist is available with the current song. The Add button toggles to Remove when that song is already in the playlist.

Now Playing is in the sidebar while a library track is loaded, and it leaves when the player is empty. The stage shows the artwork or a MilkDrop visualizer, and it can go full screen in the tab or pop out into a floating window. The seek bar draws the file's waveform. Up next, Lyrics, About and History sit beside the stage on a wide window, and under the controls on a phone. Catalog previews have no Now Playing page. With nothing loaded, that page says "Nothing playing yet."

## Player controls

Previews are provider clips, not full library playback. Failed Deezer clips refresh their URLs and can fall back to a matching iTunes preview. Some tracks have no playable preview.

- Artwork controls start or pause a preview. Tracks with no available preview show a disabled state.
- The player's song title returns to its highlighted track in the album for previews, or links to Now Playing for library tracks. The highlighted row receives focus and shows a visible focus indicator.
- Album and artist pages show "Back to results" when reached from search, restoring your last query and filters.
- Its artist and album names link to their Library pages when playing library tracks, or to the artist page for previews.
- Seek within the clip, restart, mute, adjust volume or close it.
- Volume is remembered in the current browser under `musimo.player-volume`. Mute preserves the chosen level.
- Navigating keeps playback; closing stops audio and cancels a pending lookup.

Library playback adds previous (restarts the current track after 4 seconds of playback), next, shuffle, repeat including repeat one, thumbs up to add or remove from the liked playlist, add to playlist picker, and expand to Now Playing. The queue autosaves every 10 seconds of playback and on pause or close. Now playing scrobbles on play and submits on track end. MediaSession handlers provide play, pause, next and previous for system media controls.

Keyboard controls: `/` focuses search; Ctrl/Cmd+K opens the command palette; Escape closes it or filter menus. ArrowUp, ArrowDown, Home and End move focus through track lists and the download job list. Space toggles playback outside editing fields and interactive controls. Native sliders support keyboard adjustment. Browser autoplay rules can require another press of Play. On Now Playing, Left and Right seek by five seconds, Shift with either goes to the previous or next track, Up and Down adjust volume, M mutes, L opens the large lyrics view and closes it, Q opens Up next, S switches the stage between small and large, and `?` lists the keys. On the stage itself, F enters full screen, Esc leaves full screen or closes the popout, N and P skip tracks, V switches between artwork and the visualizer, and `[` and `]` change the preset. See [Now Playing](now-playing-popout.md) and [the visualizer](visualizer.md).

## Music bot

The music bot builds a queue from songs already in the library. A pet sits on the player. Its name is Octive until you change it. Tapping the pet opens the chat. The Music bot row in the sidebar, and the link in the top bar, open the same conversation as a page at `/music-bot`. The character, name, colour, size and perch are saved in this browser, under Settings, Yours.

It needs Ollama reachable from the Musimo server. In Docker that address is often `http://host.docker.internal:11434`. No model is downloaded for you. Pick one in the chat. Until the server answers and a model is chosen, the chat says why and waits.

Ask for an artist, a genre, a year, a length, songs you have liked, or songs you have not played lately. Genre words match the tags in the files and the broad genres in [genre mapping](genre-mapping.md). The card stays a preview until you play it, play it next, add it, replace what is coming up, or save it as a playlist. Each of those checks the files again before it changes the queue. Undo restores the last of those edits, and refuses once the queue has moved on.

The bot does not listen to the audio. A request about mood, energy or tempo is refused, because that analysis is switched off. "More like this" uses saved genre and artist tags. See [the music bot](player.md#music-bot).

## Downloads and history

Jobs progress through queued, matching, downloading, optional conversion, tagging, moving, scanning and done. Job cards display the destination and format. Low-confidence matches are flagged. Failures retain their stage and error rather than looking like success.

Each failure shows a reason summary with plain language messages. The NO_MATCH message names the sites that were asked, such as "No matching recording was found on YouTube." Those tracks sit on the No match tab. Real failures sit on the Errors tab, which groups them by download group with reason chips and offers Retry errors and Clear errors. Clear no match hides the tracks that never found a recording. Per card attempt counts are shown and reset when retrying. Each finished card also has its own Clear to dismiss it individually. The download arrow on a track becomes Retry with the failure reason in its tooltip.

The floating queue button appears only while a download is active. History and queue load more results on scroll.

Pause/resume and restart recovery depend on the stage and surviving partial files. Cancelling does not remove an already published library file. Clearing finished jobs from the queue is separate from download history.

Validate a new setup by inspecting a permitted test file, its tags and its appearance in the library. A queue acknowledgement confirms submission, not successful publication. Download controls show the destination and format before queueing so you know where files will land. [Measurements](measurements.md) records which acceptance checks have actually passed.

## Recent activity

Settings and Diagnostics show the same scrollable feed. It displays up to 100 recent visible entries. Clear all clears through the snapshot you saw, preserving events that arrive afterward. The clear point survives refresh and restart.

This clears the feed, not music, download history or the bounded live-event replay buffer. It is not a privacy wipe. See [Privacy](../PRIVACY.md).

## Audio quality and metadata

`original` is the default. It avoids unnecessary conversion when possible. M4A, Opus and MP3 are also offered. A codec/container mismatch may require remuxing or conversion.

A higher output bitrate cannot recover detail absent from the source. Converting lossy audio into a larger file does not make it lossless. Subscriptions, catalog results and preview URLs do not establish that a permitted full-quality download exists.

Album size figures are estimates from duration and an assumed bitrate. Check the codec and bitrate of the finished file for actual output characteristics.

Tagging uses catalog metadata, artwork and optional MusicBrainz/LRCLIB enrichment. Available fields include titles, artists, album, date, track/disc numbers, genre, label, identifiers and lyrics. Missing or ambiguous data can stay empty; warnings should explain failed optional enrichment. Artwork and lyrics have their own rights and provider conditions.

## Playback

Musimo plays the files in its music folders. Mount the host folder, select it as the download destination, and list it in `MUSIMO_LIBRARY_ROOTS`. A finished download is indexed and can be played without another server.

Library tracks hand over without a gap. Crossfade and the sleep timer are part of that player. The Now Playing seek bar draws a waveform of the file, worked out once and kept in SQLite. Cover art, lyrics, playlists and the saved queue come from the same index. See [library player](player.md), [the visualizer](visualizer.md) and [Now Playing](now-playing-popout.md).

Listening state from a Navidrome 0.63.2 database can move across with the importer in the library player document. It matches files you have already scanned, then copies manual playlists, likes, artist favourites, play counts and last played. It does not copy audio, and it leaves an existing Musimo queue alone.
