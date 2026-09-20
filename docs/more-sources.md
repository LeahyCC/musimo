# More sources: what shipped

This began as a plan for five things yt-dlp makes possible beyond the Deezer to YouTube road: pasted links, a second match source, indie sites, mixes and radio, and the Internet Archive. All five are built. This file is now the record: what each phase shipped, what was tried against real sites and what was not, and what is still open. [Downloads](downloads.md) says how each part behaves today, and the [brief](brief.md) (sections 3, 4.2 and 7) holds the original scope.

```text
before   Deezer result ----> YouTube search ----> file
              podcast feed ----------------------> file

now      pasted link ---> allowed site? ---> review sheet ---> file
         Deezer result -> YouTube search -> SoundCloud search (setting on) -> file
```

Spotify, Apple Music and Tidal audio are DRM and stay out. A pasted Spotify or Apple link is refused with "Catalog imports are not built yet." A catalog import (resolve to Deezer, then match as usual) is separate work that has not started.

## What was checked

Against the pinned yt-dlp 2026.8.19 on 19 September 2026, every extractor below exists and reports itself as working. That flag only means upstream has not marked it broken. Eight sites were then downloaded from for real: the Internet Archive, Bandcamp, SoundCloud, Audius, Jamendo, HearThisAt, NTS (through the Mixcloud copy of the show) and BBC Sounds. Audiomack and TuneIn failed and are switched off in the site table (`working`). Mixcloud was read but not downloaded on its own; NTS's download went through Mixcloud's extractor, so it is covered that way. YouTube was not run for this work because it needs the PO token provider, and SoundCloud as a match source was not run against the live site at all.

The table is the site table in `backend/sources.py`, in its order.

| Site             | Kind    | Extractors                                                               | Result                                                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| YouTube          | `music` | `youtube`, `youtube:tab`, `youtube:playlist`, `YoutubeYtBe`              | Not run for this work. The pasted link uses the same row as the catalog road.                      |
| Internet Archive | `music` | `archive.org`                                                            | Downloaded. Multi-file items, one row per track. FLAC is kept when the item has it.                |
| Bandcamp         | `music` | `Bandcamp`, `Bandcamp:album`, `Bandcamp:user`                            | Downloaded: 128 kbps stream, or FLAC when the artist offers a free download.                       |
| SoundCloud       | `music` | `soundcloud`, `soundcloud:set`, `soundcloud:playlist`, `soundcloud:user` | Downloaded: 160 kbps AAC. `soundcloud:search` is not allowed. A track over 20 minutes is a mix.    |
| Audiomack        | `music` | `audiomack`, `audiomack:album`                                           | **Failed**: yt-dlp cannot read the live site. Switched off.                                        |
| Audius           | `music` | `Audius`, `audius:track`, `audius:playlist`, `audius:artist`             | Downloaded: 320 kbps MP3. No cover art.                                                            |
| Jamendo          | `music` | `Jamendo`, `JamendoAlbum`                                                | Downloaded: FLAC. Creative Commons music, named in the brief. No cover art in an album list.       |
| Mixcloud         | `mix`   | `mixcloud`, `mixcloud:playlist`, `mixcloud:user`                         | Read for real, not downloaded on its own. A user list is read in full, so a big account times out. |
| NTS              | `radio` | `nts.live`, then `mixcloud` or `soundcloud`                              | Downloaded, through the Mixcloud copy of the episode.                                              |
| HearThisAt       | `mix`   | `HearThisAt`                                                             | Downloaded: 320 kbps MP3. The data names no uploader.                                              |
| BBC Sounds       | `radio` | `bbc.co.uk`                                                              | Downloaded: 318 kbps AAC (HLS, so FFmpeg does the transport). UK only.                             |
| TuneIn           | `radio` | `tunein:podcast`, `tunein:podcast:program`                               | **Failed**: yt-dlp gets HTTP 400 from TuneIn's API. Switched off. Stations are live and refused.   |

