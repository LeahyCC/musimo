# Visualizer build record

8 September 2026. Independent preview at `http://127.0.0.1:5180`. Work remains on `feature/music-visualizer`; the earlier discovery changes have been preserved.

Colin selected Ben Böhmer's “Dive (Extended Mix)” from Dive EP. The selected library copy is 380.9275 seconds according to ffprobe, stereo at 48 kHz, with SHA-256 `6d93fe771f69c6c903fdc228b99966607f49725db8daafcd0f30470ec6194889`. The private audio copy stays in ignored `visualizer/public/local/dive.opus`. The repository contains the recording identity, numerical analysis and editable visual score.

## Implemented

The `visualizer/` package has its own pinned dependencies, build, development server and exported engine. Its preview owns a native audio element. A separate decode supplies stereo PCM at 44.1 kHz; no media-element audio source reroutes playback. The preview verifies the default recording's hash and duration before using its song data.

The initial audible audition used the two discovery presets, Witchcraft Reloaded and Sherwin Maxawow. Colin found their motion too jerky for Dive and asked for a more liquid treatment that follows the recording's soothing energy. The authored study now retains Sherwin's textured surface and lighting, with slower motion equations, continuous noise travel and softened band responses. Orbit, current and bloom share that material; cue weights, intensity and variation change its flow and colour without loading another shader.

The local analysis command records 8,203 feature windows: RMS level, spectral centroid, flatness and flux. The score marks a quieter passage around 2:34 and a return near 3:36, based on measured changes. Its cues remain provisional and `reviewed` remains false. The score does not claim those cues came from a verified musical-structure detector.

## Playback and restoration

The engine uses integer frames at 60 Hz and media-indexed PCM. A pause freezes both the score and feedback. A seek cancels outdated preparation and rebuilds up to 120 frames of seeded visual history. When music has advanced during preparation, one additional frame lands on its current time. The preview keeps music playing and dissolves into the replacement over 450 ms. Recovery from a hidden tab follows the same reconstruction path. Exact historical pixel restoration is not implemented.

The pinned beta changes global Math helpers and keeps a module-level random generator. Each engine loads its bundled renderer in a separate browser realm, including its generated equation functions. This keeps those changes out of the host application. Initial shader preparation completes before the preview offers playback; the authored forms share one program through their transitions.

## Verification

The independent package build and four PCM, analysis and journey regression tests passed. Its dependency audit found no vulnerabilities. Existing frontend lint, build and browser-test type checks passed. Backend lint, formatting, typing and all 45 tests passed, with 77.07% branch-inclusive coverage. These checks used the installed Windows Node 24.19.0 and Python 3.14 environment; the CI workflow uses Node 26.

The isolated Chromium replay check uses the real recording and final shader. Three seconds rendered individually and in three-frame batches produced identical pixel hashes. Restart reproduced that hash, pause held it, and a different seed changed it. Seeking to 222 seconds, back to 164, then to 222 again reproduced the same destination hash, including the transition's controller state. Clock jumps, a moving playback destination, cancelled preparation, renderer cleanup and unchanged host globals passed. This establishes the tested short runs and destination reconstructions, not a complete-song pixel comparison or cross-GPU determinism. The headless run used software rendering; its costs do not describe the desktop's GPU.

The actual playback clip contains 19.98 seconds of stereo Opus audio and 1920 × 1080 VP9 canvas output. FFmpeg measured non-silent audio at -15.1 dB mean level. The clip stays in ignored local test output because it includes the selected recording.

An uninterrupted 1× playback reached the native media element's ended state at 380.9275 seconds in the desktop's in-app Chromium browser, using 1920 × 1080 output and the final liquid shader. During later sections the rolling render-submission p95 was 1.7–1.8 ms, with sampled media/visual differences of 0.000–0.013 seconds. At the ended state the held last frame was 0.028 seconds behind. Preset preparation was 140.1 ms for this instance. Submission measurements exclude GPU completion and do not establish a whole-run 60 fps guarantee. The inspection tab's output volume was zero, while native audio capture retained the measured non-silent signal. No browser warnings or errors were reported. Full-song listening acceptance remains separate.

The [replay results](assets/visualizer-build/replay-results.json) and [developed surface capture](assets/visualizer-build/journey-developed-110s.png) preserve evidence from this version. The earlier discovery benchmark does not validate this implementation.

The preview controls restarted playback from zero, held playback on pause, reconstructed a paused seek into the return at 222 seconds, and reconstructed the quieter passage at 164 seconds. Playback then resumed at 720p with a sampled submission p95 of 1.6 ms and media/visual difference of 0.004 seconds. A final review found and corrected capture handling during renderer replacement, overlapping recording starts, and old PCM surviving failed preparation of a new recording. Repository formatting now passes after excluding private `.git` metadata from its scan.

Two successive captures also started and finished in the desktop browser, with sound playback continuing between them. A focused headless check passed the delayed double-start guard and automatic-rebuild capture cleanup. Its subsequent recording attempt timed out under software rendering, so that result is inconclusive and is not counted as a successful repeat-capture check.

The final bounded [preview regression](assets/visualizer-build/preview-results.json) passed duplicate-start protection and capture cleanup during a rebuild. It also served the production build on a temporary local port, loaded the bundled renderer asset successfully and prepared the first 1080p frame without browser errors. The temporary server was stopped. The visible development preview remains on port 5180.

## Still open

- Colin's review of the complete authored journey and provisional musical map.
- A small Musimo adapter after the independent journey is convincing, followed by the full playback integration checks.
- Exact feedback checkpoints, ordinary-device measurements and non-Chromium verification.

Run instructions and analysis commands are in [the package README](../visualizer/README.md). The [build handoff](visualizer-build-handoff.md) remains the governing brief.
