# Bounded audio-analysis trial

14 October 2026. Milestone 2 only. Measurements and listening review are separate gates. Neither candidate is approved for production indexing until Colin has assessed the shortlist.

> **Missing files (found 20 October 2026).** The harness under `experiments/audio-trial/` was never committed, and the evidence under `runtime/audio-trial/` (including the listening page) is no longer on disk. The figures in this report are all that remain, and the reproduction steps below cannot run as written. The [analyser bake-off](analyzer-bakeoff.md) is the committed, rerunnable successor for tempo and genre.

## Measured result

Both candidates completed 100 sampled tracks and twelve fuller references under the enforced 2 GB, one-CPU, zero-swap limits. The corrected runs had no failed tracks, timeouts or OOM kills. Values below include decoder memory and use decimal MB. Repeated reads benefited from the shared filesystem cache.

| Measurement                                  |             MFCC |               CLAP |
| -------------------------------------------- | ---------------: | -----------------: |
| Peak container memory                        |           641 MB |           1,412 MB |
| Fresh-process load                           |      10.6–10.7 s |         6.3–10.9 s |
| Three-section median / p95 per song          |  0.366 / 2.899 s |    0.636 / 0.717 s |
| Three-section throughput                     |   93.0 songs/min |     90.1 songs/min |
| Fuller-reference median per song             |          2.741 s |            6.158 s |
| Raw vector per song                          |        160 bytes |        2,048 bytes |
| 100 profile JSON files / vector files        | 213 KB / 28.8 KB | 1.45 MB / 217.6 KB |
| Mean sampled/full top-five overlap           |            58.3% |              80.0% |
| Synthetic 44,070-vector scoring median / p95 | 0.129 / 0.444 ms |   1.866 / 2.011 ms |

CLAP text encoding plus scoring and selecting five results took **34.1 ms median, 37.4 ms p95**, over eighteen warm queries. Its combined peak was 833 MB. Loading the model and matrix took 5.21 seconds, and the first query then took another 1.72 seconds. The warm path meets the proposed 500 ms target in this harness; the cold path does not. This excludes HTTP, metadata filters and Ollama. The 44,070-entry matrix repeats the hundred measured vectors, so it measures scoring cost, not large-library relevance. Raw matrices would occupy 7.05 MB for MFCC or 90.26 MB for CLAP, before metadata and storage overhead.

Weighting measured times by the indexed format counts gives warm-cache p10/mean/p90 scan estimates of 3.9/5.7/7.9 hours for MFCC and 7.7/8.1/8.2 hours for CLAP. That narrow CLAP range understates disk uncertainty. The initial pass, excluding the two underfilled M4A files described below, implied 9.1/15.4/22.5 hours and 15.0/24.3/46.8 hours respectively. No cache was flushed, and the initial decoder differed. Use roughly **4–24 hours MFCC or 8–48 hours CLAP** as provisional active-time planning ranges, not bounds or a scan promise. Pauses, contention, slow seeks and errors can extend them. The sample overrepresents uncommon formats; these estimates correct format proportions but not every genre, duration or storage effect.

The twelve fuller-reference tracks reached 14.8 songs/min for MFCC and 8.0 for CLAP. Their p95 analysis times were 8.33 and 12.55 seconds, peak memory 286 and 659 MB, and fresh-process loading 10.58 and 5.08 seconds. Reference JSON/vector files occupied 35.2/3.46 KB for MFCC and 183.6/26.1 KB for CLAP. Lower peaks than the short runs reflect separate process lifetimes and cache/allocation effects, not a guaranteed saving from analysing more audio. All reference queries use the same hundred-track sampled catalogue, making their retrieval cost the same scoring operation shown above.

### Quality and listening gate

The twelve-reference comparison favours CLAP stability, but it does not establish musical accuracy. CLAP's sampled/full cosine ranged from 0.909 to 0.995; MFCC's from 0.515 to 0.985. Vintage Culture's `Cante por Nós (Reverse Effect, Tokah Remix)` retained only one of five CLAP neighbours despite a 0.956 cosine. The electronic-dance phrase also changed its first result within the reference subset from Fred V's `Gezellig` to Sub Focus's `Torus`. Three sections cannot yet be accepted for changing tracks.

