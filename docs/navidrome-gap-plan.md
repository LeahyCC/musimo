# Plan: close the gaps left by removing Navidrome

Status: implementation underway. This follows [the replacement review](navidrome-replacement-review.md). The progress note distinguishes completed work from the remaining plan.

Progress, 13 October 2026: the unmocked player test and synthetic browsing benchmark are implemented. The real-file test passes on Chromium, Firefox, WebKit and the phone project. All 400 existing backend tests pass after fixing a connection leak when refusing a newer database; 367 frontend unit tests pass. The older mocked WebKit player specs still fail on this Windows run, while the unmocked test passes; that baseline issue remains open. The importer is implemented with a dry run against the actual Navidrome schema and a successful write/repeat rehearsal on backup copies. The selected account has now been imported into the backed-up live database: 244 track count/date updates, four song likes, 32 artist favourites and six playlists. The existing Liked playlist and queue were preserved. One unmatched artist favourite remains in the report. The restarted service is healthy, and its API returns the imported playlists, likes and play counts. Live listening, deployment and the remaining features are not complete.

## Implementation sequence, reviewed 13 October 2026

Reviewed against `38470ef` on `feature/local-player`, including the player, scanner, tag reader, store, conversion helper and browser history. The steps below turn the phases into separate reviewable changes. They take precedence where the older phase descriptions differ. This review did not run tests or change the live installation.

```text
Baseline and restore check
  -> Import listening state
  -> Detect format problems -> Convert explicitly
  -> Shared history -> Four smart lists
  -> Live-library acceptance

Measure browsing early -> SQL changes only if needed
External scrobbling and library-specific extras stay optional
```

### 1. Establish the baseline

- [ ] Run the required checks in `CONTRIBUTING.md` and the isolated player browser specs. Recheck the recorded Firefox launch failure and formatting failures rather than treating old results as current.
- [ ] Add an unmocked player browser test using generated tagged audio: scan, browse, play, seek, save queue, reload, and edit a playlist. Keep the existing mocked specs for UI edge cases.
- [ ] Measure cold and warm queue restore, album and Tracks requests, and peak memory before changing queries. Record the fixture size and environment in `docs/measurements.md`.
- [ ] Discover the actual installation and roots before live checks. The Colima details below describe the earlier Mac installation; this checkout is on Windows. Use `docs/windows.md` and the machine notes for deployment work. Make a consistent SQLite backup through the backup API or with the service stopped, then restore it into scratch storage. Keep personal paths outside Git.

Implementation can proceed with fixtures while access to the old database or live listening checks is outstanding. A release still needs the live acceptance pass below.

### 2. Import listening state

- [ ] Add the dry-run CLI in `backend/library/import_navidrome.py`. Inspect the supplied database schema read-only, select the source user explicitly when several exist, and require mappings from source music roots to enabled Musimo roots.
- [ ] Apply the phase 1 match rules. Report ambiguous and missing files, existing playlist names, unavailable queue data and unmatched artist favourites. Preserve playlist order and duplicate entries; report any capacity limit before writing.
- [ ] Write through the store in one transaction, revalidate matches, and invalidate player caches after commit. Keep larger play counts and later dates. Repeated imports must not duplicate likes or playlists, and must preserve an existing queue.
- [ ] Test dry-run immutability, rollback on failure, path mappings across operating systems, ambiguity, source-user isolation and a repeated import. Verify a playlist, like and count through the real API.

The real import is complete. Source and pre-import target backups and the detailed report are retained outside Git. The unmatched artist favourite needs review; no replacement artist was guessed.

### 3. Detect format problems, then add conversion

- [ ] Persist codec and the facts needed to flag compatibility problems. Bump both the schema and `TAGS_VERSION` so unchanged files receive the new facts. Test upgrades from schema 6 and repeat scans.
- [ ] Reconcile `AUDIO_EXTENSIONS`, `CONTENT_TYPES` and supported tag readers first. Several formats listed in phase 2, including `.aac`, `.mp4` and `.ape`, are not currently indexed. Do not promise badges for invisible files.
- [ ] Add the song response fields and badges to album and track rows. Use cautious copy for uncertain browser support. Verify the supported-format policy before making a warning exclude a song from Play all or Shuffle. Cover individual play, saved queues, an entirely unsupported album, and visible skipped counts.
- [ ] Fix `Tagger.prepare` before reusing it: its same-extension shortcut copies ALAC `.m4a` unchanged when asked for AAC `.m4a`. Test the output codec with ffprobe, not its filename.
- [ ] Implement the full conversion flow: choose a supported output, confirm the new copy and unchanged old listening state, show progress, cancel or retry, then play the indexed result. Use temporary output and collision-safe publishing; retain tags and artwork. Refuse read-only destinations and recheck source paths. Keep conversion out of the stream request.