### Internet Archive, checked for real

On 19 September 2026 with yt-dlp 2026.8.19, no cookies, from a Windows machine:

- `scripts/source_probe.py --site-list --only archive` made one attempt at one MP3 track (about 1.9 MB) and it succeeded in 3.307 s. One attempt is not a median or a p95.
- The real resolver read the item `The_Open_Goldberg_Variations-11823` as a playlist of 32 entries, one per track, each an MP3 original with an Ogg copy inside it. The entries have no address and no extractor name, and their IDs are file paths with a slash in them, so the resolver builds the address and the server accepts that ID shape.
- The link case of `scripts/download_smoke.py` took one track through resolve, queue, the real worker, tagging and indexing in 5.047 s. The file was an MP3 tagged with the item's creator as artist, its title as album, its date and track 5 of 32, and the library index held it.
- The Archive's licence field is set by the uploader. Items credited to Aphex Twin, Tool and Disney carry a CC0 tag in it, so the test item was chosen because its performer released it to the public domain herself, not because of that field. The reasons are in `scripts/source_probe_sites.json`.

Not checked: an item whose originals are FLAC (the FLAC choice is covered by tests on canned formats and yt-dlp's own format selector, not by a download), an item with two originals of one track, a restricted or private file, and the Deezer tidy-up on an Archive track (the smoke test stubs it, and the Archive row has the tidy-up off anyway).

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

## Phase by phase

Each phase lists what shipped, what was checked, and what stays open. "Tests" means the Python tests on canned yt-dlp answers (`tests/test_sources.py`, `test_links.py`, `test_archive.py`, `test_mixes.py`, `test_worker.py`), which never touch a site.

### Phase 0: shared groundwork

Shipped:

- **Site table.** `backend/sources.py` holds `SITES`, one row per site: label, kind (`music`, `mix`, `radio`), hosts, extractors, and the per-site rules the later phases needed. The worker passes the row's extractors as yt-dlp's `allowed_extractors`, which switches off the generic extractor, so a redirect to an unlisted site fails. Only `https` links to a listed host are read: no IP address host, no user or password, no odd port. Artwork hosts are allowlisted too, since the server fetches the cover. No cookies, logins or yt-dlp arguments come from the browser.
- **Link jobs.** `Job.catalog` gains `link`. `source_url` (already used by podcasts) holds the address, `track_id` is a stable 63 bit hash of `extractor:id` so the duplicate check and "reuse a finished job" keep working, and `Job.source` names the site for display, pausing and error mapping.
- **Worker.** Podcasts and links download the address in the job: no search, no catalog length check. A live stream is refused before download. Mixes and radio get the hour-long budget episodes have.
- **Per-source pause.** The `source_control` table (schema version 4) keeps a pause flag and a blocking-failure count per source, and the old single YouTube flag moves across on upgrade. The dispatcher skips a queued job only when its own source is paused. `POT_MISSING`, `JS_RUNTIME_MISSING` and `COOKIES_EXPIRED` only apply to YouTube jobs. `GEO_RESTRICTED` never counts toward a pause, and podcast refusals never do either.
- **No hardcoded YouTube.** A candidate carries its `source` and `url`, an ID is checked against its own source's rule, and the `NO_MATCH`, `SOURCE_BLOCKED` and `RATE_LIMITED` hints name the site.

Checked: tests cover a generic address, a `file://` address, a private address, a redirect off the list, the per-source pause with canned blocking errors, and an old database carrying its YouTube pause across. No real site has been blocked while this was watched, so the pause has only met canned errors.

Open: nothing planned.

### Phase 1: paste a link

Shipped:

- **Preview.** `POST /api/links/resolve` checks the address against the table, then runs `python -m backend.resolver` in its own process group, without downloading, for at most 20 seconds. It lists at most 500 entries and returns a preview with a token that lasts ten minutes. The server keeps 32 previews and runs two lookups at once. A browser that cancels stops the lookup and its child process.
- **Queue.** `POST /api/links` takes the token and the ticked entry IDs and queues from the saved preview, so titles, file addresses and paths never come from the browser. More than one entry becomes a download group.
- **Review sheet.** The search box opens it for a whole pasted link (`frontend/src/links.tsx`): one recording, or a tick list for a playlist or profile with owned songs unticked and a profile starting with nothing ticked. It shows where the file lands, the format and the site's quality note, and keeps Download off when the destination is missing or read-only.
- **Tags.** A loose track of kind `music` gets one Deezer lookup by artist, title and length just before its first attempt. A confident hit swaps in the catalog's tags, and otherwise the site's tags stay. The job carries a note saying which. Mixes and radio shows never call the catalog. A pasted YouTube link goes through the same path with `source` `youtube`.
- **Refusals.** An unlisted site, a Spotify or Apple link, a live stream and a site that is switched off each get their own plain sentence.

Checked: tests, and `frontend/e2e/links.spec.ts` in a browser at desktop and phone width (keyboard, axe, touch sizes, cancelling a lookup). That spec stubs the server for most cases and uses the real one for the refusal of an unlisted site and a Spotify link. Real downloads from the Internet Archive, Bandcamp and SoundCloud went through the sheet or the smoke test (see What was checked). The lookup on a real SoundCloud track found no catalog match, and no record here shows a confident hit on a real link.

Not checked: a pasted YouTube link against the live site. The sheet's results are not written up in [UI verification](ui-verification.md).

Open: AcoustID as a fallback for junk metadata, and catalog imports from Spotify and Apple Music links. Neither is built.

### Phase 2: SoundCloud as a backup match

Shipped: a Settings switch, "Use SoundCloud when YouTube has no match" (`soundcloud_fallback`, off by default, under Audio quality). SoundCloud is searched with `scsearch8:` only after YouTube answered `NO_MATCH`, or when YouTube was paused or blocked at dispatch. It is never searched beside YouTube, and a `DURATION_MISMATCH` never falls back. It uses a higher bar (accept from 0.70, "check match" below 0.90, against YouTube's 0.55 and 0.86), set in `backend/matching.py`. A job that matches there takes `source` `soundcloud`, so its blocks pause SoundCloud alone. Pressing Retry starts the job over on YouTube. Review candidates name their site.

Checked: tests on canned search results in `tests/test_worker.py`.

Not checked: a real `scsearch8` search through the worker, and whether real SoundCloud search results have the numeric IDs the candidate rule expects. Match precision is **not measured**: `scripts/match_benchmark.py --source soundcloud` exists, but the 100-case corpus has no SoundCloud rows, so the two thresholds are chosen, not measured (see [measurements](measurements.md)).

Open: measure the corpus against SoundCloud, then decide whether the switch should default to on.

### Phase 3: indie and unsigned music

Shipped: rows for Bandcamp, SoundCloud, Audius and Jamendo, plus Audiomack with `working` off. Each row has a `quality_note` shown on the sheet. A Bandcamp, SoundCloud or Jamendo album lands like a catalog album, and a SoundCloud set is an album only when SoundCloud says so. Profile links open up to ten releases. The resolver reads the page of every row that lists no title (at most 40) and fills an album's artist, date and cover from the first track, all inside a 14 second budget, and a page it could not finish is marked `partial`. The format selector `KEPT_AUDIO` skips ALAC, WAV and AIFF, which the worker cannot keep. A track whose list names no artist takes it from its own page when the worker runs.

Checked for real: see "Indie sites, checked for real" above. It found the ALAC failure, fixed by `KEPT_AUDIO`, and the Audius 429 that made the resolver read three pages at a time.

Not checked: Audiomack beyond the failure. A SoundCloud set that is an album was checked at the listing stage only.

Open: Audiomack, until yt-dlp reads the site again (then it is one line, `working`). A SoundCloud profile of about 300 tracks lists in about 14.5 seconds, close to the 20 second limit. `on.soundcloud.com` short links and a custom domain that serves a Bandcamp page are not accepted.

### Phase 4: DJ mixes and radio shows

Shipped: rows for Mixcloud and HearThisAt (`mix`), NTS and BBC Sounds (`radio`), TuneIn (`radio`, off), and SoundCloud tracks over 20 minutes, which are a `mix` although their row is `music`. Files land at `Mixes/<uploader>/<YYYY-MM-DD> - <title>.<ext>`, ignoring the naming template, and skip the Deezer tidy-up, lyrics and MusicBrainz. The sheet shows the landing path before anything is queued. NTS hands over to its Mixcloud or SoundCloud copy (`hops`). BBC Sounds takes only programme and Sounds pages, and outside the UK it fails with `GEO_RESTRICTED`, which never counts toward a pause. TuneIn stations, Mixcloud `/live/` pages and the NTS live channels are refused as live.

Checked for real: see "Mixes and radio, checked for real" above.

Not checked: a Mixcloud account with thousands of uploads, which cannot finish in 20 seconds. A SoundCloud track over 20 minutes was covered by tests only. There are no probe rows for these sites, since they are other people's work.

Open: TuneIn, until yt-dlp reads its API again.

### Phase 5: Internet Archive

Shipped: an item is a multi-file list that uses the tick list. When an uploader left an MP3 and a FLAC of one track, the resolver keeps one row, the FLAC. Each track downloads from `https://archive.org/details/<item>/<file>`, and the format selector prefers FLAC, then MP3, Ogg and M4A. Tags come from the item (creator, title, date, track order), and the item's own cover is used. The row has `catalog_tidy` off, so a live show or old transfer is never retagged as a studio album. One public-domain item is the fixture for the `link` case of `scripts/download_smoke.py`.

Checked for real: see "Internet Archive, checked for real" above.

Open: a track whose files are all WAV or SHN fails with `DOWNLOAD_FAILED`.

## Order and status

| Order | Phase                              | Size   | Status                                            |
| ----- | ---------------------------------- | ------ | ------------------------------------------------- |
| 1     | 0 + 1, groundwork and paste a link | Large  | Built.                                            |
| 2     | 5, Internet Archive                | Small  | Built. Gave the link path its end-to-end fixture. |
| 3     | 3, indie sites                     | Small  | Built. Audiomack is switched off.                 |
| 4     | 4, mixes and radio                 | Medium | Built. TuneIn is switched off.                    |
| 5     | 2, SoundCloud backup               | Medium | Built, off by default, not measured.              |

## Testing

- The Python tests use the `Downloader` protocol with canned info dicts per site, so CI never touches a real site.
- `scripts/source_probe.py` gives its PO token argument to YouTube addresses only, and `--site-list` reads one public, openly licensed address per site from `scripts/source_probe_sites.json`. Results are in [measurements](measurements.md) with the date and yt-dlp version.
- `scripts/download_smoke.py` has three cases: `wikimedia`, `link` (an Internet Archive track) and `bandcamp`. See [testing](testing.md#reliability-and-indexing-checks).
- The review sheet has `frontend/e2e/links.spec.ts`.

## Docs that carry the detail

[Downloads](downloads.md) (flow, error table, layouts), [architecture](architecture.md) (API list, the "not yet implemented" list, the pause wording), [settings](settings.md) (the SoundCloud switch), [search](search.md) (link handling in the search box), [roadmap](roadmap.md) and `CHANGELOG.md`.

## Starting choices

These were defaults picked to get going. Each is cheap to change.

1. Deezer tidy-up on a pasted music link is automatic. The job card says which tags it used. As built.
2. The SoundCloud backup runs after a YouTube `NO_MATCH` or while YouTube is paused, not after `DURATION_MISMATCH`. As built.
3. A profile or playlist link is capped at 500 entries (`MAX_ENTRIES` in `backend/links.py`). As built.
4. `Mixes/` sits beside `Podcasts/` in the chosen music root, with no separate destination setting. As built.
