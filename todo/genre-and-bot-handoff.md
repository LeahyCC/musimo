# Handoff: genre search, music bot and open work

14 October 2026. Repository `C:\Users\cclea\projects\musimo`, branch `feature/local-player`, machine pancakes (Windows, PowerShell). Read the vault rules and `Reference/PC/musimo.md` and `drive-layout.md` before touching the server. Never trust a drive letter without checking it, and never delete `M:\Media`.

## Where things stand

```
done today
  genre mapping       63 tag words -> broad genres         backend/library/genres.py
  bot genre search    raw tags + broad genres               backend/library/music_bot.py
  bot guards          genre-as-artist fix, request fallback
  tests               438 backend pass, bot benchmark 27/28 on two runs
  deployed            running container = this checkout     http://127.0.0.1:8765
not done
  nothing committed   whole branch has mixed uncommitted work
```

Read first: `docs/genre-trial-review.md` (why audio genre was parked), `docs/genre-mapping.md` (the table and the bot rules), `docs/player.md` (Music bot section).

The working tree holds uncommitted work from several tasks (tagging, imports, scanning, artwork, player, bot, experiments). Do not reset, clean or overwrite any of it. Snapshot `git status` and `git diff` before changing anything.

## Open items

Each item says where to look and when it is done. Items marked **Colin** need his decision first.

### 1. Commit the work (Colin)

Nothing is committed. The genre code depends on the uncommitted bot code, so they go together. Colin decides how to split the branch's mixed work into commits. Follow the vault git rules for identity, wording and trailers.

### 2. Slow start and hanging Library after a scan

After each restart, Musimo takes about 6 minutes to start, then the first Library request takes about 3.5 minutes. Library pages and the bot hang until then. The same happens during any full scan.

- Start-up: `Library.start()` in `backend/library/index.py` schedules a watchdog `PollingObserver` (`MUSIMO_WATCH_MODE=poll`) on the `M:` bind mount inside the app's lifespan. The initial snapshot of about 44,000 files appears to run before start-up completes.
- Library view: `Player.view()` in `backend/library/player.py` rebuilds whenever `library_revision` changes, and `_build` walks directories for covers. Scan batches bump the revision, so views keep rebuilding under load.
- Done when: the container reports healthy within about 30 seconds, and Library pages and the bot answer during a scan (for example, by serving the last built view while a new one builds). Measure before and after on the real library.

### 3. Genre exclusion ("no hip hop")

The bot cannot exclude a genre. "No hip hop please" returns an odd mix that still contains hip hop. The request fallback deliberately skips negated requests.

- Add `exclude_genres` to `SearchPlan` in `music_bot.py`, using the same matching rules as `genres`. Merge follow-ups like `exclude_artists` (exclusions accumulate and need explicit withdrawal language). Add it to the prompt and `FilterName`.
- Add unit tests and benchmark cases ("no hip hop", "rock but no metal", withdrawing a genre exclusion).
- Done when: unit tests pass and the benchmark passes twice on `huihui_ai/qwen3.5-abliterated:9b` with no regressions.

### 4. Bot copies queue context into a fresh request

Benchmark case `genre-rap-decade` ("some rap from the 2000s") fails on both runs. The model copied the queued songs' artist, decade and Rock genre into a request with no previous plan. The chat sends `current`, `reference`, `proposal` and `upcoming` song context every time (around `music_bot.py:255`).

- Try sending upcoming-queue context only when the request is about the queue, or tell the model that context songs are not filters. Measure, do not guess.
- Done when: the benchmark passes all cases on two runs. The previous 22 cases must keep passing.

### 5. Leaked test data in the real settings (Colin, for the reset)

The live library name reads "Activity 1789850089973". `frontend/e2e/app.spec.ts:404` sets `library_label` to `Activity <timestamp>`. The e2e default is `http://127.0.0.1:18765` (`frontend/e2e/env.ts`), so a run was pointed at port 8765 (the real server) with `PLAYWRIGHT_BASE_URL`.