### 4. Put history on the server

- [ ] Choose one local listening rule and use it for both counts and history: proposed rule is ten seconds heard, or completion of a shorter track. This changes current behavior. Today `recordPlay` writes browser history at the threshold, while `finishTrack` sends the count at track end. Playback position alone must not count a seek as time heard.
- [ ] Add bounded `recent_plays` storage and read/clear routes. Save the count and history event in one transaction. Give each listen an id so a retry, repeat, crossfade or duplicate ended event cannot count it twice. Repeat listens get separate events.
- [ ] Import validated browser history once without increasing play counts. Record that migration separately from whether history is empty, so clearing history cannot resurrect it. Remove the local copy only after success.
- [ ] Test two browsers, refresh, request failure/retry, repeat, crossfade, a short song, seeking, and clear-history persistence. Clearing history leaves lifetime counts intact.

### 5. Add the four smart lists

- [ ] Add read-only list queries for Recently added, Never played, Most played and the saved genre. Reuse the existing library routes and queue machinery where practical; keep manual playlists unchanged.
- [ ] Add Playlists cards and detail states, including an unset or missing genre. Apply the same query to displayed rows, totals, Play all and Shuffle. Preserve the 500-song cap and shuffle continuation.
- [ ] Test date boundaries, stable ordering, fresh play counts, genre changes, empty results and more than 500 matches. Imported counts are useful but are not a prerequisite for implementing these lists.

### 6. Measure again and complete acceptance

If browsing needs improvement, first replace `tracks_by_ids` with a bounded SQL lookup and use it for queue restore. The current method calls `_catalog()` and builds the whole view; calling it alone saves nothing. Then move browsing to paginated SQL in separate changes, preserving grouping, search fallback, facets and shuffle. Compare the same measurements before and after.

Each change updates `docs/player.md` and the relevant architecture, settings or testing notes, and passes the repository checks. Visible changes also need the desktop and phone journey, keyboard access, error/retry, refresh and the theme checks.

Before release, verify a restored backup, the real library counts, a finished download appearing in the library, seek and queue restore. Record listening checks across track boundaries in the browsers actually used, including a hidden tab and a phone. Automated handover checks do not establish an audible gapless result.

Optional work stays separate: external scrobbling needs the chosen service's authentication and listening rules checked first; a generic token and the local ten-second rule are not a sufficient contract. Move repair needs retained old rows or a backup because pruning already deletes their listening state. Extra sidecars, artwork sizes and featured-artist browsing wait for a demonstrated need.

The local player is already the better player for listening in this browser. The switch is still a downgrade on the day an existing Navidrome library is opened, and it is still behind on files the browser cannot decode, on saved rules for "what should I play", and on opening a large library without building it all in memory. This plan closes those gaps in that order.

Musimo stays one person's home app: search, download, tag, and play the files in the music folders. The work below copies the slice of Navidrome that matters for that, and keeps the failures the branch already refused.

## Leave in place

- Song ids stay `tr-` plus 16 hex characters on the path. Album and artist ids stay `frozen_id` (`musimo-id-v1`). A retag that changes the album or artist name is a new album or artist id.
- An album is album artist plus album title. Date, format, and folder do not split it.
- An empty root is not pruned while the index still holds rows for it.
- `GET /api/player/stream/{id}` keeps serving the file with an exact length and range support. It does not transcode.
- The art route takes no `size` parameter. Sort columns stay fixed SQL. Symlinks are refused at request time. Tag text stays text.
- One writer, short reads, no `ANALYZE`. Id lists go through `json_each`.
- `added_at` is written once.
- There is no Subsonic or Jellyfin API, no LDAP, no SSO, no second user, no library sharing, and no jukebox.

## Order

