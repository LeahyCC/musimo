# Song characteristics

Status: implemented, 15 October 2026, with both recipe settings empty. The ranker, schema 9, the lease, the worker image and the gates are in the code. The `tempo-energy-v1` 100-song resource run happened on 19 October, on a copy of the database ([results](#100-song-run-19-october-2026)); it found librosa's tempo too coarse, and the [analyser bake-off](analyzer-bakeoff.md) recommends Beat This! in its place. On 20 October that became [`tempo-beat-v1`](#tempo-beat-v1), with a graphics-card worker, the [Song analysis page](#song-analysis-page) and [half and double tempo](#half-and-double-tempo) in Octive. The listen on that page, the embedding listen and a full-library scan are outstanding, so no recipe is switched on and the live library has not been analysed. The implementation handoff is [todo/audio-profile-handoff.md](../todo/audio-profile-handoff.md). It is the approach left open by [the music-bot plan](ai-music-plan.md) after the [genre listen](genre-label-review.md). The held-out labels from that listen stay sealed. They are not a tuning set for anything described here. The rest of this document is the contract the code was built to; where the implementation settled a detail the contract left open, the paragraph says so.

The bot keeps its current shape. Ollama emits a filter plan. `MusicBot.resolve` chooses real song ids from the player view. The model never emits song ids, SQL, or paths. This spec gives that resolver measured tempo, measured energy, and one sound vector, stored in the existing SQLite file.

AudioMuse-AI is the source of the behaviour, read from [its algorithm description](https://github.com/NeptuneHub/AudioMuse-AI/blob/main/docs/ALGORITHM.md) (chapters 1, 6, and 14, main branch as of 15 October 2026) and the v0.9.0 and v3.4.0 release notes. Musimo reimplements the parts below. AudioMuse-AI is AGPL-3.0. None of its code, ONNX exports, or distilled weights are vendored.

## What is kept from AudioMuse

AudioMuse keeps one `score` row per recording: raw-ish tempo, energy, key, and scale, a mood string, and six extra scores (`danceable`, `aggressive`, `happy`, `party`, `relaxed`, `sad`). The six scores are the cosine between a 512-dimension CLAP audio vector and six fixed text prompts. They are not a second classifier. A separate 200-dimension MusiCNN vector answers "sounds like this song." The chat model does not invent songs. It calls tools. `search_database` filters genre, mood, tempo, energy, key, year, and length. `text_match` ranks a description against the CLAP vector. `seed_search` ranks neighbours of a named song. A requested tempo or energy range is a gate. Songs inside it tie on that axis, and similarity or the database order breaks the tie. "Calmer than this" is measured against the seed's own energy, not against a fixed "low" bucket. The same title and artist is dropped. An artist cap limits how much of a playlist one artist can fill. A phrase that is only a negation ("no vocals") is dropped, because an embedding reads the negation as the thing named.

Musimo keeps that contract, narrowed:

- Tempo in BPM and energy as measured RMS amplitude, on a versioned row keyed by `song_id`; RMS is not a validated perceived-intensity label.
- One float32 vector per song, for one recipe at a time. Neighbour rank uses cosine to the seed. A sound phrase uses cosine to the text encoding of that phrase, and only when the recipe was trained in a shared text space.
- Hard gates. A song outside a requested tempo, energy, artist, genre, year, duration, or exclusion is out. The reply reports the shortfall. AudioMuse's relax loop, which drops tempo and energy when the pool is short, is not copied. The current bot already refuses to relax exclusions.
- Artist cap of two while the result list is filled from the library or songs are added to a proposal. Artists the user named are uncapped, and a song with no artist tag is not counted against anyone. Refining a proposal or the queue only filters it.
- Same normalized title and artist dropped, under the same conditions as the cap; a song with no artist tag is never a duplicate. The seed song and a copy of it (same title, same artist or none) are dropped on "more like this" in every scope.
- Negation-only sound phrases dropped, not embedded.

Energy bands are library percentiles of the done rows for the active recipe, which is how AudioMuse's chat speaks energy (0 is the calm end of this library, 1 is the intense end). Their stored energy is also scaled by `ENERGY_MIN` / `ENERGY_MAX` (defaults 0.01 and 0.15). v3.4.0 had to null `tempo`, `energy`, `key`, and `scale` after the formula changed. Musimo stores the raw measurement and puts the formula in the recipe id, so a formula change is a new recipe. Old rows stay readable until the operator switches the active recipe.

Tempo bands match the buckets in AudioMuse's planner: slow is under 90 BPM, medium is 90 up to but not including 140, fast is 140 and above. An explicit BPM in the request ("under 100") is a hard range and replaces the band. AudioMuse widens a single named BPM to a window. Musimo's window is 10 BPM either side, so "120" is 110 through 130, and that window stays a hard gate.

## What is left out

These AudioMuse features stay out of Musimo. They are products on top of the same row, and they are not required for a queue.

- PostgreSQL, the disk-paged IVF indexes, and any other approximate-neighbour index. The [bounded trial](audio-analysis-trial.md) scored a synthetic 44,070 by 512 matrix in about 2 ms. Warm text encoding plus scoring was 34 ms median. The search budget in the plan is 500 ms warm, measured apart from Ollama. An index is a later spec, and only after a real query misses that budget.
- Key, scale, the stored mood string, and the six label columns. A phrase the user typed is scored at query time from the vector.
- Clustering, the 2D map, song path, alchemy, sonic fingerprint, artist Gaussian mixtures, lyrics search, Whisper, and search-by-recording.
- The radius walk and the energy-arc reorder. Filling the list in rank order is the playlist order.
- A cosine near-duplicate threshold. AudioMuse's `DUPLICATE_DISTANCE_THRESHOLD_*` belongs to their embedding. Musimo sets one only in the notes of an embedding recipe that a listen has accepted.
- Genre from audio. File tags remain the genre. The October CLAP run does not write genres, moods, or vectors into this table.

[Discover](discover.md) still does not get its own recommendation database. These rows live in Musimo's SQLite file.

## Storage

Schema version is 9 (`backend/core/store.py`); this work added it, with the `audio_job` queue table beside the one below. Older binaries refuse a newer file. The upgrade needs the same pre-upgrade backup as version 6. `library_files` is unchanged. `song_id` stays the unique library identity (`library_song_id`).

```sql
CREATE TABLE audio_profile (
    song_id TEXT NOT NULL,
    recipe TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done', 'failed', 'skipped')),
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    tempo_bpm REAL,
    energy REAL,
    dim INTEGER NOT NULL DEFAULT 0,
    vector BLOB,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (song_id, recipe)
);
CREATE INDEX audio_profile_recipe ON audio_profile(recipe, status);
```

`tempo_bpm` is beats per minute, null when this recipe does not measure tempo, or, for a recipe that allows it (`tempo-beat-v1`), when the tempo was measured but is not sure enough to use. `energy` is the mean RMS of the analysed sections, linear amplitude, null when this recipe does not measure energy. `vector` is little-endian float32, L2-normalised, length `dim * 4`. `dim` 0 and a null vector mean this recipe has no vector. A done row whose byte length disagrees with `dim` is ignored, the same as a failed row. Failed and skipped rows have a null vector and null measurements.

There is no genre column and no mood column.

A profile is stale when its `size` or `mtime_ns` disagrees with `library_files`. Stale, failed, and skipped rows do not satisfy a tempo, energy, or vector constraint. The scanner deletes profile rows in the same transaction that deletes a `library_files` row. Dropping `audio_profile` is a safe reset. The worker refills it. Two recipes are never scored against each other. A scalar recipe and an embedding recipe may both be active, because a BPM is not compared with a vector.

Active recipe ids live in settings. Both default to empty. An empty id means the chat prompt still refuses that family of request. Rows may exist before the recipe is activated. The bot ignores them until the operator turns the recipe on. That is the switch between a trial and production.

## Recipes

### `tempo-energy-v1`

Librosa, ISC, the same family as the trial baseline. No neural net and no downloaded weights. Three 10-second mono sections, at 10, 50, and 90 percent of `duration - 10` seconds. The [earlier experiment](audio-analysis-trial.md) informed this recipe; its resource results are not a production-worker measurement on the current host. The real-host resource run is [below](#100-song-run-19-october-2026); listening acceptance remains pending. Decoder rules from that trial stay: FFmpeg seeks, a section more than 100 ms short is rejected, M4A uses `-seek_streams_individually 0`, the decoder deadline is 30 seconds, and native threads are pinned to one.

Tempo is the median of the section estimates that succeeded. Energy is the mean RMS of the accepted sections: signal amplitude, not validated perceived intensity or mood. Loud mastering can confound calmer/more-intense comparisons. A done row requires both numbers. A file that yields neither is `failed`, with the reason in `detail`. No BPM is invented.

`dim` is 0. The vector is null.

Genre `podcast`, `podcasts`, or `spoken word`, compared casefolded to the stored genre string, is `skipped`. Speech tempo is not a music tempo. The trial sample for this recipe includes at least one of those files and at least one recording longer than 20 minutes. The listen can add a further skip rule, such as a duration ceiling, before the recipe is activated. The rule becomes part of the recipe. Changing it mints a new recipe id.

Implemented in `worker/audio_worker/recipe.py`, with librosa 0.11.0 on Python 3.12, the interpreter the trial measured. The details the contract left open were settled this way, and each is part of the recipe id: a section's tempo comes from `librosa.feature.rhythm.tempo` on its onset envelope, and a section with no onsets at all gives no estimate rather than the estimator's 117 BPM prior, so digital silence cannot become a done row; a section's energy is the mean of `librosa.feature.rms` frames, and the row's `energy` is the mean of the accepted sections; the genre check also reads every string in the `genres` list, not only the single `genre` column; a file whose three starts coincide (a 10-second file) is decoded once; the worker reports the file's size and modification time as it found them, so a file the index has not caught up with is refused and tried again rather than written against stale identity. A measured section that fails only its tempo estimate still counts towards energy.

#### 100-song run, 19 October 2026

Run on a copy of the live database (SQLite backup API, read-only on the source), as its own Compose project with `M:\Media\Music` read-only and no route out, since the copy holds queued downloads. The live app and its volume were not touched. The compose file, worker log and copy stay in the ignored `runtime/tempo-trial/`.

The 100 were the 98 newest files from `scripts/enqueue_audio_trial.py`, plus one podcast and one recording over 20 minutes added by hand on the copy, as this section requires. 99 were done and the podcast was skipped as spoken word. 100 songs took 53 s: median 0.3 s a song, p95 1.9 s, 11.9 s for the first while the worker warmed up. Peak memory was 815 MB of the 2 GB cap, with no swap and one CPU. At that rate the 50,510 files on the copy are about 6 to 8 hours.

The run found that the tempo is too coarse to use. `librosa.feature.rhythm.tempo` at this hop can only return 60 × 22050 / 512 / n for a whole number n, so the 99 songs got 12 distinct values (86.1, 92.3, 95.7, 99.4, 112.3, 117.5, 123.0, 129.2, 136.0, 143.6, 152.0 and 161.5) and 53 of them read exactly 143.6. Trance at 138 and techno at 145 cannot be told apart. The [analyser bake-off](analyzer-bakeoff.md) measured Beat This! as the replacement; adopting it is a new recipe id. Energy was not checked.

### `tempo-beat-v1`

Decided 20 October 2026. Beat This! 1.1.0 (CPJKU, MIT code and weights), checkpoint `final0`, SHA-256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`, without its DBN. It is the [bake-off's](analyzer-bakeoff.md#method) method exactly, nothing retuned. Every rule below is part of the id; changing one is a new recipe.

```
song ──► skip?  podcast / podcasts / spoken word genre       → skipped
         │      shorter than 60 s                            → skipped
         ▼
       decode four windows (FFmpeg, mono, 22,050 Hz)
         10 s at 10% ─┐
         10 s at 50% ─┼─ of (duration - 10)
         10 s at 90% ─┘
         60 s centred on the middle
         ▼
       Beat This! beats per window ──► steady-gap BPM per window
         ▼
       song BPM = median of the section BPMs
       sure     = 2+ sections gave a BPM
                  and that median is within 2 BPM of the 60 s window
                  and it is 200 BPM or less
         ▼
       done row: energy always; tempo_bpm only when sure
```

- **Windows.** Three 10-second sections at 10, 50 and 90 percent of `duration - 10`, as in `tempo-energy-v1`, and one 60-second window centred on the middle of the song. The decoder rules of `tempo-energy-v1` stay: FFmpeg seeks, a window more than 100 ms short is rejected, M4A and the rest of the MOV family use `-seek_streams_individually 0`, the deadline is 30 seconds and FFmpeg runs one thread. Samples are mono float32 at 22,050 Hz; Beat This! resamples them itself.
- **BPM of a window.** The model's beat times. Fewer than 4 beats gives no BPM. The gaps between beats, the median gap, and the "steady" gaps within 12 percent of that median. Fewer than 3 steady gaps gives no BPM. Otherwise BPM is 60 divided by the mean steady gap, rounded to two decimals.
- **BPM of the song.** The median of the section BPMs that exist. The 60-second window is the check, not the answer.
- **Sure.** At least two sections gave a BPM, their median is within 2 BPM of the 60-second window's BPM, and the median is 200 BPM or less. Anything else is unsure. On 100 fresh songs 79 were sure and 60 of those matched Deezer; the rule does not catch half or double time (13 of the 79), which is why the bot [allows for it](#half-and-double-tempo).
- **Energy.** The mean RMS of the windows that decoded. A window's RMS is the mean over frames of 2,048 samples, hop 512, of the square root of the mean square. Each window counts once. Like `tempo-energy-v1` it is signal amplitude, not a validated perceived intensity.
- **A done row.** Needs energy, so at least one window decoded. `tempo_bpm` is set only when the reading is sure. **An unsure song is a done row with energy and a null tempo.** It answers energy requests, it does not answer tempo requests, and the bot counts it as not covered for tempo. This changes the `tempo-energy-v1` rule that "a done row requires both numbers", on purpose, for this recipe only; `tempo-energy-v1` still requires both. A file where no window decodes is failed with the reason in `detail`.
- **`detail`.** A JSON object, so the [page](#song-analysis-page) can show the reading and play the exact sections: `{"bpm": 142.31 or null, "sure": true, "long": 142.4 or null, "sections": [[start, bpm or null], ...], "long_start": 120.0, "why": ""}`. `bpm` is the song BPM before the sure check, so an unsure song still shows what was read. `why` says why it is unsure ("1 section", "sections and 60 s disagree", "over 200 BPM"). It stays under the 400-character limit.
- **Skips.** Decided from the lease before any decoding, so they cost nothing. The genre rule of `tempo-energy-v1` stays: `podcast`, `podcasts` or `spoken word` in the genre or the genres list. New: **a file shorter than 60 seconds is skipped**, with the detail "shorter than the 60 s check window". Under 60 seconds the check window is the whole file and the sections sit inside it, so the sure rule would be comparing the audio with itself. Measured on the 20 October copy of the database (50,510 files): 1,711 files are under 60 seconds. They include 782 of the 786 "A State of Trance" radio clips under 90 seconds that every analyser read a beat from (the other four are 61 to 66 second mixed outros, which are music), and 929 other short files: skits, intros, interview snippets and short live banter. 154 files carry a podcast or spoken-word genre. A skipped song has no tempo and no energy, so a voice clip cannot turn up in a "calm" playlist either.
- **Device.** The worker picks CUDA when it finds a usable graphics card and the CPU otherwise, once at start, and reports which in its status. The numbers are the same on both; only the speed differs (0.61 s a song on the RTX 5080, 5.6 s on one CPU core, in the bake-off).

Known misses, from the bake-off: live recordings with talking (The Doors, Phish, Slipknot live) and half or double readings, which only a listen can settle. Several half readings look like Deezer doubling hip-hop, so Deezer is not the truth either.

#### 100-song run on the graphics card, 20 October 2026

On the trial stack: a SQLite-backup copy of the live database (50,510 files, 19 October), `M:\Media\Music` read-only, the app on an internal network with no route out, the GPU worker image with the `analysis-gpu` defaults (4 cores, 4 GB, no swap). Queued with the page's own "Measure 100 songs" route. The live app, its volume and its settings were not touched, and nothing was switched on in the copy either.

| Run (100 songs each)          | Decoders | Seconds a song | Sure | Unsure | Skipped | Failed |
| ----------------------------- | -------: | -------------: | ---: | -----: | ------: | -----: |
| 1, the sample                 |        4 |           0.99 |   86 |     13 |       1 |      0 |
| 2, the next sample            |        8 |           0.39 |      |        |         |        |
| 3                             |        1 |           0.76 |      |        |         |        |
| 4                             |        4 |           0.42 |      |        |         |        |
| All four (397 songs measured) |          |                |  315 |     78 |       4 |      0 |

- **Counts.** 79 percent sure, close to the bake-off's 79 of 100. No reading went over 200 BPM. The 315 sure songs have 153 distinct BPM values (librosa gave 12), median 145: 20 slow, 93 medium, 202 fast. Skipped: the podcast in each sample (the same file each time, since a skipped song is tried again after new ones) and three files under 60 seconds. Recordings of 21 to 55 minutes measured without trouble; two DJ mixes and two ambient tapes came out unsure, one at 108.7.
- **Speed.** 0.4 to 1.0 s a song with parallel decoding, against 0.61 s with one decoder in the bake-off. The spread follows file reads through Docker Desktop's Windows mount rather than the decoder count: the first run read cold files (its first songs took 18 s), and 8 decoders were no faster than 4 on the later runs. At 0.4 to 1.0 s the 50,117 songs left are about 6 to 14 hours. The page's estimate uses the latest run's own rate.
- **Memory.** Process peak 1.9 GB, as in the bake-off. The container's peak, which counts file cache, was 2.1 to 3.8 GB, under the 4 GB cap and reclaimable. Graphics memory in use on the card went from 1,345 MiB idle to about 1,917 MiB with the worker loaded; the card is shared with the desktop, so that is the worker's share at most. The model loads in 3.5 to 5.3 s.
- **No way out.** In the app container `api.deezer.com` and `www.youtube.com` do not resolve, connections to 1.1.1.1 and 8.8.8.8 fail with "network unreachable", and the routing table has no default route. The page reaches Colin's browser through a proxy container bound to 127.0.0.1 that forwards only to the app.

The listen on the page, and the call on whether to switch it on, are Colin's.

### Embedding recipe

Unnamed. The id is chosen when four things exist together: a checkpoint, a licence that Musimo may ship, a written sampling recipe, and a passed 100-song neighbour listen. The October labels are not that listen.

The row stores one L2-normalised float32 vector. Tempo and energy stay on `tempo-energy-v1` unless the embedding recipe's own notes say it replaces them. A text-aligned recipe may answer a sound phrase. A recipe that is not text-aligned leaves sound phrases unsupported. That flag is a constant of the recipe in code, not a per-row column.

`laion/clap-htsat-unfused` revision `8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a` remains a candidate. It is Apache-2.0, it fitted the worker cap (peak 1.41 GB), and it failed as a genre labeler. Genre failure does not decide neighbour quality. The listen does. MFCC remains the cheap similarity baseline from the same trial, and it cannot answer a text phrase.

## Analysis worker

The worker contract in [the music-bot plan](ai-music-plan.md) stands, with the caps made settings [below](#colins-decisions-of-20-october-2026). One optional Linux container, read-only music, by default one song at a time, 2 GB RAM, one CPU, no swap. FastAPI owns SQLite. The worker leases through the internal API and never opens the database. Expired leases are dropped. A late or duplicate result cannot replace a newer row. File size and modification time are rechecked before commit. A busy bot request prevents new leases; it does not pause or cancel a job already running. Playback stays usable.

The result body this spec adds is: `song_id`, `recipe`, `lease_token`, `size`, `mtime_ns`, `status`, `tempo_bpm`, `energy`, `dim`, `vector` (the little-endian float32 bytes, base64 in the JSON), `detail`. FastAPI rejects a result whose recipe, identity, lease, or vector length disagrees with the lease.

Order of work, once a recipe is approved to run: the operator's chosen songs, then new library files, then the backlog. Implemented so far: `scripts/enqueue_audio_trial.py` and the [Song analysis page](#song-analysis-page) queue newest files first and the lease hands them out in that order. Songs whose row for the file as it is now is failed or skipped wait behind every song not yet tried, so a limited run keeps reaching new songs; choosing particular songs is a later item, not in this change. Each committed row is readable. The bot uses them only after that recipe is the active one. At the trial's fuller CLAP rate of about 8 songs a minute, 44,070 tracks is on the order of four days at one song at a time. The trial measures the real rate before a full scan is started.

#### Colin's decisions of 20 October 2026

This section used to say "a model that does not fit the cap is a failed candidate, not a reason to raise the cap", and the page used to have no scan button. Colin overruled both on 20 October 2026:

- **Caps are settings, not a fixed rule.** The defaults are the safe ones for anyone else running Musimo: CPU, one worker container, one decoder, one core, 2 GB, no swap. A graphics card, more decoders, more cores and more memory are opt-in. Colin's machine may use up to 10 GB for analysis.
- **The page has a scan button.** "Measure whole library" queues every song lacking a row, after a confirmation that names the count and the time estimate. Switching the recipe on for Octive is still a separate action, after the listen.

#### `tempo-beat-v1` worker

The same contract: optional containers, read-only music, the lease API, never the database, size and modification time rechecked before commit, a busy bot request holds back new leases. What changed:

```
           ┌─ decoder 1: lease ─► check file ─► FFmpeg x4 ─┐
lease API ─┼─ decoder 2: lease ─► check file ─► FFmpeg x4 ─┼─► queue ─► one model ─► result
           └─ decoder N ...                                ┘   (N)     (GPU or CPU)
```

- **Parallel decoding, one model.** `MUSIMO_WORKER_DECODERS` threads each lease a song, check it, decode its four windows and hand them to a queue that holds at most that many songs. One thread runs Beat This! on them in turn and posts the results. In the bake-off FFmpeg was 61 percent of the time on the graphics card, so decoding in parallel is where the speed is. Each song has its own lease, so a song never waits on the queue for long against its 180-second lease.
- **More than one lease at once is safe.** Checked in `AudioProfiles.lease`: each lease is one `BEGIN IMMEDIATE` transaction under the store lock that picks one queued (or lapsed) row and marks it leased with its own token, so two decoders, or two worker containers, can never be handed the same song while a lease is current. A result must carry the current token, so a late result after a lapse is refused. `tests/test_audio_worker.py` covers concurrent leases.
- **Compose profiles.** `analysis` starts `audio-worker`, the CPU image. `analysis-gpu` starts `audio-worker-gpu`, the CUDA image (about 11.6 GB, torch 2.7.1 built for CUDA 12.8, which the RTX 50 series needs), and asks Docker for the graphics card. Run one or the other. The checkpoint is downloaded while the image is built and checked against its SHA-256, so the containers never need the internet.
- **The caps** come from `.env`, read by Compose: `MUSIMO_WORKER_CPUS`, `MUSIMO_WORKER_MEMORY` and `MUSIMO_WORKER_DECODERS`. The CPU profile defaults to 1, `2g` and 1. The GPU profile defaults to 4, `4g` and 4. Swap stays off (`memswap_limit` equals the memory cap). See [settings](settings.md#song-analysis-worker).
- **Status.** Each lease call carries the worker's device, graphics card name, decoders and memory cap. The app keeps the last one in memory for the page; it is not stored. A worker idle with nothing queued still asks every 15 seconds, so "last seen" stays current.
- **Pause.** The `audio_analysis_paused` setting. While it is on the lease hands out nothing; a song already leased finishes. The queue is kept.

`tempo-energy-v1` keeps its own image (`worker/Dockerfile`), which is no longer in a Compose profile. Its rows stay readable.

## How the bot ranks

`SearchPlan` carries the fields below from this change, all empty by default, so one schema exists. While a recipe's setting is empty the prompt keeps today's refusal, word for word: mood, energy, tempo, instruments, and vocals are `unsupported`, and they are not approximated with genres. The service enforces it too: a search plan that filled one of those fields anyway becomes `unsupported` with the same explanation and the fields cleared. `system_prompt` in `backend/library/music_bot.py` builds the prompt from the active recipes.

When a scalar recipe (`tempo-energy-v1` or `tempo-beat-v1`) is active, the plan may carry:

- `tempo`: `slow`, `medium`, `fast`, or empty.
- `tempo_min` and `tempo_max`: BPM bounds. Set from an explicit BPM in the request. A band and a bound can both be set. Both are hard.
- `energy`: `low`, `medium`, `high`, or empty. Low is below the 33rd percentile of done `energy` for this recipe, medium is from the 33rd up to but not including the 66th, high is the 66th and above. Songs with null energy are outside every band.
- `energy_compared`: `calmer` or `more_intense`, or empty. This is strictly below or above the reference song's stored energy. It does not mean the low or high band.
- `tempo_compared`: `slower` or `faster`, or empty. The same, against the reference song's `tempo_bpm`.

When an embedding recipe is active and marked text-aligned, the plan may carry `sound`, a phrase of at most 120 characters. Empty means no phrase. A phrase that is only a negation is cleared by the service. Genre words stay in `genres`.

Two details the service settles rather than the model: a plan whose `tempo_min` equals its `tempo_max` is the single named BPM, and the service widens it to the 10 BPM window above; and a plan with both `similar_to_current` and `sound` keeps one rank key, the reference song's vector, and drops the phrase.

`MusicBot.resolve` then does the following. The player view is already the whole library, so the walk covers every stored song in scope.

1. Apply today's tag gates: artist, genre, year, duration, favourites, play history, exclusions, scope. Named tempo, energy, and comparison gates apply to songs with a fresh done row on the active scalar recipe. A sound phrase or `similar_to_current`, once an embedding recipe is active, requires a fresh done vector on that recipe.
2. Order the survivors. Play counts and skips are never a default taste score (see [Broad selection](#broad-selection)). On "more like this" the seed song and a copy of it (same title, same artist) are removed first, so they never set the scale of fit. One rank key is used, and keys are not blended. `similar_to_current` ranks by cosine to the seed vector. A sound phrase ranks by cosine to the text encoding of the phrase. Without either, `history: familiar` ("more familiar", "most played") keeps only played songs (`play_count > 0`) and ranks them by `log1p(play_count)`. Any other request has no rank key: every match fits equally. Tempo and energy do not break ties inside a band.

   A library search then draws its order with `broad_order` in `backend/library/selection.py`. Each song's draw is a blake2b hash of the generation seed and its `song_id`, so one seed repeats one selection. With no rank key, adding, removing or playing one song never reorders the others; with one, a change to the best or the weakest fit in the window rescales the draw and can. With no rank key the order is a uniform shuffle. With a rank key and more matches than the request needs, a window holds the best `need` songs, never reaches past twice `need`, and never takes a song further below the `need`-th than the `need`-th is below the best. The window is drawn by Gumbel-top-k: sampling without replacement, weighted by fit, so the best song is four times as likely to be drawn first as the weakest in the window (`RELEVANCE_RATIO`). The noise comes from a second, independent hash of the seed and the song, so songs tied at the edge of the window can still be drawn. The songs below the window follow in rank order. With a rank key and a pool that fits, the order is the rank. In every case a song the chat showed lately goes after the songs that fit as well.

   `need` is `add_count` when that is set. With a `target_seconds` it is the target divided by the lower median (`statistics.median_low`) of the matches' known song lengths, rounded up, plus one, at most `limit`. Otherwise it is `limit`. It only sizes the window. It never weighs a song, so a draw does not lean to short or long songs.

   A proposal or queue refinement keeps the person's own order (`refine_order`). Nothing is drawn or sorted, even with a rank key, so a familiar filter carried over from an earlier request does not re-sort the queue.

3. Fill the result list by walking that order. Skip a missing file. Skip the seed and another copy of it again, as a safety net. In a library search, or when adding songs to a proposal, skip a song whose normalized title and artist were already kept, and take at most two songs for one `artist_key`, unless that artist is named in the plan. A song with no artist tag has no `artist_key` and is subject to neither rule; a name that is only punctuation keeps its own spelling as the key. A proposal or queue refinement keeps every song that passes the filters. Stop at `limit` or `target_seconds`, as today. A drawn library result with a rank key is then shown best fit first; the set and its length do not change.
4. Report a shortfall in minutes when the duration cannot be filled. No gate is relaxed to fill it. The summary names the recipe and the coverage: how many library songs have a fresh done row, out of how many are in the library. Songs skipped for a missing profile are counted in that sentence. When a fresh library selection chose among more matches than the request needs and returned songs, the summary says how they were picked. With no rank key, or when every match fits the same, it is "Picked at random from M matches." With a rank key it is "Picked from the closest of M matches." or "Picked from your most played of M matches." It names no depth, because the artist cap, duplicates or missing files can push the fill below the window and a tie can straddle its edge. Adding to a proposal and an empty answer say nothing here. When songs shown lately had to be used, the summary says so: "1 song repeats from an earlier answer; no other match could be used." That reason is given only when no unshown, unused match comes after a repeated song in the walk, which proves every unshown match was used or ruled out first (always so without a rank key). In a ranked draw that reached a repeat before songs that fit less, the sentence gives no reason ("2 songs repeat from earlier answers."), since whether those songs could have played is not checked. The "Picked" sentence also needs at least one match left unused. Songs kept from the proposal when adding are never counted as repeats.

The 5,000-candidate ceiling went away in this same change. It was applied before the sort, in scan order, so a broad request was an alphabetical slice. File checks run only while the result list is being filled.

`similar_to_current` today replaces the plan's genres with the reference song's tags and drops the artist. That replacement stays only while no embedding recipe is active, and the summary keeps saying similarity is tags. Once an embedding recipe is active, the reference song's tags are not copied onto the plan. The user's own genre and artist filters still apply. A reference song with no fresh vector produces an honest miss, not a tag search.

`validate` rechecks the new gates the same way it rechecks tags and file availability. A profile that went stale between the proposal and Play is a 409, the same as a vanished file.

There is no skip log yet. A stop before 30 seconds is not a rank feature in this spec. Play counts and skips are never a default taste score. Likes and history enter a request only when it asks for them: `favourites`, `history` (`familiar`, `played` or `unplayed`) and `exclude_played_days`. A later listen-event table would feed those explicit requests only. It would not become a default rank key.

### Broad selection

Colin decided these rules on 15 October 2026. They replace the play-count order the first ranker used.

- Play counts and skips are never a default taste score. A request is ranked by its fit to what was asked, and by nothing else.
- Songs that fit equally are equal. The service does not invent a preference among them. It draws them in a uniform random order.
- Variety never costs relevance or an explicit constraint. A draw only reorders songs inside a window near the best fits. Every gate, the artist cap, the title rule, the missing-file skip, `add_count` and the shortfall report apply as before.
- A small pool overlaps. When the matches barely exceed what the request needs, asking again gives mostly the same songs. The "Picked" sentence appears only when there was a choice to make.
- Exact identity stays deterministic. A proposal or queue refinement keeps its order, the reference song is found by id, and `validate` neither takes nor checks the seed.

Every library search has a generation seed, an integer from 0 to `2**53 - 1`, so a browser can hold it as an exact number. `BotRequest.generation_seed` names one. Without it the server draws a fresh one with `secrets`. The reply returns it as `generation_seed`, which is null for a refinement, a question or a command. The same plan, seed, `shown_ids`, `proposal_ids`, reference and current song and scope, against the same library state (the player view, the Liked playlist, the profile rows and the local day), give the same songs in the same order. A pool with no rank key is the same on any machine. A pool ranked by cosine or by play count is exact on the same machine; fit is rounded to six decimals before the draw. The browser never sends a seed, so every request draws afresh. The seed is there to repeat a selection while debugging.

`BotRequest.shown_ids` lists up to 500 songs the chat showed lately. The server keeps them: the songs of the last three presented library results, newest first, in SQLite (`bot_memory`, schema 12), for the name that is listening, shared by that name's devices, with a memory revision that rises on every change. It survives a restart and a closed tab. A result is recorded once, when its stored revision is reported as shown; a cancelled or superseded generation, a refinement, a question and an empty result are not recorded. The chat and a library search through the engine read this memory themselves (`context.shown_ids` omitted, under contract version 4; an intent that says 3 or lower keeps its old meaning of none), and the snapshot names the revision they read, so the same seed over another memory is another snapshot. A request can still send its own list to the engine, which is then used as given and leaves the memory unread. A shown song goes after the unshown songs that fit as well. It is never excluded, so a small pool still fills, and the summary counts the repeats. It is suggestion memory, not a taste score: play counts and skips are not touched and never become a like or a dislike. Chat settings has Forget shown songs, which clears only this memory on every device; Clear chat does not. A result whose report was still in flight when Forget was pressed on another device is not recorded after it. See [Shown-song memory](architecture.md#shown-song-memory).

`RELEVANCE_RATIO` of 4 and the window of at most twice `need` are reasoned, not listened. They are to be tuned at the embedding listen.

Left as they are, by the same decision: there is no exact "my N most played" mode and no "less played" mode; songs in the queue or playing now are not demoted; a request that names several artists samples their songs uniformly and does not balance the artists. Duration words are unchanged for now. A later pass settles "about", "under" and "at least". Colin has decided that "about N minutes" will mean the whole-track total closest to N, never more than 5 minutes off, and otherwise a shortfall. That is a decision, not built.

### Half and double tempo

Decided 20 October 2026, for every scalar recipe. A beat tracker can lock on to every other beat or to every half beat, so a song felt at 140 may read 70, and the other way round. Energy is the tie-breaker the bot has, so it is used only where it agrees.

```
"fast" (140+)    song reads 72, energy high    72 x 2 = 144 fits, high energy  → octave match
"fast" (140+)    song reads 72, energy low     144 fits, but low energy        → out
"slow" (<90)     song reads 168, energy low    168 / 2 = 84 fits, low energy   → octave match
"120 bpm"        song reads 61, energy medium  122 fits, medium energy         → octave match
```

- **Tempo words and BPM ranges.** A song matches **directly** when its BPM fits every tempo gate in the plan (`tempo`, `tempo_min`, `tempo_max`). If not, it is an **octave match** when its BPM doubled or halved fits all of them **and** its energy band agrees with that reading: doubled (the song is really faster than it read) needs medium or high energy, halved (really slower) needs low or medium. With no energy bands yet there are no octave matches. Every other gate, energy included, still applies as a hard gate.
- **Direct matches rank first.** The library draw runs on the direct matches, then on the octave matches, and the walk takes them in that order, so an octave match is only used when the direct ones run out or are capped. A refinement keeps the person's own order, as before.
- **The reply says so.** When the result holds octave matches the summary adds "N of these matched at half or double their measured tempo."
- **"Faster" and "slower" than this.** When the song and the reference song are in the same energy band, the song's BPM is first brought into the reference song's octave: doubled or halved until it is within half an octave of the reference (from the reference / √2 up to, not including, the reference × √2), under the same energy rule as a range (doubling needs medium or high energy, halving low or medium). Then it is compared. So a song at exactly double the reference's tempo, with the same medium or low energy, is the same pace and is neither faster nor slower, and a high-energy song at 150 is not called slower than a high-energy song at 100. When the bands differ, there are no bands, or the energy does not allow the fold, the BPM is compared as it is. A song that is in only because of that folding counts as an octave match: it ranks after the direct ones and is counted in the sentence.
- **Unsure tempo.** With `tempo-beat-v1`, a done row with a null tempo is outside every tempo gate and counted with the songs "skipped without a measurement". An energy-only request still uses it.

`validate` accepts direct and octave matches alike, so a proposal built on an octave match still plays.

## Song analysis page

`/library/analysis`, linked from Server settings under Music bot. It is where a person measures songs, checks them by ear and switches the recipe on for Octive. It always works on `tempo-beat-v1`. It works at 390 px wide and uses the app's settings layout, buttons and themes.

```
┌ Song analysis ──────────────────────────────────────────────┐
│ 1  Octive uses tempo [off]   Worker: graphics card, seen 4 s │
│    done 98 · unsure 21 · skipped 2 · failed 0 · queue 0      │
├─────────────────────────────────────────────────────────────┤
│ 2  Measure 100 songs   [Measure 100]   ████████░░ 82 of 100  │
├─────────────────────────────────────────────────────────────┤
│ 3  Listen   fastest · slowest · loudest · quietest · unsure  │
│    Song - Artist   144 BPM  high   [10%] [50%] [90%]         │
│    "Tempo can read half or double ..."                       │
├─────────────────────────────────────────────────────────────┤
│ 4  [Turn on for Octive]                                      │
│    Measure whole library: 48,700 songs, about 8 h on the GPU │
│    [Measure whole library]  [Pause]   progress · ETA         │
└─────────────────────────────────────────────────────────────┘
```

1. **Status.** The on/off switch for Octive, which is the existing `audio_scalar_recipe` setting set to `tempo-beat-v1` or empty. Turning it off keeps every row. The worker: device, graphics card, decoders, memory cap and when it was last seen. A worker not seen in the last minute is "not running", and the page shows the one command that starts it, for the CPU or the graphics card. With no `MUSIMO_ANALYSIS_TOKEN` it says to set one first. Counts for the library as it is now: done (sure tempo), unsure, skipped, failed, waiting, plus the rate and time left while a run is going.
2. **Measure 100 songs.** Queues the 98 newest songs without a row, one podcast-tagged song and one recording over 20 minutes, the shape of the 19 October trial, so the spoken-word skip and a long file are always in it. Progress counts the rows written since it was pressed. The app keeps that start time in memory, so a page reload keeps the progress and an app restart forgets it (the counts and the queue are in the database and stay).
3. **Listen.** Groups of up to 10: fastest, slowest, loudest, quietest, and "check these": unsure songs, songs under 100 BPM with high energy and songs over 160 BPM with low energy, the likely half or double readings. Each row shows the BPM (or what was read, for an unsure song), the energy band and three buttons that each play the exact 10-second section that was measured. A plain note says tempo can read half or double and Octive allows for it. There are no thumbs or ratings; the listen is for the person to decide whether to switch it on.
4. **Turn on and measure everything.** "Turn on for Octive" sets the setting. "Measure whole library" shows how many songs lack a row and a time estimate for the device in use: the rate of this machine's last run when there is one, otherwise the bake-off rate (0.61 s a song on the graphics card, 5.6 s on the CPU). It asks to confirm before queueing. Pause and resume, progress and time left.

Routes, all under `/api/audio-analysis/` and same-origin like the rest of the app: `GET status`, `POST sample`, `POST all` (with `{"confirm": true}`; without it the answer is the count and nothing is queued), `POST pause` (`{"paused": true|false}`) and `GET listen`. The worker's lease routes are unchanged and still refuse a browser.

## Listen gate

Implementation, automated validation, real-library listening/resource measurements, recipe activation and full-library scanning are separate milestones. Passing generated-audio tests does not establish recommendation quality or authorize activation. Production embeddings are absent. Tempo and energy share one scalar activation setting: if tempo passes but perceived-intensity checks fail, keep it off or separately implement and validate capability gating. Strict approximate/maximum/minimum duration modes, richer musical evidence and the V2 engine remain follow-on work in [issue #179](https://github.com/LeahyCC/musimo/issues/179).

`tempo-energy-v1` is activated after a scripted listen, not after a full scan. The operator hears pairs that the gate claims are faster, slower, calmer, and more intense than a seed, on the order of a few dozen songs, including one long recording and one spoken-word file. Activation is a settings change. A bad listen mints no second recipe and starts no scan.

The embedding recipe is activated after a separate 100-song neighbour listen. The page plays "more like this" results. If the recipe is text-aligned, the same listen includes the phrases "relaxed", "aggressive", and "sad piano", judged as playlists. Agreement between two models is not a pass. The October genre labels are not reused, and they are not the reason a checkpoint is rejected or kept for this job.

`tempo-beat-v1` is switched on after the listen on the [Song analysis page](#song-analysis-page), not after a full scan: the fastest, slowest, loudest, quietest and check-these groups of a 100-song measurement, each song heard at the sections that were measured. Activation is the switch on that page, the same setting as before. Turning it off keeps the rows.

A full scan of `tempo-energy-v1` or an embedding recipe starts only after that recipe's listen has passed and the operator has turned it on. For `tempo-beat-v1` Colin decided on 20 October 2026 that the page may measure the whole library before or after the switch is on; its confirmation is the gate, and the rows do nothing until the switch is on. Coverage in the bot is whatever fraction is done. The reply says so.

## Licences

| Piece                                                                     | Terms                                                     | Use here                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| AudioMuse-AI, its ONNX exports, and its distilled CLAP (DCLAP) repository | AGPL-3.0                                                  | Behaviour only. The DCLAP student weights and training code stay out.                              |
| Essentia, and the MTG Essentia models AudioMuse replaced in v0.9.0        | Essentia is AGPL. Those models are CC BY-NC-SA 4.0.       | Out.                                                                                               |
| Original MusiCNN, as described in the AudioMuse v0.9.0 release note       | The note calls the model ISC.                             | Not a Musimo dependency. Any later use has to confirm the weight file's own licence before a scan. |
| `laion/clap-htsat-unfused` at `8fa0f1c`                                   | Apache-2.0                                                | Candidate for the embedding listen. Not selected.                                                  |
| librosa, for `tempo-energy-v1`                                            | ISC                                                       | The first scalar recipe.                                                                           |
| Beat This! 1.1.0 code and the `final0` checkpoint                         | MIT (the README warns some training audio is copyrighted) | `tempo-beat-v1`. The checkpoint is downloaded at image build, not committed.                       |
| torch, torchaudio, einops, rotary-embedding-torch                         | BSD, BSD, MIT, MIT                                        | `tempo-beat-v1` worker images.                                                                     |
| soxr (Beat This! resampler)                                               | LGPL-2.1-or-later                                         | `tempo-beat-v1` worker images, as an unmodified shared library.                                    |
| NVIDIA CUDA libraries in the torch cu128 wheels                           | NVIDIA's redistributable licence                          | The GPU worker image only. Built by the operator, not published.                                   |

## Acceptance

These are the checks the implementation carries, in `tests/test_music_bot.py`, `tests/test_selection.py`, `tests/test_music_bot_audio.py`, `tests/test_audio_profile.py`, `tests/test_audio_worker.py` and `worker/tests/test_recipe.py`, on generated audio and test recipes. The last item is the exception: the listen gates need Colin's ears, and the worker's real rate and peak memory are measured on the machine that will run the scan, which has not happened. The 500 ms budget is checked on a synthetic 44,000 by 512 matrix, not the live library.

- A done `tempo-energy-v1` row has both measurements, a null vector, and `dim` 0. A podcast genre is skipped. A changed file size makes the row stale and invisible to the bot.
- A vector row from recipe A is never scored against recipe B. A byte length that disagrees with `dim` is invisible.
- With both recipes inactive, today's refusals still hold, including "calmer" and "more like this" staying on tags.
- With the scalar recipe active, "fast and low energy" returns only songs inside both gates. A short list reports the shortfall and does not widen the gates.
- "Calmer than this" uses the seed's stored energy. It is not the low percentile band.
- With an embedding recipe active, "more like this" does not copy the seed's genres onto the plan. The seed and a second copy of the same title and artist are absent. In a library search at most two songs share an artist, unless the user named that artist.
- A sound phrase of pure negation adds no rank. A sound phrase while the active embedding recipe is not text-aligned is `unsupported`.
- A library request with no audio fields and no familiar history is drawn at random among its matches, not ordered by play count or title. The returned seed, with the same shown songs, repeats it. The summary does not mention a 5,000 cap.
- A "more familiar" request draws from the most played and lists them most played first. Asking again prefers songs from outside the last three presented answers, on any device, and says when one repeats. Refining a proposal or the queue keeps its order.
- The summary states coverage whenever an audio gate was used.
- `validate` rejects a proposal whose profile went stale.
- The worker result is rejected when the file changed during the lease, or when the vector length disagrees with the recipe.
- Worker peak memory, songs per minute, and warm resolve time are recorded the way the trial report records them, on the machine that will run the scan. Warm resolve of an audio request stays under 500 ms apart from Ollama.
- `tempo-beat-v1` (`worker/tests/test_beat.py`, generated audio and a stand-in tracker): the steady-gap BPM and its 4-beat and 3-gap floors; the song BPM is the median of the sections; sure needs two sections, agreement with the 60 s window within 2 BPM and at most 200 BPM; an unsure song is done with energy and no tempo; podcast genres and files under 60 s are skipped before decoding; energy is the mean window RMS; a file where nothing decodes is failed; the decoders feed one model and every result goes back under its own lease. The real model on a click track runs inside the worker image.
- A done `tempo-beat-v1` row may have a null tempo and must have energy; a done `tempo-energy-v1` row still needs both.
- Two leases at once never get the same song.
- Half and double (`tests/test_music_bot_audio.py`): a song at half the asked tempo with high energy is an octave match for "fast", with low energy it is out; the same for "slow" at double with low energy; a BPM range works the same way; direct matches come before octave matches; the summary counts the octave matches; "faster than this" folds a same-band song into the seed's octave and compares the raw BPM when the bands differ; an unsure song is not covered for tempo but is for energy; `validate` accepts an octave match.
- The page's routes (`tests/test_audio_analysis_api.py`): status counts, worker last seen and device, the 100-song sample with a podcast and a long recording, "measure all" queues nothing without confirmation, pause holds back the lease, the listen groups and the ambiguous list.
- The page (`frontend/src/features/analysis/*.test.ts` and `frontend/e2e/song-analysis.spec.ts` on the desktop and phone projects, routes mocked).

## Build order

1. **Ranker, no audio.** Done. The 5,000 ceiling is gone and the artist cap applies. Tag matches were first ordered by play count and last played; since 15 October 2026 a library search draws among them under a seed instead (see [Broad selection](#broad-selection)). "More like this" stays tag-based until an embedding recipe exists.
2. **Schema 9 and `tempo-energy-v1` trial.** The code is done: the tables, the lease, the worker image, the search-plan fields and the prompt switch. The 100-song resource run happened on 19 October on a copy of the database ([results](#100-song-run-19-october-2026)) and showed the tempo is too coarse. The scripted listen has not happened, and the recipe is not turned on. The next step is a Beat This! recipe, measured in the [analyser bake-off](analyzer-bakeoff.md).
3. **`tempo-beat-v1`, the page and half and double.** Code done on 20 October 2026, not merged. The 100-song GPU run on the trial copy is [above](#100-song-run-on-the-graphics-card-20-october-2026). Next: Colin's listen on the page, then the switch.
4. **Embedding listen.** Not started. The code takes a registered embedding recipe and a text encoder, which only tests register; no candidate is named.
5. **Full scan.** Not started. "Measure whole library" on the page, or `scripts/enqueue_audio_trial.py --all`, is that scan, and both stop to ask before queueing anything.

## Where the code is

`backend/core/audio_recipes.py` is the recipe registry and the settings check. `backend/core/store.py` holds schema 9 and drops a removed song's rows. `backend/library/audio_profile.py` reads and writes the rows, runs the lease and the queue, works out the bands, and scores cosine. `backend/api/audio_worker_api.py` is the internal lease. `backend/library/music_bot.py` holds `SearchPlan`, `system_prompt`, `AudioGates` and the ranker in `MusicBot.resolve`. `backend/library/selection.py` holds the seeded draw and the refinement order. `worker/` holds both worker images: `Dockerfile` with `tempo-energy-v1` in `audio_worker/recipe.py`, and `beat.Dockerfile` (built twice, CPU and CUDA) with `tempo-beat-v1` in `audio_worker/beat.py` and the decoder pipeline in `audio_worker/pipeline.py`. `backend/library/audio_analysis.py` is the page's service (status, sample, listen groups) and `backend/api/audio_analysis_api.py` its routes; `frontend/src/features/analysis/` is the page. `scripts/enqueue_audio_trial.py` and the page are the only ways to queue work. The player view remains the catalogue the resolver walks. No second database is added.
