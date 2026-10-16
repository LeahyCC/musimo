# Song characteristics

Status: implemented, 15 October 2026, with both recipe settings empty. The ranker, schema 9, the lease, the worker image and the gates are in the code; the scripted listen for `tempo-energy-v1`, the embedding listen and a full-library scan are outstanding, so no recipe is switched on and nothing has been analysed. The implementation handoff is [todo/audio-profile-handoff.md](../todo/audio-profile-handoff.md). It is the approach left open by [the music-bot plan](ai-music-plan.md) after the [genre listen](genre-label-review.md). The held-out labels from that listen stay sealed. They are not a tuning set for anything described here. The rest of this document is the contract the code was built to; where the implementation settled a detail the contract left open, the paragraph says so.

The bot keeps its current shape. Ollama emits a filter plan. `MusicBot.resolve` chooses real song ids from the player view. The model never emits song ids, SQL, or paths. This spec gives that resolver measured tempo, measured energy, and one sound vector, stored in the existing SQLite file.

AudioMuse-AI is the source of the behaviour, read from [its algorithm description](https://github.com/NeptuneHub/AudioMuse-AI/blob/main/docs/ALGORITHM.md) (chapters 1, 6, and 14, main branch as of 15 October 2026) and the v0.9.0 and v3.4.0 release notes. Musimo reimplements the parts below. AudioMuse-AI is AGPL-3.0. None of its code, ONNX exports, or distilled weights are vendored.

## What is kept from AudioMuse

AudioMuse keeps one `score` row per recording: raw-ish tempo, energy, key, and scale, a mood string, and six extra scores (`danceable`, `aggressive`, `happy`, `party`, `relaxed`, `sad`). The six scores are the cosine between a 512-dimension CLAP audio vector and six fixed text prompts. They are not a second classifier. A separate 200-dimension MusiCNN vector answers "sounds like this song." The chat model does not invent songs. It calls tools. `search_database` filters genre, mood, tempo, energy, key, year, and length. `text_match` ranks a description against the CLAP vector. `seed_search` ranks neighbours of a named song. A requested tempo or energy range is a gate. Songs inside it tie on that axis, and similarity or the database order breaks the tie. "Calmer than this" is measured against the seed's own energy, not against a fixed "low" bucket. The same title and artist is dropped. An artist cap limits how much of a playlist one artist can fill. A phrase that is only a negation ("no vocals") is dropped, because an embedding reads the negation as the thing named.

Musimo keeps that contract, narrowed:

- Tempo in BPM and energy as a measured loudness, on a versioned row keyed by `song_id`.
- One float32 vector per song, for one recipe at a time. Neighbour rank uses cosine to the seed. A sound phrase uses cosine to the text encoding of that phrase, and only when the recipe was trained in a shared text space.
- Hard gates. A song outside a requested tempo, energy, artist, genre, year, duration, or exclusion is out. The reply reports the shortfall. AudioMuse's relax loop, which drops tempo and energy when the pool is short, is not copied. The current bot already refuses to relax exclusions.
- Artist cap of two while the result list is filled. Artists the user named are uncapped.
- Same normalized title and artist dropped. The seed song is dropped on "more like this."
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

`tempo_bpm` is beats per minute, null when this recipe does not measure tempo. `energy` is the mean RMS of the analysed sections, linear amplitude, null when this recipe does not measure energy. `vector` is little-endian float32, L2-normalised, length `dim * 4`. `dim` 0 and a null vector mean this recipe has no vector. A done row whose byte length disagrees with `dim` is ignored, the same as a failed row. Failed and skipped rows have a null vector and null measurements.

There is no genre column and no mood column.

A profile is stale when its `size` or `mtime_ns` disagrees with `library_files`. Stale, failed, and skipped rows do not satisfy a tempo, energy, or vector constraint. The scanner deletes profile rows in the same transaction that deletes a `library_files` row. Dropping `audio_profile` is a safe reset. The worker refills it. Two recipes are never scored against each other. A scalar recipe and an embedding recipe may both be active, because a BPM is not compared with a vector.

Active recipe ids live in settings. Both default to empty. An empty id means the chat prompt still refuses that family of request. Rows may exist before the recipe is activated. The bot ignores them until the operator turns the recipe on. That is the switch between a trial and production.

## Recipes

### `tempo-energy-v1`

Librosa, ISC, the same family as the trial baseline. No neural net and no downloaded weights. Three 10-second mono sections, at 10, 50, and 90 percent of `duration - 10` seconds. That is the short recipe that already passed the 2 GB, one-core, no-swap gate in the [trial report](audio-analysis-trial.md). Decoder rules from that trial stay: FFmpeg seeks, a section more than 100 ms short is rejected, M4A uses `-seek_streams_individually 0`, the decoder deadline is 30 seconds, and native threads are pinned to one.

Tempo is the median of the section estimates that succeeded. Energy is the mean RMS of the accepted sections. A done row requires both numbers. A file that yields neither is `failed`, with the reason in `detail`. No BPM is invented.

`dim` is 0. The vector is null.

Genre `podcast`, `podcasts`, or `spoken word`, compared casefolded to the stored genre string, is `skipped`. Speech tempo is not a music tempo. The trial sample for this recipe includes at least one of those files and at least one recording longer than 20 minutes. The listen can add a further skip rule, such as a duration ceiling, before the recipe is activated. The rule becomes part of the recipe. Changing it mints a new recipe id.

Implemented in `worker/audio_worker/recipe.py`, with librosa 0.11.0 on Python 3.12, the interpreter the trial measured. The details the contract left open were settled this way, and each is part of the recipe id: a section's tempo comes from `librosa.feature.rhythm.tempo` on its onset envelope, and a section with no onsets at all gives no estimate rather than the estimator's 117 BPM prior, so digital silence cannot become a done row; a section's energy is the mean of `librosa.feature.rms` frames, and the row's `energy` is the mean of the accepted sections; the genre check also reads every string in the `genres` list, not only the single `genre` column; a file whose three starts coincide (a 10-second file) is decoded once; the worker reports the file's size and modification time as it found them, so a file the index has not caught up with is refused and tried again rather than written against stale identity. A measured section that fails only its tempo estimate still counts towards energy.

### Embedding recipe

Unnamed. The id is chosen when four things exist together: a checkpoint, a licence that Musimo may ship, a written sampling recipe, and a passed 100-song neighbour listen. The October labels are not that listen.

The row stores one L2-normalised float32 vector. Tempo and energy stay on `tempo-energy-v1` unless the embedding recipe's own notes say it replaces them. A text-aligned recipe may answer a sound phrase. A recipe that is not text-aligned leaves sound phrases unsupported. That flag is a constant of the recipe in code, not a per-row column.

`laion/clap-htsat-unfused` revision `8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a` remains a candidate. It is Apache-2.0, it fitted the worker cap (peak 1.41 GB), and it failed as a genre labeler. Genre failure does not decide neighbour quality. The listen does. MFCC remains the cheap similarity baseline from the same trial, and it cannot answer a text phrase.

## Analysis worker

The worker contract in [the music-bot plan](ai-music-plan.md) stands. One optional Linux container, read-only music, one song at a time, 2 GB RAM, one CPU, no swap. FastAPI owns SQLite. The worker leases through the internal API and never opens the database. Expired leases are dropped. A late or duplicate result cannot replace a newer row. File size and modification time are rechecked before commit. Analysis pauses during a bot request. Playback stays usable.

The result body this spec adds is: `song_id`, `recipe`, `size`, `mtime_ns`, `status`, `tempo_bpm`, `energy`, `dim`, vector bytes, `detail`. FastAPI rejects a result whose recipe, identity, or vector length disagrees with the lease.

Order of work, once a recipe is approved to run: the operator's chosen songs, then new library files, then the backlog. Each committed row is readable. The bot uses them only after that recipe is the active one. A full-library scan waits on the listen below. At the trial's fuller CLAP rate of about 8 songs a minute, 44,070 tracks is on the order of four days at one song at a time. The tempo recipe should be faster. The trial measures the real rate before a full scan is started. The plan's rule stands: a model that does not fit the cap is a failed candidate, not a reason to raise the cap.

## How the bot ranks

`SearchPlan` carries the fields below from this change, all empty by default, so one schema exists. While a recipe's setting is empty the prompt keeps today's refusal, word for word: mood, energy, tempo, instruments, and vocals are `unsupported`, and they are not approximated with genres. The service enforces it too: a search plan that filled one of those fields anyway becomes `unsupported` with the same explanation and the fields cleared. `system_prompt` in `backend/library/music_bot.py` builds the prompt from the active recipes.

When `tempo-energy-v1` is active, the plan may carry:

- `tempo`: `slow`, `medium`, `fast`, or empty.
- `tempo_min` and `tempo_max`: BPM bounds. Set from an explicit BPM in the request. A band and a bound can both be set. Both are hard.
- `energy`: `low`, `medium`, `high`, or empty. Low is below the 33rd percentile of done `energy` for this recipe, medium is from the 33rd up to but not including the 66th, high is the 66th and above. Songs with null energy are outside every band.
- `energy_compared`: `calmer` or `more_intense`, or empty. This is strictly below or above the reference song's stored energy. It does not mean the low or high band.
- `tempo_compared`: `slower` or `faster`, or empty. The same, against the reference song's `tempo_bpm`.

When an embedding recipe is active and marked text-aligned, the plan may carry `sound`, a phrase of at most 120 characters. Empty means no phrase. A phrase that is only a negation is cleared by the service. Genre words stay in `genres`.

Two details the service settles rather than the model: a plan whose `tempo_min` equals its `tempo_max` is the single named BPM, and the service widens it to the 10 BPM window above; and a plan with both `similar_to_current` and `sound` keeps one rank key, the reference song's vector, and drops the phrase.

`MusicBot.resolve` then does the following. The player view is already the whole library, so the walk covers every stored song in scope.

1. Apply today's tag gates: artist, genre, year, duration, favourites, play history, exclusions, scope. Named tempo, energy, and comparison gates apply to songs with a fresh done row on the active scalar recipe. A sound phrase or `similar_to_current`, once an embedding recipe is active, requires a fresh done vector on that recipe.
2. Rank the survivors. A library request with no seed and no sound phrase ranks by `play_count` descending, then `last_played` descending, then `song_id`. `history: familiar` remains a filter (`play_count > 0`), not the only time play count is allowed to matter. `similar_to_current` ranks by cosine to the seed vector, descending. A sound phrase ranks by cosine to the text encoding of the phrase. Tempo and energy do not break ties inside a band. One rank key is used. The keys are not blended.
3. Fill the result list in that order. Skip a missing file. Skip a song whose normalized title and artist were already kept. Skip the seed. Take at most two songs for one `artist_key`, unless that artist is named in the plan. Stop at `limit` or `target_seconds`, as today.
4. Report a shortfall in minutes when the duration cannot be filled. No gate is relaxed to fill it. The summary names the recipe and the coverage: how many library songs have a fresh done row, out of how many are in the library. Songs skipped for a missing profile are counted in that sentence.

The 5,000-candidate ceiling went away in this same change. It was applied before the sort, in scan order, so a broad request was an alphabetical slice. File checks run only while the result list is being filled.

`similar_to_current` today replaces the plan's genres with the reference song's tags and drops the artist. That replacement stays only while no embedding recipe is active, and the summary keeps saying similarity is tags. Once an embedding recipe is active, the reference song's tags are not copied onto the plan. The user's own genre and artist filters still apply. A reference song with no fresh vector produces an honest miss, not a tag search.

`validate` rechecks the new gates the same way it rechecks tags and file availability. A profile that went stale between the proposal and Play is a 409, the same as a vanished file.

There is no skip log yet. A stop before 30 seconds is not a rank feature in this spec. `play_count` and `last_played` are the listening rank until a later listen-event table exists. That table can replace the rank key without a new audio recipe.

## Listen gate

`tempo-energy-v1` is activated after a scripted listen, not after a full scan. The operator hears pairs that the gate claims are faster, slower, calmer, and more intense than a seed, on the order of a few dozen songs, including one long recording and one spoken-word file. Activation is a settings change. A bad listen mints no second recipe and starts no scan.

The embedding recipe is activated after a separate 100-song neighbour listen. The page plays "more like this" results. If the recipe is text-aligned, the same listen includes the phrases "relaxed", "aggressive", and "sad piano", judged as playlists. Agreement between two models is not a pass. The October genre labels are not reused, and they are not the reason a checkpoint is rejected or kept for this job.

A full scan of a recipe starts only after that recipe's listen has passed and the operator has turned it on. Coverage in the bot is whatever fraction is done. The reply says so.

## Licences

| Piece                                                                     | Terms                                               | Use here                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| AudioMuse-AI, its ONNX exports, and its distilled CLAP (DCLAP) repository | AGPL-3.0                                            | Behaviour only. The DCLAP student weights and training code stay out.                              |
| Essentia, and the MTG Essentia models AudioMuse replaced in v0.9.0        | Essentia is AGPL. Those models are CC BY-NC-SA 4.0. | Out.                                                                                               |
| Original MusiCNN, as described in the AudioMuse v0.9.0 release note       | The note calls the model ISC.                       | Not a Musimo dependency. Any later use has to confirm the weight file's own licence before a scan. |
| `laion/clap-htsat-unfused` at `8fa0f1c`                                   | Apache-2.0                                          | Candidate for the embedding listen. Not selected.                                                  |
| librosa, for `tempo-energy-v1`                                            | ISC                                                 | The scalar recipe.                                                                                 |

## Acceptance

These are the checks the implementation carries, in `tests/test_music_bot.py`, `tests/test_music_bot_audio.py`, `tests/test_audio_profile.py`, `tests/test_audio_worker.py` and `worker/tests/test_recipe.py`, on generated audio and test recipes. The last item is the exception: the listen gates need Colin's ears, and the worker's real rate and peak memory are measured on the machine that will run the scan, which has not happened. The 500 ms budget is checked on a synthetic 44,000 by 512 matrix, not the live library.

- A done `tempo-energy-v1` row has both measurements, a null vector, and `dim` 0. A podcast genre is skipped. A changed file size makes the row stale and invisible to the bot.
- A vector row from recipe A is never scored against recipe B. A byte length that disagrees with `dim` is invisible.
- With both recipes inactive, today's refusals still hold, including "calmer" and "more like this" staying on tags.
- With the scalar recipe active, "fast and low energy" returns only songs inside both gates. A short list reports the shortfall and does not widen the gates.
- "Calmer than this" uses the seed's stored energy. It is not the low percentile band.
- With an embedding recipe active, "more like this" does not copy the seed's genres onto the plan. The seed and a second copy of the same title and artist are absent. At most two songs share an artist, unless the user named that artist.
- A sound phrase of pure negation adds no rank. A sound phrase while the active embedding recipe is not text-aligned is `unsupported`.
- A library request with no audio fields is ordered by play count and last played, not by title. The summary does not mention a 5,000 cap.
- The summary states coverage whenever an audio gate was used.
- `validate` rejects a proposal whose profile went stale.
- The worker result is rejected when the file changed during the lease, or when the vector length disagrees with the recipe.
- Worker peak memory, songs per minute, and warm resolve time are recorded the way the trial report records them, on the machine that will run the scan. Warm resolve of an audio request stays under 500 ms apart from Ollama.

## Build order

1. **Ranker, no audio.** Done. The 5,000 ceiling is gone, tag matches are ordered by play count and last played, and the artist cap applies. "More like this" stays tag-based until an embedding recipe exists.
2. **Schema 9 and `tempo-energy-v1` trial.** The code is done: the tables, the lease, the worker image, the search-plan fields and the prompt switch. The 100-song resource run and the scripted listen have not happened, so the recipe is not turned on.
3. **Embedding listen.** Not started. The code takes a registered embedding recipe and a text encoder, which only tests register; no candidate is named.
4. **Full scan of an activated recipe.** Not started. `scripts/enqueue_audio_trial.py --all` is that scan, and it stops to ask before queueing anything.

## Where the code is

`backend/core/audio_recipes.py` is the recipe registry and the settings check. `backend/core/store.py` holds schema 9 and drops a removed song's rows. `backend/library/audio_profile.py` reads and writes the rows, runs the lease and the queue, works out the bands, and scores cosine. `backend/api/audio_worker_api.py` is the internal lease. `backend/library/music_bot.py` holds `SearchPlan`, `system_prompt`, `AudioGates` and the ranker in `MusicBot.resolve`. `worker/` is the worker image, with the recipe in `audio_worker/recipe.py` and its own lock. `scripts/enqueue_audio_trial.py` is the only way to queue work. The player view remains the catalogue the resolver walks. No second database is added.
