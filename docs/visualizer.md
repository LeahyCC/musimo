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
- `tempo`: once a second, the autocorrelation of the last 480 frames of flux (about 4 s at 120 Hz) over the lags that mean 60 to 200 BPM. The flux is first compressed with `log1p(3 × flux / mean)`, because a few big hits otherwise own the correlation and the beats between them do not register. Correlations are normalised by overlap, each lag is scored with half its double lag and a quarter of its quadruple added in, the score is weighted toward 120 BPM by a log-Gaussian 0.9 octaves wide, and when the half lag correlates at least 0.6 as well it wins; all of this because a bar correlates as well as a beat and a naive pick reads half-time. The reported value is the median of the last five readings. It stays 0 until one lag clearly wins.

The packet layout lives at the top of the file; WGSL structs must match it exactly. Indices 0 to 3 are the first four bands, 4 to 7 treble, energy, flux and the threshold, 8 to 11 onset, strength, pulse and tempo, 12 and 13 time and the frame step. The renderer, not the extractor, fills nothing else in; 14 and 15 are reserved.

## WebGPU

WebGPU only. Where it is missing, or the adapter or device cannot be had, the stage shows the artwork exactly as before and says so once (`musimo.now-playing-visualizer-notice`). There is no WebGL fallback and none is planned.

`frontend/src/visualizer/gpu/Device.ts` asks for a high-performance adapter and a device once, keeps them as a module singleton, logs `uncapturederror`, and clears the singleton when the browser reports the device lost so the next request starts fresh. An adapter whose info names SwiftShader or another software rasteriser is flagged, and the scene caps its particle count at 20,000 on it.

### Lifetime

The popout portals a fresh stage into the Picture-in-Picture document, so the stage subtree unmounts and remounts on every dock and popout transition. Nothing that is expensive or stateful may live in a component:

```
module singleton, survives remounts            per mount, made again each time
------------------------------------           -------------------------------
GPUDevice, feature uniform buffer              HTMLCanvasElement (scene + HUD)
pipelines, particle storage buffers            GPUCanvasContext, configure()
the feature worker and its client              ResizeObserver, visibility hook
frame clock, HUD history                       requestAnimationFrame handle
```

`gpu/Renderer.ts` is that singleton. A stage calls `attach(canvas, hudCanvas, onFailure)` on mount and `detach(canvas)` on unmount; `attach` configures the context, sizes the canvas to its CSS box times `devicePixelRatio`, and starts a loop on the canvas's own window, so a popout keeps drawing while the tab behind it is hidden and a hidden tab stops. On device loss the renderer drops the scene and buffers and tries once to come back on the same canvas; if that fails it calls `onFailure` and the stage falls back to artwork.

Each frame: read the analyser through the feature client (once the library element has played), stamp time and dt into the packet, upload it as one 64-byte uniform, run the scene's compute and render passes, then draw the HUD if it is on. React owns mounting, unmounting and the controls only; no per-frame state touches it. The canvas carries `data-adapter`, `data-frame-ms` and `data-particles` so a screenshot or a test can read them.

### Popout and full screen

The design above was checked, not assumed. Across six dock, popout, dock round trips in desktop Chrome the page created one device and one particle storage buffer, reported no `uncapturederror`, and configured exactly one more canvas context than it unconfigured at every point, so nothing leaks with repeated toggling and the field never restarts. The popout's canvas is the size of its window at that window's pixel ratio and draws on that window's own animation frames, so it keeps moving while the tab is hidden behind it. The `captureStream` fallback the plan sketched was not needed and is not built.

Full screen in the tab renders at device pixel ratio: a 1920 by 1080 CSS box at ratio 2 gets a 3840 by 2160 canvas.

### Particles

`scenes/Particles.ts` with `shaders/common.wgsl`, `particles.compute.wgsl` and `particles.render.wgsl` (imported with `?raw`). Particles live in one storage buffer of 32-byte records (position, life, velocity, seed). A compute pass moves each one through a curl-noise flow field (simplex noise by Ashima Arts and Stefan Gustavson, MIT), toward three attractors that circle the middle, and integrates with drag and a soft spring; dead particles respawn in a ball, staggered on the first frame. The render pass draws one instanced quad per particle with no vertex buffer, additively blended, sized and lit by speed. Each particle is dimmed by the expected number landing on a pixel (count times point area over canvas area), so a small docked stage and a 4K full screen come out the same brightness. The target of 0.65 light units per pixel, the brightness floor and the attractor spread were set by eye on real tracks at 4K; the first cut looked dim and sparse on anything quieter than a test signal.

Audio mapping: bass (the louder of sub and bass) to attractor strength; treble to noise frequency and jitter; `beatPulse` to a radial push and a size bump; energy to flow strength, speed and how many dead particles respawn. Colour runs cool to warm with bass.

The count is chosen from the stage's top bar (100k, 250k, 500k, 1M) and remembered as `musimo.visualizer-particles`. The default is 250,000.

### HUD

H toggles `hud/Hud.ts`, a 2D canvas over the scene: the five band envelopes and energy as bars, the flux trace against its threshold with onset marks, beat, tempo, frame time, particle count and the adapter. It ships in the build so a report from another machine can carry a screenshot.

