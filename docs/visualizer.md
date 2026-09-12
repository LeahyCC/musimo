# Now Playing visualizer

A WebGPU visualizer for the Now Playing stage, built in small steps. This note records what each step added and what was checked by hand, in the style of [the popout note](now-playing-popout.md). Where WebGPU is unavailable the stage shows artwork exactly as before.

## Audio graph

Library playback feeds one Web Audio `AudioContext` and one `AnalyserNode` (`fftSize` 2048, no smoothing; the feature extractor smooths per band). The graph lives in `frontend/src/visualizer/audio/AudioGraph.ts`, a module singleton that survives any remount, and the player loads it on demand from the library element's first `play` event.

Two rules keep playback safe:

- Only the library element is ever attached. Catalog previews stream straight from the provider's CDN with no CORS headers; a `MediaElementSource` on such media is silenced by the browser, and a source can only be created once per element, so the damage would be permanent. This is why `player.tsx` has one element for previews and one for library tracks.
- The source is attached only once the context is running. A context made outside a user gesture starts suspended, and a source on a suspended context is silent. Building it from a `play` event that was itself allowed to start, and checking `state === 'running'` after `resume()`, means the track keeps playing on its own if the browser refuses. The next play tries again, and the player also resumes the context when the tab becomes visible.

## Feature extraction

`frontend/src/visualizer/audio/FeatureExtractor.ts` turns each analyser frame (dB per bin from `getFloatFrequencyData`, plus the seconds since the last frame) into a 16-float packet. It is pure TypeScript with unit tests in `FeatureExtractor.test.ts`, and it runs in a worker (`features.worker.ts`, protocol in `features.protocol.ts`) so neither the renderer nor the analysis can stall the other. The spectrum buffer is transferred to the worker and handed back with each packet, so nothing is allocated per frame on the player thread.

What it computes, in order:

- dB to linear magnitude, then five log-spaced bands: sub 20 to 60 Hz, bass 60 to 250, lowMid 250 to 1k, highMid 1k to 4k, treble 4k to 16k. Each band is the mean magnitude of its bins, followed by an envelope with its own attack and release (sub 20 and 250 ms, treble 5 and 90 ms), then scaled by the loudest that band has been in the last few seconds so a quiet track fills the same 0 to 1 as a loud one.
- `energy`: RMS across 20 Hz to 16 kHz, smoothed and scaled the same way.
- `flux`: half-wave rectified spectral flux. The onset threshold is the mean plus 2.5 standard deviations over a 1.5 second window, measured before the current frame joins it. An onset is flux rising through that threshold, at most one per 80 ms. `onsetStrength` grades the hit against the loudest recent hit, since flux over its own mean is 1 on average and would hide hits in sustained music. `beatPulse` jumps to 1 on an onset and falls to 1/e in 180 ms.
- `tempo`: once a second, the autocorrelation of the last 8 seconds of flux over the lags that mean 60 to 200 BPM. It stays 0 until one lag clearly wins.

The packet layout lives at the top of the file; WGSL structs must match it exactly. Indices 0 to 3 are the first four bands, 4 to 7 treble, energy, flux and the threshold, 8 to 11 onset, strength, pulse and tempo, 12 and 13 time and the frame step. The renderer, not the extractor, fills nothing else in; 14 and 15 are reserved.

## Code

- `frontend/src/visualizer/audio/AudioGraph.ts`: the context, the analyser and the attach and resume rules above.
- `frontend/src/visualizer/audio/FeatureExtractor.ts`, `features.protocol.ts` and `features.worker.ts`: the feature packet and the worker that produces it.
- `frontend/src/player.tsx`: the two audio elements, the handlers they share (each ignores events from the element that is not current), and the visibility resume.

## Checks

The extractor is checked by unit tests with synthetic spectra: band collapse at both FFT sizes, envelope attack and release timing, every click in a click train detected with none between and the tempo found, jitter not read as onsets, and the worker protocol handing buffers back. Playwright cannot hear audio and headless engines stop it early, so the suite only proves the structure of playback: the preview checks in `e2e/app.spec.ts` drive the preview element, the phone player checks drive the library element, and the player shortcut checks still pass.

Checked by hand, each on a named machine and browser:

- The analyser reports non-zero frequency data during library playback.
- A catalog preview is still audible after a library track has played, and vice versa.
- Pausing the tab, switching tabs for a minute and coming back resumes the context.
