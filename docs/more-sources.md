# More sources plan

A plan, and only phase 5 (the Internet Archive) is shipped behaviour so far. It covers five things yt-dlp makes possible beyond the current Deezer to YouTube road: pasted links, a second match source, indie sites, mixes and radio, and the Internet Archive. [Downloads](downloads.md) describes what exists today and the [brief](brief.md) (sections 3, 4.2 and 7) holds the original scope.

```text
today      Deezer result ----> YouTube search ----> file
                podcast feed ----------------------> file

planned    pasted link ---> allowed site? ---> review sheet ---> file     (phases 1, 3, 4, 5)
           Deezer result -> YouTube search -> SoundCloud search -> file   (phase 2)
```

## What was checked

Against the pinned yt-dlp 2026.8.19 on 19 September 2026, every extractor below exists and reports itself as working. That flag only means upstream has not marked it broken. One site has been downloaded from for real since then, the Internet Archive (see below). Every other site still needs its own probe before its phase ships.

| Site             | Extractors                         | Notes                                                        |
| ---------------- | ---------------------------------- | ------------------------------------------------------------ |
| SoundCloud       | track, set, playlist, user, search | The only music site with a search prefix (`scsearch`).       |
| Bandcamp         | track, album, user, weekly         | Free stream only, 128 kbps MP3.                              |
| Audiomack        | track, album                       |                                                              |
| Audius           | track, playlist, artist            |                                                              |
| Jamendo          | track, album                       | Named in the brief. Creative Commons music.                  |
| Mixcloud         | show, playlist, user               | No tracklists in the data.                                   |
| NTS              | `nts.live`                         |                                                              |
| HearThisAt       | track                              |                                                              |
| BBC Sounds       | `bbc.co.uk`                        | Geo-restricted to the UK. HLS, so FFmpeg does the transport. |
| TuneIn           | podcast, program, station          | Stations are live streams and never end. Refuse them.        |
| Internet Archive | `archive.org`                      | Multi-file items. FLAC is often available. Checked for real. |

### Internet Archive, checked for real

On 19 September 2026 with yt-dlp 2026.8.19, no cookies, from a Windows machine:

- `scripts/source_probe.py --site-list --only archive` made one attempt at one MP3 track (about 1.9 MB) and it succeeded in 3.307 s. One attempt is not a median or a p95.
- The real resolver read the item `The_Open_Goldberg_Variations-11823` as a playlist of 32 entries, one per track, each an MP3 original with an Ogg copy inside it. The entries have no address and no extractor name, and their IDs are file paths with a slash in them, so the resolver builds the address and the server accepts that ID shape.
- The link case of `scripts/download_smoke.py` took one track through resolve, queue, the real worker, tagging and indexing in 5.047 s. The file was an MP3 tagged with the item's creator as artist, its title as album, its date and track 5 of 32, and the library index held it.
- The Archive's licence field is set by the uploader. Items credited to Aphex Twin, Tool and Disney carry a CC0 tag in it, so the test item was chosen because its performer released it to the public domain herself, not because of that field. The reasons are in `scripts/source_probe_sites.json`.

Not checked: an item whose originals are FLAC (the FLAC choice is covered by tests on canned formats and yt-dlp's own format selector, not by a download), an item with two originals of one track, a restricted or private file, the Deezer tidy-up on an Archive track (the smoke test stubs it), and the YouTube entry of the site list, which needs the PO token provider.

Spotify, Apple Music and Tidal audio are DRM and stay out. A pasted Spotify or Apple link is a catalog import (resolve to Deezer, then match as usual), which the brief plans separately. This plan only makes the search box say so plainly.

## Phase 0: shared groundwork

Everything else depends on this. None of it is visible on its own.

**Site allowlist.** New `backend/sources.py` holds one table: extractor name, site label, kind (`music`, `mix`, `radio`), and whether Deezer tidy-up applies. [Architecture](architecture.md) already requires an allowlist before any URL reaches a download API. The worker passes the same list as yt-dlp's `allowed_extractors`, which switches off the generic extractor, so a pasted link can never make the server fetch an arbitrary address and a redirect to an unlisted site fails. No cookies, no logins, no extra yt-dlp arguments from the browser.

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

Bandcamp, SoundCloud, Audiomack, Audius, Jamendo. After phase 1 this is allowlist rows, a metadata mapping per site, and probes.

- A Bandcamp album maps cleanly: album title, track numbers, artist, cover. It should land exactly like a Deezer album.
- The review sheet states the quality ceiling per site before queueing ("Bandcamp streams are 128 kbps MP3. Buying the album there gets you lossless.").
- Profile links (a whole SoundCloud or Bandcamp artist) use the tick list with nothing ticked by default.

## Phase 4: DJ mixes and radio shows

Mixcloud, NTS, HearThisAt, SoundCloud sets over 20 minutes, BBC Sounds, TuneIn podcasts.

- Kind `mix` and `radio` skip Deezer tidy-up, lyrics and MusicBrainz.
- Files land at `Mixes/<uploader>/<YYYY-MM-DD> - <title>.<ext>`, ignoring the music naming template, the same way episodes do. Tags: uploader as artist, show or uploader as album, genre DJ Mix or Radio. Navidrome then shows each DJ or show as an album.
- BBC Sounds fails outside the UK. That gets its own plain message instead of `DOWNLOAD_FAILED`.
- TuneIn stations and any other live stream are refused at the review step.

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
| 3     | 3, indie sites                     | Small  | Mostly allowlist rows and probes.                    |
| 4     | 4, mixes and radio                 | Medium | New file layout and the geo and live refusals.       |
| 5     | 2, SoundCloud backup               | Medium | Riskiest for wrong matches, so it needs measuring.   |

## Testing

- Unit tests use the existing `Downloader` protocol with canned info dicts per site, so CI never touches a real site.
- Allowlist tests: a generic URL, a `file://` URL, a private address, and a redirect off the list are all refused at resolve and again in the worker.
- `scripts/source_probe.py` loses its YouTube-only assumptions (the PO token argument becomes optional) and gains a small list of one public URL per site. Results go into [measurements](measurements.md) with the date and yt-dlp version. Done: the argument now goes only to YouTube URLs, `--site-list` reads `scripts/source_probe_sites.json`, and the Internet Archive result is recorded.
- UI checks for the review sheet follow [UI verification](ui-verification.md): phone and desktop, keyboard, axe.

## Docs to update as each phase lands

[Downloads](downloads.md) (flow, error table, layouts), [architecture](architecture.md) (API list, the "not yet implemented" list, the pause wording), [settings](settings.md) (source cards), [search](search.md) (link handling in the search box), [roadmap](roadmap.md), `CHANGELOG.md`.

## Starting choices

These are defaults picked to get going. Each is cheap to change later.

1. Deezer tidy-up on a pasted music link is automatic. The job card says which tags it used.
2. The SoundCloud backup runs after a YouTube `NO_MATCH` or while YouTube is paused. It does not run after `DURATION_MISMATCH`.
3. A profile or playlist link is capped at 500 entries.
4. `Mixes/` sits beside `Podcasts/` in the chosen music root. There is no separate destination setting.
