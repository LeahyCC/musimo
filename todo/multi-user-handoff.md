# Handoff: named listeners in the one container

Updated 19 October 2026. This is the brief for a new session. Read this file first, then the working tree. The working tree wins where this note, `main`, or a doc disagrees.

Implement named listeners on the dirty tree. Do not start a clean branch. Do not revert, reset, or stash what is already changed. Do not commit unless Colin asks. Do not open a pull request unless he asks.

## Start here

Checkout: `H:\Git\musimo`. Remote: `https://github.com/LeahyCC/musimo.git`. Branch: `main` at `5e3d766` (merge of PR #222). The work is uncommitted on top of that commit. PowerShell. `git -C H:\Git\musimo` if a command might land in another checkout. `H:\Git\musimo-main` is a different worktree. Leave it alone.

The container at `http://127.0.0.1:8765` was rebuilt from this dirty tree. It is Colin's library. Do not call it, do not point Playwright or curl at it, do not rebuild it, do not restart it, do not migrate its database. `PLAYWRIGHT_BASE_URL` must not be `http://127.0.0.1:8765`. Browser tests use the isolated stack in `docs/testing.md` (the e2e default is port `18765` in `frontend/e2e/env.ts`).

Never `docker compose down -v`. Never pass `-v` or `--volumes` to `docker compose down`. `compose.override.yaml` is gitignored and binds the real music folder. Do not remove it. Do not copy, move, delete, retag, or replace files in the music folder. A holding does not do those things either. Keep it that way.

SQLite for the live install is `/data/musimo.sqlite3` inside the named volume `musimo-data`. The live file is already at schema 14. A backup from before the holdings migration is `H:\Git\musimo\runtime\backups\musimo-before-holdings.sqlite3`. Do not open the live database. Tests use a temporary database. The next schema, when this feature lands, is 15, and an older image must keep refusing a newer file.

Commit identity, if a commit is asked for later: `Colin Leahy <leahycc@pm.me>`. Do not pass `-c user.name` or `-c user.email`. No `Co-Authored-By` trailer. No AI fingerprints in branch names, comments, or docs. No em dashes.

`scripts/check.sh` full stops at the first failure. On this machine, symlink tests can fail pre-push with WinError 1314. That is environmental. Do not skip hooks unless Colin asks.

## What this feature is

One container stays one library. People are names, not passwords. Tailscale Serve is still the door. Anyone who can open Musimo can pick any name.

```
no name remembered on this browser
        |
        +-- no names exist yet --> type a name --> Create
        |                              |
        |                         the first saved name keeps today's
        |                         queue, playlists, Liked, likes,
        |                         artist stars, play counts, bot memory
        |
        +-- names exist --> list of names
                            Create a new name
                                   |
                             a later name starts empty
                             and gets its own empty Liked
        |
the shell opens as that name
music stays paused
```

This browser remembers the last name in local storage until someone switches. The phone remembers its own. Two tabs in one browser follow each other.

```
Listening as Colin
   Colin            ✓
   Sam
   Create a new name
```

Classic: the current name sits on the musimo word at the top of the sidebar (`frontend/src/app/shell/classic.tsx`, the `brand` link). Phone and Listening room: the name sits in the top bar. The room rail is icons only (`frontend/src/app/shell/room.tsx`). One sheet in all three places. The first open is that sheet in front of the shell. There is no skip and no cancel until a name is already chosen.

Pressing another name saves the current place, stops playback in this browser, and opens the other name paused where they last were. Do not autoplay on a switch. Now Playing closes when that person has nothing loaded. An album, search, downloads, settings, or diagnostics page stays. Hearts and counts on it update. A playlist page that is not theirs goes to Playlists. The open Octive chat is this tab (`sessionStorage`) and clears on a switch. Shown songs follow the name across devices.

A name is trimmed, required, at most 40 characters, and unique ignoring case. Blank and duplicate stay on the sheet with the reason. Two creates at the same moment: the first one saved takes the existing listener data. The other starts empty.

```
moves with the name, on the server     stays with the house
queue                                  music folder and the index
playlists and Liked                    holdings
likes and artist stars                 download queue, destination, naming
play counts and last played            the one Deezer cookie, file command,
bot memory                             listen cache, and account lock
bot proposals and receipts             YouTube cookies and the helper container
                                       Spotify app file
                                       server settings
                                       waveforms, covers, audio profiles
                                       account_tracks (facts for a dz- id)

this browser, per name                 this browser, for whoever is at it
History list (musimo.play-history)     theme, layout, pet
Home shelves built from that list      volume, shuffle, repeat, crossfade
shuffle deck and queue-chosen          replay gain, lyrics offset, visualizer
                                       library layout and view memory
                                       recent searches
```

Home and the History tab follow the name only on this device. Colin's phone starts those empty until he plays there. Continue listening, This week, Jump back in, and On repeat are computed in `frontend/src/features/home/listening-stats.ts` from `musimo.play-history`, not from the server counts. The server counts have no dates. Most played, artist play totals, and the bot's familiar filter use the server counts, and those counts become the name's.

The history already stored under `musimo.play-history` on a browser attaches to the first name that browser picks. It does not jump to the phone.

## Closed decisions

Do not reopen these.

- No password, no session secret, no Tailscale user header. The app does not see which tailnet user connected. Loopback has no identity. A name is the account.
- The browser tells the server which name it is using. That id is not a secret. A missing name is refused on listener routes once any name exists. Before the first name exists, the only listener write is create.
- Holdings stay house-wide. One row per `(catalog, track_id)`. Use the house copy answers for everyone. Save another copy can still queue a download. A matching sha256 still keeps the oldest file and deletes only the new staged file.
- One Deezer cookie for the install (`/data/deezer-arl.txt`). One account lock. Play and download share it. "The Deezer account is busy." stays true across names. Removing or replacing the cookie still drops the one listen cache and stops every account stream. No second cookie in this feature.
- Music files stay one folder. This feature must not copy them.
- Rename, delete, and a playlist shared between names are out. The public flag on a playlist keeps filtering that person's own list. Other people do not see the playlist.
- Theme and layout stay in the browser. `/settings/user` still never reaches the server.
- Server settings stay one copy. Two people can still overwrite each other's server settings. The existing "Changed elsewhere" row stays.

## The dirty tree this feature sits on

Three slices are mixed in one working tree. Listener work folds into this tree. It does not replace the other two slices, and it does not split them into their own commits unless Colin asks.

### Holdings, schema 14

A holding points one Deezer track at one audio file this install already has. It does not copy, move, link, retag, or replace that file, and it does not start a download.

`holdings` columns: `id`, `catalog`, `track_id`, `song_id`, `path`, `reason` (`catalog`, `bytes`, or `chosen`), `created`. Unique on `(catalog, track_id)`.

- `catalog`: certain match when queueing. Same Deezer track, finished job, file still in an enabled folder and in the index. The existing job is returned. No new job. No new holding row on that path (`certain_catalog_match` in `backend/jobs/holdings.py`).
- `bytes`: at publish, the new file's sha256 matches another finished Deezer file that is still there. Keep the oldest. Delete only the new staged file. Do not publish a second audio file, cover, or lyrics. The job stores `reused_file` so a later crash does not write those beside the house file. `Job.public()` omits `reused_file`. The browser never sees it.
- `chosen`: an ISRC, MusicBrainz, or artist-title-duration match, including a match on another album. Nothing holds or downloads until the person presses Use the house copy. Save another copy still queues a download. `POST /api/holdings` with `HoldingRequest` (`track_id`, `song_id`) records `chosen` only after the server re-matches. A body the re-match does not support is 422.

A live holding shows as owned, `matched_by` `holding`. A stale one is ignored and removed (`refresh_holdings`). Deleting the library file deletes its holdings in the same transaction (`drop_song_references` in `backend/core/store.py`). Album and artist batches skip a certain match or a live holding, and count the uncertain ones as `needs_choice` for a one-by-one choice (`batch_skip`, `albumBatchStatus`, `artistQueueBucket`).

An ownership-edition match sets `matched_song`. Same-album tag, ISRC, and MusicBrainz matches set it too. The download dialog posts `item.matched_song`. An empty `song_id` is rejected. That fix is in `backend/library/index.py`. Do not drop it.

Files:

- `backend/jobs/holdings.py` (new)
- `frontend/src/features/downloads/holding-choice.ts` (new)
- `frontend/src/features/downloads/download-button.test.ts` (new)
- `tests/test_holdings.py` (new)
- `backend/api/download_api.py` (`POST /api/holdings`, batch `needs_choice`)
- `backend/core/job_models.py` (`reused_file`, `HoldingRequest`)
- `backend/core/store.py` (schema 14, `SCHEMA_VERSION = 14`, delete holdings with the file)
- `backend/jobs/downloads.py`, `backend/jobs/job_store.py`, `backend/jobs/artist_downloads.py`
- `backend/library/index.py`
- `frontend/src/api.ts`
- `frontend/src/features/downloads/download-button.tsx`
- `frontend/src/features/downloads/album-download.tsx`
- `frontend/src/features/downloads/artist-download.tsx`
- `tests/test_downloads.py`, `tests/test_artist_downloads.py`, `tests/test_search.py`
- `docs/downloads.md`, `docs/search.md`, `CHANGELOG.md`

Listener work does not add a person column to `holdings`. The press is a house decision, whoever is signed in as a name.

### Deezer account listen

One cookie and one `file_command` for the whole install. Play writes `job.json` with the track id beside the listening file before that command runs (`_write_track_id` in `backend/jobs/account_listen.py`). A listen is not a download job. The file is cached under the data directory at `account-listen/<track id>`, apart from the library. `drop_cache` removes that tree when the cookie is removed or replaced, and clears the cached sign-in. Playlist rows in `account_tracks` are left in place.

`prepare_track` returns `play` of `account`, `library`, `preview`, `unavailable`, `busy`, or `off`. A finished Deezer job whose file is still indexed short-circuits to `library` (`library_song`). That lookup is the house file, not a person's taste. The cookie stays on the server. The browser plays `/api/player/account/dz-{id}/file`. Diagnostics carries a `mark` for the cookie file, not the cookie. The player stops when the mark changes.

Play holds the account lock only while it fetches. The file command runs after the lock is free. If the account is already busy, Play says "The Deezer account is busy." and leaves the other work running.

A Deezer song can sit in a Musimo queue or playlist beside library songs. Playback of a library song is the file. Playback of a Deezer song goes through the account. The liked playlist is Musimo's, and under this feature it is that person's. History may list the listen as Played from Deezer (`playedFrom: 'deezer'` on the history entry). The library play count does not move for an account listen. Keep that rule per person: an account listen still does not increment that person's file play count.

`account_tracks` (schema 13) stores title, artist, album, duration, art, and `deezer_id` for a `dz-` id that a playlist or the queue is holding. It is a fact about the recording, shared by the house. Do not split it per person. When queues and playlists split, they still point at the same `dz-` id.

Files: `backend/jobs/account_listen.py`, `backend/jobs/account_lock.py`, `tests/test_account_listen.py`, `docs/player.md` (Deezer account section), `docs/settings.md` (cookie and `file_command`), `docs/search.md` (the `job.json` sentence). `backend/integrations/deezer_cookie.py` names the file `deezer-arl.txt`.

Recent commits on `main` already cover related account-listen behavior. Do not undo them: `ad024be` (an in-flight fetch must not take over a preview or a closed player), `e0f7716` (Spotify download and account listen stay on the recording they named), `05525dd` (a rejected save must not echo the Deezer cookie or Spotify secret).

### Genre slice, leave it working

Unrelated, in the same diff. Drum and bass is its own group and stays electronic. Liquid on its own stays the liquid tag, not the whole group. Keys fold case, hyphens, spaces, and `&`. Files: `backend/library/genres.py`, `docs/genre-mapping.md`, `tests/test_genres.py`. `tests/test_proposals.py`, `tests/test_shown_memory.py`, `frontend/e2e/app.spec.ts`, and `frontend/e2e/cards.spec.ts` also have small edits in this tree. Read them before changing those tests. Do not revert them to make the listener tests fit.

## What is one install today

`SCHEMA_VERSION` is 14 in `backend/core/store.py`. There is no users table. `SHOWN_PROFILE = "default"`. That string is a row in `bot_memory`, not a login. `docs/architecture.md` under Shown-song memory says several listeners are out of scope. `SECURITY.md` and the README say there is no login. Those sentences change with this feature. The trust sentence stays: anyone who can reach the server can do what the server can do.

| Piece | Where it lives now | After this feature |
| --- | --- | --- |
| Music files | host folder, mounted at `/music` | house |
| `library_files`, `library_roots`, `library_fts`, `library_covers`, `library_state`, `library_revision` | SQLite | house, except `play_count` and `last_played` move off the file |
| `holdings` | unique `(catalog, track_id)` | house |
| `jobs`, `queue_control`, `source_control`, `job_events` | one download queue | house |
| Settings rows, `deezer-arl.txt`, `youtube-cookies.txt`, `spotify-app.json` | one install | house |
| `waveforms`, `audio_profile`, `audio_job` | per song | house |
| `account_tracks` | per `dz-` id | house |
| `search_cache`, `sources_health`, `activity_state` | one install | house |
| `playlists`, `playlist_songs` | no owner | the name |
| `linked_playlists` key `liked` | one liked playlist | one Liked per name. The first name keeps the current link |
| `artist_favourites` | one set | the name |
| `play_queue` | `CHECK(id=1)`, plus `writer_epoch` and `write_sequence` | one queue per name. Same last-writer rule between that person's devices |
| `play_queue_songs` | the one queue | the name's queue |
| `library_files.play_count`, `last_played` | one number on the file | the name. The file columns stop being the source of truth |
| `bot_memory` | one row, profile `default` | one row per name |
| `bot_proposals`, `bot_proposal_revisions`, `bot_receipts` | no owner | the name who made them. Another name cannot commit that id |
| `musimo.play-history` | this browser, cap 200 | this browser, per name |
| `musimo.shuffle-deck`, `musimo.queue-chosen` | this browser | this browser, per name |
| `musimo.music-bot.history`, `.proposal`, `.log`, `.preview` | this tab, `sessionStorage` | clear them on a switch |
| `musimo.layout`, `musimo.home-sections`, `musimo.theme*`, `musimo.pet`, volume, shuffle, repeat, crossfade, replay gain, lyrics offset, visualizer, now-playing view and tab, library layout and view keys, `musimo.recent-searches` | this browser | stay one copy for the browser |

`drop_song_references` deletes playlist rows, queue rows, waveforms, audio profiles, and holdings for songs that left the index. After the split it still deletes those rows for every name, in the same transaction. Song ids stay `tr-` plus 16 hex on the file. A moved file is still a new song. `dz-` ids stay global.

The Navidrome importer (`backend/library/import_navidrome.py`) writes playlists, likes, artist stars, play counts, and last played into the one set of tables. Point that write at one listener. When only one name exists, that name is the target. When several exist and the command names none, refuse. Do not build a new importer screen.

## Server shape

Add a listener the create sheet can save: a stable id and the display name. The id is what the browser stores and sends. The name is what the sheet shows.

The first successful create copies, in one transaction:

- the single `play_queue` row and its songs
- every playlist, its songs, and the `liked` link
- every artist favourite
- each file's `play_count` and `last_played`, onto that listener, for songs with a count or a date
- the `bot_memory` row whose profile is `default`
- existing bot proposals and receipts, onto that listener

A later create makes an empty queue, an empty Liked playlist, no other playlists, no stars, zero counts, and an empty bot memory at revision 0. It does not copy Colin's data.

Listener-scoped routes, as they exist today, take the caller's id:

- `GET` and `PUT /api/player/queue`, `POST /api/player/queue/writer`
- `POST /api/player/scrobble` (this is the file play count, not the browser history)
- playlist list, liked, get, create, rename, add, remove, delete
- artist favourite put and delete
- library albums, artists, tracks, and the player song, where the payload includes play count, last played, liked, or starred
- `POST /api/library/tracks/shuffle` and the deck it keeps on the server
- music-bot chat, intent, proposals, revisions, edits, commit, and memory (`GET`, `POST .../shown`, `DELETE`)

House routes stay unscoped: jobs, batches, `POST /api/holdings`, settings, diagnostics, library scan, stream, art, lyrics, account play and the account file, the YouTube cookie, the Deezer cookie. Annotating search results with owned and `matched_by` stays house. Hearts on those rows, when the row is a library song, use the caller's likes.

`play_queue` today refuses a stale writer. Keep that inside one name. Two devices on Colin can still replace each other's queue. Sam's save does not bump Colin's epoch.

Bot search that filters on favourites or play history reads the caller's likes and counts. Shown-song memory reads and writes the caller's `bot_memory` row. A commit of a proposal id from another name is refused. A retry of the same operation id still returns the first receipt.

Do not put the listener id in the holdings unique key. Do not fork `deezer-arl.txt`. Do not fork the listen cache.

## Browser shape

Remember the chosen id in local storage. On a switch, write it, pause, let the existing queue save finish for the name being left, then load the other name's queue the way a reload already restores a queue: paused, source `restored`. Other tabs hear the storage change and do the same.

Split the history key by listener id. The old single array is read once, given to the first name this browser picks, and then not read again. Home already calls `readHistory()`. It should see the current name's list and nothing else.

Clear `musimo.music-bot.history`, `musimo.music-bot.proposal`, `musimo.music-bot.log`, and `musimo.music-bot.preview` in this tab on a switch. Shown songs are not in those keys. They come from `GET /api/music-bot/memory`.

`musimo.shuffle-deck` and `musimo.queue-chosen` are part of that person's place on this device. Swap them with the name. Leave appearance, pet, transport preferences, and recent searches alone.

The sheet lists names and Create. Create is one text field and one button. The shell underneath is not usable until a name is chosen. After that, the name is always visible in the sidebar or the top bar.

Copy, plain:

- First open, no names: "Who is listening?"
- A name already in use: "That name is already in use."
- Blank: the field needs a name.
- Switch while something is playing: the music stops, and the other person's queue shows where they left it.

## Docs to change in the same work

The code is ahead of these sentences. Update them so they match the feature. Do not leave "several listeners are out of scope" in place.

- `docs/architecture.md` Shown-song memory, the Profile bullet, and the schema 12 paragraph. Memory is per name. The name is still not a password.
- `docs/player.md` queue (one row today), play history (this browser only), Deezer account (one cookie, busy lock), liked playlist.
- `docs/settings.md` the line that server settings are shared by whoever opens Musimo. That part stays true. Say names do not split server settings.
- `docs/downloads.md` only if a sentence claims owned is a person's private state. Owned is the house holding.
- `SECURITY.md` and the README login paragraphs. Say there are names, and that a name is not a lock.
- `docs/reverse-proxy.md` can keep "Musimo has no separate login." Add that a name only picks whose queue and likes this browser shows.
- `CHANGELOG.md` Unreleased, in the voice of the existing bullets.

## Tests

Add coverage in the existing suites. Use a temporary database. Do not point anything at port 8765.

Backend, at least:

- The first create adopts the queue, Liked, a playlist, an artist star, a play count, and the `default` bot memory. A second create does not see those rows.
- Two names have two queues. A stale writer on one does not reject the other.
- Deleting a library file removes it from every name's playlist and queue, and removes the house holding, in one transaction.
- `POST /api/holdings` is the same row no matter which name asks. A second chosen press for the same Deezer track still follows today's 422 or return-the-existing-row rule.
- Account listen still uses one cache and one busy lock while two names exist. An account listen does not move the caller's play count.
- Another name's proposal id is refused. The owner's retry returns the same receipt.
- The genre tests still pass. The holdings tests still pass.

Frontend, at least:

- `holding-choice.ts` stays as it is unless a test name has to move. Do not make Use the house copy per person.
- The history list swaps with the name, and the old key attaches once.
- A switch clears the session chat keys.
- The sheet refuses a blank and a duplicate.

Run `uv run coverage run -m unittest discover -s tests -v` for the backend cases touched, and the frontend test for the sheet and the history key. `scripts/check.sh full` is the bar before a push, and Colin has not asked for a push. Say what you did not run.

UI: when the sheet and the switch exist, verify them on the isolated stack, desktop and phone. The live container is not that check. A single screenshot is not the check. Walk create, reload, switch, and a playlist page that belongs to the other name.

## Build order

1. Listener row and create, including the one-transaction adopt. No UI yet beyond what a test calls. House behavior unchanged.
2. Queue, playlists, Liked, artist stars, play counts. Library and bot reads use the caller's counts and likes.
3. Bot memory, proposals, receipts.
4. The sheet, the remembered name, history and deck keys, the switch.
5. Importer target, docs, changelog.

Each step should leave `tests/test_holdings.py`, `tests/test_account_listen.py`, and `tests/test_genres.py` passing.

## Out of this feature

- Rename or delete a name.
- A playlist both people can see.
- A Deezer cookie, file command, or listen cache per name.
- A password, or reading a Tailscale identity.
- A second database, a second music folder, or a second container.
- Moving theme, layout, or the pet onto the server.
- Rebuilding or migrating the container on port 8765.