| Phase                                 | Outcome                                                                                            | Depends on                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0. Prove the live library             | The real folders play on the live install, and gapless is heard                                    | A backup. Schema 6 cannot be opened by an older build.               |
| 1. Bring listening state across       | Playlists, stars, and play counts from the existing Navidrome database land on `tr-` ids           | Phase 0 backup. The library has been scanned, so paths exist.        |
| 2. Show files the browser cannot play | Those rows are marked before play, and an explicit convert exists for them                         | Scan already reads a codec in `facts_for`.                           |
| 3. Four smart lists and one history   | Recently added, never played, most played, and one genre. The History tab reads the server.        | Play counts from phase 1, if that import is kept.                    |
| 4. Optional scrobbling                | Last.fm or ListenBrainz runs after the local count is saved, and only when a key is set            | The existing `scrobble` call.                                        |
| 5. Browse from SQL                    | Opening the player and restoring the queue no longer build every album and walk every cover folder | Measure first, on the real index and the synthetic 50,000-file tree. |
| 6. Only if this library needs it      | A move-repair tool, extra lyric sidecars, a written remote-access note                             | A count of the real files, not a feature list.                       |

Phases 0 and 1 are the switch. Phases 2 and 3 are what make the replacement better for daily listening. Phase 5 is what keeps it better as the library grows. Phase 4 and phase 6 wait until someone would miss them.

## Phase 0. Prove the live library

PR 168 was played on the isolated stack (port 18765). The live install (Colima, port 8765, volume `musimo_musimo-data`) was left alone because the version 6 upgrade is one-way. `docs/research.md` recorded Navidrome 0.63.2 with 2,738 tracks on this machine. The cited Musimo index elsewhere is 3,681 files. Use whichever library is actually mounted. Do not treat the synthetic 50,000-file scan as this check.

Before the upgrade:

1. Copy `musimo.db` (and the Navidrome database, if phase 1 will run) to a folder outside both containers.
2. Confirm an older checkout cannot open the upgraded file, and that the backup still opens on the old checkout.
3. Write the backup path into the upgrade note in the changelog, next to the existing schema 6 warning.

Then, on the upgraded live install:

- Home, an album, an artist, and Tracks open, and the song counts match a SQL `count(*)` of `library_files` for the enabled roots.
- A known file seeks. A second range on the stream is refused. A symlink is refused.
- A finished download appears in the player without a separate scan.
- An album or a DJ mix plays through a track boundary in Chrome, Firefox, and Safari, once with the tab visible and once with it hidden, and once on a phone. The suite in `frontend/src/features/player/handover.ts` checks which element starts. This check is whether the join is silent. Record the result in `docs/player.md`, including iOS if the standby element waits for a tap.
- The Firefox end-to-end project that failed to launch (`Could not find profile folder`) is a test-runner fix. It is separate from hearing the join.

Done when those notes exist and the backup has been restored once in a scratch directory, so the one-way upgrade has a proven way back.

## Phase 1. Bring listening state across

This is the sharpest downgrade on the day of the switch. Files stay. Playlists, favourites, play counts, and the saved queue do not. Navidrome has wiped this data on its own upgrades (v0.50.0, v0.55.0, v0.64.0). Doing it once, into frozen ids, is how the switch stops being a reset.

### Shape

A one-shot importer, run by hand against a Navidrome SQLite file and the already-scanned Musimo index. It is not a startup migration and it does not put Navidrome back in the image. Suggested module: `backend/library/import_navidrome.py`, with a dry-run as the default and `--write` as the only path that mutates Musimo.

Read Navidrome read-only. For the 0.63.2 database on this machine, expect one library. Map:

| Navidrome                                                                          | Musimo                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `media_file.path`                                                                  | `library_files.path`, then a tag fallback                         |
| `annotation` where `item_type` is media file: `play_count`, `play_date`, `starred` | `library_files.play_count`, `last_played`, and the liked playlist |
| `annotation` where `item_type` is artist: `starred`                                | `artist_favourites`, keyed by `frozen_id("ar", name)`             |
| `playlist` and `playlist_tracks`                                                   | `playlists` and `playlist_songs`                                  |
| The play queue, if that Navidrome version stored one                               | `play_queue` and `play_queue_songs`, capped at 500                |

Confirm the table and column names against the 0.63.2 schema before writing the mapper. Later Navidrome versions re-encoded ids (v0.64.0). Match on path and tags, never on Navidrome's internal id.

