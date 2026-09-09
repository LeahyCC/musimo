# Visualizer preview

A local preview for the first song journey: Ben Böhmer, “Dive (Extended Mix)”, from Dive EP. The musical map and visual treatment are awaiting Colin's review.

```sh
npm ci --prefix visualizer
npm run prepare:dive --prefix visualizer
npm run dev --prefix visualizer
```

Open `http://127.0.0.1:5180`. The preparation command reads the selected recording from Musimo on port 8765, checks its SHA-256 against the prepared analysis, and keeps the audio in the ignored `public/local/` folder. Playback works locally after that copy. It neither changes the library nor uses Musimo's audio element. A missing recording leaves **Open your song** available.

The preview provides play, pause, seek, repeat from the start, volume, full screen and 1080p/720p/540p rendering. The song map jumps to provisional section starts. **Record clip** captures up to 20 seconds of the rendered canvas and native audio playback; the clip can be played or saved below the viewer. A pause or renderer replacement finishes the capture early. It requires a browser with media-element capture and WebM recording support. Choosing another recording switches to a preset audition and drops Dive's score.

The **Customize** section tunes the current study live: a theme palette (Abyss, Ember, Ultraviolet, Mono), liquid clock speed, feedback persistence and onset response, plus a seed re-roll. Every one of those is a uniform, so a slider moves the picture while you drag it and nothing is rebuilt. Only a seed re-roll still needs a rebuild, because the seed generates the noise textures at load. Choices persist in `localStorage` under `musimo.studio.visual`, and the defaults reproduce the authored visuals exactly (Abyss, 1× motion, centred trails, 1× sensitivity, the journey score's seed).

## The native renderer

Every study is a manifest of WebGL2 passes, compiled onto the owner's canvas directly by `visualizer/src/study-renderer.ts`. There is no separate realm and nothing is compiled from preset text: RGBA16F ping-pong buffers carry feedback, and the studio's options and each study's own settings reach the shaders as live uniforms rather than baked constants.

Five studies exist today.

- **Dive journey**: the song's own study. Sherwin Maxawow's liquid, ported per pixel: a persistent RGBA16F feedback pass carrying three drifting vortices and the preset's warp sinusoids, its inner border painted into the same buffer, then a display pass that lights the surface from its own gradient and grades it with the score. The journey reaches the shaders as `q21` to `q30`, so cue transitions stay visible events inside one program. No settings; the Customize panel is the whole of its live control.
- **Native tunnel**: one persistent feedback pass zooming and rotating into itself, tinted and glowed on the way out.
- **Kaleidoscope V3**: a kaleidoscopic IFS evaluated per pixel, twelve generations of fold, rotate, scale and offset, coloured from orbit traps and the generation the orbit runs away at, seen through a log-polar tunnel around one central void. That void is a stack of up to four centres; a slow breath spreads them onto a ring and draws them back, so one void opens into several and closes again. Nothing grows in a feedback loop, so detail stays crisp at every scale. Settings: folds, voids, spread, depth, spin, glow.
- **Julia spiral**: an escape-time Julia set in hard posterised bands, falling into its own repelling fixed point. The set is invariant under that point's multiplier, so zooming in by it lands on the same picture and the dive never ends or runs out of float precision; the multiplier's argument is what winds the arms into a spiral. Settings: zoom, spiral, bands.
- **Liquid contours**: a scalar field carried by a divergence-free curl-noise flow and drawn as iso-contour lines with relief lighting. Settings: lines, flow.

The manifest format, the uniforms and samplers every pass gets, the per-frame hook, live settings and the determinism rules are in [the renderer note](../docs/visualizer-renderer.md), which also covers adding a study. Band levels come from `src/audio-levels.ts`, a port of Butterchurn's FFT and `AudioLevels` that is pure, DOM-free and unit tested.

The engine contract is fixed: 60 media steps per second, a seek rebuilding up to 120 frames from the seed, and `costs`, `loadMs`, `warmMs` and `reconstructionMs` reporting. The Customize sliders take effect while you drag them, with no "Preparing visual" rebuild; re-rolling the seed still rebuilds, because the seed generates the noise textures at load.

## This study

Under Customize sits a second panel holding the controls a study declares for itself. It is generated from the loaded manifest's `settings`, one slider each with its label and current value, plus a Reset that returns the study to its authored values. Studies without settings, which is every Butterchurn study, hide the panel entirely.

A setting is a uniform, so a change applies mid-drag with no rebuild. It is also an input to the deterministic frame: the frame hook reads the settings, so the studio hands the stored values to the engine before the seek reconstruction rather than after, and a seek with the same settings reproduces the same frame. Values persist per study in `localStorage` under `musimo.studio.study.<id>` and are clamped to the manifest's own bounds on the way back in, so a stale stored value cannot reach a shader.

## Song preparation

The local command uses FFmpeg and ffprobe already installed on the machine. It measures RMS level, spectral centroid, flatness and flux in 2,048-sample windows at 44.1 kHz. It does not claim to detect instruments, beats or musical recurrence.

Paths passed through `npm --prefix` are relative to `visualizer/`:

```sh
npm run analyze --prefix visualizer -- --input public/local/dive.opus --output songs/dive-new.analysis.json --title "Dive (Extended Mix)" --artist "Ben Böhmer" --recording-id lM32EZpWF7jIOn7k9bWKWR --media-url /local/dive.opus
```

The command refuses to overwrite existing output. The separate [song score](songs/dive-extended-mix.song.json) holds editable cue times, motif names, transition lengths, intensity and variation. Re-running analysis cannot replace those choices. `reviewed: false` means the map still needs a listening and visual review. The recording hash and duration identify this exact library copy; another edit needs new analysis.

## Engine boundary

`@musimo/visualizer` exports the engine from `src/engine.ts`. A bundler such as Vite can import the package locally. The owner supplies a canvas, stereo PCM at 44.1 kHz, dimensions and optional song score. The engine receives media times; the owner retains its audio element and transport. The independent Vite build includes the pinned renderer asset and notices.

Rendering advances at 60 fixed media steps per second, regardless of display refresh. Dive runs on the native renderer: two WebGL2 passes on the owner's canvas, no separate realm, and nothing compiled from preset text. The score and the studio options arrive as uniforms rather than baked constants, so a section change and a slider drag both cost one uniform write and no shader compilation. Cue transitions are visible events inside that one program: the score's `transition` window drives a transition-activity signal (q30, peaking mid-window), which fires a threshold-noise dissolve, where the outgoing look shatters into scattered fragments that settle into the incoming tint, and a zoom-through burst that dives into the frame and decelerates as the new motif settles. A cue with `transition: 0` fires no event. Both effects are display-path only and exact functions of media time, so seeks and pause behave as before.

Pause holds the image. A seek rebuilds bounded feedback history from the seed at the destination, then the preview dissolves into it. This preserves the score's state and returning motifs; it does not restore historical pixels. Hidden-tab recovery uses the same policy. Repeat from zero uses the same seed and prepared input. Determinism and timing evidence belong in the [build record](../docs/visualizer-build.md), including the machine and limits of each check.

Musimo integration is still pending. Its shared library/Deezer/iTunes audio element must remain player-owned. The first adapter should use prepared data and media time, as described in [the handoff](../docs/visualizer-build-handoff.md).

## Checks

```sh
npm run build --prefix visualizer
npm test --prefix visualizer
```

The tests use generated audio and local analysis. They do not fetch a recording. CI builds and tests this package alongside the existing frontend checks. Browser evidence, artistic review and actual audible playback remain separate checks.

For the optional real-recording replay check, prepare Dive, keep the preview running on port 5180, and install the existing frontend browser-test dependencies and Chromium:

```sh
npm ci --prefix frontend
npx --prefix frontend playwright install chromium
node visualizer/tests/replay.browser.mjs
node visualizer/tests/native.browser.mjs
node visualizer/tests/preview.browser.mjs
```

`replay` is the Dive journey's acceptance check and `native` asks the same questions of every other native study in turn, plus live option and setting updates and the part a setting plays in rebuilding history. Set `PREVIEW_URL` when the preview is not on 5180, for example `PREVIEW_URL=http://127.0.0.1:5181` for a worktree running its own server. `tests/soak.browser.mjs` reads the same variable, and takes a study, a seek time, a soak length and an output name.

This checks short replay hashes, pause, restart, forward/backward reconstruction, transition state, cancellation and renderer isolation. It writes captures and results under ignored `visualizer/test-results/`. It does not compare every frame of the complete song or establish cross-GPU identity.

The preview check also needs `npm run build --prefix visualizer` first. It checks duplicate recording starts, capture cleanup during renderer replacement, and loading the bundled renderer from the production build. Its temporary local server closes when the check finishes.

Upstream preset authors and MIT notices are preserved in [the distributed notice](public/THIRD_PARTY_NOTICES.txt).
