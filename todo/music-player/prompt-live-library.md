# Session prompt: prove the live library

Paste the block below into a fresh session. It is phase 0 of `docs/navidrome-gap-plan.md` only. When it is done, stop. The next session is the Navidrome import dry-run, and it gets its own prompt.

```text
Prove Musimo's live library on this machine, then stop.

Repo: /Users/cookies/Documents/development/git/musimo
Branch: feature/local-player
Plan: docs/navidrome-gap-plan.md, section "Phase 0. Prove the live library" only.
Checklist already open: todo/music-player/TODO.md, the unchecked live-install item under Browser pass.

This session checks that the real music folders play after Navidrome is gone. It does not build the replacement's missing features.

## Done looks like

1. A backup of the live Musimo database exists outside the container, and that backup has been opened on a pre-upgrade checkout in a scratch directory.
2. The live app on http://127.0.0.1:8765 is running this branch. Home, one album, one artist, and Tracks open. The song count on screen matches `count(*)` of `library_files` for the enabled roots.
3. One known file seeks. You listened through one track boundary (an album or a DJ mix) and wrote whether the join was silent. Cover Chrome if that is what is installed. Add Firefox, Safari, a hidden tab, or a phone only when that browser is actually available. Do not claim a browser you did not hear.
4. docs/player.md records that listen, including a gap or an iOS tap if that is what happened. CHANGELOG.md names the backup path next to the existing schema 6 warning. todo/music-player/TODO.md checks off the live-install line with the date and what was actually played.
5. You report the backup path, the track count, what you heard, and anything that failed. Then you stop.

## Read first

- docs/navidrome-gap-plan.md (Phase 0 only)
- docs/player.md (ids, queue, the sentence that the suite cannot hear the join)
- docs/testing.md and docs/setup-handoff.md (live port 8765 versus the isolated stack on 18765)
- docs/release-handoff.md (do not touch the real music folders)
- CHANGELOG.md Unreleased entry for the version 6 upgrade
- The live-install checkbox in todo/music-player/TODO.md

## How to do it

Work in this order. Stop at the first step you cannot finish safely.

1. See what is running. `docker compose ps`, the volume name (expected `musimo_musimo-data`, confirm it), and http://127.0.0.1:8765/api/health. The isolated stack on 18765 is not this check. The synthetic 50,000-file scan is not this check. Use the library that is actually mounted. docs/research.md mentioned Navidrome 0.63.2 with 2,738 tracks; docs/measurements.md mentioned 3,681 files. Quote the count you measure.

2. Back up before any rebuild. Copy the live `musimo.db` (and the Navidrome database too, if you can find it without starting Navidrome) to a folder outside both containers and outside the music folders. Record the path. Never `docker compose down -v`. Never delete or overwrite the music library.

3. Prove the backup. Open it with a checkout from before the version 6 upgrade, in a scratch directory, and show that it opens. State the user_version you read. If you cannot prove the backup, stop. Do not rebuild.

4. Rebuild the live install onto this branch only after the backup opens. Schema 6 is one-way: an older build will refuse the upgraded database. Do not add fixture files to the live music folder. Fixtures stay on the isolated stack.

5. Play it. Open Home, an album, an artist, and Tracks. Compare the count with SQL. Seek a file you already know. Confirm a second range on `GET /api/player/stream/{id}` is refused, and a symlink is refused, using the tests or a request against the live app. Do not invent a symlink inside the real library.

6. Listen. Pick one album or one DJ mix and play across a track change. The tests in frontend/src/features/player/handover.ts only check which audio element starts. This step is whether the join is silent. Write the browser, whether the tab was visible, and what you heard. If you cannot hear audio from this environment, say so and leave the listen for the user. Do not "fix" gapless in this session.

7. Write the notes from steps 2 and 6 into CHANGELOG.md, docs/player.md, and the live-install checkbox. Do not commit unless asked.

## Do not

- Do not implement the Navidrome importer, a codec column, smart lists, scrobbling, SQL browse, move repair, or lyric sidecars. Those are later sessions in docs/navidrome-gap-plan.md.
- Do not change song ids, album identity, the empty-root prune guard, the stream route, or the art route.
- Do not put Navidrome back into Compose, the image, or readiness.
- Do not edit unrelated dirty files (downloads, source status, errors, worker). Leave them as you found them.
- Do not commit, push, or open a pull request.
- Do not run `docker compose down -v`, and do not point a test container at the live volume.

## If you get stuck

Stop and report the step, what you saw, and the safest next action. A failed backup, a database that will not open, or a player that will not start is a stop, not a reason to widen the task.
```
