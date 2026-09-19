# Downloads

Musimo provides durable single-track jobs, album batches, queue controls and download history. Artist pages can prepare albums only or every release type in one review sheet with complete catalog counts, release selection and skip-owned defaults. Pasted links open a review sheet from the search box (see below).

## User flow

Choose a track format, then its download arrow. Download controls show the destination and format before queueing. Songs already in the library have a disabled download arrow, except when another edition is detected (same title and artist but different album), where the download remains enabled with a hint. Album cards download missing tracks and display where files will land. The album page has one button: Download album for an unowned album, Download missing (n) for a partial album, or a disabled Download album for a fully owned album. Edition matches are shown on a separate line "N tracks have another edition in your library". Track badges show distinct states: "In library" for exact matches, "Another edition in library (album name)" when a different edition is detected, "Queued" or other job stages for active downloads, and "Downloaded earlier" for completed downloads. The download arrow on a track row becomes Retry with the failure reason in its tooltip after a failure. The bottom queue and Downloads page share live state. Pause stops the worker process; resume keeps usable partial files. Cancel removes that job's staging folder. Retry restarts a failed or cancelled job and resets the attempt count. Per card attempt counts are shown. Queue controls, tabs and batch summaries show their failed counts, and the Failed tab shows a reason summary with "Showing the latest N below" and groups the reasons with chips before listing each job. Failures are explained with plain language messages; the NO_MATCH message reads "No matching recording was found on YouTube." When failures span more than one download group, the Failed tab offers a chip per group so an album's failures can be read on their own; single-track failures group under Single tracks. Retry failed restarts every failure at once and Clear failed hides them; each finished card also has its own Clear to dismiss it individually. Clear all finished removes done, failed, and cancelled jobs from the queue. Clearing only hides a job, so History retains it and supports text and date filters. The History tab shows an empty state when nothing has finished yet. The floating queue button is hidden until a download is active. History and queue load more results on scroll.

Album-card status lines separate owned and queued counts. They come from the shared queue and library index, so they remain visible after opening a card and returning to the results page.

The default is Original. AAC stays M4A and Opus is remuxed into an Opus container without re-encoding. Other requested formats convert only when needed: AAC/Opus at 160 kbps, MP3 at 320 kbps. Conversion cannot improve a lossy source. Finished jobs show the measured audio packet bitrate and codec. Custom quality presets are not implemented yet.

A lower-confidence recording gets a "check match" flag. Its top three candidates link out for listening. Each candidate carries its `source` and `url`; the card links to that `url` and falls back to the YouTube watch page for jobs saved before candidates had one. Picking checks the ID against the candidate's own source (an 11 character ID for YouTube) and refuses a source with no ID rule. If automatic matching rejects every candidate, the job now keeps up to three duration-valid rejected candidates for review instead of discarding them. Nothing downloads until the user selects one. Pause before choosing another match. A correction after completion writes a new file and keeps the previous file. Copy path is available; opening a folder on a remote Docker host is not implemented.

## Podcast episodes

An episode downloads the publisher's own file, so there is no YouTube search, match review or duration check (feed lengths are rough and stitched-in ads change them). `POST /api/podcast-episodes` takes the show and episode IDs; the server looks the episode up again and never takes a file address from the browser. Jobs are stored with `catalog` set to `podcast` and the file address in `source_url`, so episode numbers never collide with Deezer track numbers.

Episodes keep the format the show publishes (usually MP3 or AAC) and land at `Podcasts/<show>/<YYYY-MM-DD> - <title>.<ext>` in the chosen folder, ignoring the music naming template. Tags use the host as artist, the show as album, the release date and the genre Podcast, with the show's artwork. The files are indexed like music, so Navidrome shows each show as an album. A worker gets an hour per episode instead of ten minutes. Episode jobs have `source` set to `podcast`. Host errors are reported as `DOWNLOAD_FAILED` and never count toward the YouTube block; a YouTube pause does not hold back episodes.

## Pasted links

A link to an allowed site downloads that recording directly, like an episode: no search, no match review, no catalog length check. The allowed sites live in one table in `backend/sources.py`. Each row has the site label, the job `source`, a kind (`music`, `mix` or `radio`), the URL hosts it accepts, the yt-dlp extractors a link may pass through, and the ones that mean a single recording. YouTube and the Internet Archive (both kind `music`) are listed so far. A row can also set the yt-dlp format selector for its recordings (`audio_format`), say that its lists are albums (`album_lists`), and give the address of a list entry that has none of its own (`entry_url`).

