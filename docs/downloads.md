# Downloads

Version 0.3 adds durable single-track jobs, album batches, queue controls and download history. Artist pages can prepare albums only or every release type in one review sheet with complete catalog counts, release selection and skip-owned defaults. Pasted-link imports remain later work.

## User flow

Choose a track format, then its download arrow. Download controls show the destination and format before queueing. Songs already in the library have a disabled download arrow, except when another edition is detected (same title and artist but different album), where the download remains enabled with a hint. Album cards download missing tracks and display where files will land. The album page has one button: Download album for an unowned album, Download missing (x + y editions) for a partial album showing both truly missing and edition counts, or a disabled Download album for a fully owned album. Track badges show distinct states: “In library” for exact matches, “Another edition in library (album name)” when a different edition is detected, “Queued” or other job stages for active downloads, and “Downloaded earlier” for completed downloads. The download arrow on a track row becomes Retry with the failure reason in its tooltip after a failure. The bottom queue and Downloads page share live state. Pause stops the worker process; resume keeps usable partial files. Cancel removes that job’s staging folder. Retry restarts a failed or cancelled job and resets the attempt count. Per card attempt counts are shown. Queue controls, tabs and batch summaries show their failed counts, and the Failed tab shows a reason summary with “Showing the latest N below” and groups the reasons with chips before listing each job. Failures are explained with plain language messages; the NO_MATCH message reads “No matching recording was found on YouTube. Nothing was downloaded.” When failures span more than one download group, the Failed tab offers a chip per group so an album’s failures can be read on their own; single-track failures group under Single tracks. Retry failed restarts every failure at once and Clear failed hides them; each finished card also has its own Clear to dismiss it individually. Clearing only hides a job, so History retains it and supports text and date filters. The floating queue button is hidden until a download is active. History and queue load more results on scroll.

Album-card status lines separate owned and queued counts. They come from the shared queue and library index, so they remain visible after opening a card and returning to the results page.

The default is Original. AAC stays M4A and Opus is remuxed into an Opus container without re-encoding. Other requested formats convert only when needed: AAC/Opus at 160 kbps, MP3 at 320 kbps. Conversion cannot improve a lossy source. Finished jobs show the measured audio packet bitrate and codec. Custom quality presets are not implemented yet.

A lower-confidence recording gets a “check match” flag. Its top three candidates link to YouTube for listening. If automatic matching rejects every candidate, the job now keeps up to three duration-valid rejected candidates for review instead of discarding them. Nothing downloads until the user selects one. Pause before choosing another match. A correction after completion writes a new file and keeps the previous file. Copy path is available; opening a folder on a remote Docker host is not implemented.

## Storage and safety

Select a writable configured music root in Settings. Staging lives at `<root>/.musimo/<job id>` on the destination filesystem. Only a probed, tagged audio file is published. Existing audio, artwork and lyric sidecars are never overwritten.

Linux uses `renameat2(RENAME_NOREPLACE)`. Docker Desktop Windows rejects that flag on its bind mount, so publication falls back to an atomic hard link followed by unlinking the staged name. A stored SHA-256 and final path reconcile a crash between publication and completion. No fallback copies into a visible half-written destination.

SQLite commits the job and its SSE event together. A partial unique index prevents concurrent duplicate track/format/destination jobs. Queue entry also reuses a completed job when its exact catalog ID, format and destination match and its file still exists. Explicit recording corrections can create a new file. Completed catalog IDs remain ownership evidence while their saved path is indexed, including when album responses omit ISRC or report a slightly different duration. An album expands transactionally into track jobs. Active duplicates are reused. Job snapshots and events omit lyrics to keep progress payloads small; complete metadata remains in the job record. The queue loads active jobs, their complete groups, the latest 50 failures and the latest 50 other finished jobs. Summary counts and failure reasons cover every visible retained job; history pages through all retained records.

## Metadata

