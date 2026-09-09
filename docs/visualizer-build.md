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

## Native renderer, 9 September 2026

A second renderer now sits beside Butterchurn. `visualizer/src/study-renderer.ts` draws a study manifest with WebGL2 directly on the owner's canvas, with no iframe realm and no JavaScript compiled from preset text. Every entry in `studies` carries a `renderer` field and `load` branches on it; the Butterchurn studies are untouched. The first native study is `tunnel`, "Native tunnel". The manifest format, uniforms, samplers, frame hook and determinism rules are documented in [the renderer note](visualizer-renderer.md).

Checks that ran on this machine, against a worktree preview on port 5181 under headless Chromium with SwiftShader:

- `npm test --prefix visualizer`: 16 passing, including the new `audio-levels` tests.
- `node visualizer/tests/native.browser.mjs`: same-seed playback matched between one-frame and three-frame batching, a different seed changed the image, restart and paused frames held their hashes, the seeks at 30 and 10 seconds reproduced their destination in 120 reconstructed frames each, a 300-second jump asked for a reconstruction, live options and settings changed the picture without a rebuild, no iframe was created, `Math.random` and the window's global names were unchanged, and the browser reported no errors. RGBA16F buffers were available. Results in ignored `visualizer/test-results/native-results.json`.
- `node visualizer/tests/replay.browser.mjs`: passed. Its five hashes were then compared against the same check run with the previous `engine.ts` restored, and all five matched, so the Butterchurn output is byte-identical.
- The band-level port was compared against the pinned Butterchurn build's own `FFT`, `AudioProcessor` and `AudioLevels` classes over 1,500 synthetic frames. The worst absolute difference was 0.
- The studio page itself was driven in a headless browser: picking "Native tunnel" showed the "Native renderer" credit, created no iframe, kept the generic canvas label, and a motion-slider change moved the image on the same engine instance without the "Preparing visual" rebuild. Switching back to a Butterchurn study restored its own credit line.

These ran under software rendering on one machine. They do not establish cross-GPU identity, and they do not replace artistic review with sound.

## Band levels and onset, 9 September 2026

The native `onset` uniform now carries a real value: half-wave-rectified spectral flux of the equalized spectrum, graded between a slow baseline and a decaying recent peak, clamped and run through the same attack/release smoothing `JourneyController` uses for its own onset feature. The engine multiplies it by the sensitivity option before it reaches the shader. Formulae and rates are in [the renderer note](visualizer-renderer.md). The first version divided the flux by its own average, which reads 1 through any sustained sound; a probe with a steady broadband signal and a burst every two seconds showed 0.96 to 1.00 throughout with the bursts invisible, and reads 0.02 between bursts after the change.

`visualizer/tests/levels.browser.mjs` drives a Butterchurn `sherwin` engine and a native `tunnel` engine on the same Dive PCM, both from `startAt(0)`, and compares their band levels frame by frame for the first 20 seconds (after the first 50 frames, once both analysers are past the fast/slow long-average switch). The worst relative difference across `bass`, `mid`, `treb` and their attack-smoothed companions was 0: the native port is bit-identical to Butterchurn's own analyser on real audio, not only on the earlier synthetic frames. Results in ignored `visualizer/test-results/levels-results.json`.

Unit tests in `visualizer/tests/audio-levels.test.ts` cover the onset feature directly: silence holds it at exactly 0, and a 2 Hz click train produces a clear peak at each click that settles to a low value before the next one, always inside 0..1.

## Native studies and per-study settings, 9 September 2026

Kaleidoscope V3 moved off Butterchurn onto the native renderer, and two cheaper studies joined it: Julia spiral and Liquid contours. The Butterchurn "Kaleidoscope V3" entry and its import are gone from `engine.ts`; `kaleidoscope-v3-preset.ts` itself stays until the card that removes Butterchurn. The three studies are described in [the package README](../visualizer/README.md) and the manifest, settings and study-writing steps in [the renderer note](visualizer-renderer.md).

The V3 GLSL had never been compiled or viewed, and two things in it did not survive contact with a screen. Its log-polar depth coefficient of 0.3 put barely half a tunnel ring in frame, which read as a flat field rather than a dive; it is 1.1 now. Its IFS scale drifted between 1.65 and 2.15, and below about 1.9 the whole tile falls under a pixel, so the mandala turned to grey noise for stretches of a minute or more; the drift now sits between 2.3 and 2.6. The orbit traps alone also saturate across most of the tile, so the colour now leans on the generation the orbit runs away at, which is what makes the shells read as nested.

