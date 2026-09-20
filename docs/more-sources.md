# More sources plan

A plan, and phase 5 (the Internet Archive), phase 3 (indie sites) and phase 4 (mixes and radio) are shipped behaviour so far. It covers five things yt-dlp makes possible beyond the current Deezer to YouTube road: pasted links, a second match source, indie sites, mixes and radio, and the Internet Archive. [Downloads](downloads.md) describes what exists today and the [brief](brief.md) (sections 3, 4.2 and 7) holds the original scope.

```text
today      Deezer result ----> YouTube search ----> file
                podcast feed ----------------------> file

planned    pasted link ---> allowed site? ---> review sheet ---> file     (phases 1, 3, 4, 5)
           Deezer result -> YouTube search -> SoundCloud search -> file   (phase 2)
```

## What was checked

Against the pinned yt-dlp 2026.8.19 on 19 September 2026, every extractor below exists and reports itself as working. That flag only means upstream has not marked it broken. Nine sites have been downloaded from for real since then: the Internet Archive, the five indie sites, HearThisAt, NTS (through the Mixcloud copy of the show) and BBC Sounds (see below). Two of them, Audiomack and TuneIn, failed and are switched off in the site table (`working`). Mixcloud was read but not downloaded on its own; NTS's download went through Mixcloud's extractor, so it is covered that way.

| Site             | Extractors                         | Notes                                                                                            |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| SoundCloud       | track, set, playlist, user, search | Downloaded: 160 kbps AAC. `scsearch` is not allowed.                                             |
| Bandcamp         | track, album, user, weekly         | Downloaded: 128 kbps stream, or FLAC when the artist offers a free download.                     |
| Audiomack        | track, album                       | **Failed**: yt-dlp cannot read the live site. Switched off.                                      |
| Audius           | track, playlist, artist            | Downloaded: 320 kbps MP3.                                                                        |
| Jamendo          | track, album                       | Downloaded: FLAC. Creative Commons music, named in the brief.                                    |
| Mixcloud         | show, playlist, user               | Read for real. A user list is read in full, so a big account times out.                          |
| NTS              | `nts.live`                         | Downloaded, through the Mixcloud copy of the episode.                                            |
| HearThisAt       | track                              | Downloaded: 320 kbps MP3. The data names no uploader.                                            |
| BBC Sounds       | `bbc.co.uk`                        | Downloaded: 318 kbps AAC (HLS, so FFmpeg does the transport). UK only.                           |
| TuneIn           | podcast, program, station          | **Failed**: yt-dlp gets HTTP 400 from TuneIn's API. Switched off. Stations are live and refused. |
| Internet Archive | `archive.org`                      | Multi-file items. FLAC is often available. Checked for real.                                     |

### Internet Archive, checked for real

On 19 September 2026 with yt-dlp 2026.8.19, no cookies, from a Windows machine:

- `scripts/source_probe.py --site-list --only archive` made one attempt at one MP3 track (about 1.9 MB) and it succeeded in 3.307 s. One attempt is not a median or a p95.
- The real resolver read the item `The_Open_Goldberg_Variations-11823` as a playlist of 32 entries, one per track, each an MP3 original with an Ogg copy inside it. The entries have no address and no extractor name, and their IDs are file paths with a slash in them, so the resolver builds the address and the server accepts that ID shape.
- The link case of `scripts/download_smoke.py` took one track through resolve, queue, the real worker, tagging and indexing in 5.047 s. The file was an MP3 tagged with the item's creator as artist, its title as album, its date and track 5 of 32, and the library index held it.
- The Archive's licence field is set by the uploader. Items credited to Aphex Twin, Tool and Disney carry a CC0 tag in it, so the test item was chosen because its performer released it to the public domain herself, not because of that field. The reasons are in `scripts/source_probe_sites.json`.

### Indie sites, checked for real

On 19 September 2026 with yt-dlp 2026.8.19, no cookies, from a Windows machine. Every URL is an openly licensed one, and `scripts/source_probe_sites.json` says why each is safe to use.

