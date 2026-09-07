# Measurements

Run date: 6 September 2026 HST. Host: Windows desktop, Docker Desktop Linux/amd64. Experimental raw data initially lives in `.research`; final summaries are copied to `docs/evidence`.

## Completed research checks

- Navidrome ping: 0.63.2, 82 ms in an unauthenticated request. This confirms version/reachability only.
- Navidrome database: 2,738 media files, one library, counted read-only.
- Watcher: live log entries showed scans triggered and completed on the same date.
- Direct Deezer search: one request, 583 ms. Track details: one request, 499 ms. Neither sample is a p95.
- First container Deezer run: 60/60 requests succeeded at roughly 9.5 starts/second. This is not a discovered hard limit.
- First worker microbenchmark: cold import 252 ms; ten fresh child imports median 240 ms; warm YoutubeDL construction mean 27 ms; idle-child SIGTERM 3.35 ms. Repeat: 312 ms / 216 ms / 28 ms / 3.28 ms respectively. These exclude network work and active downloader cancellation.
- Initial upstream fixture `BaW_jenozKc`: three unavailable responses, then stopped. An unavailable fixture is not a source outage.

## Transport experiments and remaining measurements

- Replacement fixture: official Blender Big Buck Bunny (`aqz-KE-bpKQ`), full audio download with pinned Deno/EJS/bgutil, no cookies: **50/50 succeeded**, median **3.978 s**, p95 **5.751 s**. One sequential worker, one-second waits, fresh output paths and process per trial, cache disabled, zero retries. This is a repeated-fixture transport result, not a 50-distinct-track music study.
- Requested 50 distinct music downloads and real format ceilings: not yet established. One repeated film is not that sample.
- Premium-format behaviour: no Premium cookies supplied.
- Live transfer cancellation: one throttled sample per method. Child SIGTERM 7.351 ms; running Future refused cancellation, cooperative hook stopped the thread in 42.849 ms. This does not measure a socket stall or an eventual scheduler's UI acknowledgement. [Raw results](evidence/cancel.json).
- aria2 A/B: five paired alternating-order trials per downloader, full 10.2 MB fixture, fresh process/extraction, no retries/cache, ten successes. Median native 4.201 s; aria2c 12.933 s. [Raw results](evidence/aria2.json).
- Resolver precision on 100 independently labelled tracks: not measured; no reference corpus yet.
- Full 50k tag scan, 12-track album timings and end-to-end public-domain tagging test: require later phases.
- arm64: image design targets it; native amd64 validation does not prove arm64 correctness.

Every unavailable metric must be printed as NOT IMPLEMENTED or NOT MEASURED by the release benchmark, never zero or PASS.

## Phase 2 container checks

The live scanner indexed **2,770 files with zero errors** from the verified Windows library mounted read-only. This filesystem count is separate from the earlier 2,738-row Navidrome database snapshot. A subsequent unchanged-file scan took **23.8 seconds**. The initial scan was interrupted by an application rebuild, so no uninterrupted cold-scan duration is claimed.

Live track, album and artist search, year hydration, album detail, artist discography, Deezer preview HTTP range access, an iTunes fallback lookup and route reloads passed. A real library recording, 1991's “Chant”, returned an owned badge. Eight Python tests, strict typing and the React production build passed. A restart with an SSE stream held open took **2.97 seconds**; settings and event replay survived it. Browser rendering, keyboard interaction and audible playback were not exercised.

The first batched ownership query took too long because SQLite selected a broad join. Separate indexed identity joins reduced the final **50-track badge lookup p95 to 0.48 ms** and **cached search HTTP p95 to 2.81 ms** over 50 requests. Seven uncached searches after that change had median **399.43 ms**, p95 **559.34 ms**. Three additional searches were already cached and excluded from the cold sample. The cold 400 ms p95 target remains unmet. These HTTP timings exclude the 200 ms debounce and browser rendering. [Final search evidence](evidence/phase2-final-search.json).

Native filesystem events did not report a host-created fixture within 12 seconds on Docker Desktop. An initial five-second polling trial detected addition in **2.44 seconds** and deletion in **5.00 seconds**, one sample each. That setting used **7.67% of one CPU core** over a 15-second idle sample, so the shipped default was increased to 60 seconds. The generated fixture was removed and the index returned to 2,770 files. [Watcher evidence](evidence/phase2-watcher.json).

