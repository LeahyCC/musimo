# Handoff: song personality, any word or phrase

Written 20 October 2026. Paste everything below the line into a new session in `H:\Git\musimo` (Windows, PowerShell + Docker Desktop, RTX 5080).

---

Build the next stage of Musimo's song analysis: a measured "personality" for every song, so Octive (the music bot) can answer any descriptive word or phrase ("dark", "euphoric", "sad piano", "aggressive but slow", "sunny road trip", "sounds like a rave at 4am"), not only tempo. Open a PR at the end and STOP. Do not merge, do not deploy to the live container, do not switch anything on in the live app, do not scan the live library. Colin reviews first. Stop means stop: no early commits to main, no early PR.

## Read first

- `docs/audio-profile-spec.md`: the contract. Especially "Embedding recipe", "How the bot ranks" (one rank key, never blended; gates are hard), "Listen gate", "Licences", and the `tempo-beat-v1` sections.
- `docs/analyzer-bakeoff.md` and `experiments/analyzer-bakeoff/`: how a candidate was measured last time (fresh sample, Deezer reference, GPU image, resource table). Copy that method.
- `docs/genre-label-review.md`, `docs/genre-trial-review.md`, `docs/audio-analysis-trial.md`: the October CLAP trial. CLAP failed as a genre labeller; that does not decide neighbour or phrase quality. The held-out genre labels stay sealed and are not a tuning set.
- `backend/core/audio_recipes.py` (`registered`, `TextEncoder`, `text_aligned`), `backend/library/audio_profile.py` (vector rows, `ProfileSet.cosine`), `backend/library/music_bot.py` (`SearchPlan.sound`, `negation_only`, `system_prompt`, `AudioGates`), `worker/` (`beat.Dockerfile`, `audio_worker/pipeline.py`: several decoders feeding one model, CPU or CUDA chosen at start).
- The Song analysis page: `frontend/src/features/analysis/`, routes in `backend/api/audio_analysis_api.py`.
- Colin's global rules in `CLAUDE.md` (short replies, no em dashes, no AI fingerprints in commits or PRs, commit as Colin).

## What is known (late October 2026)

- `tempo-beat-v1` (Beat This! on the GPU) is merged. Tempo is on for Octive; **energy is off**. Energy is RMS loudness of the loudest measured window, and loudness does not separate intensity in a library that is mostly loud electronic music: on 393 songs most Bliss tracks (psytrance, "wildly high energy") came out medium, whether measured on snippets or the whole song. So "energy" needs a real perceived-intensity measure, and this work should supply one.
- The spec already has an unnamed embedding recipe slot: one L2-normalised float32 vector per song, `text_aligned` when a phrase can be encoded into the same space, cosine ranking, the seed and copies removed, artist cap of two. Negation-only phrases are dropped. A recipe is named only when four things exist: a checkpoint, a licence Musimo may ship, a written sampling recipe, and a passed 100-song listen.
- `laion/clap-htsat-unfused` at revision `8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a` (Apache-2.0) fitted 2 GB on CPU (peak 1.41 GB) and is the standing candidate. Newer text-audio models may be better; check what exists now and its licence.
- Out: Essentia and its models (AGPL / CC BY-NC-SA), AudioMuse-AI code, ONNX exports and DCLAP weights (AGPL; behaviour only). Genre stays with the file tags.
- Library: 50,510 files, mostly electronic (trance, dance, electro, dubstep), plus rap, rock, pop and R&B. 1,711 files under 60 s are skipped, podcasts are skipped.
- Hardware: RTX 5080 (CUDA 12.8, torch 2.7.1 cu128), Docker with `--gpus all`, 24 threads, about 15 GB RAM to Docker. Colin allows up to 10 GB for analysis.
- Trial stack for real-library testing: `runtime/tempo-trial/compose.yaml`, project `musimo-tempo-trial`, env file `runtime/tempo-trial/.env`. It holds a SQLite-backup copy of the live DB, music read-only, internal network with no internet (the copy holds queued downloads that must never start), and a loopback-only proxy at http://127.0.0.1:18766. Re-copy the DB with the SQLite backup API (read-only on the source) if fresher data is needed. Prove egress is still blocked after any change.

