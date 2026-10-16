# Handoff: song characteristics

15 October 2026. Paste everything below the line into a new session.

---

Implement [song characteristics](../docs/audio-profile-spec.md), review the branch, and open one pull request. The spec is the contract. Where this handoff and the spec disagree, stop and ask Colin. Do not quietly pick one.

Repository: `H:\Git\musimo`. PowerShell. Branch from current `main`. Snapshot `git status` and `git diff` before editing. If the tree has changes that are not the spec and its two doc pointers (`docs/audio-profile-spec.md`, the 15 October paragraph in `docs/ai-music-plan.md`, the schema sentence in `docs/architecture.md`), stop and ask. Do not reset, clean, or overwrite unrelated work. Do not deploy. Do not point the worker at a real music library. Do not merge the pull request.

## What "finished" means

The pull request ships the machinery with both recipe settings empty. Empty means the bot still refuses mood, energy, tempo, instruments, and vocals, and "more like this" still uses tags. Superseded (owner decision 15 Oct 2026, see [the spec's Broad selection](../docs/audio-profile-spec.md#broad-selection)): library searches are now drawn under a seed, not ordered by play count. The ranker change is live: library matches are ordered by play count and last played, the artist cap applies, and the 5,000-candidate ceiling is gone.

Colin still has to do these later, and this pull request must not pretend they happened:

- The scripted listen that would turn `tempo-energy-v1` on.
- The 100-song neighbour listen, the checkpoint choice, and turning an embedding recipe on.
- A full-library scan. At the old CLAP rate that is days of machine time, and the tempo recipe's real rate is unmeasured.

No AudioMuse-AI code, ONNX export, or DCLAP weight. No Essentia. No MTG model. No CLAP download. No IVF index. No second database. No genre written from audio. The October genre labels stay sealed and are not a tuning set.

## Read first

- `docs/audio-profile-spec.md`. The whole document.
- `docs/ai-music-plan.md`, section 2, for the worker limits. Those limits are unchanged.
- `backend/library/music_bot.py`. `SearchPlan`, `SYSTEM`, `resolve`, `_matches`, `validate`.
- `backend/core/store.py`. `SCHEMA_VERSION` is 8. `drop_song_references` is where a removed song loses its playlist, queue, and waveform rows. Both library deletes call it (`backend/library/index.py`).
- `backend/core/text.py`. `normalize` is the title and artist key.
- `backend/core/models.py`. `Settings` and `SettingsPatch`.
- `frontend/src/api.ts`. `settingsSchema` and `botPlanSchema`. The server and this schema must accept the same plan.
- `frontend/src/features/settings/server-settings.tsx`. Where a settings field is shown.
- `frontend/src/features/music-bot/bot-replies.test.ts`. It asserts the "first 5,000" sentence. That sentence goes away.
- `tests/test_music_bot.py` and `tests/test_player_store.py`. The migration tests open an older `user_version` and expect `SCHEMA_VERSION`.
- `docs/player.md`, the music-bot paragraph that says analysis is not enabled and similarity uses tags. Update it to the new ranker, and keep the analysis-off sentence true while the settings are empty.
- `CONTRIBUTING.md`, tests and pull requests. `scripts/check.sh full` is the required check. GitHub Actions does not run on pull requests.

## Branch and commits

Branch name: `audio-profiles`.

One pull request. Commits in this order, each buildable:

1. Ranker only. No schema, no worker, no new plan fields.
2. Schema 9, profile store, lease, `tempo-energy-v1` worker, enqueue script.
3. Plan fields, prompt, gates, settings, and the bot summary. Recipes stay empty by default.
4. Docs, changelog, notices.

Do not squash them into a drive-by of unrelated files.

## 1. Ranker

In `MusicBot.resolve`:

- Walk every in-scope song in the player view. Delete the `len(candidates) == 5000` break and the summary sentence "Search checked the first 5,000 matching candidates."
- Superseded (owner decision 15 Oct 2026, see [the spec's Broad selection](../docs/audio-profile-spec.md#broad-selection)): play count now ranks only `history: familiar`, and other requests are drawn under a seed. Order a request that is not "more like this" and has no sound phrase by `play_count` descending, then `last_played` descending (missing last-played sorts last), then `song_id`. Title is not a sort key. `history: familiar` stays a filter (`play_count > 0`). It is not the only time play count matters.
- While filling the returned list, skip a missing file, skip the seed song when `similar_to_current` is set, and skip a song whose `normalize(title)` and `normalize(artist)` were already kept. Take at most two songs per `normalize(artist)`, unless that artist is named in `plan.artists`. Named artists are uncapped. As built, the title rule and the cap apply to library searches and to songs added to a proposal, not to a proposal or queue refinement, and a song with no artist tag is subject to neither. Stop at `limit` or `target_seconds`, as today.
- A shortfall is still reported in minutes. No gate is relaxed to fill it.
- File checks run only while filling the list, not for every match.
- `similar_to_current` keeps today's tag behaviour for this commit: copy the reference genres, or the artist when there is no genre, and say so in the summary. The embedding commit changes that only when an embedding recipe is active.

`StoredSong` has no `artist_key`. Use `normalize` from `backend/core/text.py`. That is the same function the scanner stores.

Update `tests/test_music_bot.py` and `bot-replies.test.ts` for the new order, the cap, and the removed ceiling sentence. A fixture full of one artist must return two songs unless the plan names that artist. Superseded (owner decision 15 Oct 2026, see [the spec's Broad selection](../docs/audio-profile-spec.md#broad-selection)): the order no longer follows play count. Add a case with two artists and uneven play counts so the order is play count, not title, and the third song by the busier artist is held back.

## 2. Schema 9

`SCHEMA_VERSION = 9`. Older binaries already refuse a newer file. Follow the version-8 block in `store.py`: one `BEGIN IMMEDIATE`, then the new tables, then `PRAGMA user_version=9`. Add a test beside the existing ones that opens a populated version-8 file, upgrades, reopens, and checks both tables. A file newer than 9 still refuses startup.

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

CREATE TABLE audio_job (
    song_id TEXT NOT NULL,
    recipe TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'leased')),
    lease_token TEXT NOT NULL DEFAULT '',
    leased_until TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, recipe)
);
```

`library_files` is unchanged. There is no genre column and no mood column on `audio_profile`.

Failed and skipped rows store null measurements and a null vector. A done row with `dim` 0 has a null vector. A done row whose `vector` length is not `dim * 4` is ignored by every reader, the same as a failed row. `tempo_bpm` is beats per minute. `energy` is mean linear RMS of the accepted sections.

A row is fresh when `status` is `done`, `size` and `mtime_ns` equal the `library_files` row, and a vector row's byte length matches `dim`. Stale, failed, and skipped rows satisfy no tempo, energy, or vector gate.

`drop_song_references` deletes `audio_profile` and `audio_job` for those song ids, in the caller's transaction. Both delete paths in `index.py` already call it. Add a test that removes a file, scans, and sees the profile go.

Dropping the two tables is a safe reset. Say that in `docs/architecture.md` next to the waveform-cache note.

## 3. Recipes in code

A recipe is a constant, not a per-row flag:

- `tempo-energy-v1`: scalar, `dim` 0, not text-aligned. This is the only production recipe.
- Tests may register another id, for example `embed-test`, with a small `dim` and `text_aligned` true, plus a stub that maps a phrase to a vector. That registration lives in the test. It is not a settings choice in production.

`Settings` gains `audio_scalar_recipe` and `audio_embedding_recipe`, both strings, default `""`, max length 80. `""` is off. Any other value must be a registered recipe of the right kind, or `Settings` rejects it. `SettingsPatch` carries the same two optional fields. `frontend/src/api.ts` `settingsSchema` needs both, with defaults, so an older cached payload still parses.

The production embedding setting can only be `""`. Do not add a CLAP recipe id to the registry.

## 4. Worker

The web image does not gain librosa, numba, onnx, or Essentia. Scoring in the web process needs NumPy. Add NumPy to the main project, lock it, and record the licence in `THIRD_PARTY_NOTICES.md`. Librosa stays in the worker image only. Pin it there and lock that file too. Librosa is ISC.

Layout:

- `backend/library/audio_profile.py` reads and writes profiles, computes percentiles, and scores cosine. No librosa import.
- `backend/api/audio_worker_api.py` is the lease. It is not a browser route.
- `worker/` has its own Dockerfile and lockfile. The recipe code lives here.
- `scripts/enqueue_audio_trial.py` inserts `audio_job` rows. It is the only way to queue work.

Compose service `audio-worker`, profile `analysis`, so `docker compose up` does not start it. `mem_limit: 2g`, `cpus: "1"`, `memswap_limit: 2g` (that is the no-swap cap), `init: true`, music mounted read-only, no published port, `no-new-privileges`. The app and the worker share `MUSIMO_ANALYSIS_TOKEN`. An empty token makes the lease routes return 404. Compare the bearer token with `secrets.compare_digest`. Do not log the token. Do not raise the 2 GB or one-core cap if a dependency does not fit. Record the failure and stop.

Lease:

- `POST /api/internal/audio/lease` and `POST /api/internal/audio/result`.
- One leased song. If `MusicBot.busy` is set, lease returns no work. `busy` already exists around the chat call.
- Lease expiry is 3 minutes. A late result whose token or expiry does not match is rejected and does not replace the row. A second result for the same lease is rejected.
- Re-check `size` and `mtime_ns` against `library_files` before commit. A mismatch is rejected.
- A vector length that disagrees with the recipe `dim` is rejected.
- Three failed attempts write `audio_profile.status = failed` and delete the job. The song stays out of gates.
- The worker never opens SQLite.

`tempo-energy-v1` sections, matching the trial that already passed the resource gate:

- Span is `duration - 10` seconds. Starts at 10, 50, and 90 percent of that span. Three 10-second mono sections.
- Duration under 10 seconds, or a span that cannot hold the starts, is `failed` with a short `detail`. No invented BPM.
- FFmpeg seeks. A section more than 100 ms short is rejected. M4A input uses `-seek_streams_individually 0`. Decoder deadline 30 seconds. One native thread.
- Decode with FFmpeg. Do not let librosa open the file. That would read the whole recording.
- Tempo is the median of the section estimates that succeeded. Energy is the mean RMS of the accepted sections. A done row needs both. Otherwise `failed`.
- `dim` 0 and a null vector.
- Genre `podcast`, `podcasts`, or `spoken word`, casefolded, on the `genre` column or any string in the `genres` JSON, is `skipped` without decoding.

`scripts/enqueue_audio_trial.py --recipe tempo-energy-v1 --limit N` queues up to N songs that lack a fresh row. Default limit 100. `--all` prints the count and exits unless `--yes` is also passed. This pull request does not run it against a real library. Tests call the same function on generated wavs.

There is no browser button that starts a scan.

## 5. Bot gates

Add the fields to `SearchPlan` with empty defaults so one schema exists. Grow `FilterName` and `change_filters`'s max length. Today the literal has 11 names and `max_length=11`. New names: `tempo`, `tempo_min`, `tempo_max`, `energy`, `energy_compared`, `tempo_compared`, `sound`.

- `tempo`: `""`, `slow`, `medium`, or `fast`. Slow is under 90 BPM. Medium is 90 up to but not including 140. Fast is 140 and above.
- `tempo_min` and `tempo_max`: BPM, or null. A single named BPM such as 120 is the hard window 110 through 130, inclusive. A band and a bound can both be set. A song must pass every one that is set.
- `energy`: `""`, `low`, `medium`, or `high`.
- `energy_compared`: `""`, `calmer`, or `more_intense`. Strictly below or above the reference song's stored energy. It is not the low or high band.
- `tempo_compared`: `""`, `slower`, or `faster`. The same rule, against the reference song's `tempo_bpm`.
- `sound`: at most 120 characters, default `""`.

Percentiles use fresh done energies for the active scalar recipe only, sorted ascending. With `n` values, the 33rd percentile is the value at index `floor(0.33 * (n - 1))`, and the 66th is `floor(0.66 * (n - 1))`. Low is strictly below the 33rd. Medium is from the 33rd up to but not including the 66th. High is the 66th and above. Null energy is outside every band. Do not use an interpolated percentile. Pin this with a test where equal values make the low band empty.

`SYSTEM` becomes a function of the active recipes.

- Both empty: keep today's prompt, including the "make the rest calmer" example that returns `unsupported` and does not search. The service enforces that. If the model sets any of the new fields, clear them. If the request cannot be represented without those fields, the action becomes `unsupported` with the current explanation, and suggestions stay tag-based. Do not approximate tempo or energy with genres.
- Scalar recipe active: the prompt may fill the tempo and energy fields, and the calmer example becomes a search with `energy_compared` `calmer`. Instruments, vocals, and mood words stay `unsupported`.
- Embedding recipe active: `similar_to_current` does not copy the reference genres or artist onto the plan. The user's own filters still apply. Rank by cosine to the seed vector, descending. The seed is absent. A reference song with no fresh vector is an honest miss, not a tag search. The summary names the recipe.
- Embedding recipe active and text-aligned: `sound` is a phrase. Genre words stay in `genres`. A phrase that is only negation is cleared and adds no rank. Treat it as negation-only when every remaining token is in this closed list: `no`, `not`, `nothing`, `without`, `minus`, `dont`, `don't`, `never`, `vocals`, `vocal`, `explicit`. "No rock" is dropped from `sound`. Do not build genre exclusion in this change. That is a separate item in `todo/genre-and-bot-handoff.md`.
- A `sound` phrase while the active embedding recipe is missing or not text-aligned is `unsupported`.

One rank key. Do not blend play count with cosine, and do not break ties inside a tempo or energy band by being "faster" or "calmer." Songs inside the gate tie on that axis. Superseded (owner decision 15 Oct 2026, see [the spec's Broad selection](../docs/audio-profile-spec.md#broad-selection)): play count is the rank key only for `history: familiar`, and with no rank key the songs are drawn at random. Order them by the one rank key: play count, or cosine when the request is similar-to or a sound phrase.

The summary names the recipe and coverage whenever an audio gate was used: how many library songs have a fresh done row for that recipe, out of how many are in the library, and how many matches were skipped for a missing profile. A shortfall still says no exclusions were relaxed.

`validate` rechecks the new gates. A profile that went stale, or a file whose size changed, is a 409, the same as a vanished file.

`frontend/src/api.ts` `botPlanSchema` must accept the new fields with empty defaults so a reply from an older build still parses during a mixed deploy. The UI does not have to draw the new fields as chips in this pull request. It must keep rendering the reply.

## 6. Settings UI

In `server-settings.tsx`, show the two recipe ids. Empty is the default and the copy says analysis is off. Saving empty stays off. Do not prefill `tempo-energy-v1`. Do not add a scan button.

The bot page, with the settings empty, still answers "calmer" as unsupported. That is the behaviour `docs/player.md` and the pet already describe. Keep it.

## 7. Tests

Acceptance from the spec, all of them that do not need Colin's ears. Use generated wavs (`write_wav` in the player tests). No downloaded music. No network in unit tests.

- Done `tempo-energy-v1` row: both measurements, null vector, `dim` 0. A podcast genre is skipped and not decoded. A changed file size is stale and invisible to the bot.
- Recipe A is never scored against recipe B. A wrong byte length is invisible.
- With both settings empty, "calmer" and a model that filled `energy` still return `unsupported`. "More like this" still uses tags, and the summary says so.
- With the scalar recipe set in the test store, "fast" and "low energy" return only songs inside both gates. A short list reports the shortfall and the gates stay as requested.
- "Calmer than this" uses the seed's stored energy. A song in the low band but louder than the seed is out.
- With a test embedding recipe registered, "more like this" does not copy the seed's genres. The seed and a second copy of the same title and artist are absent. A third song by one unnamed artist is absent. A named artist is uncapped.
- The sound phrase "no vocals" adds no rank. A sound phrase with a recipe that is not text-aligned is `unsupported`.
- Superseded (owner decision 15 Oct 2026, see [the spec's Broad selection](../docs/audio-profile-spec.md#broad-selection)): such a request is now drawn at random under a seed. A library request with no audio fields is ordered by play count and last played. The summary does not mention 5,000.
- Coverage is in the summary when an audio gate was used.
- `validate` returns 409 when the profile goes stale.
- The lease rejects a changed file and a wrong vector length. A late token does not overwrite. A second result for the same lease is rejected. While `MusicBot.busy` is set, lease returns no work.
- A version-8 database upgrades. A removed song deletes its profile. An unknown recipe id is rejected by settings. `""` is accepted.
- Worker peak memory is not claimed. Do not write a songs-per-minute number you did not measure. The 500 ms resolve budget is checked in a unit test on a synthetic in-memory matrix of about 44,000 by 512 float32, separate from Ollama, and the test fails if warm scoring plus the gate walk exceeds 500 ms. Say in the pull request that this is a synthetic matrix, not the live library.

`scripts/check.sh full` passes. Run `scripts/check.sh browser` if the settings page or the bot page changed. Exercise the settings fields on desktop and at 390 px: they load empty, save empty, and survive reload. The bot still refuses "calmer." A TypeScript build is not that check.

## 8. Docs in the same pull request

- `docs/audio-profile-spec.md`: status becomes implemented, recipes default off, listen and full scan outstanding. Do not delete the contract.
- `docs/architecture.md`: schema 9, the internal lease, the worker profile, the ranker. The sentence that says no audio index exists is no longer true. Replace it with what shipped. Keep the note that an empty recipe means the bot ignores any rows.
- `docs/player.md`: the new order and the artist cap. Analysis stays off until a recipe setting is non-empty.
- `docs/ai-music-plan.md`: point the open decision at this implementation. Do not mark the listen or the full scan done.
- `docs/testing.md`: name the new test modules in the same style as the music-bot paragraph.
- `CHANGELOG.md`: under `## Unreleased`, a short music-bot bullet for the ranker, and a bullet that analysis exists and is off.
- `THIRD_PARTY_NOTICES.md`: NumPy and, for the worker image, librosa.

Do not rewrite `docs/music-bot-review-fixes.md`. It records what was true on that date.

## 9. Review

After the last commit the tree is clean. Run the review skill at `C:\Users\cclea\.grok\bundled\skills\review\SKILL.md` as `/review --main`. The reviewer is a subagent. You do not invent the findings yourself.

Fix every bug it reports. Suggestions that match the spec get fixed too. A suggestion that would vendor AudioMuse, raise the worker cap, activate a recipe, or start a scan is declined in the review notes with the spec section that forbids it.

Commit the fixes. Review again. Stop when the review has no open bugs. Do not approve your own pull request.

## 10. Pull request

`gh pr create` against `main`. Do not merge. Do not deploy.

Title: `Rank library matches and store song characteristics`.

Body, in this order:

- The problem: broad requests were an alphabetical slice of the first 5,000 scan-order matches, and tempo, energy, and sound had nowhere to live.
- What changed: the ranker, schema 9, the optional worker, the gates behind empty settings.
- What did not change: recipes ship empty, "calmer" is still refused, "more like this" still uses tags, no model was downloaded, no library was scanned.
- Checks: `scripts/check.sh full`, and browser if you ran it. Paste the result lines. Name the synthetic 500 ms test as synthetic.
- Outstanding: Colin's tempo listen, then he may set `audio_scalar_recipe` to `tempo-energy-v1`. The embedding recipe is unnamed until a separate listen. `--all` on the enqueue script is the full scan and is not part of this pull request.

Write the body to a scratch file under `C:\msys64\tmp` and pass it with `--body-file`. Delete that file after `gh` returns. Leave no scratch file behind.