With 60-second polling and a lighter HTTP health probe every 30 seconds, a final 60-second idle sample used **1.463% of one CPU core** and **53.51 MiB anonymous resident memory**. CPU improved but still misses the 1% target. This is one short sample, not a sustained resource qualification. [Resource evidence](evidence/phase2-final-resources.json).

Known remaining acceptance work: cold-search latency, sustained idle CPU, browser-level interaction and first-paint timings, album cold/prefetched latency distributions, and the 50k-file index test. Download transport and resolver precision remain gated separately in later phases.

## Phase 1 container checks

The main Docker container built and became healthy. React production compilation, Python strict typing, ruff and two focused test cases passed. The actual HTTP smoke test passed: all five application routes, validated writes, cross-origin rejection, snapshot cursor consistency, Last-Event-ID precedence, cursor reset and JSON export. A container restart preserved both the saved value and replayable event. The runtime application process runs as UID 1000; Docker's small init process retains root.

An open SSE stream initially held shutdown until Docker's stop timeout. After bounding uvicorn's graceful shutdown to two seconds, the controlled restart with a real stream held open completed in **2.99 s** and replay still passed. The smoke script now covers this regression. This timing includes Docker restart overhead and is not a browser-render/reconnect p95.

50 direct requests per HTTP endpoint: snapshot p50 **1.07 ms**, p95 **1.34 ms**; health p50 **1.09 ms**, p95 **1.58 ms**; settings p50 **1.04 ms**, p95 **1.24 ms**. These exclude browser rendering and proxy transport. Raw results: [phase1-benchmark.json](evidence/phase1-benchmark.json).

One Docker stats sample after startup reported **38.32 MiB**, **0.15% CPU**. This is container accounting, not a sustained RSS/CPU acceptance test. The live Diagnostics Deezer test succeeded in **518.3 ms**. The second research Deezer run succeeded 60/60, median **421.375 ms**, p95 **515.61 ms**.

Reproduce the source transport experiment using the main image with the helper profile enabled and `scripts/source_probe.py` mounted into an isolated `docker compose run --rm --no-deps` container. Pass `--output` to a separate evidence directory; the script uses temporary media paths and no browser credentials. The public fixture may become unavailable, as the original upstream test fixture did.

Known development-tool notices: this Windows user's npm config contains an unsupported `node-linker` key; it was not changed. The current Starlette TestClient warns that its httpx adapter is deprecated in favour of httpx2. Tests pass today; the actual-container smoke test also passes independently of TestClient. Native arm64 and visual browser interaction testing have not been performed. Prettier and `@trivago/prettier-plugin-sort-imports` are installed under `frontend`. The repo-root `.prettierrc.yaml` loads the plugin from that folder so format-on-save and `npm run format:check --prefix frontend` resolve it. `singleAttributePerLine` is off so JSX stays readable on GitHub. ESLint adds the blank lines Prettier will not insert, via `@stylistic/padding-line-between-statements`. It parses TypeScript with Babel because typescript-eslint does not support TypeScript 7 yet. Type checking stays with `tsc`.

## Phase 3 download checks

Public-domain music fixture: 2.852 seconds from HTTP transfer through the regular resumed worker, tagging, atomic publication and immediate local indexing. Navidrome’s Windows watcher indexed the U.S. Navy Band recording with its written title and artist. Actual audio packet bitrate: 342,624 bps Vorbis, duration 78.263 seconds. This fixture uses Wikimedia transport; it does not measure YouTube music matching. See [fixture evidence](evidence/phase3-public-domain.json).

The real YouTube worker downloaded the verified open-film fixture as Opus at 125,785 bps. Pause acknowledgement took 10.44 ms and worker stop completed in 26.4 ms. Paused state survived a container restart. Killing the container after the first 1,024 bytes then restarting recovered the same job to completion. See [pause](evidence/phase3-pause.json) and [recovery](evidence/phase3-recovery.json).

The required 100 independently labelled music candidates, large music-batch throughput and native arm64 measurements remain open. Earlier search and idle-resource misses remain open too.