- Add a guard so e2e refuses to run against port 8765 or a server holding a real library.
- Ask Colin before setting the label back to "Music" through `PATCH /api/settings`.

### 6. Stale schema text in architecture.md

`docs/architecture.md` says "This application opens version 6" in the schema paragraph. Code (`SCHEMA_VERSION` in `backend/core/store.py`) is 8. Version 7 adds `codec` and `flac_id3` to `library_files`; version 8 adds `writer_epoch` and `write_sequence` to `play_queue`. Fix the paragraph and keep the rollback note: older builds refuse a newer database.

### 7. Live genre words may differ from the snapshot

The mapping was built from the audio trial's catalogue snapshot. Reading the live database was blocked by a permission check. When allowed, list distinct genre words in the live `library_files.genres` (read-only) and add any new words to `TAG_GENRES` and `docs/genre-mapping.md`. `tests/test_genres.py` fails if the two disagree.

### 8. Fill genres for the untagged gap (Colin)

About 6,300 tracks from about 280 artists have no usable genre: 3,332 with only "Alternative" (104 artists) and 2,935 with none (178 artists). Fill these per artist, not per track. Options are in `docs/genre-trial-review.md`: a review page where Colin confirms a suggested genre per artist, optionally with an Essentia Discogs-EffNet suggestion from a few tracks. Store the result separately from file tags, and never rewrite tags. Note the CC BY-NC-SA licence on the model.

### 9. Broad genres in the Library menus (Colin)

The genre menus on Albums, Artists and Tracks still use raw tags. Offering broad genres there too would make browsing match the bot. This is a UX choice, so design it with Colin first.

### 10. Cleanup after the build settles (Colin)

- `runtime/backup-before-genre-test-20261014/musimo-data.tgz` holds the Deezer cookie, YouTube cookies and Navidrome credentials. Delete it when Colin is happy.
- Docker image `musimo:before-genre-test-20261014` is the rollback. Rolling back also needs that backup, because the database is now schema 8.
- `runtime/music-bot-benchmark-genre-20261014.json` is a rejected prompt variant. Keep or delete; do not cite it as the result.
- The vault note `Reference/PC/musimo.md` has a new deployment section, but it is uncommitted, and the vault had other uncommitted edits. Colin commits.
- The image still says 0.4.0 while running schema 8 code. Bump the version before any release.

### 11. Music bot pet design

Colin wants the bot redesigned as a customisable pet sitting on the Now Playing player. The design brief is `todo/music-bot-pet-design-prompt.md`. Build only after Colin approves a design.

### 12. Parked: audio analysis

Milestone 2 (mood, similarity, audio genre) stays parked behind the quality gate in `docs/ai-music-plan.md`. No production indexing, full scans or resource-limit changes without Colin. If the genre trial resumes, make `experiments/genre-trial/worker.py` save all 400 style scores per section.

## How to check

```powershell
uv run ruff check backend tests scripts
uv run ruff format --check backend tests scripts
uv run python -m unittest discover -s tests
uv run python -m scripts.music_bot_benchmark --model huihui_ai/qwen3.5-abliterated:9b --output runtime/<new-name>.json
```

Run the benchmark twice; the model is not fully deterministic. Ollama runs on the host. Inside Docker the bot reaches it at `http://host.docker.internal:11434`, which is set in the live settings.

To redeploy, run from the repository root, with no downloads active (check `GET /api/jobs`):

```powershell
docker compose --profile youtube build musimo
docker compose --profile youtube up -d --no-build musimo
```

Then wait for `/api/health`, then `/api/library` status `done`, then the first `/api/library/tracks` request (minutes, see item 2). Test the bot with `POST /api/music-bot/chat` and header `Origin: http://127.0.0.1:8765`. Results are previews and never change the queue.
