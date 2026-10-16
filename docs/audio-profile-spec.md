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

The result body this spec adds is: `song_id`, `recipe`, `lease_token`, `size`, `mtime_ns`, `status`, `tempo_bpm`, `energy`, `dim`, `vector` (the little-endian float32 bytes, base64 in the JSON), `detail`. FastAPI rejects a result whose recipe, identity, lease, or vector length disagrees with the lease.

Order of work, once a recipe is approved to run: the operator's chosen songs, then new library files, then the backlog. Implemented so far: `scripts/enqueue_audio_trial.py` queues newest files first and the lease hands them out in that order. Songs whose row for the file as it is now is failed or skipped wait behind every song not yet tried, so a limited run keeps reaching new songs; choosing particular songs is a later item, not in this change. Each committed row is readable. The bot uses them only after that recipe is the active one. A full-library scan waits on the listen below. At the trial's fuller CLAP rate of about 8 songs a minute, 44,070 tracks is on the order of four days at one song at a time. The tempo recipe should be faster. The trial measures the real rate before a full scan is started. The plan's rule stands: a model that does not fit the cap is a failed candidate, not a reason to raise the cap.

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

`BotRequest.shown_ids` lists up to 500 songs the chat showed lately. The browser keeps the songs of its last three library answers in this tab only (`musimo.music-bot.shown` in session storage), newest first, and forgets them on Clear chat or when the tab closes. A refinement or a reply with no search is not recorded. A shown song goes after the unshown songs that fit as well. It is never excluded, so a small pool still fills, and the summary counts the repeats. Nothing is stored on the server, and play counts are not touched.

`RELEVANCE_RATIO` of 4 and the window of at most twice `need` are reasoned, not listened. They are to be tuned at the embedding listen.

Left as they are, by the same decision: there is no exact "my N most played" mode and no "less played" mode; songs in the queue or playing now are not demoted; a request that names several artists samples their songs uniformly and does not balance the artists. Duration words are unchanged for now. A later pass settles "about", "under" and "at least". Colin has decided that "about N minutes" will mean the whole-track total closest to N, never more than 5 minutes off, and otherwise a shortfall. That is a decision, not built.

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

These are the checks the implementation carries, in `tests/test_music_bot.py`, `tests/test_selection.py`, `tests/test_music_bot_audio.py`, `tests/test_audio_profile.py`, `tests/test_audio_worker.py` and `worker/tests/test_recipe.py`, on generated audio and test recipes. The last item is the exception: the listen gates need Colin's ears, and the worker's real rate and peak memory are measured on the machine that will run the scan, which has not happened. The 500 ms budget is checked on a synthetic 44,000 by 512 matrix, not the live library.

- A done `tempo-energy-v1` row has both measurements, a null vector, and `dim` 0. A podcast genre is skipped. A changed file size makes the row stale and invisible to the bot.
- A vector row from recipe A is never scored against recipe B. A byte length that disagrees with `dim` is invisible.
- With both recipes inactive, today's refusals still hold, including "calmer" and "more like this" staying on tags.
- With the scalar recipe active, "fast and low energy" returns only songs inside both gates. A short list reports the shortfall and does not widen the gates.
- "Calmer than this" uses the seed's stored energy. It is not the low percentile band.
- With an embedding recipe active, "more like this" does not copy the seed's genres onto the plan. The seed and a second copy of the same title and artist are absent. In a library search at most two songs share an artist, unless the user named that artist.
- A sound phrase of pure negation adds no rank. A sound phrase while the active embedding recipe is not text-aligned is `unsupported`.
- A library request with no audio fields and no familiar history is drawn at random among its matches, not ordered by play count or title. The returned seed, with the same shown songs, repeats it. The summary does not mention a 5,000 cap.
- A "more familiar" request draws from the most played and lists them most played first. Asking again prefers songs from outside the last three answers and says when one repeats. Refining a proposal or the queue keeps its order.
- The summary states coverage whenever an audio gate was used.
- `validate` rejects a proposal whose profile went stale.
- The worker result is rejected when the file changed during the lease, or when the vector length disagrees with the recipe.
- Worker peak memory, songs per minute, and warm resolve time are recorded the way the trial report records them, on the machine that will run the scan. Warm resolve of an audio request stays under 500 ms apart from Ollama.

## Build order

1. **Ranker, no audio.** Done. The 5,000 ceiling is gone and the artist cap applies. Tag matches were first ordered by play count and last played; since 15 October 2026 a library search draws among them under a seed instead (see [Broad selection](#broad-selection)). "More like this" stays tag-based until an embedding recipe exists.
2. **Schema 9 and `tempo-energy-v1` trial.** The code is done: the tables, the lease, the worker image, the search-plan fields and the prompt switch. The 100-song resource run and the scripted listen have not happened, so the recipe is not turned on.
3. **Embedding listen.** Not started. The code takes a registered embedding recipe and a text encoder, which only tests register; no candidate is named.
4. **Full scan of an activated recipe.** Not started. `scripts/enqueue_audio_trial.py --all` is that scan, and it stops to ask before queueing anything.

## Where the code is

`backend/core/audio_recipes.py` is the recipe registry and the settings check. `backend/core/store.py` holds schema 9 and drops a removed song's rows. `backend/library/audio_profile.py` reads and writes the rows, runs the lease and the queue, works out the bands, and scores cosine. `backend/api/audio_worker_api.py` is the internal lease. `backend/library/music_bot.py` holds `SearchPlan`, `system_prompt`, `AudioGates` and the ranker in `MusicBot.resolve`. `backend/library/selection.py` holds the seeded draw and the refinement order. `worker/` is the worker image, with the recipe in `audio_worker/recipe.py` and its own lock. `scripts/enqueue_audio_trial.py` is the only way to queue work. The player view remains the catalogue the resolver walks. No second database is added.