On the hundred-track catalogue, CLAP suggested Fred again..'s `Catrin (Liverpool Street Station)` for dreamy guitar, Armin van Buuren's `Fathers and Sons` for instrumental piano without vocals, and Phish's `You Enjoy Myself` for gentle acoustic singing. These are unverified suggestions, not statements about their contents. The generated six listening checks compare both candidates, the least stable sampled/full result, early/middle/late mix sections and those three phrases. Open the file locally while Musimo is running. No listening approval has been recorded.

Recommendation: retain CLAP as the provisional text/audio candidate and MFCC as the baseline. Keep the two-GB cap. Defer production selection and sampling acceptance until the listening checks pass, particularly vocal exclusions and changing tracks.

### Playback and final checks

Four muted browser probes each advanced about 59.96 seconds during a sixty-second observation, without playback errors or stalls after playback began. Startup was 5.88 seconds during the initial MFCC run, 1.63 during initial CLAP, 2.26 during the corrected runs and 0.33 idle. Fixed ordering and shared caches prevent attributing those differences solely to analysis. Playback startup needs further review; these probes do not approve the whole player experience or listening quality.

Final deadline testing found that Python signal handlers can wait behind native code, while Linux PID 1 ignores a default SIGALRM. The final harness uses Compose `init: true` and the kernel's default alarm action. A native call holding the GIL plus a sixty-second child decoder was terminated in 1.12 seconds with exit 142 and no OOM. The earlier negative test took sixty seconds and is retained too. This deadline-only hardening followed the measured audio runs; audio recipes and calculations did not change. The measured worker SHA-256 was `6eeb2594ff5ea2b249628021082c485cf93d6914d261bb4fe7111b2cb90849e2`. Fresh reproduction needs a new output directory because resume rejects changed worker source.

## Server and scope

The machine notes identify pancakes as the Musimo server. Live Docker inspection confirmed `musimo-musimo-1`, image `musimo:0.4.0`, loopback port 8765, the `musimo_musimo-data` volume, and the existing `/library` and `/music` mounts. This is the actual server, not a substitute benchmark machine.

Hardware: Ryzen 9 9900X, 12 physical cores, 24 logical processors, about 31.1 GiB usable Windows RAM. Windows reported 2.65 GiB free at discovery. Docker Desktop exposes 24 CPUs and 5.78 GiB RAM to Linux. During the trial Linux reported 3.18 GiB available. Other existing services remained running, so these are shared-server measurements. Docker Engine is 29.7.2, Compose 5.5.0, Linux x86-64, cgroup v2.

`Get-Disk`, `Get-Volume` and the running container's mounts verified `M:\Media\Music` on the Toshiba 14 TB disk. `/music` maps to this checkout's `runtime/music`. The production mounts are writable because Musimo also downloads music; the trial mounts are separately read-only. No music, tags, permissions, production settings or database rows were changed.

A read-only SQLite query found 44,070 indexed files: 36,068 Opus, 5,789 M4A, 1,782 FLAC and 431 MP3. There are 154 podcast-tagged entries and 1,184 recordings longer than ten minutes. This is an approximate eligible count from the index, not a new filesystem scan or verification of every file. Excluding podcast-tagged entries would leave 43,916. No full-library audio scan was started.

The existing bot code matches the documented `keep_alive: "60s"` and capability-aware `think: false` behavior. The Ollama startup log at 08:55 HST confirms both `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1`. The stale plan note is corrected. Ollama and its selected Qwen model were left alone.

## Candidates

