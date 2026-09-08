# Visualizer preview

A local preview for the first song journey: Ben Böhmer, “Dive (Extended Mix)”, from Dive EP. The musical map and visual treatment are awaiting Colin's review.

```sh
npm ci --prefix visualizer
npm run prepare:dive --prefix visualizer
npm run dev --prefix visualizer
```

Open `http://127.0.0.1:5180`. The preparation command reads the selected recording from Musimo on port 8765, checks its SHA-256 against the prepared analysis, and keeps the audio in the ignored `public/local/` folder. Playback works locally after that copy. It neither changes the library nor uses Musimo's audio element. A missing recording leaves **Open your song** available.

The preview provides play, pause, seek, repeat from the start, volume, full screen and 1080p/720p/540p rendering. The song map jumps to provisional section starts. **Record clip** captures up to 20 seconds of the rendered canvas and native audio playback; the clip can be played or saved below the viewer. A pause or renderer replacement finishes the capture early. It requires a browser with media-element capture and WebM recording support. Choosing another recording switches to a preset audition and drops Dive's score.

## Song preparation

The local command uses FFmpeg and ffprobe already installed on the machine. It measures RMS level, spectral centroid, flatness and flux in 2,048-sample windows at 44.1 kHz. It does not claim to detect instruments, beats or musical recurrence.

Paths passed through `npm --prefix` are relative to `visualizer/`:

```sh
npm run analyze --prefix visualizer -- --input public/local/dive.opus --output songs/dive-new.analysis.json --title "Dive (Extended Mix)" --artist "Ben Böhmer" --recording-id lM32EZpWF7jIOn7k9bWKWR --media-url /local/dive.opus
```

The command refuses to overwrite existing output. The separate [song score](songs/dive-extended-mix.song.json) holds editable cue times, motif names, transition lengths, intensity and variation. Re-running analysis cannot replace those choices. `reviewed: false` means the map still needs a listening and visual review. The recording hash and duration identify this exact library copy; another edit needs new analysis.

## Engine boundary

`@musimo/visualizer` exports the engine from `src/engine.ts`. A bundler such as Vite can import the package locally. The owner supplies a canvas, stereo PCM at 44.1 kHz, dimensions and optional song score. The engine receives media times; the owner retains its audio element and transport. The independent Vite build includes the pinned renderer asset and notices.

Rendering advances at 60 fixed media steps per second, regardless of display refresh. The first implementation uses Butterchurn 3.0.0-beta.5 and presets 2.4.7 as an experiment. The renderer's global state lives in a separate browser realm per instance. The authored Dive study uses related forms within one preset program, so section changes need no shader compilation.

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
node visualizer/tests/preview.browser.mjs
```

This checks short replay hashes, pause, restart, forward/backward reconstruction, transition state, cancellation and renderer isolation. It writes captures and results under ignored `visualizer/test-results/`. It does not compare every frame of the complete song or establish cross-GPU identity.

The preview check also needs `npm run build --prefix visualizer` first. It checks duplicate recording starts, capture cleanup during renderer replacement, and loading the bundled renderer from the production build. Its temporary local server closes when the check finishes.

Upstream preset authors and MIT notices are preserved in [the distributed notice](public/THIRD_PARTY_NOTICES.txt).