## Code

- `frontend/src/visualizer/audio/AudioGraph.ts`: the context, the analyser and the attach and resume rules above.
- `frontend/src/visualizer/audio/FeatureExtractor.ts`, `features.protocol.ts` and `features.worker.ts`: the feature packet and the worker that produces it.
- `frontend/src/visualizer/gpu/Device.ts`, `gpu/Renderer.ts`, `gpu/math.ts`: the device singleton, the renderer and the camera maths.
- `frontend/src/visualizer/scenes/Particles.ts` and `shaders/*.wgsl`: the particle scene.
- `frontend/src/visualizer/hud/Hud.ts`, `Visualizer.tsx`: the debug overlay and the React shell the stage mounts.
- `frontend/src/player.tsx`: the two audio elements, the handlers they share (each ignores events from the element that is not current), and the visibility resume.

## Checks

Unit tests cover the pure parts: the feature extractor with synthetic spectra (band collapse at both FFT sizes, envelope attack and release timing, every click in a click train detected with none between and the tempo found, jitter not read as onsets), the worker protocol handing buffers back, and the camera maths.

Playwright can prove structure, not pixels: headless engines have no WebGPU adapter and a WebGPU canvas renders black in a screenshot. `e2e/visualizer.spec.ts` checks the artwork fallback and its one-time notice with `navigator.gpu` removed, and, only where the browser has an adapter, the default visualizer view, the V and H keys, the toggle button and the remembered choice. The preview checks in `e2e/app.spec.ts` drive the preview element and the phone player checks drive the library element, so the split cannot regress silently.

Checked by hand on a Mac (Apple M5 Pro, macOS 26.6), Chromium 153 driven by a Playwright script with mocked library routes serving a generated 120 BPM test signal:

- Audio graph: the analyser peaks at the test tone during library playback, a cross-origin preview plays without ever being attached, the library element is paused meanwhile, Space and the footer controls drive whichever is current, and a suspended context resumes on visibilitychange.
- Adapter `apple metal-3`, format `bgra8unorm`. The HUD shows live bands, the flux trace crossing its threshold on every hit, `beatPulse` reaching 1, and tempo settling at 120 BPM within ten seconds.
- Frame time, read from `data-frame-ms` after five seconds at each count. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit:

  | Stage size                                             | 100k   | 250k   | 500k   | 1M      |
  | ------------------------------------------------------ | ------ | ------ | ------ | ------- |
  | 320 by 320, ratio 1 (docked)                           | 8.4 ms | 8.4 ms | 8.3 ms | 11.2 ms |
  | 1920 by 1080 at ratio 2 (3840 by 2160, as full screen) | 8.3 ms | 8.4 ms | 8.4 ms | 8.3 ms  |

  The docked 1M case is slower than full screen because a million particles on a 320 pixel stage overdraw every pixel a hundred times; spread over 4K they do not.

- Full screen from F renders at device pixel ratio: the canvas is 3840 by 2160 for a 1920 by 1080 CSS box at ratio 2.
- Popout round trip, six times: `requestDevice` called once, one storage buffer, `configure` count always one ahead of `unconfigure`, no uncaptured errors; the popout canvas has the adapter and advancing frame times, the tab shows "Playing in the popout window", and Bring back remounts the docked canvas on the same device with the field still running. F from the popout closes it and lands the request in the tab; under automation the browser refuses it for want of a gesture and the stage shows its "Press F on the player" notice, which is the documented path.
- V switches to artwork and back; the choice and the particle count survive a reload.
- With `navigator.gpu` present but no adapter (headless Chromium), and with SwiftShader in the headless shell, which cannot present a WebGPU canvas, the stage falls back to artwork with the notice, and the renderer's device-loss recovery runs before it gives up.

- A real library, on the Mac through the Vite proxy to pancakes' Musimo over Tailscale Serve (a local config with `changeOrigin` and an Origin rewrite, see PR #50). Four tracks were played for 40 s each with the feature packets recorded and the stage screenshotted at 1920 by 1080: Aphex Twin's Donkey Rhubarb (about 140 BPM), an Above & Beyond track (about 130), and two drum and bass tracks at 174, CamelPhat's Easier in the Sub Focus remix and one by Andy C. The analyser feeds the HUD, bands sit between 0.3 and 0.95 depending on the track, onsets land on the flux trace, and 250k particles run at the 120 Hz cap. After tuning, the field on real music is a full warm cloud with bright attractor cores rather than the dim haze of the first run.
- Tempo, replaying those recordings through the extractor exactly as it runs (480-frame window, one reading a second, median of five): Donkey Rhubarb reads 140 for 59% of readings and 69 for most of the rest, where the first version read 70 throughout; Above & Beyond reads 129 for 62%. Both drum and bass tracks read 111 to 115, two thirds of the truth, because the dotted-quarter pattern of their drums correlates more than the beat. A 3:2 rule that fixed one of them broke Above & Beyond, so it was not kept. Nothing uses tempo yet; if something comes to, it needs a better method than flux autocorrelation for drum and bass.

Not checked yet: a mid-range desktop GPU.
