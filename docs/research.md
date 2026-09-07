# Musimo: research and decisions

Checked 6 September 2026, Hawaii time (7 September UTC). These findings separate source documentation, local observations, and proposals. The brief is in [brief.md](brief.md). No existing downloader code is reused.

Names considered: **Musimo**, Crate, Sideband. Choose Musimo: short, easy to say, and already the workspace name. Name availability has not been checked.

## Owner defaults and observed environment

- Premium cookies: unavailable to this project. Start anonymously; do not extract browser cookies automatically.
- Paid lossless subscriptions: assume none. Paid providers disabled; Soulseek deferred.
- Navidrome: live unauthenticated ping reports **0.63.2 (be10f89c)**. A read-only database count found **2,738 tracks, one library**. No user credentials were read.
- Host: Windows 11 with Docker Desktop Linux containers; approximately 32 GB physical RAM. The machine notes identify a Ryzen 9 9900X. No CPU performance assumption is needed for Phase 1.
- Navidrome's actual configuration names its music folder; recent logs show its watcher triggering and completing scans. Musimo initially uses an isolated test folder. Real library mounts remain an installation choice.
- HTTPS: existing machine notes describe Tailscale Serve for Navidrome. This is not automatically an HTTPS endpoint for Musimo. Bind Musimo to loopback by default; configure a LAN bind or proxy explicitly.
- Phone: unknown. Build responsive browser UI for both platforms. Default to original audio; offer AAC preference for clients that cannot play Opus.
- Dark theme first. Temp files eventually live under each selected music root, not the SQLite volume.

## 1. YouTube requirements

Use yt-dlp **2026.8.19**, Deno **2.9.6**, bundled EJS, and bgutil plugin/server **1.3.2**, verified against the package registries and release API during this run. Pin the helper and plugin together. The [EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) requires a supported runtime plus challenge solver scripts. Installing `yt-dlp[default,curl-cffi]` supplied EJS in the prototype.

The [PO token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) currently recommends a provider for `mweb` GVS requests. It also lists a browser-based provider as a fallback. Prefer [bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider), which fits the two-container limit. Leave yt-dlp's client selection at its current defaults; keep client overrides out of the normal UI. Anonymous clients have different restrictions: `web` exposes SABR, `web_embedded` only works on embeddable videos, and `android_vr` excludes made-for-kids content. These are current upstream observations, not a promise that a given IP works.