### Match rules

1. Path, after resolving the Navidrome music folder onto a Musimo root. This is the match to trust.
2. If the path misses: artist, album, title, and duration within one second, using the indexed `artist_key` / `title_key` and `duration`. Take it only when one Musimo row fits.
3. Two Musimo rows fitting one Navidrome row is a skip, with both paths in the report. The same rule Navidrome needed after automatic move detection duplicated tracks.
4. A Navidrome row with no Musimo row is a skip. The importer does not copy audio.

Stars on songs go into the existing liked playlist (`liked_id` in `backend/library/player.py`). Musimo has no per-song star column. Artist stars go into `artist_favourites`. A renamed album artist will still drop that star later. The import report names any artist whose frozen id will not match a current album artist, so that loss is visible on the day of the import.

Play counts are written as the Navidrome value when it is higher than the Musimo value. `last_played` moves only forward, which is already the rule in `record_play`. Re-running the importer is safe.

Playlist names that already exist are left alone and reported. The importer does not merge by name on a second run. Queue import replaces the Musimo queue only when that queue is empty. A queue the person has already started editing is left alone.

### Report

Dry-run prints counts: matched by path, matched by tags, skipped as ambiguous, skipped as missing, playlists created, stars, play counts, queue entries. `--write` prints the same counts and stores them in the scan or import log so the upgrade note can quote them.

### Tests

Use a tiny fixture database with the 0.63.2 tables, not the live file. Cover a path match, a unique tag match, an ambiguous tag match, a missing file, a higher play count kept, a lower play count ignored, a second run that changes nothing, and a non-empty Musimo queue left in place.

### Done when

The dry-run against the real Navidrome database has been read, `--write` has been run once after the phase 0 backup, and a playlist, a liked song, and a play count from that database show up in the player. If that database is gone, or the dry-run match rate is too low to trust, write "this install starts fresh" in `docs/player.md` and skip `--write`. Do not leave the choice implicit.

### Out of scope

Ratings, shares, other users, radio stations, and smart-playlist rules stored in Navidrome. Those rules are replaced by phase 3, not translated.

## Phase 2. Show files the browser cannot play

`facts_for` in `backend/library/tags.py` already reads mutagen's codec. It uses that only to decide bit depth for ALAC, FLAC, WAV, and AIFF. The codec is then dropped. The player learns a file is unplayable when the audio element errors, skips it, and stops the queue after `MAX_FAILURES` (3) in `frontend/src/features/player/player.tsx`.

### Mark at scan time

Add a `codec` column on `library_files`, filled from the value `facts_for` already computes, empty when mutagen has none. Schema version 7. Back up first, as with version 6.

A row is unplayable in the common browsers when any of these hold:

- suffix is `wma`, `ape`, `wv`, `dsf`, `dff`, `mpc`, `shn`, or another extension outside the play set
- codec is `alac` (usually inside `.m4a`, which otherwise looks playable)
- suffix is `flac` and the file also carries an ID3 tag (the Firefox failure)

The play set to treat as fine until a browser says otherwise: `mp3`, `m4a` / `mp4` with an AAC codec, `opus`, `ogg`, `oga`, `wav`, `flac` without ID3, `aac`. Safari can play some of the others. The badge still shows, because the same library is opened in Chrome and Firefox. The badge copy says the browser may not play it, and names the codec.

Expose `playable: false` on the song JSON from `backend/library/player.py`. Album and track rows show it before play. Play all and Shuffle skip unplayable rows when building a queue, and the status line says how many were left out. A queue that is already saved still skips at play time, with the existing failure limit as the backstop for a mounted folder that cannot be read.

### Convert explicitly

Downloads already transcode through ffmpeg in `backend/jobs/tagging.py` (`libmp3lame`, AAC, `libopus`). Reuse that for a library action, "Convert for playback", on an unplayable row or album.

The action writes a new file in the same folder, in the download `output_format` when that format is `m4a`, `opus`, or `mp3`. `original` is not a playback convert. The new file is indexed by the scan Musimo already runs, and it is a new song when the path changes. Play count and playlist rows stay on the old id until someone runs a later repair. Say that in the confirm step.

The original file stays. Replacing it in place would drop the only copy of a lossless album on a mis-click.