## Goal

Every song gets a vector in a space that text also lives in, so Octive can rank songs by any phrase, and "more like this" ranks by sound. Plus a perceived-intensity number that can replace RMS for "energy", "calm", "intense", "chill", "hard".

## Build

1. **Bake-off first, no production code.** Compare at least CLAP (`8fa0f1c`) and one or two current permissively licensed text-audio models, on the GPU, with the bake-off's method: a fixed seeded sample of about 300 songs across the main tags, windows that cover the whole song (not three 10 s snippets: a 10:42 track's loud part at 3:30 was missed last time), and recorded resources (image size, model load, per-song time, GPU and process memory, full-library estimate). For each model, run a phrase set Colin can judge: moods (happy, sad, dark, euphoric, aggressive, chill, romantic, angry, dreamy), intensity (calm, intense, hard-hitting, mellow), instruments and vocals (piano, guitar, female vocals, no vocals, instrumental), scenes (workout, study, rave, road trip, rainy night), and a few long phrases. Produce top-20 lists per phrase per model, and 20 "more like this" neighbour lists. Put the results somewhere Colin can listen to quickly (the Song analysis page pattern: play the measured section). Write it up in `docs/` like `analyzer-bakeoff.md`.
2. **Perceived intensity.** Test candidates against Colin's examples (Bliss tracks are high; check the songs he flagged: Andrelamusia, Warriors (Guitar Mix), Look Out VIP, Alliance VIP): the embedding's own "intense vs calm" phrase score, onset density or percussive strength, spectral flux, combinations. Bands stay library percentiles. Recommend one.
3. **Spec before code.** Update `docs/audio-profile-spec.md`: name the recipe (new id; any rule change is a new id), the sampling recipe, the vector length, text alignment, how phrases are scored (one rank key; how a phrase combines with tag gates and tempo gates; negations; a phrase the space cannot read), how intensity replaces RMS energy and under which setting, the listen gate for this recipe, licences. Commit the spec before code.
4. **Worker.** A new recipe in the existing worker pattern (parallel decoders, one model, CPU or CUDA at start, Compose profiles, lease contract, read-only music, never opens the DB). The checkpoint is fetched at image build and checked against a SHA-256. The text encoder runs in the app for queries; measure its load time, memory and warm query time (the spec's budget is 500 ms warm, Ollama apart), or justify running it elsewhere.
5. **Backend and Octive.** Register the recipe and its text encoder. Let the prompt fill `sound` with the descriptive part of a request and keep genres, artists, years, tempo in their own fields. Keep every existing rule: hard gates, one rank key, seeded draw, artist cap, shortfall reported, coverage sentence. Turning it on and off is the existing `audio_embedding_recipe` setting; turning off keeps rows.
6. **Page.** Extend the Song analysis page: measure, progress, a phrase box that shows the top songs for any phrase with play buttons, the neighbour check, and the switch. Works at 390 px. Follow the app's UI patterns.
7. **Tests.** Backend unit tests (a small registered test recipe and encoder), worker tests on generated audio, vitest, Playwright desktop and mobile with mocked routes. Run `scripts/check.sh full` before pushing.
8. **Real-library check on the trial stack only.** Measure a sample with the GPU worker, record resources, and leave the trial stack stopped with temp files removed.
9. **Docs.** Spec, architecture, settings, testing, guide, changelog.

## Deliver

- One PR, branch without AI fingerprints (e.g. `feature/song-personality`), description in the repo template, commits as Colin with no Co-Authored-By. Not merged.
- A short summary for Colin: which model and why, what to try on the page (with the URL on the copy), the measured numbers, and an open-items list.