Deezer supplies the canonical title, artist, album, numbering, date, genre, label, ISRC, barcode and contributors. MusicBrainz ISRC lookup requires an unambiguous artist/title recording, then an exact release-track match for release IDs. Ambiguous IDs remain empty with a note. Successful MusicBrainz responses cache for seven days; lyrics cache for one day. Optional enrichment has an eight-second budget and cannot block a download indefinitely.

Mutagen writes native ID3, MP4 or Vorbis tags, embedded cover artwork and lyrics. Synced lyrics also produce an LRC sidecar. MP3 uses the standard MusicBrainz recording UFID; MP4 uses the standard mixed-case MusicBrainz freeform names. Folder artwork is kept when already present.

## Navidrome

Choose `watcher` only when Navidrome’s file watcher is enabled and watches the same music folder. This was verified on the local Windows installation with a public-domain U.S. Navy Band recording: the new file appeared in Navidrome’s database with its written artist and title.

For explicit scanning, select `api`, set the Navidrome URL and library ID, and mount a JSON credentials file containing `username` and `password`. Set `MUSIMO_NAVIDROME_CREDENTIALS_FILE` to its container path. The file stays outside generic settings and diagnostics. Requests use a salted Subsonic token and `target=<library id>:<relative folder>`. API failures keep the saved file and add a warning. API scanning has fixture coverage but has not been exercised against this installation with real credentials.

## Controls and failures

Each song's three-dot button opens download options above the track list, including in scrolling lists. The popup stays inside the viewport and opens above the button when space below is tight. Click outside, press Escape, or scroll the list to dismiss it. Opening another song's options closes the previous popup.

Concurrency is 1–3, default 2. YouTube requests have a random 0.3–0.8 second delay. Retryable network and rate-limit failures use capped full-jitter backoff, up to four total attempts. Disk, permission, tagging, conversion and match failures require intervention. Three consecutive blocking source errors pause new work from YouTube.

The server acknowledges pause immediately and finishes stopping its process group asynchronously. Cancellation after publication completes reconciliation instead of deleting a file that has already landed. Paused state survives restart. Abruptly stopped running jobs return to the queue and resume through yt-dlp.

Repeated pause/cancel commands preserve the cleanup already in progress. Resume also accepts a job that is still stopping for pause; it queues the job after the old worker stops. Global and batch resume use the same behavior. Cancelling a stopping job changes its final intent without interrupting process termination.

An album with an incomplete catalog track list returns an error before creating any jobs. Retry after the catalog recovers. Download publication waits for any current library scan to finish pruning old entries before adding the finished file to the index.

## Verification and remaining gates

Automated tests cover Python 3.12 compatibility and Windows/Docker Python 3.14. They cover prior search/settings behavior plus queue identity, restart state, actual worker termination, protected publication, disk failure and tag round trips for all four output choices.

The live public-domain fixture took 2.852 seconds from download through local indexing and appeared in Navidrome. Its transport is Wikimedia, feeding the regular resumed worker; it does not validate YouTube matching. The separate YouTube open-film fixture completed through the actual worker, paused in 26.4 ms, preserved paused state across restart, then recovered after the container was killed during download.

A 100-recording public review corpus is prepared, including live, cover, remix, instrumental, karaoke and ambiguous-title risks. Independent listening labels are still missing, so match precision remains NOT MEASURED. See [Music match review](match-review.md). The ARM64 image builds, boots and passes 41 backend tests under emulation; native ARM hardware remains unmeasured. Custom quality, imports, cookie management, source update controls and notifications remain open. See [measurements](measurements.md) and the original [brief](brief.md).

The 7 September reliability checks exercised a generated 12-track album with real workers on Windows and Linux: pause, durable queue reopen, automatic retry, tags, immediate indexing and duplicate prevention. A separate Docker SIGKILL interrupted three workers during an MP3 batch; the same 12 jobs completed after restart with matching file hashes and no duplicates. The public-domain music fixture also passed through the worker into an isolated Windows Navidrome instance, whose watcher imported the written tags. These generated batches do not measure provider throughput or music-match accuracy. Commands and fixture boundaries are in [Testing and CI](testing.md#reliability-and-indexing-checks).
