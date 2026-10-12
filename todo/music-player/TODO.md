# Music player: Musimo plays its own files

Musimo stops using Navidrome for playback. The scan Musimo already runs becomes the player's library, and the routes in `backend/api/player_api.py` keep their paths and the JSON shapes in `frontend/src/api.ts`. Only where the data comes from changes. This overrules the brief's choice of Navidrome as the library target. Navidrome is not installed, embedded or put in the image.

Branch: `feature/local-player`, from `origin/main`, in this checkout (no worktree).

## Status

- [x] Branch created: `feature/local-player` from `origin/main` (`e54cab4`). The file-layout reorganisation from `reorganize-file-layout` was the starting point and is committed as `989fa0c`. Paths in this file are the reorganised ones: backend modules under `backend/api/`, `backend/core/`, `backend/integrations/`, `backend/jobs/` and `backend/library/`, frontend screens under `frontend/src/features/`, with `frontend/src/api.ts` unmoved.
- [x] The reorganisation is finished as far as it can go before this work. Its second pass moved every route into `backend/api/` (`main.py` now only wires the app), pulled the pure browse helpers out of `navidrome.py` into `backend/library/browse.py` and `lyric_lines` into `backend/library/lyrics.py`, moved `normalize()` to `backend/core/text.py`, and split `downloads.tsx`, `search.tsx` and `user-settings.tsx` on the frontend. Left for after this branch, because this work rewrites the same files: helpers out of `player.tsx`, the footer player out of `PlayerProvider`, splitting `LibraryPage`, and `worker.py`'s `main()`.
- [x] The reorganisation passes `tsc` and mypy. `library.tsx` lost its unused `Pause` and `Play` imports. The two large test files could not be edited, so `backend/jobs/downloads.py` re-exports `digest` and `publish_file`, and `backend/library/navidrome.py` re-exports `sort_artists`, for the imports those tests still use.
- [ ] When `tests/test_downloads.py` is next edited, import `digest`/`publish_file` from `backend.jobs.publish` and delete that re-export. `tests/test_player.py` already imports `sort_artists` from `backend.library.browse`. `navidrome.py` is gone, and with it the `sort_artists` re-export.
- [x] Reorganisation committed on its own as `989fa0c`, with the `library.tsx` icon cleanup and the two re-exports staged into it.
- [x] Test baseline after the macOS fixes: the reorganised tree had the same 18 failures as `main`, all from macOS. 15 came from `publish_file` calling `renameat2`, which macOS lacks; 3 from destination tests whose temp folder sits behind macOS's `/var` symlink. Both are fixed (`backend/jobs/publish.py` uses `renamex_np` on macOS; `tests/test_foundation.py` resolves its temp folder). At that point, 379 backend tests passed (1 Windows-only skip).
- [x] macOS fixes committed as `32a7899`, right after the reorganisation.
- [x] Back-merged the pause between groups of downloads (`05d4733`, `c5cc214`) as `6c0132c`, on top of `32a7899`. That adds the five `PaceTests` in `tests/test_downloads.py`. Schema version 5 (`pace_started`, `pace_until`) is on this branch because of that merge, which is why the player upgrade is version 6.
- [x] Current baseline, re-run on 2026-10-10: 384 backend tests pass, 1 Windows-only skip (`test_windows_stop_also_terminates_worker_children`). Any failure from here on is new.
- [x] The hook that echoes a large edit back as JSON was truncating that JSON and fail-closing. `run-with-flags.js` now answers `{"permission":"allow"}` when the payload is over 48 KB, so `player.tsx`, `library.tsx`, `tests/test_player.py` and `tests/test_downloads.py` can be edited.

## What Navidrome taught us

