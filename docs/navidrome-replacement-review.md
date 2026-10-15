# Replacing Navidrome

Reviewed 12 October 2026 from [PR 168](https://github.com/LeahyCC/musimo/pull/168) (`feature/local-player`), the committed tree on that branch, and [navidrome/navidrome](https://github.com/navidrome/navidrome) (README, release notes through v0.64.2, the Subsonic compatibility page, and GitHub issues). Uncommitted download and source-status edits in the working tree are outside this review. Counts below were read from the GitHub API and Docker Hub on that date. The follow-up plan is [navidrome-gap-plan.md](navidrome-gap-plan.md).

Musimo's product, from the current README and the original brief, is one person's home app: search, download, tag, and play the files in the music folders. Navidrome's product is a personal streaming server for browsers and other clients.

## Verdict

The local player is a **better replacement for the job Navidrome had inside Musimo**, and a **worse replacement for Navidrome as a streaming server**.

| Dimension                                         | Call     | Why                                                                                                                                                                          |
| ------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One app for search, download, tag, and play       | Better   | A finished download is indexed by `Library.index_published`. Nothing calls a second server's scan.                                                                           |
| Web player                                        | Better   | Gapless handover, a saved queue, lyrics on screen, waveform, ReplayGain, crossfade, sleep timer, Now Playing. Navidrome closed gapless in its own web player as not planned. |
| Day-to-day ops                                    | Better   | Compose no longer needs a playback server, Subsonic credentials, or a second library watcher.                                                                                |
| Album grouping                                    | Better   | An album is album artist plus album name. Navidrome's grouping has thrown away stars and split compilations across several releases.                                         |
| Files you already play in a browser on the LAN    | Equal    | Browse, stream with ranges, art, playlists, stars, and play counts all exist.                                                                                                |
| An existing Navidrome install's listening history | Behind   | Playlists, favourites, play counts, and the saved queue do not come across.                                                                                                  |
| Phone, car, and offline clients                   | Behind   | There is no Subsonic (or Jellyfin) API. A phone can use the responsive site. It cannot use the apps Navidrome is starred for.                                                |
| Formats the browser cannot decode                 | Behind   | The stream route sends the file. Navidrome transcodes per player.                                                                                                            |
| Smart playlists and external scrobbling           | Behind   | Manual playlists and a local play count exist. Rule playlists and Last.fm / ListenBrainz do not.                                                                             |
| Very large mixed libraries                        | Unproven | A synthetic 50,000-file scan is measured. The player catalog at that size is not. The cited real index is 3,681 files.                                                       |

Keep Navidrome beside Musimo only if phone apps, offline sync, or the old playlists and play counts still matter. For listening in this browser, the branch is the better player and the smaller system.

## Why Navidrome is starred

Observed 12 October 2026: **24,116 stars**, **1,755 forks**, **302 open issues**, **97 watchers**. The repo was created 24 February 2016, is written in Go, and is GPL-3.0. The latest release is **v0.64.2**, published 24 September 2026. The Docker image `deluan/navidrome` showed **58,247,276 pulls** and 361 Hub stars the same day. Pulls count image downloads, including retags, so the figure is a ceiling on popularity. The README description is "Your Personal Streaming Service" and the pitch is "like your personal Spotify": any browser or mobile device, your own files.

What the README and docs sell, which matches how people use it:

- A library that watches the music folder, reads metadata, and is meant to handle large collections at low resource use, with binaries, Docker, and a Raspberry Pi build.
- A Subsonic-compatible API (documented as Subsonic API v1.16.1 plus OpenSubsonic extensions) so existing phone, desktop, and car clients work. v0.64.0 added an experimental Jellyfin music API for clients such as Finamp.
- Multi-user accounts, each with play counts, playlists, and favourites. Multi-library with per-user access shipped in v0.58.0.
- On-the-fly transcoding, configurable per user and player, including Opus.
- Lyrics from several sidecar types (`.ttml`, `.yaml` / `.yml`, `.elrc`, `.lrc`, `.srt`, `.txt`) and embedded tags.
- A themeable web UI, translations, compilations, and box sets.

The issue tracker shows what people ask for once that base exists. These are the high-reaction requests:

| Issue                                                                                   | Reactions                                      | State on 12 Oct 2026                      | What it says people value                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| [#141](https://github.com/navidrome/navidrome/issues/141) LDAP                          | 148 (122 +1), 74 comments, open since Apr 2020 | Open                                      | Shared logins for a household or a small org     |
| [#192](https://github.com/navidrome/navidrome/issues/192) Multiple music folders        | 106 +1, 72 comments                            | Closed Jul 2025, shipped as multi-library | More than one collection, with access control    |
| [#858](https://github.com/navidrome/navidrome/issues/858) OIDC                          | 103 reactions                                  | Closed Aug 2025                           | Same auth demand as LDAP                         |
| [#2394](https://github.com/navidrome/navidrome/issues/2394) SSO, round 2                | 65 reactions, 35 comments                      | Open                                      | Auth is still the loudest open request           |
| [#1417](https://github.com/navidrome/navidrome/issues/1417) Smart playlists             | 86 reactions, 47 +1, 232 comments              | Closed Apr 2025                           | Rules on top of a library you already browse     |
| [#1421](https://github.com/navidrome/navidrome/issues/1421) External `.lrc`             | 56 +1                                          | Closed May 2025                           | Lyrics beside the files                          |
| [#238](https://github.com/navidrome/navidrome/issues/238) Multiple artists              | 51 reactions, 50 +1, 59 comments               | Closed Mar 2025                           | Tags that match how albums are actually credited |
| [#406](https://github.com/navidrome/navidrome/issues/406) Playlist cover art            | 49 reactions, 44 +1                            | Closed Mar 2026                           | Playlists that look like albums                  |
| [#211](https://github.com/navidrome/navidrome/issues/211) Browse track artists          | 38 reactions                                   | Closed Mar 2025                           | Artists who are not the album artist             |
| [#748](https://github.com/navidrome/navidrome/issues/748) Share a subset of the library | 31 +1                                          | Closed Jan 2023                           | Hand someone part of the collection              |

The code also contains a scanner, a tag reader, ReplayGain, jukebox mode, and a simulated folder browser. Those are implementation. The star count follows the product sentence: your files, in the clients you already like, without running a heavy stack. Auth and smart playlists are the features people kept asking for after that sentence was true. Musimo's brief is one person on a home LAN, so LDAP, SSO, sharing, and multi-user are real Navidrome strengths and weak reasons to keep it for this app.

## Navidrome's real problems

Recurring pain, from release notes and issues that came back in new forms:

**Album identity keeps moving, and listening history falls off.** v0.50.0 made "split albums by release" the default and warned that "Navidrome will think all albums are new, and they will lose their star/love information, as well as play counts." v0.55.0 replaced that switch with persistent IDs and stated that artist favourites and artist ratings are lost on upgrade. v0.58.0's multi-library schema cannot be undone by downgrading; the notes tell you to back up `navidrome.db` first. v0.64.0 re-encoded every internal id and again says to back up, because clients that cached ids (offline downloads included) may need to re-download. The same theme shows up as bugs: compilations exploding when tracks carry different dates ([#3949](https://github.com/navidrome/navidrome/issues/3949), 17 comments), FLAC and MP4 copies of one album landing apart ([#4300](https://github.com/navidrome/navidrome/issues/4300), 19 comments, closed June 2026), and the long thread on versions of the same album ([#1976](https://github.com/navidrome/navidrome/issues/1976), 76 comments; [#489](https://github.com/navidrome/navidrome/issues/489), 31 comments). People want compilations and box sets. The implementation has repeatedly redefined what an album is.

**The scanner and SQLite fight the disk.** v0.64.2's own summary is a fix for floods of `database is locked`, UI freezes, and failed full scans on slow storage (USB and remote drives) since 0.64.0. [#6171](https://github.com/navidrome/navidrome/issues/6171) (18 comments) is that report; it was closed with 0.64.2. A corrupt FTS5 table that fails every scan until dropped is still open ([#6067](https://github.com/navidrome/navidrome/issues/6067)). A full scan that used 10–16 GB decoding JPEGs took 34 comments ([#3408](https://github.com/navidrome/navidrome/issues/3408), closed). A bad BPM tag still aborts a scan with `NOT NULL constraint failed: media_file.bpm` ([#5747](https://github.com/navidrome/navidrome/issues/5747), open, 9 comments). A track number of `4294967295` corrupted a database ([#6200](https://github.com/navidrome/navidrome/issues/6200), opened and closed 22 September 2026). The watcher does not see SMB shares ([#5491](https://github.com/navidrome/navidrome/issues/5491), closed after a short thread). An empty mount is deliberately not scanned, so a missing disk does not wipe playlists and stars; the maintainer said so on [#3007](https://github.com/navidrome/navidrome/issues/3007). That guard is good. The surrounding scanner is where upgrades and odd tags still hurt.

**The web UI is the face of the project and the weak player.** Gapless playback ([#745](https://github.com/navidrome/navidrome/issues/745), 20 +1) was closed `not_planned` on 10 September 2023. The maintainer's first reply is that the web player came from another project. Later comments point people at Subsonic clients (DSub, iSub, Feishin) for gapless. Remembering the queue and position ([#245](https://github.com/navidrome/navidrome/issues/245)) has been open since 28 April 2020. It has 21 comments and 4 +1: open since 2020, and never a highly voted request. External `.lrc` files are served by the API and still missing in the web player ([#4148](https://github.com/navidrome/navidrome/issues/4148), 14 reactions, open; [#5531](https://github.com/navidrome/navidrome/issues/5531), 7 comments, open). The loved playback experience is largely other people's clients.

**Transcoding is a feature and a compatibility surface.** [#6170](https://github.com/navidrome/navidrome/issues/6170) (open, September 2026) is MP3 transcodes with no duration, no `Content-Length`, and `Accept-Ranges: none`. Browsers also fail specific files even before transcoding: ALAC in `.m4a` ([#813](https://github.com/navidrome/navidrome/issues/813)) and FLAC with ID3 tags in Firefox ([#1149](https://github.com/navidrome/navidrome/issues/1149)). Both are old and closed; they are why a server that can transcode stays useful.

One-off or narrow, and not worth designing around: playlist rows going empty after the 0.55.2 → 0.56.0 upgrade ([#4136](https://github.com/navidrome/navidrome/issues/4136), 2 comments, closed the same day), M3U backslashes on Linux ([#3511](https://github.com/navidrome/navidrome/issues/3511)), the web player stalling on Cloudflare HTTP/3 ([#3611](https://github.com/navidrome/navidrome/issues/3611), 12 comments, still open, 2 +1), ReplayGain `0.0` treated as missing ([#4236](https://github.com/navidrome/navidrome/issues/4236)), and a slow `getRandomSongs` ([#5558](https://github.com/navidrome/navidrome/issues/5558)).

Security advisories are a separate pile (sort/filter SQL injection more than once, art `size` exhausting memory, symlink classification, comment tags rendered as HTML). They matter because Navidrome is a multi-user server with a public API. A single-user app that never resizes art and never interpolates sort columns into SQL can refuse that class of bug by not having the feature.

## What Musimo already did well

PR 168 deletes `backend/navidrome.py` (1,168 lines) and adds `backend/library/player.py` (about 1,500 lines) as the thing `backend/api/player_api.py` calls. Schema version 6 stores playlists, playlist songs, artist favourites, play counts, and one play queue. The upgrade deletes `navidrome_url`, `navidrome_mode`, and `navidrome_library_id`. Diagnostics on this commit report a `player` key. `HEAD` of `readiness.ts` treats an absent player as fine and an unavailable player as not ready.

Concrete behaviour, from the code and `docs/player.md`:

- **The download and the library are the same index.** After publish, `index_published` updates the row. There is no Subsonic `startScan`. A file Musimo just wrote is the file the player streams.
- **Song ids survive a rescan.** `song_id` stays on the path. `added_at` is set once. Album and artist ids are `frozen_id` (`musimo-id-v1` plus a hash of the names). Ownership matching uses a separate `normalize()` and can change without moving every album. A retag that changes the album or artist name is a new id. That trade-off is written down.
- **Albums do not split on date, format, or folder.** `album_identity` uses the album artist (or "Various Artists" for a compilation with none) and the album title. Untagged albums group per folder. Tracks sort by disc, then track, then title. The album year is the newest track year.
- **An empty mount does not wipe the library.** `Library._scan` skips prune when a root walks zero audio files and the index already holds rows for it, and the scan detail says so. That is the [#3007](https://github.com/navidrome/navidrome/issues/3007) guard, in the scan Musimo already had.
- **Streaming is the file.** `GET /api/player/stream/{id}` is a `FileResponse` after `local_file` → `_safe_file`: one range, a second range refused, symlink refused, path must resolve inside an enabled root. Content type comes from the row. Art is 404 when missing, with an ETag and a long cache, and the cover id includes size and mtime so a replaced `cover.jpg` changes URL. Embedded art prefers picture type 3. A disc folder (`CD1`, `Disc 2`) looks one directory up. The scan records `has_art` and does not decode the JPEG.
- **The web player does the three things Navidrome's web player does not.** Two library audio elements and a worker clock do the gapless handover (`frontend/src/features/player/handover.ts`). The queue restores from SQLite (`play_queue`, 500 songs) and can be reordered, with Play next, Add to queue, and Save as playlist. Lyrics are a sidecar `.lrc`, then embedded text, then LRCLIB, and Now Playing follows the timed lines. [#4148](https://github.com/navidrome/navidrome/issues/4148) is the Navidrome web UI still not showing the sidecar the API already returns.
- **Listening tools that sit on top of that.** ReplayGain in the browser (`replay-gain.ts`), optional crossfade that stays off between consecutive tracks of one album, a sleep timer, a waveform seek bar (`backend/library/waveform.py`), MilkDrop via butterchurn, an About tab with the file's real path and bitrate, edition grouping on artist pages (`album-editions.ts`), and a phone layout under 768px. Play history in the browser is separate and capped at 200.
- **Search survives short and odd names.** `_fts_usable` sends only tokens of three or more alphanumeric characters to FTS. Anything else, and any FTS miss, scans title, artist, and album in the loaded rows. An FTS error returns no ids and takes the same path.
- **Several roots, one user.** `MUSIMO_LIBRARY_ROOTS` is how more than one folder works. There is no per-user library ACL, which matches the brief.
- **Tests around the contract.** The PR reports 388 backend tests, player tests that stream a finished download with no second server, a version 4 database opening as version 6, and a replaced cover getting a new art URL. Playwright on the isolated stack (178 passed on Chromium, WebKit, and the phone project) covers player, playlists, queue editing, gapless mechanism, lyrics, history, and waveform. The isolated browser pass played, seeked, skipped, restored the queue, and edited a playlist.

The branch also already had, from earlier commits on `feature/local-player` and `main`, the download queue, source pausing, pasted links, podcasts, and library badges. Those are why a second playback server was the odd piece: Musimo was already the place a song was found and filed.

## Gaps vs Navidrome

Ranked by how much they matter for a personal library played at home.

1. **Listening state already stored in Navidrome.** The changelog says playlists, favourites, play counts, and the saved queue from that server do not carry over. `docs/research.md` recorded a live Navidrome 0.63.2 with 2,738 tracks on this machine. The files remain. Years of stars and counts do not, unless someone imports them. That is the sharpest downgrade on the day of the switch.
2. **Clients other than this website.** Subsonic clients are the feature the README leads with, and v0.64.0 extended the same idea to Jellyfin clients. Musimo's phone UI is the same site, narrower. It has no offline sync, no car app, and no second device with its own queue. On the LAN, a phone browser covers a lot of [#245](https://github.com/navidrome/navidrome/issues/245). Away from the house, it does not cover why people install Navidrome.
3. **Transcoding on play.** New downloads can be saved as original, M4A, Opus, or MP3 (`output_format` in settings). The player never converts. ALAC, WMA, and some FLAC files hit "could not be played" and, after three failures, playback stops. Navidrome exists in part so a phone that cannot decode the file still plays it.
4. **Smart playlists.** Musimo has create, rename, reorder, a liked playlist that cannot be deleted, and a mosaic cover. It does not have "added recently", "never played", or a genre rule. That request took 232 comments ([#1417](https://github.com/navidrome/navidrome/issues/1417)) and shipped, still marked beta in the docs. For one person it is more useful than LDAP.
5. **External scrobbling.** `POST /api/player/scrobble` updates `play_count` and `last_played` on the song. It does not tell Last.fm or ListenBrainz. Fine for the app. A loss if those graphs are part of listening.
6. **Lyric sidecar types.** Navidrome reads `.ttml`, YAML, `.elrc`, `.lrc`, `.srt`, and `.txt`. Musimo reads `.lrc` (UTF-8, BOM allowed, bad bytes replaced) and embedded lyrics, then LRCLIB. Display in the player is ahead. A library full of `.ttml` sidecars would look lyric-less until LRCLIB hits.
7. **Artist pages.** Albums are where this person is the album artist. "Appears on" and a browsable list of every track artist are absent ([#4688](https://github.com/navidrome/navidrome/issues/4688), [#211](https://github.com/navidrome/navidrome/issues/211)). Featured-artist linking exists only as `linked_artist` when choosing which artist page a song opens.
8. **Multi-user, sharing, LDAP, jukebox, translations.** Real Navidrome features. The brief is one person. They rank last here.

A moved or renamed file becomes a new song, and playlist rows, play counts, and queue entries for the old id go with it (`ON DELETE` cleanup in the prune path). Navidrome's persistent IDs were built to stop that ([#2068](https://github.com/navidrome/navidrome/issues/2068)). v0.61.0 then had to stop duplicate tracks when several missing files matched one new file ([#5183](https://github.com/navidrome/navidrome/pull/5183)). Upgrades in between had already dropped favourites (v0.50.0, v0.55.0, v0.64.0). Leaving moves as new songs is a written limit.

## What needs improvement inside the replacement

These are problems in the branch itself.

**The player materializes the whole library.** `LibraryPlayer.view` caches one `LibraryView`: every track dict, every album, every artist, plus the stored rows. `_build` groups them in Python. Cover lookup lists album directories (`_rank_images` → `iterdir`) while building that view. Restoring the queue calls `_catalog()`, so opening the player pays for the full build. `docs/measurements.md` shows a synthetic 50,000 tiny-WAV scan in about 45 seconds and an unchanged rescan around 30 seconds. It also says the real Windows index is **3,681 files**, and a mixed-format 50,000-file library was not tested. The scan can get through a large fake tree. The player view is a different cost, and it is unmeasured. Navidrome's "large collections" claim is the bar this will hit first.

**Unplayable files are discovered by failing playback.** The status line says the track was skipped, and three failures stop the queue. Nothing on the album marks the file before you press play. With no transcoder, that is the whole recovery path.

**Two histories.** The server stores `play_count` and `last_played`. The History tab is `localStorage` (`musimo.play-history`), this browser only, 200 rows, and it records a play after 10 seconds. They will disagree across browsers and after a cleared site. The About tab reads the server. The History tab does not.

**Gapless and crossfade are proven as a mechanism.** The suite does not hear the join. `docs/player.md` says the suite cannot hear the join, and that iOS may refuse to start the standby element until a tap. The PR's Firefox project did not launch (`Could not find profile folder`). The live install (Colima, port 8765, volume `musimo_musimo-data`) was not rebuilt, because version 6 is one-way and an older build will refuse the upgraded database. The isolated stack on port 18765 is what was actually played.

**Playlist and queue limits are hard.** 500 songs in a queue, and a create of 500 songs. Play all on a bigger filtered library takes the first 500 in sort order. Shuffle past that uses a server-side window and a seed kept for a day. That is coherent. A long mix or a large genre shuffle hits that ceiling and the status line says the add was refused.

**Artist favourites are names.** `artist_favourites` is keyed by the frozen artist id. Renaming the album artist drops the star. The docs say so. The UI does not warn when a retag will do it.

**Art is the original bytes.** There is no `size` parameter, which avoids Navidrome's art-resize advisories. A large embedded cover is still sent whole to every grid cell. `docs/player.md` already notes this as a follow-up if album grids get slow.

**Schema 6 has no down migration.** The changelog and README say to back up first. That is the same operational warning Navidrome prints on its breaking releases. It is acceptable. Shipping it without playing the real library first is the part that is still open.

## Suggestions

Each item is either a Navidrome strength worth a narrow copy, or a Navidrome failure this design can refuse.

### Now

1. **Decide the old listening state in the open.** Either a one-time import from the existing Navidrome database (playlists, song stars if present, play counts, and the queue, mapped onto `tr-` ids by path or by artist/album/title/duration) or a written "starting fresh" note next to the upgrade. Navidrome's own upgrades have wiped this data more than once (v0.50.0, v0.55.0, v0.64.0). Doing it once, into frozen ids, with the backup the changelog already requires, is how the switch stops being a reset. `docs/research.md`'s 2,738-track library is the reason this is first.
2. **Play the real collection on the live install** after that backup. PR 168 stopped at the isolated stack. Navidrome is trusted because it has been run on slow disks and odd tags. The replacement is not done until this library's albums open, a known file seeks, and a finished download shows up beside older files.
3. **Show unplayable files before they skip.** A suffix or codec the common browsers cannot decode should be visible on the row. For those files only, reuse the ffmpeg path downloads already have (`output_format`) as an explicit convert, or document that the collection must already be in a browser format. That is the useful slice of Navidrome transcoding. Per-user, per-player transcode profiles are the part that produced [#6170](https://github.com/navidrome/navidrome/issues/6170).
4. **Listen to a live album or a DJ mix** in the browsers you actually use, including a hidden tab and a phone. The gapless tests check which element starts. [#745](https://github.com/navidrome/navidrome/issues/745) is the complaint this branch claims to beat, and the docs already say the suite cannot hear it.

### Next

5. **Four smart lists, stored as filters.** Recently added (`added_at`, written once, which avoids [#2650](https://github.com/navidrome/navidrome/issues/2650)), never played, most played, and one genre. Compute them from song rows at read time so there is no stored album total to go stale. [#1417](https://github.com/navidrome/navidrome/issues/1417) is the demand. Navidrome's beta rules and the empty-playlist upgrade ([#4136](https://github.com/navidrome/navidrome/issues/4136)) are the version to skip.
6. **Optional ListenBrainz or Last.fm on the existing scrobble call.** `last_played` already moves only forward, which is the fix for [#2262](https://github.com/navidrome/navidrome/issues/2262). Keep it off unless a key is set. Do not block local play counts on the network.
7. **Browse from SQL.** Albums, artists, and a page of tracks should be queries, with the in-memory `LibraryView` reserved for a small overlay (stars, the open album). Cover directory reads should happen for the page on screen, not for every album on each revision. This is the way to approach Navidrome's large-library claim while refusing the scanner that decoded every JPEG ([#3408](https://github.com/navidrome/navidrome/issues/3408)) and locked SQLite on slow storage ([#6171](https://github.com/navidrome/navidrome/issues/6171)). Keep the single writer and the empty-mount guard.

### Later

8. **Reattach a moved file only as an explicit repair.** Match on tags and duration, refuse the match when two missing files fit one new file, and leave it off by default. Navidrome's automatic move detection duplicated tracks. Musimo's random `song_id` is already the right id. The missing piece is a repair tool.
9. **Treat the phone site plus Tailscale as the remote client** until a real session needs offline or a car. A read-only Subsonic facade is a large product. LDAP ([#141](https://github.com/navidrome/navidrome/issues/141)) and library sharing ([#748](https://github.com/navidrome/navidrome/issues/748)) stay out. The starred quality is "listen from the phone", and the phone layout is already there.
10. **More lyric sidecars only if this library has them.** `.ttml` and `.elrc` matter if the files are already beside the albums. They do not matter while LRCLIB and embedded LRC cover what Musimo's tagger writes. Navidrome's web player still fails to show `.lrc` it has parsed ([#4148](https://github.com/navidrome/navidrome/issues/4148)). Do not trade the on-screen lyrics away to match the sidecar list.

Leave in place: frozen ids, the empty-root prune guard, no art `size` parameter, sort columns as fixed SQL, symlink checks at request time, and tag text rendered as text. Those are the Navidrome failures this branch already refused.