**CLAP:** `laion/clap-htsat-unfused`, revision `8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a`. The weights are 614,525,833 bytes, SHA-256 `1cd3c601bc4afe0fa87be3de4c13dd2cfadd249fac1e29acf74a9b296c3219bb`. The model card declares Apache-2.0 and documents CPU inference. Transformers 4.51.3, used here, is also Apache-2.0. The downloader checks the weights and all tokenizer/configuration blobs against this revision. [Model and CPU example](https://huggingface.co/laion/clap-htsat-unfused), [implementation licence](https://github.com/huggingface/transformers/blob/v4.51.3/LICENSE).

This smaller general-audio checkpoint is a bounded first candidate, not a claim to be the best music model. LAION also recommends larger HTSAT-base music checkpoints; those were not measured here. Its original implementation has a CC0 licence, distinct from the Hugging Face checkpoint and Transformers implementation used in this trial. [Upstream checkpoint guidance](https://github.com/LAION-AI/CLAP#pretrained-models), [original code licence](https://github.com/LAION-AI/CLAP/blob/main/LICENSE).

Input is mono float32 at 48 kHz, ten seconds per section. The checkpoint specifies a ten-second window and repeat-padding for shorter input. Each section produces 512 values. Section vectors are normalised, averaged, then normalised again. The weights alone occupy about 586 MiB in float32; runtime imports, activations, text inference and decoder memory must fit above that. The container test, not checkpoint size, decides whether it fits. [Input configuration](https://huggingface.co/laion/clap-htsat-unfused/blob/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a/preprocessor_config.json).

**MFCC baseline:** librosa 0.11.0, ISC licence, with no learned checkpoint and zero model-weight download. Its direct wheel is about 260 KB; NumPy, SciPy, Numba and other dependencies are additional downloads. It uses mono float32 at 22,050 Hz, twenty MFCC coefficients, each coefficient's mean and standard deviation, and averages those forty values across sections. Search standardises each dimension using the 100 sampled tracks, then normalises vectors and scores cosine similarity. The saved normalisation belongs to this trial; changing its fitted catalogue changes the comparison. This is a small CPU sound-texture baseline, not an instrument or mood classifier. [MFCC API](https://librosa.org/doc/0.11.0/generated/librosa.feature.mfcc.html), [licence](https://github.com/librosa/librosa/blob/0.11.0/LICENSE.md).

Sound similarity alone cannot answer arbitrary text such as “dreamy guitar.” CLAP can rank recordings against that phrase, but a high score does not prove that the music is dreamy, contains guitar, or has no vocals. Neither approach establishes strict vocal exclusions or reliable mood labels without listening evidence.

The isolated image uses Python 3.12.10, CPU PyTorch 2.6.0, Transformers 4.51.3, librosa 0.11.0, NumPy 2.2.6 and SciPy 1.15.3. `experiments/audio-trial/requirements.lock` records all resolved Python packages. The base image digest, FFmpeg 5.1.9 and libsndfile 1.2.0 package versions are pinned in the Dockerfile. Debian's FFmpeg build enables GPL components. The image and decoder details used for measurement are retained in `runtime/audio-trial/image-id.txt` and `ffmpeg-version.txt`.

## Selection and sampling

The snapshot and sample are retained as `catalogue.json` and `sample.json` under `runtime/audio-trial`. The catalogue SHA-256 is `ac8568a2f29b2fb1c20b7581b310ec8a96d2b63a092b7be2604b9d6c8fa07fa8`.

Selection is deterministic. Hash each path with seed `musimo-trial-20261014`; anchor every available format, the four longest recordings, and up to two title/album matches each for instrumental, acoustic, piano, live and mix. Fill remaining places by cycling formats and hashed genre/duration groups. Duration boundaries are 120, 300 and 600 seconds. Sorting the input differently does not change the sample. This deliberately varied sample is not proportional to the library.

The result is 100 real files: 22 FLAC, 26 M4A, 21 MP3 and 31 Opus, spanning 48 genre strings including missing tags. Six are podcast-tagged recordings, retained as difficult cases; this is not a claim of 100 verified music-only songs. Durations range from 13.63 seconds to 3 hours 15 minutes. No artist/title pair repeats, although different recordings or editions cannot be ruled out from tags alone. Vocal/instrumental coverage and changing musical sections still require listening confirmation. Generated audio was used only for decoder correctness checks.

The short recipe analyses ten-second sections starting at 10%, 50% and 90% of `duration - 10`. Duplicate start positions collapse for very short files. For short songs the sections can overlap; results record both summed analysed time and unique covered time.

The reference covers twelve sampled tracks: the first eight anchors and the final four selections. A 2–10 minute sampled MP3 replaces the long MP3 podcast anchor, because repeated seeks in that file were slow in the smoke test. The long Opus/M4A anchors remain. Reference windows cover whole ordinary songs and use at most sixty evenly spaced ten-second sections for long recordings. Long references therefore cover at most ten minutes, not an entire multi-hour mix. Start positions, actual decoded lengths, overlap and truncation are saved per track. Both recipes use identical aggregation within each candidate.

## Enforced limits and recovery

The standalone Compose file is opt-in and is never combined with the production stack. It sets 2,000,000,000 bytes RAM, equal total memory-plus-swap, one CPU equivalent, at most 64 processes, no network, a read-only root filesystem, read-only music/model mounts and a 128 MiB temporary filesystem. Only the separate experiment output directory is writable. User/group 1000 matches the existing music-folder ownership. No source ACLs were changed.

Docker inspection checks `Memory`, `MemorySwap`, `NanoCpus`, network mode and mount flags. The worker also checks the actual kernel controls and read-only mount flags before loading either candidate. On this server they are `memory.max=1999998976`, `memory.swap.max=0` and `cpu.max=100000 100000`. Linux rounds the requested byte ceiling down to a page boundary. The VM has swap available, but this worker cannot use it. Unsupported cgroup layouts fail closed rather than silently running uncapped. [Docker memory/swap semantics](https://docs.docker.com/engine/containers/resource_constraints/), [Compose controls](https://docs.docker.com/reference/compose-file/services/).

FFmpeg seeks before decoding and returns at most ten seconds of mono samples. Each decoder has a 30-second deadline. Model startup has 180 seconds; a short-recipe track has 120 seconds and a reference track 600 seconds. The host has a three-hour backstop per invocation. All decoder children belong to the worker's cgroup. Native-library thread counts are set to one. There are no automatic track retries.

Each completed track writes an atomic JSON record and a float32 vector. File size and modification time are checked before and after analysis. Resume skips completed records, including recorded failures; it rejects a different worker/checkpoint/package setup. A killed track is recorded by the host so an explicit resume can move past it. This is local experiment output, not a production job system or database migration.

The first smoke invocation stopped before model loading because the limit check incorrectly required an exact byte count. The second loaded MFCC but stopped at the first folder because root with all capabilities dropped could not read owner-only folders. Both setup failures are preserved in the raw logs. The corrected runs use page-aware verification and UID 1000.

Coverage inspection then found a decoder failure that exit codes had missed. The first pass produced vectors for every track, but `Torus` and `Higgins (Instrumental)` returned sections as short as 1.17 seconds instead of ten. These fragmented M4A files include attached pictures. The tested fix is the MOV demuxer's `-seek_streams_individually 0`, applied only to M4A input. The corrected worker also rejects a section more than 100 ms shorter than requested, allowing codec end padding. Its recipes are version 2. The initial vectors and evaluation are retained under `runtime/audio-trial/attempt-1` and are superseded for quality assessment. The fixed sample is rerun rather than mixing decoder versions. [FFmpeg demuxer options](https://ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp).

## Decisions before production work

CLAP is the candidate that can support the requested text-search flow. MFCC can provide a cheap sound-texture comparison, but does not meet the mood/instrument/text-search requirement on its own. Production selection remains open until listening review. Similarity scores and agreement between two sampling recipes are not accuracy scores.

The plan also needs a decision about text-encoder residency. A warm query can use an already-loaded CLAP text encoder; unloading the analysis worker on idle does not preserve that warm state. Before milestone 3, decide where text encoding runs and how its memory is budgeted while analysis is paused. Do not turn a warm scoring benchmark into a promise for a cold user request.

## Reproduction

Run from the repository root in PowerShell. Verify mounts again before setting these environment values on another machine. Export the live index with a read-only connection; do not copy only the database file while its WAL is active.

```powershell
New-Item -ItemType Directory -Force runtime/audio-trial | Out-Null
$query = @'
import sqlite3,json
c=sqlite3.connect('file:/data/musimo.sqlite3?mode=ro',uri=True)
c.row_factory=sqlite3.Row
sql='SELECT song_id,path,root,size,mtime_ns,title,artist,album,duration,genre,suffix FROM library_files WHERE root IN (SELECT path FROM library_roots WHERE enabled=1)'
print(json.dumps([dict(r) for r in c.execute(sql)]))
'@
docker exec musimo-musimo-1 python -c $query | Set-Content runtime/audio-trial/catalogue.json
uv run python experiments/audio-trial/prepare.py runtime/audio-trial
uv run python experiments/audio-trial/download.py runtime/audio-trial/model
docker build -t musimo-audio-trial:1 experiments/audio-trial
$env:TRIAL_LIBRARY='M:\Media\Music'
$env:TRIAL_MUSIC=(Resolve-Path runtime/music).Path
$env:TRIAL_OUTPUT=(Resolve-Path runtime/audio-trial).Path
$env:TRIAL_MODEL=(Resolve-Path runtime/audio-trial/model).Path
uv run python experiments/audio-trial/run.py trial-mfcc-smoke --candidate mfcc --limit 4
uv run python experiments/audio-trial/run.py trial-clap-smoke --candidate clap --limit 4
# Inspect smoke records before expanding. Run these sequentially.
uv run python experiments/audio-trial/run.py trial-mfcc-100 --candidate mfcc --limit 100
uv run python experiments/audio-trial/run.py trial-clap-100 --candidate clap --limit 100
uv run python experiments/audio-trial/run.py trial-mfcc-full --candidate mfcc --full
uv run python experiments/audio-trial/run.py trial-clap-full --candidate clap --full
$checks=(Resolve-Path experiments/audio-trial).Path
docker compose -f experiments/audio-trial/compose.yaml -p musimo-audio-trial --profile trial run --rm --volume "${checks}:/checks:ro" --entrypoint python trial /checks/evaluate.py
uv run python experiments/audio-trial/listen.py
```

Use a fresh output directory for fresh timings, or unique container names to resume. Keep the snapshot/model mounts consistent. The completed smoke tracks are reused in the 100-track runs, so those four timings remain part of the results. Do not mix records from different software or recipes.

For a one-minute playback check during a worker run and again afterward:

```powershell
node experiments/audio-trial/playback.cjs runtime/audio-trial/browser-playback-check.json
uv run python experiments/audio-trial/check.py
uv run ruff check experiments/audio-trial
uv run ruff format --check experiments/audio-trial
node frontend/node_modules/prettier/bin/prettier.cjs --check experiments/audio-trial/playback.cjs experiments/audio-trial/compose.yaml docs/audio-analysis-trial.md
```

The browser probe requires the repository's installed Playwright and Chromium. It streams a real song into a muted audio element without queue changes or scrobbles. It records elapsed playback and stalls; it cannot provide listening approval.

## Evidence and review boundary

Checks passed: Ruff lint and formatting; host and pinned Linux correctness checks for deterministic selection, section bounds, short files, corrupt input, vector normalisation, self-exclusion and singleton retrieval; Prettier for the report, Compose and playback probe; and `git diff --check`. The listening page has six checks and fifteen players, fits a 390-pixel viewport without horizontal overflow, and its first player successfully streamed from the specified section without an error. This was muted UI verification, not listening assessment. Baseline hashes confirm that only the plan and testing document changed among pre-existing files.

Key local evidence: evaluation, corrected playback probe, deadline termination, and phone listening-page screenshot. No experiment worker remains running.

Raw evidence stays in ignored `runtime/audio-trial`: starting diff and file hashes, environment, read-only catalogue snapshot, sample, checkpoint metadata, model files, build logs, container inspections, run logs, playback probes, per-track records, vectors and evaluation output. No audio excerpts are saved or uploaded. The only source edits belong to `experiments/audio-trial/`, this report, `docs/ai-music-plan.md` and the trial link in `docs/testing.md`.

Exact new experiment files: `Dockerfile`, `compose.yaml`, `requirements.lock`, `download.py`, `prepare.py`, `worker.py`, `run.py`, `evaluate.py`, `check.py`, `listen.py` and `playback.cjs`, all under `experiments/audio-trial/`. No backend, frontend or application dependency files were changed by this work.

An unrelated existing documentation mismatch remains: `docs/architecture.md` says the application opens schema 6 in its storage section and describes schema 8 in the bot section. The current code uses schema 8. This trial does not reconcile that earlier work.

Stop here for review. No commit, merge, deployment, permanent index, worker leases, migrations or audio-aware bot work belongs to this trial.