Do not transcode inside the stream route. Navidrome's on-the-fly MP3 responses shipped without a duration, without `Content-Length`, and with `Accept-Ranges: none`. A file on disk keeps the range behaviour the player already has.

### Tests

A fixture ALAC `.m4a` and a `.wma` are `playable: false`. An AAC `.m4a` and a plain FLAC are `playable: true`. Play all on a mixed album omits the unplayable rows and reports the count. Convert writes a file ffmpeg can decode, leaves the original, and does not change the old song id.

### Done when

An ALAC album in the real library shows the badge, Play all skips it with a count, and one converted track plays in Chrome and Firefox. `docs/player.md` replaces the "known limit, not a bug" line with this behaviour.

## Phase 3. Four smart lists and one history

### Smart lists

Manual playlists stay as they are: rows in `playlist_songs`, a 500-song create cap, reorder, rename, the liked playlist that cannot be deleted.

Add four lists that are queries, computed when opened, with no stored membership to go stale:

| List           | Query                                                                       | Sort                             |
| -------------- | --------------------------------------------------------------------------- | -------------------------------- |
| Recently added | `added_at` within a fixed window (30 days), and `added_at` was written once | newest `added_at`                |
| Never played   | `play_count = 0`                                                            | `added_at`, newest first         |
| Most played    | `play_count > 0`                                                            | `play_count`, then `last_played` |
| One genre      | the genre string stored on the song                                         | album, then disc, then track     |

They appear in the Playlists view with a label that they follow the library, and they cannot be reordered or renamed. Play and Shuffle use the same 500-song queue cap as Tracks. When the query is larger, Shuffle can use the existing window and seed. Play takes the first 500 in that list's sort and says so.

The genre list is one saved genre, chosen from the facets the Tracks view already returns, stored as a setting. It is not a rule language. Navidrome's smart playlists shipped as a beta rule editor and then had an upgrade that emptied playlist rows. Four named queries avoid both.

Recently added must keep using the write-once `added_at`. A rescan that rewrote it would scramble the list the way Navidrome's re-imports did.

### One history

The server stores `play_count` and `last_played` on the song. The History tab stores `musimo.play-history` in this browser, 200 rows, recorded after 10 seconds. They diverge across browsers and after the site data is cleared.

Add `recent_plays (id, song_id, played_at)` written from the same `record_play` path that updates the song, capped at 200 by deleting the oldest. The History tab reads that list. Clear history deletes those rows. The 10-second rule stays in the player before it calls scrobble, so a skipped track still does not count.

`localStorage` history is read once, if the server list is empty, and then dropped. After phase 1, the History tab shows plays made in Musimo. It does not reconstruct a timeline Navidrome never stored. Play counts and last-played dates from the import still show on the song and in Most played.

### Tests

Recently added ignores a file whose `added_at` is older than the window, including one whose mtime just changed. Never played and Most played follow `play_count`. The genre list is empty when that genre is gone, and it does not keep a private copy of song ids. Two browsers see the same History tab after one scrobble. A second scrobble of the same song moves `last_played` forward and appends a row.

### Done when

The four lists are on the Playlists view, and History on a second browser matches the first without copying site data.

## Phase 4. Optional scrobbling

`POST /api/player/scrobble` already updates the local count and refuses to move `last_played` backward. After that write commits, and only when a token is set, send the same play to ListenBrainz or Last.fm.

- Settings hold one service and one token. Empty means off. The token is stored like other secrets Musimo already keeps, and it is not returned to the browser in full.
- A network failure, a 401, or a timeout leaves the local count as it is. The player does not retry on the request that just finished playback. A later manual "send recent plays" can wait.
- The submission still waits for the player's existing rule (the History tab's 10 seconds) so a skip is not a scrobble.
- Now Playing submission (`submission: false`) stays a no-op, as it is today.

Tests use a fake HTTP client. Local `play_count` increases when the fake server returns 500. Nothing is sent when the token is empty.

Done when a play with a token set shows up on the chosen service, and a play with the token cleared does not leave the machine.

## Phase 5. Browse from SQL

`LibraryPlayer.view` builds one `LibraryView`: every track dict, every album, every artist, plus `iterdir` for covers. Restoring the queue calls `_catalog()`, so opening the player pays for that build. Album, artist, and track routes then filter the in-memory lists. `docs/measurements.md` records a synthetic 50,000 tiny-WAV scan at about 45 seconds and an unchanged rescan around 30 seconds. The player view at that size is unmeasured. The real index to measure first is the mounted library (3,681 files in the measurements note, or the live count from phase 0).