Treat AAC around 128 kbps and Opus around 130–160 kbps as typical, not fixed ceilings or guaranteed formats. Premium can expose 256 kbps AAC, but no Premium account was tested here. Record the selected format and probe the actual file. FLAC/320 kbps encoding cannot restore lost information. Opus commonly arrives inside WebM; producing `.opus` may require a lossless remux, even though no audio encoding occurs. [spotDL's audio notes](https://github.com/spotDL/spotify-downloader/blob/master/docs/usage.md) also distinguish output bitrate from source quality.

Docker experiments and their sample limitations are recorded in [measurements.md](measurements.md). A retired yt-dlp fixture failed three times as unavailable. Its replacement, Blender's official Big Buck Bunny film, completed 50/50 full audio downloads with no retries: median 3.978 s, p95 5.751 s. Extracted format 251 was Opus in WebM at a reported 128.612 kbps, 10,202,210 bytes; AAC format 140 reported 129.481 kbps. No format 141 appeared. These are extractor estimates, not a post-download ffprobe measurement. Repetition of one accessible film is a transport test, not a representative music error rate. A distinct music sample and Premium comparison remain release gates.

## 2. Deezer

Live keyless requests to [track 3135556](https://api.deezer.com/track/3135556) returned ISRC, contributors, preview, track/disc position and release date. Search also returned ISRC and preview. Album-specific fields still need album hydration; do not make an album call for every search row.

The container sent 60 track requests spaced about 105 ms apart, with at most ten in flight. All 60 returned successfully. This supports a conservative 50-per-5-second client budget but does **not** establish Deezer's hard limit. No authoritative current limit contract was found. Stop on 429 or API error 4, respect Retry-After, and retain a shared limiter. The probe's response times are in the measurements. Previews now include expiry information in signed URLs: refresh stale preview URLs independently of a 24-hour album cache.

## 3. Spotify imports

The [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) requires Premium ownership for developer apps, limits search to ten results per request, renames playlist `/tracks` to `/items`, and restricts playlist contents to playlists the authenticated user owns or collaborates on. Its current text says removal of `external_ids` was reverted in March. Restrictions differ for extended quota apps.

Choose optional official OAuth for supported playlists, plus CSV import for everything else. A pasted unsupported playlist must explain the restriction and offer CSV, not silently enqueue an incomplete list. Anonymous web scraping is less stable; avoid making it the only import path. Track/album imports can resolve using available external IDs and catalog metadata. No owner Spotify credentials were available for a live authenticated prototype.

## 4. Navidrome scanning

The actual parameter is repeated **`target=libraryID:folderPath`**, for example `target=1:Artist/Album`, URL-encoded. It is not `libraryId` plus a separate `folder` parameter. Verify using the installed version's [handler](https://github.com/navidrome/navidrome/blob/v0.63.2/server/subsonic/library_scanning.go), not a generic Subsonic client schema. The [upstream tests](https://github.com/navidrome/navidrome/blob/master/server/subsonic/library_scanning_test.go) exercise multiple targets and `fullScan`.

Maintain a mapping from each container root to Navidrome's library ID and relative root. StartScan requires an appropriate authenticated user. A successful HTTP response alone does not mean the Subsonic operation succeeded.

This host's logs confirm an active watcher. Default its eventual integration to watcher mode. A remote Musimo install cannot reliably discover watcher configuration through standard Subsonic APIs; expose auto/explicit/watcher settings and show evidence or “unknown”. The [configuration reference](https://www.navidrome.org/docs/usage/configuration/options/) documents `Scanner.WatcherWait`, so watcher detection does not imply sub-second library visibility. Coalesce explicit scan targets once a batch finishes; track library visibility separately from a successfully written file.

## 5. Worker isolation

Choose one child process per active track, with an asyncio scheduler in the main process. Linux process groups allow cancellation of yt-dlp and its FFmpeg descendants. A cancelled Python thread cannot safely be force-stopped. Startup measurements found roughly 0.22–0.24 seconds for a fresh Python process importing yt-dlp versus about 27 ms for a warm YoutubeDL constructor. An idle imported child terminated in about 3 ms. These are local microbenchmarks; active transfer cancellation still needs testing.

In a subsequent live transfer throttled to 50 KB/s, process-group SIGTERM completed in 7.351 ms. Cancelling the running thread's Future was refused; a cooperative hook then stopped it in 42.849 ms. These are one-sample observations, and hooks cannot interrupt a blocked network read. Pay the startup cost for reliable control. A process pool is unnecessary initially. Keep a staged manifest and `.part` files on pause. Kill the group only after bounded graceful termination; the UI acknowledges the command before process exit. Persist desired action separately from observed stage. Restart interrupted post-processing from its input artifact, and recover moves by destination identity instead of downloading again.

## 6. aria2c

Omit it by default. Five paired trials of each downloader, alternating order, downloaded the same 10.2 MB audio fixture successfully. Native median was **4.201 s**; aria2c median was **12.933 s**, about 3.1 times slower. Both included a fresh yt-dlp process and extraction, disabled cache and retries, and used the same network. This sample supports the decision for this setup, not a universal claim about aria2. It also adds subprocess and continuation complexity. Reconsider only if another real workload shows a material gain without extra failures. Raw trials are in [aria2.json](evidence/aria2.json).

## 7. Resolver

Source reviewed directly on this date:

- [spotDL matching](https://github.com/spotDL/spotify-downloader/blob/master/spotdl/utils/matching.py) and [provider](https://github.com/spotDL/spotify-downloader/blob/master/spotdl/providers/audio/base.py): ISRC searches, title/artist matching, duration decay, verified results and a views-based tie preference. Do not let popularity override recording identity.
- [Tonus](https://github.com/madmax1301/tonus/blob/main/backend/services/youtube.py): title 0.45, artist 0.25, duration 0.20, rank 0.10 plus heuristics. Its [multi-source service](https://github.com/madmax1301/tonus/blob/main/backend/services/multi_source.py) rejects preview-length mismatches before score filtering. Preserve that useful distinction.
- [Octo](https://github.com/winters27/octo/blob/main/octo/Services/Soulseek/SoulseekDownloadService.cs): plausibility filters then variant penalty, quality, peer queue and upload speed. It also checks real duration after transfer. Its current code is more careful than its short README description.
- [Tubifarry](https://github.com/TypNull/Tubifarry/blob/master/Tubifarry/Indexers/Spotify/SpotifyToYouTubeEnricher.cs): album/artist fuzzy comparisons with ratio/partial/token thresholds, then album tracks. Album context is useful, but partial text agreement is not enough for recording identity.

Proposed service policy: normalize Unicode and punctuation without stripping version terms; convert all durations to seconds at the adapter boundary. Hard reject unavailable items, previews, explicit version conflicts, and duration differences above `max(12 seconds, 8%)`. When duration is unknown, cap confidence. Rank survivors using 0.45 title, 0.30 primary artist, 0.20 duration and 0.05 channel evidence. Feature credits add evidence but their absence does not erase a correct primary artist. Prefer Topic channels only as a small tie factor. An ISRC is strong catalog evidence, not proof that an unverified uploaded file is that recording.

Provisional thresholds: at least 0.86 and a 0.08 margin for an automatic confident choice; 0.72–0.86 downloads with “check match”; below 0.72 produces NO_MATCH without stopping sibling jobs. Show the top three candidates with component scores. Source failures fall back to the next healthy enabled source. Preserve source-specific rate budgets.

**Precision on 100 known tracks: not measured.** There is no independently labelled reference set in this empty repository. Generating expected matches from the same scoring algorithm would give a meaningless precision number. Before Phase 3 acceptance, collect 100 labelled track/candidate sets across common titles, collaborations, live/remix/acoustic versions, multilingual names, short tracks and classical movements. Report correct accepted / all accepted, coverage, wrong-version rate, and top-three recall separately. Keep these thresholds provisional until that test passes.

## 8. Library index

At 2,738 tracks, both memory and SQLite are fast enough. Choose SQLite for durable identity, multiple file copies and restart behaviour. Use exact indexed ISRC and recording-MBID queries first, then normalized artist/title and a duration range. A single rounded duration bucket misses neighbours at bucket boundaries; inspect adjacent buckets or use an indexed range. FTS5 supports human library search, not the primary ownership join.

Use a watcher for small changes, a periodic reconciliation walk for lost events, and immediate upsert on successful move. Run tag reads outside the asyncio loop. Windows bind mounts and network filesystems can lose events, so a watcher alone is insufficient. Full scans use scan generations; only remove absent rows after a complete successful walk. Cancellation must never mark the unvisited library as deleted. Cap scanning concurrency to protect search latency. A 50k synthetic lookup benchmark does not establish a 50k tag-reading benchmark.

## 9. Other projects and useful ideas

[MusicSeeker](https://github.com/lucashanak/music-seeker) has a broad provider/player experience. Borrow clear provider status, keep Musimo focused on finding and keeping music. Tonus's CSV import and library-first matching are useful. Octo's preview-before-keep and batch notifications fit well. [Tidarr](https://github.com/cstaelen/tidarr) exposes processing paths and actual download history; copy the clarity, not a subscription-dependent default. [MeTube](https://github.com/alexta69/metube) demonstrates a compact queue-oriented browser UI and multi-architecture image.

Additional projects found: [SoulSync](https://github.com/Nezreka/SoulSync) has version-aware repair and provider fallback, [Octo-Sync](https://github.com/m8tec/octo-sync) separates playlist reconciliation from acquisition, and [Blissful](https://github.com/Angablade/Blissful) exposes acquisition as a small Lidarr service. These are current discoveries, not a claim they all launched in 2026.

[slskd](https://github.com/slskd/slskd) and [Soularr](https://github.com/mrusse/soularr) remain useful later, but adding a Soulseek helper alongside bgutil would exceed the two-container limit unless slskd is external. The streamrip repository fetch failed during research. No unambiguous maintained music project named “mfui” was found, and deemix maintenance was not verified. Do not choose a dependency on those names without locating and inspecting its current source. These are explicit research gaps.

## 10. Corrections before implementation

1. Fast search is a local UX target, not a remote API SLA. The first direct Deezer search took 583 ms here, already above the 400 ms cold goal. Benchmark caching separately from provider latency.
2. Metadata enrichment cannot promise every ID and lyric on every track. Store provenance, absence and retryable enrichment state; never substitute the wrong release to fill fields. MusicBrainz recording ID and release-track ID are distinct.
3. LRCLIB is not unlimited. Its [current docs](https://lrclib.net/docs) require a client identifier, sequential requests, pauses during batches and Retry-After handling. They describe a roughly two-second duration tolerance and possible 404s. Lyrics must match the written recording, especially for flagged audio matches.
4. MusicBrainz enrichment at one request per second can consume an entire album's optimistic download budget. Cache by release/ISRC and allow visible enrichment-pending status. Apple documents approximately [20 calls per minute](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html), not a guaranteed quota.
5. An atomic audio rename does not atomically publish cover art, lyrics and database rows. Use a persisted move manifest, fsync and reconciliation. Never overwrite an unrelated existing file.
6. Environment settings are described both as “bootstrap only” and “locked”. Use env values as first-run seeds, then retain their origin and lock in SQLite. Removing the variable does not silently unlock a setting. A future explicit unlock operation can transfer ownership to the UI.
7. “Open folder” cannot open the server's file manager from a phone. Offer a copyable final path and configured share link.
8. Pause/stop under two seconds conflicts with allowing five seconds before SIGKILL. Acknowledge within 300 ms, use a bounded two-second escalation for transfers, and explain that tagging is finishing or will restart.
9. Hot updater rollback needs a separate versioned installation, not pip overwriting a running worker's environment. Keep updates manual and pinned until that exists.
10. shadcn now defaults to [Base UI](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default). Do not assume Radix props. The initial shell only needs native controls; add accessible complex primitives as their screens arrive.

Research gaps stay visible in [measurements.md](measurements.md). Phase 1 can establish storage, settings, realtime delivery and diagnostics without treating an unmeasured resolver as validated.