| Site       | Probe (`--site-list --only`, one attempt) | What the file was                                                                                                      |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bandcamp   | 7.447 s, ok                               | A 60 s FLAC. The artist has switched on free downloads.                                                                |
| SoundCloud | 6.300 s, ok                               | 160 kbps AAC (`hls_aac_160k`), 199 s.                                                                                  |
| Audiomack  | 1.598 s, **failed**                       | Nothing. yt-dlp's Audiomack extractor stops with "Failed to parse JSON" on the live site, for a song and for an album. |
| Audius     | 4.282 s, ok                               | 320 kbps MP3 (320,089 bps measured), 274 s.                                                                            |
| Jamendo    | 20.521 s, ok                              | FLAC of 460,687 bps, 210 s.                                                                                            |

One attempt is not a median or a p95. Beyond the probe:

- **Bandcamp end to end.** The `bandcamp` case of `scripts/download_smoke.py` took track 3 of a 60 track album through the real resolver, queue, worker, tagging and index in 15.203 s. The FLAC carries the album title, the artist and album artist, the release date (2023-03-10), track 3 of 60 and an embedded cover, and the job has no warnings. The resolver read one page (the first track's) for all 60 rows.
- **Found while doing it.** With yt-dlp's default choice, Bandcamp's free download came back as ALAC, which the worker cannot keep as original, and the job failed with `TRANSCODE_FAILED`. The rows now use a format selector that skips ALAC, WAV and AIFF (`KEPT_AUDIO`), and the same check passes.
- **Bandcamp artist page.** `chriszabriskie.bandcamp.com/music` lists 20 releases. The resolver opened the first ten and returned 129 tracks in 6.8 s, marked partial.
- **SoundCloud.** A profile of 295 tracks took 14.5 s to list, and a profile's sets page 14.6 s. Both are close to the server's 20 second limit, so a slower connection can time out. One track went through the real UI (paste, review, queue, worker, tagging) into `Scott Buckley/In This Moment (CC-BY)/` as a 160 kbps AAC file, tagged from the site and noted "no catalog match" by the Deezer lookup. A set that is an album was checked at the listing stage only, not downloaded.
- **Audius.** Six page reads at once drew HTTP 429 from Audius, so the resolver reads three at a time and tries a failed page once more; a profile of 15 tracks then listed in full. Audius covers sit on many different node hosts, so none is kept.
- **Jamendo.** A 12 track album listed in 8.1 s with each track's title and artist, numbered by list order. yt-dlp listed no cover art for it, so its files have none.
- **Audiomack.** Not checked beyond the failure above. What an album's rows look like comes from reading the extractor's code, not from a run: each row is a file address on Audiomack's storage host, with no song page. The row has `working` off, so it is left out of the "It works with:" message and a pasted Audiomack link is refused with "Audiomack links don't work right now. The tool Musimo uses can't read that site." Its tests and probe entry stay, so a fixed yt-dlp needs one line changed.

### Mixes and radio, checked for real

On 19 September 2026 with yt-dlp 2026.8.19, no cookies, from a Windows machine, each through the real resolver, queue, worker, tagging and index, one attempt each (so no median or p95; the times are from a slow connection and include the download). These are other people's recordings, so they are not in `scripts/source_probe_sites.json`, and nothing was kept.

| Site       | Link                                                         | Result                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HearThisAt | one 6 minute track                                           | Resolved in 1.1 s. Downloaded in 115 s to `Mixes/<uploader>/2026-09-17 - <title>.mp3`, a 14.7 MB MP3 at 320 kbps, genre `DJ Mix`, with the cover. The page names no uploader, so the name in the address (a short code for this account) was used as artist and album. |
| NTS        | an episode from 2022, through its Mixcloud copy              | Resolved in 2.3 s (album `Absolute Fiction`, read from the address). Downloaded in 147 s: an 80 MB Opus file at 180 kbps, genre `Radio`, with the cover, under `Mixes/Mixcloud NTS Radio/2022-07-25 - ...`.                                                            |
| BBC Sounds | a 45 minute 2004 programme, pasted as a `/sounds/play/` link | Read as its `/programmes/` page in 4.2 s. Downloaded in 89 s: a 101 MB AAC file at 318 kbps, genre `Radio`, artist `BBC Sounds`, album `Desert Island Discs`, no date in the data so the file is dated the day it was downloaded.                                      |
| Mixcloud   | one show, and a small account's uploads                      | The show resolved in 2.2 s with a cover (its address has no file extension, so the resolver takes a bare address for these kinds). A user page listed in 14.6 s and was marked partial. The track artists yt-dlp lists for a mix are not used; the uploader is.        |
| TuneIn     | two podcast programmes                                       | Failed both times: "HTTP Error 400" from the site's own API, then a `KeyError`. Switched off.                                                                                                                                                                          |

- **Refusals, against the real server.** A BBC news video link ("Musimo only takes programme and Sounds pages from BBC Sounds."), a TuneIn station ("Live streams never finish, so they can't be saved.") and an Audiomack link ("Audiomack links don't work right now...") each showed their own message on the review sheet.
- **Geo restriction, for real.** A current Desert Island Discs episode (`/programmes/m0031c9v`) answered "geolocation" to this machine, and the real resolver turned that into 422 "BBC Sounds only plays in the UK, and this server is not there." at the preview. The 2004 programme above plays anywhere, so a BBC link can go either way.
- **Not checked.** A Mixcloud account with thousands of uploads (yt-dlp reads every page before it returns, so it cannot finish in 20 seconds). A SoundCloud track over 20 minutes was covered by tests on canned data only.

Not checked: an item whose originals are FLAC (the FLAC choice is covered by tests on canned formats and yt-dlp's own format selector, not by a download), an item with two originals of one track, a restricted or private file, the Deezer tidy-up on an Archive track (the smoke test stubs it), and the YouTube entry of the site list, which needs the PO token provider.

Spotify, Apple Music and Tidal audio are DRM and stay out. A pasted Spotify or Apple link is a catalog import (resolve to Deezer, then match as usual), which the brief plans separately. This plan only makes the search box say so plainly.

## Phase 0: shared groundwork

Everything else depends on this. None of it is visible on its own.

**Site allowlist.** New `backend/sources.py` holds one table: extractor name, site label, kind (`music`, `mix`, `radio`), and whether Deezer tidy-up applies (`catalog_tidy`, off for the Internet Archive; an entry that came from an album list is never tidied whatever the site says). [Architecture](architecture.md) already requires an allowlist before any URL reaches a download API. The worker passes the same list as yt-dlp's `allowed_extractors`, which switches off the generic extractor, so a pasted link can never make the server fetch an arbitrary address and a redirect to an unlisted site fails. No cookies, no logins, no extra yt-dlp arguments from the browser.

**Link jobs.** `Job.catalog` gains `"link"`. `source_url` already exists for podcasts. `track_id` becomes a stable hash of `extractor:id`, so the duplicate index and "reuse a finished job" keep working. `Job` gains `source` (`youtube`, `soundcloud`, `bandcamp` and so on) for display, pausing and error mapping.

**Worker.** The `podcast` flag in `worker.py` turns into "direct": no search, no catalog duration check, URL taken from the job. Live streams are refused before download (`is_live`). Mixes and radio get the one-hour timeout that episodes have.

**Per-source pause.** Architecture says three blocking errors pause one source and leave healthy ones alone. The code has a single `source_paused` flag and treats everything that is not a podcast as YouTube (`downloads.py:197`). That has to become a pause per `source` before a second source ships, or a YouTube block would hold back Bandcamp and a Bandcamp error would pause YouTube. The YouTube-only error codes (`POT_MISSING`, `JS_RUNTIME_MISSING`, `COOKIES_EXPIRED`) only apply when `source` is `youtube`.

**Hardcoded YouTube.** Candidate links (`downloads.tsx:611`), the `Pick` pattern and the worker's 11-character ID check, and the `NO_MATCH` and `SOURCE_BLOCKED` hints all assume YouTube. `Candidate` gains `source` and `url`, and the hints name the site.

## Phase 1: paste a link

The search box already says "Search music or paste a link" and does nothing with a link. This is the big one: every later phase is mostly a row in the allowlist.

Flow:

```text
paste link
   |
   +-- site not on the list ---> "Musimo can't download from <host>. It works with: ..."
   +-- Spotify / Apple --------> "Catalog imports are not built yet."
   +-- live stream ------------> "Live streams never finish, so they can't be saved."
   |
   v
review sheet: site, title, uploader, length, artwork, where the file will land, format
   |            (album, playlist or profile: tick list, skip owned, capped at 500)
   v
queue ---> same job cards, pause, retry, history
```

- `POST /api/links/resolve` takes the URL, checks it against the allowlist, and runs a flat, no-download extraction in a worker process with a 20 second budget. It returns a preview and a short-lived token. Nothing downloads at this step.
- `POST /api/links` takes the token and the ticked entry IDs. The server queues from its own saved preview, so the browser never supplies titles, paths or file addresses. This keeps the podcast rule ("the file address never comes from the browser") as close as a pasted link allows.
- A multi-entry link becomes one download group, reusing the artist review sheet and the group pause, resume and cancel controls.
- Metadata comes from the site: title, artist or uploader, album, year, artwork. For kind `music`, the server then tries one Deezer lookup by artist, title and length. A confident hit swaps in the full Deezer metadata, so the file lands in the normal library layout and ownership badges work. No hit keeps the site's own tags and adds a note on the job. AcoustID stays later work.
- A pasted YouTube link goes through the same path with `source` set to `youtube`, so it respects the YouTube pause and keeps the YouTube error codes.

## Phase 2: SoundCloud as a backup match source

For normal Deezer downloads. SoundCloud is tried only when YouTube is paused or blocked, or when YouTube returns `NO_MATCH`. It is not searched in parallel: SoundCloud is full of remixes, reuploads and sped-up edits, and there is no equivalent of YouTube's "Topic" channels to trust.

- The worker runs `scsearch8:` and feeds the same `Matcher`. The version-word penalty already covers remix, live, cover and slowed.
- A higher bar than YouTube: minimum score 0.70, and "check match" below 0.90. Both numbers are guesses until measured.
- Settings gets a SoundCloud source card with one toggle, default off. It turns on by default only after `scripts/match_benchmark.py` has run the 100-case corpus against SoundCloud and the precision is written into [measurements](measurements.md).
- Quality is lower than YouTube (about 128 kbps MP3 or 160 kbps AAC for free streams). Job cards already show the measured bitrate, so no new UI, but the source card says it up front.

## Phase 3: indie and unsigned music

Bandcamp, SoundCloud, Audiomack, Audius, Jamendo. Built, and checked for real on 19 September 2026 (see What was checked), except that Audiomack does not work today: its row has `working` off. After phase 1 this was allowlist rows, a metadata mapping per site, and probes, and [Downloads](downloads.md#indie-sites) describes how each behaves.

- A Bandcamp album maps cleanly: album title, track numbers, artist, cover. It lands like a catalog album (checked with a real download, see above). The list itself carries only titles, so the artist, date and cover come from the first track's page, and track numbers are the list order.
- The review sheet states the quality ceiling per site before queueing. The Bandcamp line the plan wanted was too simple, because an artist's free download is lossless: it now says the stream is 128 kbps MP3 and that a free download, when offered, is taken instead.
- Profile links (a whole SoundCloud or Bandcamp artist) use the tick list with nothing ticked by default, and open up to ten releases.
- A SoundCloud set is an album only when SoundCloud says so. A playlist of mixed uploaders keeps each track's own artist and has no shared album.

## Phase 4: DJ mixes and radio shows

Mixcloud, NTS, HearThisAt, SoundCloud tracks over 20 minutes, BBC Sounds, TuneIn podcasts. Built, and checked for real on 19 September 2026 (see What was checked), except that TuneIn does not work today: its row has `working` off. [Downloads](downloads.md#mixes-and-radio-shows) describes how it behaves.

- Kind `mix` and `radio` skip Deezer tidy-up, lyrics and MusicBrainz. The kind is per recording: a SoundCloud track over 20 minutes is a `mix` although its site row is `music`.
- Files land at `Mixes/<uploader>/<YYYY-MM-DD> - <title>.<ext>`, ignoring the music naming template, the same way episodes do. The date is the upload or broadcast day, else the day it was downloaded. Tags: uploader as artist, show or uploader as album, genre DJ Mix or Radio. Navidrome then shows each DJ or show as an album. The review sheet shows the landing path before anything is queued.
- BBC Sounds fails outside the UK. That gets its own plain message, "BBC Sounds only plays in the UK, and this server is not there.", under `GEO_RESTRICTED` instead of `DOWNLOAD_FAILED`, and it never counts toward pausing a source. Only its programme and Sounds pages are taken, not its video or news pages.
- TuneIn stations and any other live stream are refused at the review step. NTS episodes are hosted on Mixcloud or SoundCloud, so a link there passes through to their extractors.

## Phase 5: Internet Archive

Live concert recordings, 78rpm transfers, netlabels. Legal and stable. Built, and checked for real on 19 September 2026 (see What was checked). [Downloads](downloads.md#internet-archive) describes how it behaves.

- An item is a multi-file playlist, so it uses the phase 1 tick list. Original format keeps FLAC when the item has it; the worker already accepts `.flac`.
- Tags from the item: creator, title, date, track order.
- One public-domain item becomes the fixture for the link path in `scripts/download_smoke.py`, next to the existing Wikimedia fixture.

## Order and size

| Order | Phase                              | Size   | Why here                                             |
| ----- | ---------------------------------- | ------ | ---------------------------------------------------- |
| 1     | 0 + 1, groundwork and paste a link | Large  | Everything else hangs off it.                        |
| 2     | 5, Internet Archive (built)        | Small  | Gives the link path a legal end-to-end test fixture. |
| 3     | 3, indie sites (built)             | Small  | Mostly allowlist rows and probes.                    |
| 4     | 4, mixes and radio (built)         | Medium | New file layout and the geo and live refusals.       |
| 5     | 2, SoundCloud backup               | Medium | Riskiest for wrong matches, so it needs measuring.   |

## Testing

- Unit tests use the existing `Downloader` protocol with canned info dicts per site, so CI never touches a real site.
- Allowlist tests: a generic URL, a `file://` URL, a private address, and a redirect off the list are all refused at resolve and again in the worker.
- `scripts/source_probe.py` loses its YouTube-only assumptions (the PO token argument becomes optional) and gains a small list of one public URL per site. Results go into [measurements](measurements.md) with the date and yt-dlp version. Done: the argument now goes only to YouTube URLs, `--site-list` reads `scripts/source_probe_sites.json`, and the Internet Archive and indie site results are recorded.
- UI checks for the review sheet follow [UI verification](ui-verification.md): phone and desktop, keyboard, axe.

## Docs to update as each phase lands

[Downloads](downloads.md) (flow, error table, layouts), [architecture](architecture.md) (API list, the "not yet implemented" list, the pause wording), [settings](settings.md) (source cards), [search](search.md) (link handling in the search box), [roadmap](roadmap.md), `CHANGELOG.md`.

## Starting choices

These are defaults picked to get going. Each is cheap to change later.

1. Deezer tidy-up on a pasted music link is automatic. The job card says which tags it used.
2. The SoundCloud backup runs after a YouTube `NO_MATCH` or while YouTube is paused. It does not run after `DURATION_MISMATCH`.
3. A profile or playlist link is capped at 500 entries.
4. `Mixes/` sits beside `Podcasts/` in the chosen music root. There is no separate destination setting.