The Julia study aims at Colin's reference gif, a hard-banded deep zoom with black cores and spiral arms. It dives into the set's own repelling fixed point β = 1 − μ/2, where the set is invariant under multiplication by λ = 2 − μ. Zooming by |λ| and turning by arg(λ) therefore lands on the same picture, so two levels a whole step apart cross-fade without a seam, the dive never ends, and no float ever runs out of precision. arg(λ) is where the spiral arms come from. c is parameterised by μ rather than directly, which keeps it near the main cardioid where the set has the interior the reference draws black.

The studio page grew a "This study" panel below Customize, generated from the loaded manifest's `settings`. It is hidden for studies that declare none, which is every Butterchurn study.

Checks that ran on this machine, against a worktree preview on port 5183 under headless Chromium with SwiftShader:

- `npm run build --prefix visualizer` and `npm test --prefix visualizer`: 19 passing.
- `node visualizer/tests/native.browser.mjs` now runs its full set for `tunnel`, `kaleidoscope3`, `julia` and `contours`. All four: same-seed playback matched between one-frame and three-frame batching, a different seed changed the image, restart and paused frames held their hashes, the seeks at 30 and 10 seconds reproduced their destination in 120 reconstructed frames each, a 300-second jump asked for a reconstruction, live options and settings changed the picture without a rebuild, no iframe was created, and the host realm was untouched. Each study also ran its seeks with one setting moved off its default and the same seek at the default gave a different picture, so a setting really does take part in rebuilding history. RGBA16F buffers were available throughout. Reconstruction cost 0.5 s for tunnel, julia and contours and 1.1 s for kaleidoscope3 at 640 pixels wide under software rendering. Results in ignored `visualizer/test-results/native-results.json`.
- `node visualizer/tests/soak.browser.mjs kaleidoscope3 30 110 soak-kaleidoscope3` at 1080p: the mandala at 140 seconds shows nested self-similar rosettes receding into two tunnel centres, not a blur and not a flat field. The study was also probed at 40, 70, 100 and 140 seconds while the IFS scale floor was being set, because it can look right at one moment and be noise a minute later.
- The studio page was driven in a headless browser for the settings panel: it is hidden for Dive and Sherwin, shows four labelled sliders for Kaleidoscope V3 and three for Julia spiral, a drag moved the engine's value and the label with no "Preparing visual" rebuild, the value was written to `musimo.studio.study.kaleidoscope3` and came back into both the engine and the slider after a reload, and Reset returned the study to its authored values. The browser reported no errors.

These ran under software rendering on one machine. They do not establish cross-GPU identity, and they do not replace artistic review with sound.

## Dive on the native renderer, 9 September 2026

The Dive journey moved off Butterchurn. `visualizer/src/studies/dive.ts` is a two-pass native study: a persistent RGBA16F liquid pass carrying Sherwin Maxawow's warp body, its three vortices and its inner border, and a screen pass carrying its comp body with the journey grade, zoom-through and noise dissolve. The `dive` entry in `studies` is `renderer: 'native'` and the engine's Butterchurn `runFrameEquations` override is gone; the score reaches the shaders as `q21` to `q30` returned by the study's own frame hook. The mapping and what moved where are in [the renderer note](visualizer-renderer.md). `journey-preset.ts` is no longer imported but stays on disk with `kaleidoscope-v3-preset.ts` until the card that removes Butterchurn. The raw `sherwin` and `witchcraft` presets are still selectable, so the pinned renderer asset now loads only when one of them is chosen.

Butterchurn computed the warp source coordinate once per vertex on a 48 by 36 mesh; the study evaluates the same arithmetic per pixel. That was checked numerically rather than by eye: at 110 seconds the study's formula, evaluated in JavaScript at all 49 by 37 mesh points, differed from the running Butterchurn renderer's own `warpUVs` by at most 0.00025 in uv, about a quarter of a pixel at 1080p. The same comparison against a vertically flipped variant differed by 1.0, so the orientation is settled too.

Checks that ran on this machine, against a worktree preview on port 5187 under headless Chromium with SwiftShader:

- `npm run build --prefix visualizer` and `npm test --prefix visualizer`: 19 passing.
- `node visualizer/tests/replay.browser.mjs`, the acceptance check, now on the native Dive. Same-seed playback matched between one-frame and three-frame batching, a different seed changed the image, restart and the paused frame held their hashes, the seek to 222 seconds then 164 then 222 reproduced the destination hash with its transition state (bloom 0.844, transition activity 0.527), each seek rebuilt 120 frames, a 300-second jump asked for a reconstruction, a moving landing arrived at 166.25 seconds, a cancelled load aborted, no iframe was created, `Math.random` and the window's global names were unchanged, and the browser reported no errors. Reconstruction cost about 1.0 s at 640 pixels wide under software rendering. Results in ignored `visualizer/test-results/replay-results.json`.
- Its pixel hashes now come from `engine.readPixels()` rather than a 2D context, because the native path draws to the default framebuffer. To keep the cancelled-load question meaningful, `load` yields once before a native study takes the canvas, so an owner that disposes in the same turn still wins; without that a synchronous native load could spend the canvas's one WebGL context on a load nobody was waiting for.
- `node visualizer/tests/native.browser.mjs`: `tunnel`, `kaleidoscope3`, `julia` and `contours` unchanged and passing. Dive is not in that list because its settings assertion needs a study that declares settings, and Dive declares none; the replay check covers it instead.
- `node visualizer/tests/preview.browser.mjs`: passing. Its production assertion changed with the default study: the first frame now creates no realm, so the check picks `sherwin`, waits for the credit line to name Butterchurn, and then asserts one realm and the served `assets/butterchurn.min-*.js`.
- The studio page was driven in a headless browser: Dive showed "Visual: Based on Flexi, martin + geiss's Sherwin Maxawow · Native renderer", created no iframe, kept the "This study" panel hidden (Dive declares no settings), reported RGBA16F buffers, and a theme change to Ember plus a motion drag to 2× moved the image on the same engine instance with no "Preparing visual" rebuild. The browser reported no errors.

The visual comparison is against a fresh Butterchurn capture, not the [8 September surface capture](assets/visualizer-build/journey-developed-110s.png), which predates the theme tints and the current replacements and no longer shows what the Butterchurn Dive draws. `node tests/soak.browser.mjs dive 110 40` was run with the previous `engine.ts` restored and again with the new one, giving [the Butterchurn frame](assets/visualizer-build/journey-butterchurn-110s.png) and [the native frame](assets/visualizer-build/journey-native-110s.png). Side by side they are the same liquid: the same magenta and violet, the same brightness and vignette, the same fine relief striations combed along the flow, the same border ring smeared inward at the edges. The large forms are arranged differently, which is what a feedback loop does with a source coordinate that is a quarter of a pixel apart and then compounded over 2,400 frames. The quiet passage at 164 seconds and the return at 222 seconds were captured the same way on both paths and read the same: the deep violet crest and dark relief masses at 164, the magenta bloom with olive and gold speckle at 222.

These ran under software rendering on one machine. They do not establish cross-GPU identity, and they do not replace artistic review with sound. Colin has not yet seen the native Dive.

## Butterchurn removed, 9 September 2026

Butterchurn and its presets are gone. `visualizer/src/renderer-sandbox.ts`, `vendor.d.ts`, `effects-presets.ts`, `kaleidoscope-v2-preset.ts`, `kaleidoscope-v3-preset.ts` and `journey-preset.ts` are deleted, the `butterchurn` and `butterchurn-presets` dependencies are gone from `package.json`, and `engine.ts` no longer has a renderer switch: every entry in `studies` is native. The studio page's picker and Customize panel dropped the Butterchurn-only studies (Phosphor Memory, Kaleidoscope Tides, Kaleidoscope V2, Prism Fracture, Witchcraft Reloaded, Sherwin Maxawow); opening a local recording now falls back to Native tunnel instead of Sherwin Maxawow. `THIRD_PARTY_NOTICES.txt` keeps only the Sherwin Maxawow attribution and its MIT text, because Dive's GLSL still carries that lineage.

`npm ci --prefix visualizer` and `npm audit --prefix visualizer --audit-level=high` pass against the regenerated lock file. `npm run build --prefix visualizer` and `npm test --prefix visualizer` pass. The browser checks (`replay.browser.mjs`, `native.browser.mjs`, `preview.browser.mjs`) were already native-only except `preview.browser.mjs`'s production assertion, which no longer looks for a bundled Butterchurn asset and now expects zero iframes throughout.

## Kaleidoscope V3 void, 9 September 2026

Colin's reference for this study is a mandala around a single central void, so the log-polar tunnel no longer uses the Möbius map and its two singular points. The tunnel centre is a stack of up to four centres on the same point; a slow breath (about 48 seconds at 1× motion, leaned on by bass) spreads them onto a ring and draws them back, so one void opens into several and closes again. Depth is the mean of the log distances to the centres and the angle their sum, which keeps the merged void's ring density as it splits and puts the angle's branch cuts on the mirrored tile's own seams. `voids` and `spread` are settings beside the existing four. Checked with the native determinism set and captures at 20, 110 and 180 seconds.

## Still open

- Colin's review of the complete authored journey and provisional musical map.
- A small Musimo adapter after the independent journey is convincing, followed by the full playback integration checks.
- Exact feedback checkpoints, ordinary-device measurements and non-Chromium verification.
- Colin's eye on the three native studies, in particular whether Kaleidoscope V3's grainy field between the jewels wants softening and whether Julia spiral should carry more of the reference's colour.

Run instructions and analysis commands are in [the package README](../visualizer/README.md). The [build handoff](visualizer-build-handoff.md) remains the governing brief.