```text
POST /api/links/resolve {url}
   |
   +-- not https, IP host, user or password, odd port, host not listed ---> 422, names the allowed sites
   +-- Spotify or Apple Music ---> 422 "Catalog imports are not built yet."
   |
   v
child process, 20 s, no download ---> live stream? 422.  nothing downloadable? 422.
   |
   v
preview saved on the server for 10 minutes under a random token
   |
POST /api/links {token, entry_ids, format?, target?}
   |
   v
jobs with catalog "link" (more than one entry: one download group)
```

- The preview runs `python -m backend.resolver` in its own process group, the way the download worker runs, so yt-dlp never loads into the server. It is stopped after 20 seconds. It reads a list flat and returns at most 500 entries.
- Each preview entry has an ID, title, artist or uploader, album when the site gives one, date, length, artwork and an owned flag. Owned uses the library's title, artist and length match, since a site's own IDs have no ISRC. The server keeps an entry only if it is one recording from the same site; list pages, live streams and anything off the site are dropped. Artwork is kept only from the site's own image host (`i.ytimg.com` for YouTube, `archive.org` for the Internet Archive), because the server fetches it later. The resolver picks the largest JPEG by width and height when yt-dlp gives sizes. For YouTube it prefers `maxresdefault.jpg`, then `sddefault.jpg`, then `hqdefault.jpg`, and never a numbered frame grab such as `/3.jpg`. A video without a `maxresdefault.jpg` has no cover from that pick, because yt-dlp lists it without checking it exists; the job then notes "Cover art unavailable" and carries on.
- The server keeps at most 32 previews. An expired or unknown token gets 404 "This link preview has expired. Paste the link again."
- `POST /api/links` queues only entries from the saved preview. The browser never sends titles, file addresses or paths, and extra fields are refused. Metadata comes from the preview: title, artist (also album artist), album, date and artwork. A recording with no album is filed as its own single, with its title as the album, so every loose track without a catalog match becomes its own one-track album. The job note says so (see the Deezer tidy-up below).
- A link job's `track_id` is a stable 63 bit hash of `extractor:id`, so the same recording from a direct link or a playlist reuses the active or finished job like any other track. The job's `source` comes from the site row, so a YouTube link respects the YouTube pause and keeps the YouTube error codes.
- The worker passes the row's extractors to yt-dlp as `allowed_extractors`. That switches off the generic extractor, so a redirect to an unlisted site fails with `SITE_NOT_ALLOWED`. It reads the link once without downloading, refuses a live stream with `LIVE_STREAM`, and refuses anything that did not land on one recording of the site. No cookies, yt-dlp options or output paths come from the browser.
- Kind `music` lands through the normal naming template. Kinds `mix` and `radio` get the hour-long worker budget that episodes have; their `Mixes/` layout is later work and has a marked place in `Downloads.layout`.
- The search box opens the review sheet, described under Pasted links in [search](search.md#pasted-links). It calls `POST /api/links/resolve` once a whole link is pasted or submitted, and `POST /api/links` for the ticked entries. The resolve response has `profile`, true for a list from a person's or channel's page (`Site.profile_paths`), and the sheet then starts with nothing ticked.
- At most two lookups run at once (`MAX_RESOLVES` in `backend/links.py`, a semaphore); a third waits for a free place. When the browser cancels a lookup, `POST /api/links/resolve` notices the client leaving (it waits on the request's disconnect message beside the lookup task), cancels the lookup, stops the yt-dlp child and its process group, and frees the place at once. The response is 499, which nobody receives.
- The worker checks the job's own address before it reads anything: `backend.sources.match(source_url)` has to be the job's own site, or the job fails with `SITE_NOT_ALLOWED`. `allowed_extractors` then covers redirects.
- A link job goes straight to `downloading`, since it has no search. Its card lists no matching stage and shows "from <site>".
- Deezer tidy-up (`backend/link_tags.py`): a job of kind `music` runs one catalog lookup by artist, title and length just before its first download attempt, so mixes and radio shows (kinds `mix` and `radio`) never call the catalog. The pasted side is cleaned before the lookup. A title of the form "Artist - Title" is split, and the artist from the title replaces the uploader's. Upload decoration is dropped: "(Official Video)", "[Official Audio]", "(Lyrics)", "| Official Video", "- Official Music Video" and a trailing "HD" or "4K". A trailing "VEVO" or " - Topic" comes off the uploader. Version words (live, remix, acoustic and the rest) stay, because they are musical differences. The cleaned pair is searched first and the raw pair second, both inside the one eight second budget, and both must clear the same bar below, so cleaning can only find a recording the raw pair missed, never accept a worse one. A hit is confident only when all of these hold, scored by the same `Matcher.score` the YouTube match uses: the title similarity and the artist similarity are both at least 0.9 (the matcher's "artist named in the title" lift does not count), the length is inside the matcher's tolerance (the larger of 15 seconds and 12%), the site gave a length at all, and there is no version word (live, cover, karaoke, remix, slowed, sped, instrumental) on one side that the other lacks, in either direction, so a remix is never tidied to the original or the other way round. The best confident hit wins.
- On a confident hit the job takes the catalog's full tags (title, artist, album artist, album, track and disc numbers, date, genre, label, ISRC, barcode, contributors and artwork; the site's artwork stays if the catalog cover fails the media check), so the file lands in the normal library layout and the ownership badges match it by ISRC. Lyrics and MusicBrainz IDs are not fetched for links. Otherwise the site's tags stay. Either way the job gets one note in its `notes` list, which is separate from `warnings`. The card shows a note as plain muted text and the done heading counts only warnings, so a clean download no longer reads "1 warning". The notes are: "Tagged from the Deezer catalog", "Tagged from YouTube, no catalog match", or "Tagged from YouTube, the catalog lookup failed" after a timeout or a catalog error. When the site's tags stay and the album is empty or the same as the title, the note ends "It is filed as its own album named after the track". The lookup shares the eight second enrichment budget (`BUDGET_SECONDS` in `backend/enrichment.py`), and its failure never fails the download. A retried job keeps its first note and does not look again. Jobs stored before `notes` existed load with none, and a job that kept the note in `warnings` counts as tidied too, so it is not looked up again. AcoustID stays later work.
- Not built yet: any site besides YouTube and the Internet Archive.