### Measure before changing it

Time, on the real library and on the synthetic 50,000-file tree:

- first `view()` after startup
- queue restore
- one album page and one Tracks page
- peak RSS of the API process during those calls

Write the numbers in `docs/measurements.md`. If the real library opens in well under a second and the 50,000-file view stays modest, this phase can stop at the numbers. The work below starts when either number is a problem.

### Shape, when the numbers say to build it

Albums, artists, and a page of tracks become SQL, with the same filters and sorts `docs/player.md` already lists (`q`, genre, year, sort, offset, size). Album grouping stays album artist plus album title, computed in the query, so there is still no stored album row to go stale.

`LibraryView` remains for a small overlay: the open album's songs, artist favourites applied onto a page, and the queue's songs. Queue restore uses the existing id lookup (`tracks_by_ids`) for at most 500 ids. It does not load every other track.

Cover directory reads run for the albums on the page being built, not for every album on each revision. The scan already records `has_art` and does not decode JPEGs. Keep that. A page that needs a folder image can `iterdir` that album's directory only.

Search keeps the current FTS rule: tokens of three or more alphanumeric characters go to FTS, and anything else scans title, artist, and album. That fallback has to stay correct when the scan is SQL. Short names ("MØ", "AC/DC", "Ry X") stay in the test list.

The single writer and the empty-root guard stay. Player reads stay short. The store lock is not held while a cover directory is listed.

### Done when

The measurements are in the doc, and, if the SQL path shipped, the player tests for filters, sorts, facets, shuffle past the browse cap, and queue restore still pass, with a timed note for the 50,000-file view.

## Phase 6. Only if this library needs it

Each item waits for a fact about the mounted folders.

**Move repair.** A moved file is a new song, and playlist rows, play counts, and queue entries for the old id go away. Leave that as the default. Add an explicit repair, off unless someone runs it: match a missing path to one new file on artist, album, title, and duration. Refuse the match when two missing files fit one new file. Apply play count, playlist rows, and queue rows onto the new id, then drop the old row. This is a tool, not scan behaviour. Automatic matching is how Navidrome duplicated tracks.

**Lyric sidecars.** The player reads `.lrc`, then embedded text, then LRCLIB, and shows timed lines. Count sidecar extensions beside the real library. Add `.ttml` or `.elrc` only when that count is non-zero. A library that Musimo's tagger already writes as `.lrc` does not need the longer list. The on-screen lyrics stay as they are either way.

**Phone away from the house.** The phone layout is the remote client. `docs/reverse-proxy.md` should say how to reach the existing site over Tailscale, including the queue and the gapless player. A read-only Subsonic facade is a different product. Build it only when a car or an offline phone is a real session, and as its own plan.

**Artist "appears on".** Artist pages list albums where this person is the album artist. A separate "appears on" list is a screen change. Add it when featured-artist browsing is actually missed. `linked_artist` already picks which artist page a song opens.

**Large covers.** Art is the original bytes, with a long cache and an ETag that changes when the file changes. If album grids get slow, add a fixed set of widths, not a client-supplied `size`. Until the grid is slow, leave the route unchanged.

**Artist-favourite warning.** Renaming the album artist drops the star, because `artist_favourites` is the frozen id. When a retag would change that id and a star exists, say so in the tagger before the write. The id rule itself stays.

## What this plan does not do

- Put Navidrome back into Compose, the image, or the readiness checks.
- Translate Navidrome smart-playlist expressions, shares, or users.
- Transcode per player, estimate a stream length, or answer a stream without `Content-Length`.
- Re-attach moved files during a scan.
- Raise the 500-song queue cap. A long mix uses Shuffle's window. Raising the cap makes queue restore heavier, which phase 5 is trying to shrink.
- Block local playback on Last.fm or ListenBrainz.
- Start Discover, authentication, or multi-user work. Those stay on the roadmap as separate plans.

## Suggested first session

Phase 0 and the phase 1 dry-run, in one sitting, before any schema change. The dry-run report decides whether phase 1 writes, and the listen decides whether gapless needs a code fix or only a note. Phase 2's `codec` column is the first schema change after that, and it should not land in the same upgrade as an untested import.