Read on 2026-10-06 from every release from v0.47.5 to v0.64.2 and the 28 published security advisories at [navidrome/navidrome](https://github.com/navidrome/navidrome). The issues review is under "From the issue tracker" below.

### From the release notes and advisories

Good, and worth copying:

- **Sidecar lyrics win.** The default `LyricsPriority` is `.ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded` ([v0.63.0](https://github.com/navidrome/navidrome/releases/tag/v0.63.0)). Its LRC parser learned to skip a byte-order mark ([v0.58.5](https://github.com/navidrome/navidrome/releases/tag/v0.58.5)), sort repeated lines ([v0.52.5](https://github.com/navidrome/navidrome/releases/tag/v0.52.5)) and ignore `[bg:]` and unknown tags ([v0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0)). Musimo: `.lrc` beside the file, then embedded, then LRCLIB, and a tolerant `lyric_lines`.
- **Art falls back from track to album** ([v0.61.0](https://github.com/navidrome/navidrome/releases/tag/v0.61.0)). The embedded picture typed "front cover" is chosen ([v0.54.1](https://github.com/navidrome/navidrome/releases/tag/v0.54.1)). `cover.jpg` beats `cover.1.jpg` ([v0.59.0](https://github.com/navidrome/navidrome/releases/tag/v0.59.0)), and the album folder beats its disc subfolders ([v0.62.0](https://github.com/navidrome/navidrome/releases/tag/v0.62.0)). Musimo: pick picture type 3 when a file holds several. For a file in `CD1`/`Disc 2`, also look one folder up.
- **Cover ids carry a version**, so a changed cover is never served stale ([v0.49.2](https://github.com/navidrome/navidrome/releases/tag/v0.49.2), [v0.62.0](https://github.com/navidrome/navidrome/releases/tag/v0.62.0)). Musimo already strips Navidrome's `ar-<id>_<n>` suffix. Musimo: cover id = owner id + `_` + a short value derived from the source's size and mtime. Then the art response can be cached for a long time.
- **ReplayGain**: R128 tags read ([v0.53.0](https://github.com/navidrome/navidrome/releases/tag/v0.53.0)), NaN ignored ([v0.55.2](https://github.com/navidrome/navidrome/releases/tag/v0.55.2)), empty values allowed ([v0.57.0](https://github.com/navidrome/navidrome/releases/tag/v0.57.0)). Musimo: nullable columns; an unparsable value is absent, never 0.
- **Albums order by disc, then track** ([v0.56.0](https://github.com/navidrome/navidrome/releases/tag/v0.56.0)), and "year 0" is not shown ([v0.58.0](https://github.com/navidrome/navidrome/releases/tag/v0.58.0)). Musimo: sort by disc, track, title. Clamp track, disc and year at scan time; [v0.64.2](https://github.com/navidrome/navidrome/releases/tag/v0.64.2) still fixed a bad track number breaking scans.
- **An explicit MIME map**, fixed over time: `audio/aac` ([v0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0)), WAV in browsers ([v0.61.2](https://github.com/navidrome/navidrome/releases/tag/v0.61.2)), a missing `Content-Type` ([v0.64.2](https://github.com/navidrome/navidrome/releases/tag/v0.64.2)). Raw files go through Go's `http.ServeContent` (range support). Only transcodes estimate a length ([media_streamer.go](https://github.com/navidrome/navidrome/blob/master/core/stream/media_streamer.go)). Musimo: exact length from the file, every response typed, each format tried in Chrome, Firefox and Safari.
- **Skip junk folders**: `$RECYCLE.BIN` ([v0.50.0](https://github.com/navidrome/navidrome/releases/tag/v0.50.0)), Synology `#snapshot` ([v0.53.0](https://github.com/navidrome/navidrome/releases/tag/v0.53.0)) and `@eaDir` ([v0.64.2](https://github.com/navidrome/navidrome/releases/tag/v0.64.2)). Musimo already skips dot folders. Add these names to the walk and the watcher.
- **The play queue is one record** of ordered ids, the current one and an integer position, and missing songs are skipped on restore ([v0.53.2](https://github.com/navidrome/navidrome/releases/tag/v0.53.2), [v0.58.5](https://github.com/navidrome/navidrome/releases/tag/v0.58.5)). Last played only moves forward ([v0.50.0](https://github.com/navidrome/navidrome/releases/tag/v0.50.0)). Musimo: same.

Bad, and to avoid:

- **Changing album identity loses favourites and play counts.** v0.50.0 split albums by release date by default, and "Navidrome will think all albums are new, and they will lose their star/love information, as well as play counts" ([v0.50.0](https://github.com/navidrome/navidrome/releases/tag/v0.50.0)). The big refactor lost artist favourites and ratings and could regroup albums ([v0.55.0](https://github.com/navidrome/navidrome/releases/tag/v0.55.0)). The multi-library upgrade could lose them again and could not be undone by downgrading ([v0.58.0](https://github.com/navidrome/navidrome/releases/tag/v0.58.0)). Then every id was re-encoded ([v0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0)). Musimo: settle the id rules in this branch and treat them as permanent. Album and artist ids must not hash `normalize()` from `backend/core/text.py`, because ownership matching shares it and will keep changing. Give ids their own frozen function, with a version prefix in case it ever has to change.
- **Move detection is hard.** It made duplicate tracks when several missing files matched one new file ([v0.61.0](https://github.com/navidrome/navidrome/releases/tag/v0.61.0)). Navidrome needed "missing files" screens, `Scanner.PurgeMissing` ([v0.56.0](https://github.com/navidrome/navidrome/releases/tag/v0.56.0)) and `missing fix` commands ([v0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0)). Musimo deliberately does none of this: the brief accepts that a moved file is a new song. Write the trade-off in `docs/player.md`.
- **Stale album and artist totals** after quick scans and after deleting missing files ([v0.57.0](https://github.com/navidrome/navidrome/releases/tag/v0.57.0), [v0.58.5](https://github.com/navidrome/navidrome/releases/tag/v0.58.5)). Musimo works albums and artists out from song rows at read time, so there is no stored total to go stale. Keep it that way.
- **SQLite lock contention** came back release after release ([v0.53.0](https://github.com/navidrome/navidrome/releases/tag/v0.53.0) then reverted in [v0.54.1](https://github.com/navidrome/navidrome/releases/tag/v0.54.1); [v0.60.0](https://github.com/navidrome/navidrome/releases/tag/v0.60.0) "Expression tree is too large"; [v0.64.2](https://github.com/navidrome/navidrome/releases/tag/v0.64.2) floods of `database is locked`). Musimo already has one writer behind a lock and batched writes (`STAMP_BATCH`). Keep player reads short. Pass id lists through `json_each` rather than long `IN (...)` lists. Never hold the store lock while reading a file for art or lyrics.
- **FTS5 search lost short and non-ASCII names** ([v0.63.0](https://github.com/navidrome/navidrome/releases/tag/v0.63.0)). Musimo's Tracks search will sit on `library_fts`. Test "MØ", "AC/DC", "Ry X" and a two-letter name, and fall back to `LIKE` where FTS cannot match.
- **Migrations broke on odd data** ([v0.49.3](https://github.com/navidrome/navidrome/releases/tag/v0.49.3), [v0.51.1](https://github.com/navidrome/navidrome/releases/tag/v0.51.1), [v0.55.1](https://github.com/navidrome/navidrome/releases/tag/v0.55.1)), and `restore` once wiped a database ([v0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0)). Musimo: test the version 6 upgrade on a version 5 database that has blank tags, non-UTF-8 paths and a stale liked-playlist link. Version 5 is already the pause between groups of downloads.
- **Security:**
  - Files were classified by a symlink's name, so `x.wav` pointing at `/etc/passwd` was indexed and streamed ([GHSA-r5qr-m328-qcf4](https://github.com/navidrome/navidrome/security/advisories/GHSA-r5qr-m328-qcf4), medium, fixed 0.63.0). Musimo's walk skips symlinks and `index()` checks `resolve()`. The stream and art routes must check again at request time.
  - SQL injection through sort and filter values came back three times ([GHSA-58vj-cv5w-v4v6](https://github.com/navidrome/navidrome/security/advisories/GHSA-58vj-cv5w-v4v6), [GHSA-5wgp-vjxm-3x2r](https://github.com/navidrome/navidrome/security/advisories/GHSA-5wgp-vjxm-3x2r), [GHSA-hm54-32q6-3rcr](https://github.com/navidrome/navidrome/security/advisories/GHSA-hm54-32q6-3rcr)). Musimo: map the sort names `backend/api/player_api.py` already validates onto fixed `ORDER BY` text, and bind every value as a parameter.
  - An unbounded art `size` exhausted memory and disk ([GHSA-hrr4-3wgr-68x3](https://github.com/navidrome/navidrome/security/advisories/GHSA-hrr4-3wgr-68x3), critical; [GHSA-f22h-6qxh-rqq2](https://github.com/navidrome/navidrome/security/advisories/GHSA-f22h-6qxh-rqq2)). Musimo serves no resized images, so the art route takes no size. If it ever does, use a fixed list.
  - Comment tags were rendered as HTML ([GHSA-rh3r-8pxm-hg4w](https://github.com/navidrome/navidrome/security/advisories/GHSA-rh3r-8pxm-hg4w)). Tag text is untrusted. Check that nothing renders tags or lyrics through `dangerouslySetInnerHTML`.
  - Several advisories are about users, shares, players and multiple libraries. Musimo has none of those, by the brief.

Not found in the release notes: anything on gapless playback, range-request history, or an artist image falling back to album art.

### From the issue tracker

About 140 open and closed issues, read with the maintainer's replies. 👍 counts are as of 2026-10-06.

Good, and worth copying:

- **An empty music folder must not wipe the database.** Navidrome leaves the database alone when the music folder is completely empty, "to prevent nuking your DB (and all playlists, stars, play counts, etc...), when your Music Folder is on a mounted folder and the mount is not available yet" ([#3007](https://github.com/navidrome/navidrome/issues/3007)). Musimo's scan skips a root that is not a directory. But a mount point that exists and is empty walks clean, so `_prune` deletes every row under it. Once playlists, plays and the queue hang off song ids, that prune would erase them. Musimo: do not prune a root whose walk found no audio while the index holds rows for it, and say so in the scan detail.
- **Split artists carefully.** Prefer multi-valued `ARTISTS`/`ALBUMARTISTS` tags. Split a single string only on spaced separators (`" / "`, `" feat. "`), so "AC/DC" stays whole. Keep the display string for showing ([#238](https://github.com/navidrome/navidrome/issues/238), 👍50). Musimo: the Artists view stays album artists, so splitting only matters for a song's own `artistId`.
- **A 404 for missing art is what clients want**, not a placeholder picture ([#2575](https://github.com/navidrome/navidrome/issues/2575), 👍10, open). Musimo already plans a 404, and the browser draws its own icon.
- **Range answers must be exact.** A client's `bytes=<filesize>-` was correctly refused with 416 ([#2287](https://github.com/navidrome/navidrome/issues/2287)). Musimo: test that case and `bytes=0-1`.
- **What Musimo already does better.** Navidrome's web player never had gapless playback ([#745](https://github.com/navidrome/navidrome/issues/745), 👍20, closed as not planned) and never saved its queue ([#245](https://github.com/navidrome/navidrome/issues/245), open since 2020). Sidecar `.lrc` lyrics are returned by its API but not shown in its own player ([#4148](https://github.com/navidrome/navidrome/issues/4148), 👍13). Musimo has all three in the browser. The work here is not to lose them.

Bad, and to avoid:

- **Albums split by date or file format.** Navidrome's album key includes the release date, so a compilation whose tracks carry different `DATE` tags "exploded" into many albums ([#3949](https://github.com/navidrome/navidrome/issues/3949)). FLAC and MP4 copies of one album split over tag aliases ([#4300](https://github.com/navidrome/navidrome/issues/4300)). This is the longest-running tag complaint ([#1976](https://github.com/navidrome/navidrome/issues/1976), 💬76; [#489](https://github.com/navidrome/navidrome/issues/489)). Musimo: album artist plus album name only. Date, format and folder never split an album, and the album's year is its newest track's.
- **An artist page that mixes "album artist" and "appears on"** puts a soundtrack under a band for one credit ([#4688](https://github.com/navidrome/navidrome/issues/4688)). Musimo: an artist page lists albums where they are the album artist. "Appears on" would be a screen change, so it is left out.
- **Path-based ids lost stars, plays and playlist entries on every move or rename** ([#2068](https://github.com/navidrome/navidrome/issues/2068), 👍7; [#2149](https://github.com/navidrome/navidrome/issues/2149)). Musimo's ids are random, not derived from the path. But the brief still makes a moved file a new song, so the outcome on a move is the same. Write it down; re-attaching moved files is a later option.
- **"Recently added" scrambled** when re-imports overwrote timestamps ([#2650](https://github.com/navidrome/navidrome/issues/2650), open). Musimo: `added_at` is written once and never updated.
- **Bad tags made files vanish or scans fail** (51 songs missing in [#5037](https://github.com/navidrome/navidrome/issues/5037), `NOT NULL constraint failed: media_file.bpm` in [#5747](https://github.com/navidrome/navidrome/issues/5747), a track number of `4294967295` in [#6200](https://github.com/navidrome/navidrome/issues/6200)). Musimo's scan already counts a bad file as an error and moves on. New columns get defaults or allow null, and numbers are clamped.
- **Scans ate 10 to 16 GB decoding JPEGs** ([#3408](https://github.com/navidrome/navidrome/issues/3408), 💬34). Musimo: the scan records whether a file has a picture and never decodes it.
- **Browsers cannot play some files.** ALAC in `.m4a` plays in no browser except Safari ([#813](https://github.com/navidrome/navidrome/issues/813)), and FLAC with ID3 tags fails in Firefox ([#1149](https://github.com/navidrome/navidrome/issues/1149)). With no transcoding, these hit the player's existing "could not be played" skip. Musimo: record it as a known limit in `docs/player.md`, not a bug to fix here.
- **A dropped connection skipped the track**, because the browser fires `error` and then `ended` ([#6170](https://github.com/navidrome/navidrome/issues/6170)). Musimo's player also skips on error. Resuming with a `Range` from the current position would be a player change, so it is left out; record it as a follow-up.
- **Lyrics files in other encodings**: users converted GBK `.lrc` files to UTF-8 by hand ([#5531](https://github.com/navidrome/navidrome/issues/5531)). Musimo: read `.lrc` as UTF-8 with a byte-order mark allowed and bad bytes replaced, never an error.
- **ReplayGain of `0.0` was treated as missing** ([#4236](https://github.com/navidrome/navidrome/issues/4236)). Musimo: null and 0 are different values.
- **Out-of-order scrobbles moved last played backwards** ([#2262](https://github.com/navidrome/navidrome/issues/2262)). Musimo: `last_played = max(last_played, now)`.
- **SQLite locks and corruption.** A periodic `ANALYZE` held the write lock for 5.5 minutes, and one busy timeout aborted a 4-hour scan ([#6171](https://github.com/navidrome/navidrome/issues/6171)). A corrupt FTS5 table failed every scan until it was dropped ([#6067](https://github.com/navidrome/navidrome/issues/6067)). Musimo never runs `ANALYZE` and keeps one writer. Make `library_fts` rebuildable from `library_files`, since it is only an index.
- **Random order through `ORDER BY` a function sorted the whole table** ([#5558](https://github.com/navidrome/navidrome/issues/5558)). Musimo's shuffle shuffles ids in Python. Keep it there.

Most-wanted features, by 👍, and where Musimo stands: LDAP ([#141](https://github.com/navidrome/navidrome/issues/141), 122), SSO and OIDC ([#2394](https://github.com/navidrome/navidrome/issues/2394), [#858](https://github.com/navidrome/navidrome/issues/858)) and per-user sharing ([#748](https://github.com/navidrome/navidrome/issues/748)) are out of scope with no login or users. Multiple music folders ([#192](https://github.com/navidrome/navidrome/issues/192), 106) Musimo has through `MUSIMO_LIBRARY_ROOTS`. Sidecar `.lrc` ([#1421](https://github.com/navidrome/navidrome/issues/1421), 56) is in this branch. Multiple artists ([#238](https://github.com/navidrome/navidrome/issues/238), 50) and browseable track artists ([#211](https://github.com/navidrome/navidrome/issues/211), 35) are partly in, through the `artistId` rule. Smart playlists ([#1417](https://github.com/navidrome/navidrome/issues/1417), 47) and playlist cover art ([#406](https://github.com/navidrome/navidrome/issues/406), 44) are later; Musimo already draws a playlist mosaic.

Not verified by the review: maintainer causes for [#4136](https://github.com/navidrome/navidrome/issues/4136) (every playlist empty after 0.56), [#5491](https://github.com/navidrome/navidrome/issues/5491) (no watcher events on SMB), [#3511](https://github.com/navidrome/navidrome/issues/3511) and [#3611](https://github.com/navidrome/navidrome/issues/3611). GitHub Discussions were not read.

## What Navidrome supplies today

Every route in `backend/api/player_api.py` calls one `Navidrome` object (`backend/library/navidrome.py`) through `install_player_routes(app, lambda: navidrome)`. A local class with the same public methods can replace it without touching the routes:

| Today (Subsonic call) | Methods on `Navidrome` | Becomes |
| --- | --- | --- |
| `ping` | `capabilities` | local player status |
| `getArtists`, `getAlbumList2` | `catalog`, `browse_albums`, `browse_artists`, `album`, `artist`, `artist_tracks` | SQL over the extended `library_files` |
| `search3` | `tracks`, `snapshot`, `walk_tracks`, `walk_tail`, `browse_tracks`, `select_tracks`, `shuffle_window`, `tracks_by_ids` | SQL plus `library_fts`; shuffle seeds stay in memory |
| `getSong` | `song` | one row, with the file facts the About tab reads |
| `star`, `unstar` | `favourite_artist` | `artist_favourites` table |
| `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist` | playlist methods, `linked_playlist`, `liked_id` | `playlists` and `playlist_songs` tables; `linked_playlists` stays |
| `getPlayQueue`, `savePlayQueue` | `play_queue`, `save_play_queue` | `play_queue` tables, 500 songs |
| `scrobble` | `scrobble` | play count and last played on the song |
| `getLyricsBySongId` | `lyrics` | file's own lyrics, then LRCLIB (unchanged) |
| `getCoverArt` | `cover_art`, `is_placeholder` | embedded art or a cover image beside the file |
| `stream` | `media` | the file itself, one byte range |
| `startScan` | `start_scan` (from `Downloads.navidrome`) | removed; `Library.index_published` already indexes the file |

Other readers of Navidrome: `backend/library/waveform.py` (`song()` for the path, `media("stream")` as a fallback copy), `backend/jobs/downloads.py` (`navidrome()` after publish at about line 723, and the batch retry at about line 969), `backend/api/diagnostics_api.py` (caches `capabilities()` for 30 seconds under the `navidrome` key; `backend/main.py` hands it `lambda: navidrome`).

The Playwright library, playlist, player and popout specs replace `/api/library/*` and `/api/player/*` with fixtures (`frontend/e2e/library-fixtures.ts`). They prove the browser contract still holds, not that the new backend works. Real playback is proven by the Python tests and the manual browser pass.

## Design decisions

### Ids

- [x] A song id is opaque, random, stored on its `library_files` row, and matches `^[A-Za-z0-9._:-]{1,200}$`. Proposal: `tr-` plus 16 hex characters.
- [x] The same path keeps its id across rescans and tag edits. That needs `index()` to stop using `INSERT OR REPLACE`, which deletes the row and would drop the id (and fire any delete cascade). Use `INSERT ... ON CONFLICT(path) DO UPDATE` and never touch `song_id` or `added_at` on update.
- [x] A root that walks empty while the index holds rows for it is not pruned (an unmounted share looks like that). Navidrome added the same guard ([#3007](https://github.com/navidrome/navidrome/issues/3007)). Without it, one missing mount erases every playlist, play count and the queue.
- [x] A path that disappears (`remove`, `_drop_removed_folder`, `_prune`) drops its id. Playlist entries, the queue, play counts and favourites keyed by it go with it (foreign keys with `ON DELETE CASCADE`, or a cleanup in the same transaction). A moved or renamed file is a new song.
- [x] Album and artist ids are derived, not stored: `al-` plus a short hash of the album artist and album, `ar-` plus a short hash of the artist name. Same tags, same id, across rescans. Hash through a frozen function of their own, not `normalize()`, which ownership matching shares and will keep changing. Navidrome lost favourites and play counts each time its identity rule moved. A retag that changes the album or artist name gives a new id, and an artist favourite on the old name is lost. Write that down in `docs/player.md`.
- [x] Playlist ids: `pl-` plus the row number. A cover id is the owner's id (`tr-`, `al-`, `ar-`) plus `_` and a short version from the source image's size and mtime. `/api/player/art/{id}` knows the owner from the prefix, and a changed cover gets a new URL.
- [x] The client never sends a path. Stream, art, lyrics and waveform look the id up, then check the stored path resolves inside an enabled library root, is not a symlink and is a regular file. Anything else is 404.

### What a song row gains

Extend `library_files` and the existing `Library.index()` read. No second walk.

- [x] Ids and dates: `song_id`, `added_at` (first seen; kept on update). For rows that exist before the upgrade, set `added_at` from `mtime_ns` so "newest" still means something.
- [x] Tags: `track`, `disc` (parse `3/12`), `year` (first four digits of the date), `genre` (first value; keep the rest for the album's `genres`), `album_artist` (TPE2, `albumartist`, `aART`), `compilation` (TCMP, `compilation`, `cpil`).
- [x] ReplayGain when present: track and album gain in dB, track and album peak. Read ID3 `TXXX:REPLAYGAIN_*`, Vorbis `REPLAYGAIN_*`, MP4 `----:com.apple.iTunes:replaygain_*`. Opus `R128_TRACK_GAIN` and `R128_ALBUM_GAIN` are Q7.8 against -23 LUFS; convert to the ReplayGain reference (+5 dB) or leave them out, but decide. Decision: ReplayGain wins when both are present; otherwise R128 is converted with `value / 256 + 5`.
- [x] File facts for the About tab: `suffix`, `content_type` (from the suffix), `bitrate` (kbps), `sample_rate`, `bit_depth` (FLAC, WAV, AIFF, ALAC only), `channels`, `size` (already there).
- [x] `has_art` (embedded picture present), so album art does not reopen every file.
- [x] `tags_version`. `tags_still_match` must also require the current version, or every row indexed before the upgrade keeps empty new columns forever. Cost: the first scan after upgrading rereads every file once. Measured on 2000 generated WAV files: the first read took 0.42s and a later scan that could skip unchanged tagged files took 0.02s. An untagged WAV is still read again every scan, which is the existing blank-tag rule.
- [x] Mutagen's easy mode loses some of these (ReplayGain, compilation, pictures). Read the raw tags in the same open, not a second `mutagen.File` call.
- [x] Clamp track, disc and year to sane ranges, and store an unparsable ReplayGain value (NaN, empty) as absent.
- [x] Skip `@eaDir`, `#snapshot`, `#recycle` and `$RECYCLE.BIN` in the walk and the watcher, next to the dot folders already skipped.

### Albums and artists

- [x] An album is the songs sharing album artist (falling back to the track artist) and album name. Compilation flag with no album artist: album artist "Various Artists".
- [x] Album fields the browser reads: `id`, `name`, `artist`, `artistId`, `coverArt`, `songCount`, `duration`, `playCount` (sum), `year` (newest track year), `genre`, `genres`, `created` (newest `added_at`, so Fresh in your library shows new downloads), `song` on detail, `recordLabels` when tagged.
- [x] The Artists view lists album artists, and an artist page lists the albums they are album artist of. A song's `artistId` points to its own artist when that artist has albums. Otherwise it points to the first name split off on a spaced separator (`" / "`, `" feat. "`, `" & "`) when that one has albums. Otherwise it points to the album artist. "AC/DC" is never split. Decide before writing SQL; it changes what an artist link opens.
- [x] Date, format and folder never split an album (Navidrome's most-discussed tag bug).
- [x] Untagged album name: group per folder rather than one giant "Unknown album".

### Streaming

- [x] `GET /api/player/stream/{id}` returns Starlette's `FileResponse` for the file (Starlette 1.6.0 handles `Range`, `206`, `416`, `Accept-Ranges`, `ETag`, `Last-Modified`). Keep the existing guard that refuses more than one range before it. Check it answers `bytes=0-1` with two bytes (Safari and iOS probe that way) and `bytes=N-` from a seek.
- [x] Content type by suffix: mp3 `audio/mpeg`, m4a `audio/mp4`, flac `audio/flac`, ogg and opus `audio/ogg`, wav `audio/wav`, aiff `audio/aiff`, webm `audio/webm`, wma `audio/x-ms-wma`. No transcoding; a format the browser cannot decode is skipped by the player's existing "could not be played" path.
- [x] A row whose file has gone (before the watcher catches up) is 404, not 500.

### Cover art

- [x] Song: embedded picture, else an image beside the file. Album: an image beside the first track, else the first track with `has_art`. Artist: their newest album's cover, as `cover_art` does today. Drop `PLACEHOLDER_ART` and `is_placeholder`; there is no Navidrome star to recognise.
- [x] Image beside the file: look up a short fixed list of names in that one folder at request time (`cover`, `folder`, `front`, `album`; `.jpg`, `.jpeg`, `.png`, `.webp`), case-insensitive, with `cover.jpg` ahead of `cover.1.jpg`. For a file in a disc folder (`CD1`, `Disc 2`), also look one folder up. Downloads already publish `cover.jpg` there.
- [x] Embedded: when a file holds several pictures, take the one typed front cover (type 3), else the first.
- [x] Send `ETag` and a long `Cache-Control` (the cover id changes with the image). No resizing, no `size` parameter and no new artwork service. If album grids get slow with large embedded art, record it as a follow-up.
- [x] No art: 404. The browser already falls back to an icon.

### Lyrics

- [x] Order: a sidecar `<file>.lrc`, then embedded lyrics (ID3 `SYLT`/`USLT`, Vorbis `LYRICS`/`UNSYNCEDLYRICS`, MP4 `©lyr`), then LRCLIB. Musimo's own tagger writes all of these (`backend/jobs/tagging.py`), and its embedded text can be LRC, so run embedded text through `lyric_lines` too. Same response shape as today (`displayArtist`, `displayTitle`, `synced`, `line[{start, value}]`).

### State in SQLite

- [x] `playlists` (`id`, `name`, `public`, `created`, `changed`) and `playlist_songs` (`playlist_id`, `position`, `song_id`). Positions stay dense, because the browser removes a song by its index (`song_index_to_remove`). A playlist create still accepts at most 500 songs.
- [x] The liked playlist keeps its identity in `linked_playlists`. An upgraded database holds a Navidrome playlist id there; `linked_playlist()` already clears a dead link and adopts or creates "Liked", so check that path with a stale id. `DELETE` of the liked playlist is still 409.
- [x] `artist_favourites` (`artist_id`, `starred_at`). The artist row's `starred` comes from it.
- [x] Play counts: `play_count` and `last_played` per song (columns on the row, or a table keyed by `song_id`). `POST /api/player/scrobble` with `submission=true` adds one and sets last played; `submission=false` changes nothing. No Last.fm, no ListenBrainz.
- [x] `play_queue` (current id, position in ms, changed) and `play_queue_songs` (position, song id). Still at most 500. `GET` drops songs that no longer exist and clears `current` if it was one of them.
- [x] Clear `waveforms` once on upgrade: its rows are keyed by Navidrome ids.

### Schema version and rollback

- [x] Bump `PRAGMA user_version` to 6 and raise the "newer than this application" guard to match. Version 5 is the pause between groups of downloads. Every change is additive (`ALTER TABLE ... ADD COLUMN` with defaults, `CREATE TABLE IF NOT EXISTS`), so a version 5 database opens and upgrades in one transaction.
- [x] This branch refuses a version 6 database. Rolling back after the upgrade needs the backup taken before it. Say so in `CHANGELOG.md` and the README's update notes. An older build refuses version 6; this application opens it. The note is in the changelog and the README update notes.
- [x] Test with a version 5 database built by the current schema, including a stored `navidrome_url`, `navidrome_mode=api` and a liked playlist link. After the upgrade those three settings rows are gone and the database still opens.

### Settings

- [x] Delete `navidrome_url`, `navidrome_mode` and `navidrome_library_id`. Nobody else has a database, so they do not stay on `Settings` or `settingsSchema`. This machine's database already has the rows, and `Settings` refuses unknown keys, so the version 6 upgrade deletes the three rows before validation. Drop them from `Settings`, `SettingsPatch` and `clean_navidrome_url` in `backend/core/models.py`, from `settingsSchema` in `frontend/src/api.ts`, and from the Settings form, including the `MUSIMO_NAVIDROME_CREDENTIALS_FILE` help. Stop writing them in `scripts/download_smoke.py`, `scripts/recovery_smoke.py` and `scripts/seed_transport_smoke.py`.

## Work list

### Backend

- [x] Baseline: every backend test passes on this machine (384, 1 Windows-only skip), including the five pace tests from the back-merge. Any failure from here on is new.
- [x] Schema version 6 in `backend/core/store.py`, with the store methods for playlists, favourites, plays and the queue. Version 5 is already taken by the pause between groups of downloads. The same upgrade deletes the `navidrome_url`, `navidrome_mode` and `navidrome_library_id` rows.
- [x] Extend `Library.index()` and the scan's fast path in `backend/library/index.py`. Keep a library revision counter that `index`, `remove` and `_prune` bump, so player caches can drop themselves.
- [x] New `backend/library/player.py` (name to taste) with the methods `install_player_routes` calls. Reuse the pure helpers, which are already out of `navidrome.py`: `filter_tracks`, `sort_tracks`, `sort_albums`, `sort_artists`, `natural` and the facets in `backend/library/browse.py`, and `lyric_lines` in `backend/library/lyrics.py`. They read rows in the Subsonic shape the browser already gets, so the new class should hand them rows of that shape.
- [x] `backend/api/player_api.py`: depend on the new class; serve `stream` and `art` from files; keep `checked_id`, `QueueUpdate`, the playlist models and the 500 limits; rename the "Invalid Navidrome item ID" message.
- [x] `backend/library/waveform.py`: read the path from the song row; drop the stream copy (the file is always local now). Keep the root check.
- [x] `backend/jobs/downloads.py`: delete `navidrome()`, the `startScan` call and the batch-retry branch that calls it. Finished jobs stop carrying "Navidrome integration is not configured". `index_published` stays the only step after publish.
- [x] `backend/main.py`: build the local player from `store`, `library` and `roots`; drop the Navidrome HTTP client; pass the player to `install_player_routes`, `WaveformService` and `install_diagnostics_routes` where `navidrome` goes today. `backend/api/diagnostics_api.py` then reports the local player (its `get_navidrome` parameter wants a new name).
- [x] Delete `backend/library/navidrome.py` once nothing imports it.
- [x] Capabilities: `configured` true when a library root is configured, `available` true when one is mounted and readable, `version` Musimo's, `detail` such as "Playing from your music folders" or "No music folder is mounted". Never "add a Navidrome address".

### Frontend

- [x] `frontend/src/features/diagnostics/readiness.ts`: the player only counts against readiness when it reports itself unavailable; an absent player is no fault. Update `readiness.test.ts` beside it.
- [x] Diagnostics JSON key is `player` (`diagnosticsSchema` and its reader). The row says "Player".
- [x] Copy that names Navidrome, with no layout change, under `frontend/src/features/`: `player/player.tsx` ("Check the connection to Navidrome.", "Navidrome saves 500 songs", "Your Navidrome library"), `player/play-history.ts`, `library/library.tsx`, `library/popularity-chart.tsx`, `settings/server-settings.tsx` (the Settings form), `now-playing/about-track.tsx` and `now-playing/track-info.ts` ("path as Navidrome reports it"). `search/home-shelves.tsx` does not name it. Diagnostics already says Player. Update the tests that quote the remaining copy (`player.test.ts`, `track-info.test.ts`, `settings-patch.test.ts`). Confirmed 2026-10-11: `frontend/src` no longer says Navidrome.
- [x] Screens stay as they are: Home, Albums, Artists, Tracks, Playlists, Now Playing, the queue, shuffle, the phone player.

### Tests

- [x] Rewrite `tests/test_player.py` against a temporary data directory and a temporary music root with generated fixtures (tagged WAV through Mutagen; MP3, FLAC and M4A when ffmpeg is installed, the way `test_waveform.py` does). Keep its contract checks: ids, safe headers, ranged 206, a second range refused, artwork, the artist stand-in cover, album and artist and track browsing, shuffle, playlists, the liked playlist refusing delete, the queue at 500 and 501. Fixtures are WAV. MP3, FLAC and M4A were not added.
- [x] New checks still open: a version 4 database opens and upgrades, and a finished download is browsable and streamable with no Navidrome. The rest are in `tests/test_player.py` or the scan tests: an id survives a rescan and a tag edit; a removed file loses its id and leaves its playlists and the queue; an id cannot reach a file outside the roots, through a symlink or under a disabled root; scrobble counts; lyrics order (sidecar, embedded, mocked LRCLIB); a symlink swapped in after the scan is refused at stream time; search finds "MØ", "AC/DC" and a two-letter name; a front-cover picture beats the first picture; a disc folder takes its parent's `cover.jpg`; a junk folder is not indexed; a bad track number or ReplayGain value does not stop the scan; an emptied root keeps its rows; `bytes=<size>-` is 416; a GBK or BOM-prefixed `.lrc` still reads. Confirmed 2026-10-11. `tests/test_player_store.py` opens a version 4 database and lands on 6. `tests/test_player.py` finishes a download and streams it. The emptied-root guard is asserted in `tests/test_search.py`.
- [x] `tests/test_waveform.py` and `tests/test_downloads.py` lose their Navidrome mocks. Waveform reads a temporary music root. Downloads had no remaining mock; `navidrome()` is gone and the suite still passes.
- [x] Run every required check from `CONTRIBUTING.md`, then the Playwright player specs (`player`, `playlists`, `queue-editing`, `gapless`, `library-controls`, `about`, `lyrics`, `history`, `waveform`, `phone`) against the isolated test stack from `docs/testing.md`. Backend 387 passed, 1 Windows skip, coverage 85%. Frontend 357 passed, lint, format, build and e2e types passed. `ruff format --check` still fails only on `backend/core/store.py`, `scripts/download_smoke.py` and `tests/test_library_scan.py`, which were already unformatted; those files were not rewritten. Playwright: 178 passed on Chromium, WebKit and the phone project. All 61 Firefox tests failed before launch (`Could not find profile folder`).
- [ ] Optional: one Playwright spec that does not mock `/api/player/*`, against the isolated stack with a generated tagged file in its music mount.

### Browser pass

- [x] On the isolated test stack (`docs/testing.md`, port 18765, its own volumes) with a few generated or public-domain fixture files: open an album, play, seek, skip, refresh and see the queue return, add and remove a playlist song, and see a finished download appear with no Navidrome. A public-domain Internet Archive link (see `docs/evidence/phase3-public-domain.json`) is a permitted download. Checked 2026-10-11 on `http://127.0.0.1:18765` only. Isolated album, play, seek, skip, refresh (Second Light came back), playlist add and remove. The Archive lookup answered 422, so the finished job was a local file published and indexed on that stack. It showed under Done and as the album Public domain. The live install was not used.
- [ ] The live install (Colima, `http://127.0.0.1:8765`, volume `musimo_musimo-data`): rebuild only to check the branch. Back up the volume first, because the rebuild upgrades its database to version 6 and this branch will not open it after that. Never `docker compose down -v`.

### Docs

- [x] `README.md`: the tagline ("companion for Navidrome"), the features list, the Navidrome section, `MUSIMO_NAVIDROME_CREDENTIALS_FILE`, "New files are absent", the architecture sketch (`-> Navidrome`), the update notes on schema 5. Update notes now say this application opens version 6, version 5 is the pause between groups of downloads, and an older build refuses it.
- [x] `docs/player.md`: the opening, Configuration, the API list, ids and what loses a song, Waveform source, Verification, and the paragraph about Navidrome not deleting media. Ids: `tr-` plus 16 hex survives a rescan; album and artist ids are `frozen_id`, not `normalize()`; a moved or renamed file is a new song; a retag that changes the album or artist name loses the old favourite.
- [x] `docs/settings.md`: the readiness rule, and that the three Navidrome settings are gone.
- [x] `docs/architecture.md`: Storage (the new tables and version 6), Player APIs, diagnostics, the Library player section.
- [x] `CHANGELOG.md`: an Unreleased entry, including that Navidrome-side playlists, favourites, play counts and the saved queue do not carry over. Rolling back after the version 6 upgrade needs the backup taken before it.
- [x] Also stale, not on the list: `docs/search.md` ("Fresh in your library" appears "only when Navidrome is configured"). It now says the library. `docs/brief.md` and `docs/research.md` stay historical.

### Finish

- [x] Commits under the machine's git identity, no Co-Authored-By trailer, nothing in the branch name, commits or comments saying a model wrote them.
- [x] Report: the branch name, what plays with Navidrome absent, the tests run, and what was left out. `feature/local-player`. Playback is the files in the music folders. Left out: the live install, the optional unmocked Playwright spec, the `test_downloads.py` import cleanup, commits, and Firefox (it would not launch).

## Out of scope

Login, more than one user, embedding Navidrome, on-the-fly transcoding, Last.fm, ListenBrainz, Discover, new download sources. Also left out unless asked: importing playlists, favourites, play counts or the queue from an existing Navidrome; image resizing; smart playlists; `.m3u` import and export.

## Follow-ups seen in Navidrome's history, not for this branch

- Resume a track with a `Range` request after a dropped connection instead of skipping it ([#6170](https://github.com/navidrome/navidrome/issues/6170)).
- Re-attach a moved or renamed file to its old id by tags and duration ([#2068](https://github.com/navidrome/navidrome/issues/2068)), carefully: Navidrome's move detection made duplicates ([v0.61.0](https://github.com/navidrome/navidrome/releases/tag/v0.61.0)).
- An "Appears on" section on artist pages ([#4688](https://github.com/navidrome/navidrome/issues/4688)).
- Vinyl track numbers such as "A1" ([#1652](https://github.com/navidrome/navidrome/issues/1652)).
- Smart playlists ([#1417](https://github.com/navidrome/navidrome/issues/1417)).

## Open questions

- The `artistId` rule for featured artists (see Albums and artists). The proposal there follows Navidrome's separator rule.
- The empty-root guard stops a whole root that walks empty from being pruned. It does not stop a single folder vanishing; that still drops its songs, as the brief allows.
- Diagnostics key: `player`. The readiness row says Player.
- Whether the browser pass on the live install should add fixture files to its music folder. The safer default is no: fixtures go on the isolated stack only.