### Internet Archive

A link to an item on `archive.org` or `www.archive.org` (source `archive`, kind `music`, yt-dlp extractor `archive.org`) opens the same tick list as a playlist. The hosts are matched exactly, so `archive.org.example.com`, `web.archive.org` (the Wayback Machine) and the Archive's download servers are refused.

```text
item link ---> tick list, one row per track ---> one job per ticked track
                     |                                   |
   FLAC and MP3 of the same track: one row     FLAC if the track has it, else its original
```

- An item lists each track once. yt-dlp already lists one entry per original file with the other formats inside it. When an uploader left two originals of one track (an MP3 and a FLAC), the resolver keeps one row: two rows are one track when their titles match, their track numbers do not disagree and their lengths are within two seconds. The FLAC copy is the one kept, wherever it sits in the list. Two tracks that share a name but not a number or length stay separate.
- Each ticked track downloads from `https://archive.org/details/<item>/<file>`, built from the entry's ID (the entry itself carries no address). The ID is that path percent-encoded, so file names with spaces or quotes still work.
- The worker asks for `best[ext=flac]/best[ext=mp3]/best[ext=ogg]/best[ext=m4a]`. Original format therefore keeps FLAC when the track has one and otherwise keeps the original MP3, Ogg or M4A. A track whose files are all another type (WAV, SHN) fails with `DOWNLOAD_FAILED`.
- Tags come from the item. The creator (several are joined with a comma; a track's own creator or artist wins; the uploader is never used, since it is an account name) is the artist and the album artist. The item's title is the album. The item's date is the date, or its year when it has no date. A track's number is the site's own when every track in the item has one and no two match, otherwise its place in the list. The track total is the number of tracks. A single-file item has no list, so its own album, if any, is used.
- The Deezer tidy-up runs for these as for any music link, so a confident catalog hit replaces the item's tags.

## Storage and safety

Select a writable configured music root in Settings. Staging lives at `<root>/.musimo/<job id>` on the destination filesystem. Only a probed, tagged audio file is published. Existing audio, artwork and lyric sidecars are never overwritten.

Linux uses `renameat2(RENAME_NOREPLACE)`. Docker Desktop Windows rejects that flag on its bind mount, so publication falls back to an atomic hard link followed by unlinking the staged name. A stored SHA-256 and final path reconcile a crash between publication and completion. No fallback copies into a visible half-written destination.

SQLite commits the job and its SSE event together. A partial unique index prevents concurrent duplicate track/format/destination jobs. Queue entry also reuses a completed job when its exact catalog ID, format and destination match and its file still exists. Explicit recording corrections can create a new file. Completed catalog IDs remain ownership evidence while their saved path is indexed, including when album responses omit ISRC or report a slightly different duration. An album expands transactionally into track jobs. Active duplicates are reused. Job snapshots and events omit lyrics to keep progress payloads small; complete metadata remains in the job record. The queue loads active jobs, their complete groups, the latest 50 failures and the latest 50 other finished jobs. Summary counts and failure reasons cover every visible retained job; history pages through all retained records.

## Metadata

Deezer supplies the canonical title, artist, album, numbering, date, genre, label, ISRC, barcode and contributors. MusicBrainz ISRC lookup requires an unambiguous artist/title recording, then an exact release-track match for release IDs. Ambiguous IDs remain empty with a note. Successful MusicBrainz responses cache for seven days; lyrics cache for one day. Optional enrichment has an eight-second budget and cannot block a download indefinitely.

Mutagen writes native ID3, MP4 or Vorbis tags, embedded cover artwork and lyrics. Synced lyrics also produce an LRC sidecar. MP3 uses the standard MusicBrainz recording UFID; MP4 uses the standard mixed-case MusicBrainz freeform names. Folder artwork is kept when already present.

## Navidrome

Choose `watcher` only when Navidrome's file watcher is enabled and watches the same music folder. This was verified on the local Windows installation with a public-domain U.S. Navy Band recording: the new file appeared in Navidrome's database with its written artist and title.

For explicit scanning, select `api`, set the Navidrome URL and library ID, and mount a JSON credentials file containing `username` and `password`. Set `MUSIMO_NAVIDROME_CREDENTIALS_FILE` to its container path. The file stays outside generic settings and diagnostics. Requests use a salted Subsonic token and `target=<library id>:<relative folder>`. API failures keep the saved file and add a warning. API scanning has fixture coverage but has not been exercised against this installation with real credentials.

## Controls and failures

Each song's three-dot button opens download options above the track list, including in scrolling lists. The popup stays inside the viewport and opens above the button when space below is tight. Click outside, press Escape, or scroll the list to dismiss it. Opening another song's options closes the previous popup.

Concurrency is 1–3, default 2. YouTube requests have a random 0.3–0.8 second delay. Retryable network and rate-limit failures use capped full-jitter backoff, up to four total attempts. Disk, permission, tagging, conversion and match failures require intervention. Every job has a `source` (`youtube` for catalog matches, `podcast` for episodes, the site row's source for pasted links; stored jobs without one take it from their catalog). Three consecutive blocking errors (`SOURCE_BLOCKED`, `POT_MISSING`, `JS_RUNTIME_MISSING`, `COOKIES_EXPIRED`) pause new work from that source only, and a completed download from it resets its count. `POT_MISSING`, `JS_RUNTIME_MISSING` and `COOKIES_EXPIRED` name YouTube's own helpers, so any other source gets `DOWNLOAD_FAILED` instead. A 403 or 429 from another allowed site keeps `SOURCE_BLOCKED` or `RATE_LIMITED` for that site, so three blocks in a row pause that site alone. Podcast hosts are the exception: every show has its own host, so their refusals are `DOWNLOAD_FAILED` and never pause anything. `POST /api/queue/resume-source` resumes YouTube, or the source named in `?source=`. Queue controls keep `source_paused` as the YouTube flag and add `paused_sources`, the list of every paused source. The Downloads page shows one line per paused source, naming the site, with its own "Try <site> again" button that resumes that source only; a server that sends only `source_paused` still gets a YouTube line.

The server acknowledges pause immediately and finishes stopping its process group asynchronously. Cancellation after publication completes reconciliation instead of deleting a file that has already landed. Paused state survives restart. Abruptly stopped running jobs return to the queue and resume through yt-dlp.

Repeated pause/cancel commands preserve the cleanup already in progress. Resume also accepts a job that is still stopping for pause; it queues the job after the old worker stops. Global and batch resume use the same behavior. Cancelling a stopping job changes its final intent without interrupting process termination.

An album with an incomplete catalog track list returns an error before creating any jobs. Retry after the catalog recovers. Download publication waits for any current library scan to finish pruning old entries before adding the finished file to the index.

## Error codes and recovery

Failed downloads display a plain hint with a link to the relevant setting or diagnostic. Each error code maps to one fix target. The `SOURCE_BLOCKED`, `RATE_LIMITED` and `NO_MATCH` hints name the job's site; the table shows the YouTube wording:

| Code                 | Hint                                                       | Link target                      |
| -------------------- | ---------------------------------------------------------- | -------------------------------- |
| `DEST_UNWRITABLE`    | The destination folder is missing or not writable.         | Settings → Destination           |
| `DISK_FULL`          | Less than 128 MB is free on the destination drive.         | Diagnostics → Persistent storage |
| `MOVE_FAILED`        | The file could not be moved to its final location.         | Settings → Naming template       |
| `SOURCE_BLOCKED`     | YouTube is blocking requests. Check credentials and tools. | Diagnostics → Download source    |
| `RATE_LIMITED`       | YouTube rate limit reached. Wait before retrying.          | Diagnostics → Download source    |
| `POT_MISSING`        | The PO token is required for YouTube downloads.            | Diagnostics → Download source    |
| `JS_RUNTIME_MISSING` | Deno is required for extracting YouTube metadata.          | Diagnostics → Download source    |
| `COOKIES_EXPIRED`    | YouTube cookies have expired or are invalid.               | Diagnostics → Download source    |
| `CATALOG_FAILED`     | The music catalog could not be reached.                    | Diagnostics → Sources            |
| `TRANSCODE_FAILED`   | FFmpeg could not convert the audio to the target format.   | Settings → Output format         |
| `TAG_FAILED`         | The audio file could not be tagged with metadata.          | Settings → Output format         |
| `NO_MATCH`           | No matching recording was found on YouTube.                | Job card → Pick candidate        |
| `DURATION_MISMATCH`  | The downloaded audio length differs from the catalog.      | Job card → Pick candidate        |
| `LIVE_STREAM`        | Live streams never finish, so they can't be saved.         | None, clear the card             |
| `SITE_NOT_ALLOWED`   | The link led to a site Musimo does not download from.      | None, clear the card             |
| `TIMEOUT`            | The download stage timed out before completing.            | Retry button                     |
| `DOWNLOAD_FAILED`    | The download stopped without a specific cause.             | Retry button                     |
| `INTERNAL_ERROR`     | An unexpected error occurred during processing.            | Report with tool output          |

Successful downloads with Navidrome or artwork warnings now show the warning count in the done job heading while keeping the details element collapsed. The heading reads "opus · 161 kbps · 2 warnings" so successful jobs with scan notes remain visible without being marked as failures. A job's `notes`, such as where a pasted link's tags came from, are not counted there.

## Verification and remaining gates

Automated tests cover Python 3.12 compatibility and Windows/Docker Python 3.14. They cover prior search/settings behavior plus queue identity, restart state, actual worker termination, protected publication, disk failure and tag round trips for all four output choices.

The live public-domain fixture took 2.852 seconds from download through local indexing and appeared in Navidrome. Its transport is Wikimedia, feeding the regular resumed worker; it does not validate YouTube matching. The link case of the same script took a track of the Open Goldberg Variations through the whole pasted-link road on 19 September 2026: resolve, queue, the real worker, tagging and indexing took 5.047 seconds and left an MP3 tagged with the item's artist, album, date and track 5 of 32 (see [testing](testing.md#reliability-and-indexing-checks)). The separate YouTube open-film fixture completed through the actual worker, paused in 26.4 ms, preserved paused state across restart, then recovered after the container was killed during download.

A 100-recording public review corpus is prepared, including live, cover, remix, instrumental, karaoke and ambiguous-title risks. Independent listening labels are still missing, so match precision remains NOT MEASURED. See [Music match review](match-review.md). The ARM64 image builds, boots and passes 41 backend tests under emulation; native ARM hardware remains unmeasured. Custom quality, imports, cookie management, source update controls and notifications remain open. See [measurements](measurements.md) and the original [brief](brief.md).

The 7 September reliability checks exercised a generated 12-track album with real workers on Windows and Linux: pause, durable queue reopen, automatic retry, tags, immediate indexing and duplicate prevention. A separate Docker SIGKILL interrupted three workers during an MP3 batch; the same 12 jobs completed after restart with matching file hashes and no duplicates. The public-domain music fixture also passed through the worker into an isolated Windows Navidrome instance, whose watcher imported the written tags. These generated batches do not measure provider throughput or music-match accuracy. Commands and fixture boundaries are in [Testing and CI](testing.md#reliability-and-indexing-checks).
