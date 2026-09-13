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

`frontend/src/visualizer/gpu/Device.ts` asks for a high-performance adapter and a device once, keeps them as a module singleton, logs `uncapturederror`, and clears the singleton when the browser reports the device lost so the next request starts fresh. An adapter whose info names SwiftShader or another software rasteriser is flagged, and the scene scales itself down on it: the small fluid grid with fewer sweeps.

### Lifetime

The popout portals a fresh stage into the Picture-in-Picture document, so the stage subtree unmounts and remounts on every dock and popout transition. Nothing that is expensive or stateful may live in a component:

```
module singleton, survives remounts            per mount, made again each time
------------------------------------           -------------------------------
GPUDevice, feature uniform buffer              HTMLCanvasElement (scene + HUD)
pipelines, the fluid's field textures          GPUCanvasContext, configure()
the post stack and its parameters              ResizeObserver, visibility hook
the preset and its resolved numbers
the feature worker and its client              requestAnimationFrame handle
frame clock, HUD history
```

The post stack's offscreen textures are sized from the canvas, so they belong to neither column: the singleton owns them and rebuilds them whenever the size changes, which a dock or popout move always does.

`gpu/Renderer.ts` is that singleton. A stage calls `attach(canvas, hudCanvas, onFailure)` on mount and `detach(canvas)` on unmount; `attach` configures the context, sizes the canvas to its CSS box times `devicePixelRatio`, and starts a loop on the canvas's own window, so a popout keeps drawing while the tab behind it is hidden and a hidden tab stops. On device loss the renderer drops the scene, the post stack and their buffers and tries once to come back on the same canvas; if that fails it calls `onFailure` and the stage falls back to artwork.

Each frame: read the analyser through the feature client (once the library element has played), stamp time and dt into the packet, upload it as one 64-byte uniform, resolve the preset's audio mapping into the scene's numbers and the post stack's, run the scene's compute and render passes into the post stack's texture, run the stack over it onto the canvas, then draw the HUD if it is on. React owns mounting, unmounting and the controls only; no per-frame state touches it. The canvas carries `data-adapter`, `data-frame-ms`, `data-scene`, `data-detail` (the scene's workload, such as `512 fluid`), `data-post` and `data-preset` so a screenshot or a test can read them.

### Popout and full screen

The design above was checked, not assumed. Across six dock, popout, dock round trips in desktop Chrome the page created one device and one set of simulation textures, reported no `uncapturederror`, and configured exactly one more canvas context than it unconfigured at every point, so nothing leaks with repeated toggling and the simulation never restarts. The popout's canvas is the size of its window at that window's pixel ratio and draws on that window's own animation frames, so it keeps moving while the tab is hidden behind it. The `captureStream` fallback the plan sketched was not needed and is not built.

Full screen in the tab renders at device pixel ratio: a 1920 by 1080 CSS box at ratio 2 gets a 3840 by 2160 canvas.

### Scenes

One of them for now, behind the `Scene` interface in `scenes/Scene.ts`: `init`, `resize`, `update`, `render`, `dispose`, and a `detail` line naming what the scene is doing. The renderer holds exactly one, named by the chosen preset and remembered as `musimo.visualizer-scene`.

A particle field and a raymarched Mandelbox were built first and have since been taken out; the fluid is what was kept, and more scenes are to be built on top of it. Everything around the scene stayed: the interface, the catalog, the preset format, the post stack and the renderer all still expect several, and the scene select in the top bar hides itself while the list has one entry in it. The two removed scenes, their numbers and the measurements taken on them are in the history of this file, at the `feature/visualizer-fluid-only` branch point.

No scene decides for itself which feature drives what. `update` takes the packet and a set of resolved numbers, and every magnitude in the frame comes from the second of those; the packet is read only for the clock and for events such as an onset. What a preset is and how those numbers are arrived at is under [Presets](#presets). `scenes/catalog.ts` holds the ids, the labels and the sizes each scene offers, and imports nothing, so the top bar can read them without pulling the WebGPU tree into the main bundle.

Switching scenes disposes the old one, which destroys its buffers and textures, then builds the new one on the same device and resizes it to the canvas. Nothing else changes: the device, the feature buffer and the post stack all carry on.

#### Fluid

`scenes/Fluid.ts` with `shaders/fluid.common.wgsl`, `fluid.sim.wgsl` and `fluid.render.wgsl`, plus `scenes/fluid.params.ts` for the numbers. Stam's stable fluids on a square grid of compute textures, one compute entry point per step, all of them dispatched inside a single compute pass because dispatches in one pass are ordered and see each other's writes:

```
advect velocity ─► diffuse xN ─► curl ─► vorticity and injection ─► divergence
                                                                       │
      draw ◄─ advect dye ◄─ subtract gradient ◄─ pressure xN ◄─ relax ◄─┘
```

Velocity is kept in grid widths per second, so a semi-Lagrangian backtrace is `uv - velocity * dt` with nothing scaling in between and the pressure solve works in the same units throughout. The pressure solve is 24 Jacobi sweeps, warm-started from last frame's solution faded to 0.8, which converges far better in that many sweeps than starting from nothing. The viscosity solve is two Jacobi sweeps with the alpha set directly rather than derived from a physical viscosity, because what is wanted here is a knob. Walls are free slip: the velocity component running into one is dropped and the component along it is kept. Vorticity confinement pushes each eddy back toward its own centre, which is what keeps small detail alive against the smearing the advection adds.

Every field is `rgba16float`, including the three that carry one number. `r32float` would halve their memory but is not filterable, so each would need a bind group layout of its own; one format means one explicit layout and any three fields can go to any step. Curl is read before divergence is written, so both live in one scratch field. That leaves seven textures: velocity, dye and pressure ping-ponging, and the scratch. At 512 the set is 14 MB and at 1024 it is 56 MB.

The grid is square and fixed at 512 or 1024, so nothing is rebuilt on a resize. It covers the canvas and the overflow is cropped, which keeps the scale the same on both axes so a round splat stays round; `visibleExtent` reports the band the canvas actually shows and the emitters are placed inside it, so nothing is injected off screen. A software rasteriser gets the 512 grid whatever was chosen, with 8 pressure sweeps and one viscosity sweep.

Fourteen numbers in `scenes/fluid.params.ts` are what a preset moves: the two decays, the vorticity and viscosity, the emitters' spread and orbit, what they trickle, what one onset adds on top, and where the dye sits in the palette. Three emitters ride a Lissajous orbit and push along the tangent of their own path. The trickle is scaled by the step so it does not depend on the frame rate, because a track with long quiet passages otherwise settles into a still frame.

Injection is an onset (packet index 8, its strength at 9). The gate is read from the packet by the scene rather than mapped, because it is an event and not a level; what a hit is worth is `hitForce` and `hitDye`, which a preset may point at whatever it likes. The default preset keeps PR #58's tuning: bass decides what an onset is worth, treble raises the vorticity and thins the viscosity, and energy sets both decays since a loud passage injects far more and has to clear faster.

Colour comes from a 256-texel palette lookup table built on the CPU, deep blue through teal and green into warm orange and magenta and back to the first colour so the coordinate wraps with no seam. The dye carries its place in that table as a unit vector rather than a number, so two plumes that meet average their colours the short way round instead of sweeping the whole palette between them; the draw pass recovers the angle and reads the table. Dye density is bent through `1 - exp(-d)` before it is coloured, so a thick plume reads as its own colour rather than a flat white mass, and the intensity puts only the brightest of it past the bloom threshold.

The numbers were set by eye at 3840 by 2160 against real tracks, and the first cut was wrong in a way worth recording. The viscosity alpha started between 0.4 and 2.0, which at 120 frames a second is a box blur of the neighbours every frame: 4K showed enormous soft blobs with no structure in them at all. Dropping it to between 0.02 and 0.2, halving the splat radius and roughly doubling the vorticity turned the same passage into plumes with filaments down to a texel. Emitter spread then went the other way twice: wide enough to reach the corners left three separate plumes with black between them, so it settled between the two, with more dye and a slower decay so the plumes grow into each other.

The grid size is chosen from the stage's top bar and remembered as `musimo.visualizer-fluid-grid`. The default is 512. The two sizes are not just detail levels: 512 fills the frame with bold, soft-edged plumes and 1024 draws finer, wispier ones, because the same emitter radius is a smaller fraction of the larger grid.

`scenes/fluid.params.ts` is pure TypeScript with no GPU objects, like `post/params.ts`: the palette table, the visible extent, the emitter placement, the feature mapping and the uniform write all live there and are unit tested in `fluid.params.test.ts`.

### Post stack

`post/PostStack.ts` sits between the scene and the swap chain. The scene no longer draws on the canvas at all: it draws into one of two `rgba16float` history textures, and the composite pass is the only thing that writes the canvas.

```
scene ──► history[current] ──► bright ──► blur x3 ──► composite ──► canvas
                ▲ add                                     ▲
                └── history[other], zoomed, turned, decayed
```

Half floats because a scene's brightest cores run well past 1, and in `bgra8unorm` everything above 1 was lost, which is why loud passages used to clip to a flat white blob. They are also filterable, which the warp and the blur both need.

The stages, in order:

- **Feedback.** The other history texture, scaled a little about the middle, turned a fraction of a degree and decayed, added under the new frame. The scene has already drawn into this pass's target, so the pass is additively blended rather than reading its own output. The two textures swap each frame. On a still image the gain is `1 / (1 - amount × decay)`, about 1.19 at the defaults; more than that and the field, which already fills most of the frame, turns into a milky haze.
- **Bloom.** A bright pass with a soft knee at half resolution, then three levels, each a horizontal blur that reads the level above (so it downsamples) and a vertical blur inside its own level. Five taps land between texels, so the hardware filtering makes each one a nine-tap Gaussian for the price of five. The composite adds the three levels back with their own weights.
- **Chromatic aberration.** Red and blue are read either side of green, by an offset that grows with the distance from the middle. The split is `amount + beat × beatPulse`, packet index 10, so it opens on every onset and closes again.
- **Tonemap.** A shoulder rather than a curve over the whole range: below the shoulder nothing changes, so the field keeps the brightness PR #56 tuned it to, and above it a value bends toward 1 and never reaches it. Rolling the brightest channel and letting the other two follow keeps a pixel's colour; rolling each channel on its own bleaches it toward white. The pass mixes from the first to the second across the first stop above the shoulder, so the field keeps its colour and only a real core goes white-hot. An extended Reinhard over the whole range was tried first and made every track flat and muddy.
- **Grain.** A hash of the pixel and a clock, added at the end.

Each stage has its own parameter object with an `enabled` flag, and `PostParams` holds all five plus a switch for the stack itself; a stage runs only when both are on. `post/params.ts` holds the defaults and `writePostUniform`, which resolves every toggle on the CPU and writes the 112-byte uniform each pass reads, so the shaders have no branches in them. That file is pure TypeScript with unit tests in `params.test.ts`.

It also holds `POST_LANES`, one read and one write per number in the stack a preset may name. The renderer keeps the preset's stack as it came and a second copy it rewrites each frame, so a mapping that points at `bloom.intensity` writes that one lane rather than rebuilding the object; `PostStack.useParams` points the stack at that copy instead of cloning it. `bloom.weights` is deliberately not a lane: it is three numbers, a preset can still set it outright, and nothing wants a feature riding on it.

With every stage off the composite is a straight copy, which is what the frame times below call the stack off. Nothing in the interface turns a stage off; a development-only `window.musimoVisualizer` handle does, behind Vite's `DEV` flag, so a Playwright script can measure the difference. It is not in a production build.

Textures are rebuilt whenever the canvas size changes, which includes every dock and popout move, and dropped with the device on loss. The trails therefore start again from black on each move, while the simulation itself keeps running. At 3840 by 2160 the stack holds about 176 MB: two full-resolution history textures and six smaller ones for the bloom levels and their temporaries.

### Presets

A preset is one JSON file under `frontend/src/visualizer/presets/`, and it is the whole of what the stage draws with:

```json
{
  "id": "wash",
  "name": "Wash",
  "scene": "fluid",
  "sceneParams": { "vorticity": 26, "viscosity": 0.06, "...": 0 },
  "postParams": { "bloom": { "threshold": 0.9, "intensity": 0.28 } },
  "audioMapping": [{ "from": "treble", "to": "hitForce", "gain": 1.4, "curve": "linear" }]
}
```

`sceneParams` gives every knob that scene offers a resting value; all of them are required, because a preset is a whole state rather than a patch over whatever the last one left. `postParams` is a patch over the stack's defaults, so a preset that only moves the bloom says only that. `audioMapping` is the table that makes it move.

Each row adds one feature to one number:

```
value = sceneParams[to] + Σ gain × curve(feature[from])
```

`from` is one of ten packet fields, plus `lowEnd` for the louder of sub and bass, which is what every scene wanted from the low end before presets existed. `to` is one of the scene's own knobs, or a dotted post target such as `bloom.intensity`; that is how the parser tells the two apart. `curve` is `linear`, `square`, `sqrt` or `invert`, all of which keep 0 at 0 and 1 at 1 except the last. `gain` may be negative, which is how a feature thins a number rather than raising it: `treble → viscosity` at −0.18 is the fluid keeping its detail when the music is busy. Several rows may name the same knob and they add.

All of it is resolved on the CPU, once a frame, in `presets/resolve.ts`, and nowhere else. That is why a preset can send treble to a knob that used to take bass without a line of WGSL changing, and why the scenes read no magnitude from the packet at all. Both resolvers write into an object the renderer owns and keeps, since this runs on every animation frame.

The two that remain, in the order `[` and `]` walk them:

| Preset | Scene | What it does differently                                                                                                                                                                                    |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plume  | Fluid | The fluid as PR #58 tuned it, and the default. Bass decides what an onset is worth, treble the vorticity.                                                                                                   |
| Wash   | Fluid | Treble decides what an onset is worth and bass raises the vorticity: the opposite way round. Thinner viscosity, wider spread, slower orbit, so the plumes stay separate instead of growing into each other. |

Four more went with the particle and raymarch scenes: Drift and Storm for the field, Fold and Furnace for the march.

`postParams` is where a preset changes the look without touching the scene: Wash lifts the feedback and the threshold so its thinner plumes keep their edges.

A preset file is compiled in rather than fetched, so the parser in `presets/parse.ts` throws at load rather than falling back. Everything arrives as `unknown` and is narrowed on the way through, and every message names the file and the path inside it, because a preset is a wall of numbers and "expected a number" on its own is no help:

```
presets/broken.json: sceneParams.viscosity is missing
presets/broken.json: audioMapping[0].to is neither a knob of this scene (velocityDecay, …) nor a post target (feedback.amount, …)
```

`presets/knobs.ts` holds the vocabulary and imports nothing, for the same reason `scenes/catalog.ts` does: the stage's top bar reads it without pulling the WebGPU tree into the main bundle.

The picker is the first control in the stage's top bar, grouped by scene, and `[` and `]` walk the list either way and wrap. The choice is remembered as `musimo.visualizer-preset` and the H overlay names it. It lives on the renderer singleton, not in a component, so the popout round trip keeps it.

The scene select sits next to it and is not drawn while `SCENE_IDS` has one entry, since there would be nothing to choose; it comes back on its own as scenes are added. The wiring behind it stayed: a preset names a scene, so choosing one moves the scene select under it, and choosing a scene moves to that scene's first preset, which is what keeps the two from ever disagreeing. The grid select beside them is always shown, because the fluid has two sizes whatever else is on offer.

### HUD

H toggles `hud/Hud.ts`, a 2D canvas over the scene: the five band envelopes and energy as bars, the flux trace against its threshold with onset marks, beat, tempo, frame time, what the scene is doing, the adapter and which post stages are running. It ships in the build so a report from another machine can carry a screenshot.

## Code

- `frontend/src/visualizer/audio/AudioGraph.ts`: the context, the analyser and the attach and resume rules above.
- `frontend/src/visualizer/audio/FeatureExtractor.ts`, `features.protocol.ts` and `features.worker.ts`: the feature packet and the worker that produces it.
- `frontend/src/visualizer/gpu/Device.ts`, `gpu/Renderer.ts`: the device singleton and the renderer. `gpu/math.ts` is the camera maths, which nothing calls since the two 3D scenes went; it is kept and still tested, for the next scene that needs a camera.
- `frontend/src/visualizer/scenes/Scene.ts` and `scenes/catalog.ts`: the interface a scene meets, and the ids and sizes the top bar offers.
- `frontend/src/visualizer/presets/`: the preset files, the knob vocabulary (`knobs.ts`), the parser (`parse.ts`), the mapping resolved once a frame (`resolve.ts`) and the list the top bar reads (`index.ts`).
- `frontend/src/visualizer/scenes/Fluid.ts`, `scenes/fluid.params.ts` and `shaders/fluid.*.wgsl`: the fluid scene, its numbers and its passes.
- `frontend/src/visualizer/post/PostStack.ts`, `post/params.ts` and `shaders/post.*.wgsl`: the post stack, its parameters and its passes.
- `frontend/src/visualizer/hud/Hud.ts`, `Visualizer.tsx`: the debug overlay and the React shell the stage mounts.
- `frontend/src/now-playing-overlay.tsx` and `now-playing-popout.tsx`: the preset picker, the grid select, the `[` and `]` keys, and the state that keeps the preset and the scene select in step.
- `frontend/src/player.tsx`: the two audio elements, the handlers they share (each ignores events from the element that is not current), and the visibility resume.

## Checks

Unit tests cover the pure parts: the feature extractor with synthetic spectra (band collapse at both FFT sizes, envelope attack and release timing, every click in a click train detected with none between and the tempo found, jitter not read as onsets), the worker protocol handing buffers back, the camera maths, the post stack's parameters (a patch leaving the object it was given alone, the stack's own switch overriding the stages under it, each stage that is off writing values that make its term vanish, the chromatic split widening with `beatPulse`, the bloom level sizes, and nothing that the shaders divide by reaching zero), and the fluid's parameters (the grid size chosen and capped on a rasteriser, the visible extent of a square grid on a canvas of any shape including one with no area, every emitter landing inside the band the canvas shows at the loudest spread, the push being a unit vector, an onset injecting several times the trickle and bass raising it further, the trickle halving when the step halves, the step clamped, treble raising vorticity and thinning viscosity, energy clearing the dye faster, the palette coordinate staying inside the table, the palette starting and ending on the same colour, and no emitter slot writing a radius the shader would divide by). The camera basis is still tested in `gpu/math.test.ts` for the orbit and for the one case where it is undefined, a camera looking straight along its own up vector, though nothing calls it until another 3D scene is built. The scene tests that read a mapping resolve the shipped preset for that scene the way the renderer does, so they read the behaviour the stage actually has rather than a bare default.

The presets have their own. The parser is tested for reading a whole preset and resolving its post patch over the defaults, and for rejecting a missing knob, a knob no scene offers, a mapping onto one, a feature that does not exist, a curve that does not, a gain that is not a finite number, a post field that is not part of its stage, a stage that does not exist, bloom weights that are not three numbers, a stage switch that is not a boolean, a scene that does not exist, a preset that is not an object, and a key that is not part of a preset, each with the file and the path in the message. The preset files are tested for parsing, two per scene, with every knob of their own scene and no other, unique ids and names, a default that exists and draws the fluid, `[` and `]` stepping both ways and wrapping even from an id nobody recognises, and a first preset for every scene. The resolver is tested for reading the packet by name and giving `lowEnd` the louder of sub and bass, each curve keeping its ends and never letting a negative feature through, a knob resting at its preset value with nothing driving it, gain times the bent feature added, several rows adding onto one knob, a negative gain thinning a number, a scene row and a post row each ignored by the other resolver, the object being rewritten rather than accumulating across frames, and a post lane falling back to rest once its feature does.

Playwright can prove structure, not pixels: headless engines have no WebGPU adapter and a WebGPU canvas renders black in a screenshot. `e2e/visualizer.spec.ts` checks the artwork fallback and its one-time notice with `navigator.gpu` removed, and, only where the browser has an adapter, the default visualizer view, the V and H keys, the toggle button, the remembered choice, the post stages named in `data-post`, the scene named in `data-scene` with the scene select absent because there is one of them, the grid select changing `data-detail` and surviving a reload as `musimo.visualizer-fluid-grid`, and the preset picker: that it exists, that `[` and `]` walk the two both ways and wrap, that the picker sets `data-preset` itself, and that the choice survives a reload. The two tests that were about switching scenes went with the scenes; what they covered on the preset side, a preset moving the scene and a scene moving the preset, is still unit tested in `presets/parse.test.ts`. The preview checks in `e2e/app.spec.ts` drive the preview element and the phone player checks drive the library element, so the split cannot regress silently.

The particle and raymarch measurements were taken out with the scenes; what is below is what still describes shipping code. Both sets are in this file's history at the `feature/visualizer-fluid-only` branch point, and the conclusions that outlived them, the post stack's tuning and the white-out it fixed, are kept here.

Checked by hand on a Mac (Apple M5 Pro, macOS 26.6), Chromium 153 driven by a Playwright script with mocked library routes serving a generated 120 BPM test signal:

- Audio graph: the analyser peaks at the test tone during library playback, a cross-origin preview plays without ever being attached, the library element is paused meanwhile, Space and the footer controls drive whichever is current, and a suspended context resumes on visibilitychange.
- Adapter `apple metal-3`, format `bgra8unorm`. The HUD shows live bands, the flux trace crossing its threshold on every hit, `beatPulse` reaching 1, and tempo settling at 120 BPM within ten seconds.
- Full screen from F renders at device pixel ratio: the canvas is 3840 by 2160 for a 1920 by 1080 CSS box at ratio 2.
- Popout round trip, six times: `requestDevice` called once, one set of simulation fields, `configure` count always one ahead of `unconfigure`, no uncaptured errors; the popout canvas has the adapter and advancing frame times, the tab shows "Playing in the popout window", and Bring back remounts the docked canvas on the same device with the scene still running. F from the popout closes it and lands the request in the tab; under automation the browser refuses it for want of a gesture and the stage shows its "Press F on the player" notice, which is the documented path.
- V switches to artwork and back; the choice and the grid size survive a reload.
- With `navigator.gpu` present but no adapter (headless Chromium), and with SwiftShader in the headless shell, which cannot present a WebGPU canvas, the stage falls back to artwork with the notice, and the renderer's device-loss recovery runs before it gives up.

- A real library, on the Mac through the Vite proxy to pancakes' Musimo over Tailscale Serve (a local config with `changeOrigin` and an Origin rewrite, see PR #50). Four tracks were played for 40 s each with the feature packets recorded and the stage screenshotted at 1920 by 1080: Aphex Twin's Donkey Rhubarb (about 140 BPM), an Above & Beyond track (about 130), and two drum and bass tracks at 174, CamelPhat's Easier in the Sub Focus remix and one by Andy C. The analyser feeds the HUD, bands sit between 0.3 and 0.95 depending on the track, and onsets land on the flux trace. These four tracks are the set every measurement below uses.
- The post stack, on the same Mac in headed Chromium 153 at 1920 by 1080 and ratio 2, against the real library, the same four tracks played from the start with the stage in full screen. Frame time is `data-frame-ms` after eight seconds, first with every stage on, then with the stack switched off, which leaves the composite a straight copy. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit, and on every size and track measured the stack cost nothing measurable: both numbers sat at 8.2 to 8.4 ms. The per-count table went with the particle scene.

- The white-out is gone. Without the stack, CamelPhat's Easier drove a third of the frame to a flat white mass with no structure visible inside it, and Donkey Rhubarb did the same on its loud passages. With the stack the same moments are a warm core that fades into the colour of the scene, and the detail inside it survives. The trails read as a slow radial smear from the zoom, the split opens on each onset, and no track produced a clipped area. This was measured on the particle field, which is gone, but it is why the stack exists and why it is tuned as it is.
- Tuning took several passes, all recorded here because the first two looked worse than no stack at all. An extended Reinhard over the whole range removed the clipping but flattened every track into a muddy grey-brown, so the curve became a shoulder that leaves everything below it alone. A generous feedback (amount 0.55, decay 0.86) and bloom (threshold 0.5, intensity 0.75) filled the gaps in the scene and turned it into a milky haze, so both were cut hard: the feedback gain is now 1.19 on a still image and the bloom threshold is 0.85, high enough that only the cores glow.
- Popout round trip with the stack on, six times, in headed Chromium: one `requestAdapter` and one `requestDevice`, the number of configured canvas contexts never below zero or above one, no `uncapturederror` and no console errors. Both canvases carried all five stages in `data-post` and advancing frame times throughout, the popout at 3840 by 2160 and the docked stage at 640 by 640, so the stack rebuilds its textures for each size without restarting the scene. One cycle read about 22 ms in both windows and the rest sat at the cap.
- Tempo, replaying those recordings through the extractor exactly as it runs (480-frame window, one reading a second, median of five): Donkey Rhubarb reads 140 for 59% of readings and 69 for most of the rest, where the first version read 70 throughout; Above & Beyond reads 129 for 62%. Both drum and bass tracks read 111 to 115, two thirds of the truth, because the dotted-quarter pattern of their drums correlates more than the beat. A 3:2 rule that fixed one of them broke Above & Beyond, so it was not kept. Nothing uses tempo yet; if something comes to, it needs a better method than flux autocorrelation for drum and bass.

- The fluid scene, on the same Mac in headed Chromium 153 against the real library, the post stack on throughout. Each of the four tracks was searched for, started from the tracks list and opened with in-app navigation so the analyser survived, then left playing for ten and a half seconds before `data-frame-ms` was read; the artist on the footer was checked each time, because the tracks list reloads asynchronously and a click that lands early starts whatever was there before. The four numbers in each cell are Donkey Rhubarb, Above & Beyond, CamelPhat and Andy C in that order. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit; no cell left the cap and none logged a console error:

  | Stage size                                             | Fluid 512             | Fluid 1024            |
  | ------------------------------------------------------ | --------------------- | --------------------- |
  | 320 by 320, ratio 1 (docked)                           | 8.3, 8.2, 8.3, 8.4 ms | 8.4, 8.3, 8.3, 8.3 ms |
  | 1920 by 1080 at ratio 2 (3840 by 2160, as full screen) | 8.2, 8.3, 8.4, 8.4 ms | 8.3, 8.7, 8.2, 8.4 ms |

  Full screen cannot be requested without a gesture under automation, so the 3840 by 2160 case forces the stage to a 1920 by 1080 CSS box at ratio 2, which is the same canvas.

- What the stage showed on each track, screenshotted at 3840 by 2160. Donkey Rhubarb, whose percussion is sparse, gives three well separated plumes with soft round heads and long filamented tails, and the trickle carries the field through its quiet stretches rather than letting it settle. CamelPhat's Easier nearly fills the frame by 45 seconds with two interlocking masses of orange, magenta and teal whose edges curl down to a texel; the same passage at 1024 is thinner and wispier, because the emitter radius is a smaller fraction of the larger grid. Andy C's Back & Forth throws fast edge to edge streaks with heavy colour fringing along them, since its onsets are almost continuous and the post stack's chromatic split opens on every one. Above & Beyond sits between the two, three separate coloured plumes growing steadily. No track produced a flat white mass at either grid.

- Scene switching was checked twelve times between the particle field and the fluid, and later twelve times around all three scenes, while a track played: one `requestAdapter` and one `requestDevice` for each whole run, no `uncapturederror`, no console errors, and the canvas context configured once and never reconfigured, since only the scene is rebuilt. `data-scene` and `data-detail` followed the select every time and the frame time held at 8.3 to 8.4 ms docked. There is nothing to switch between now, but the path the switch took, disposing one scene and building the next on the same device, is the path the renderer still uses and the one the next scene will arrive on.

- Popout round trip with the fluid drawing, six times: one adapter and one device, the number of configured canvas contexts always exactly one ahead of the number unconfigured, no uncaptured errors and no console errors. Both canvases carried `fluid` and `512 fluid` with advancing frame times, the docked stage came back at 320 by 320, and playback was never interrupted across the whole run.

- The grid select, eight switches between 512 and 1024 while a track played: `data-detail` followed each time, no console errors, the frame time held, and the choice survived a reload as `musimo.visualizer-fluid-grid`.

- Presets, on the same Mac in headed Chromium 153 against the real library, two of the tracks above: Aphex Twin's Donkey Rhubarb and CamelPhat's Easier in the Sub Focus remix. Each was searched for, started from the tracks list and opened with in-app navigation so the analyser survived, with the artist on the footer checked before anything was read. Every preset was cycled on each track at both sizes, `data-frame-ms` read after ten and a half seconds, and the stage screenshotted at 3840 by 2160. No console errors and no `uncapturederror` across the run. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit:

  | Stage size, track                                      | Plume  | Wash   |
  | ------------------------------------------------------ | ------ | ------ |
  | 320 by 320, ratio 1 (docked), Donkey Rhubarb           | 8.3 ms | 8.3 ms |
  | 320 by 320, CamelPhat                                  | 8.2 ms | 8.4 ms |
  | 1920 by 1080 at ratio 2 (3840 by 2160), Donkey Rhubarb | 8.3 ms | 8.4 ms |
  | 3840 by 2160, CamelPhat                                | 8.4 ms | 8.3 ms |

  The mapping costs nothing measurable: a preset resolves a dozen numbers a frame on the CPU. Full screen cannot be requested without a gesture under automation, so the 4K case forces the stage to a 1920 by 1080 CSS box at ratio 2, which is the same canvas.

- What each preset showed, screenshotted at 3840 by 2160. Plume gives the interlocking orange, magenta and teal masses PR #58 tuned. Wash gives three separate slow plumes with visible emitter heads and heavy fringing along their edges on a mostly black frame.

- Wash was retuned after looking at it. It was first written with the emitters at 0.62 of the visible band and a faster dye decay, which is exactly the look PR #58 rejected as a default: three plumes with black between them and over half the frame empty. Pulling the spread back to 0.5 and raising the trickle keeps it airier than Plume without being empty.

- The picker, `[` and `]`, and the remembered choice, in headed Chromium against the real library: `]` walks the list in order and wraps, `[` walks back and wraps, and `data-preset`, `data-detail` and the picker follow every step. The choice survives a reload as `musimo.visualizer-preset`. H names the preset on the overlay. No console errors.

- Popout round trip with a preset chosen, six times: `wash` and `fluid` on both canvases every trip, the picker still on Wash after each Bring back, one `requestAdapter` and one `requestDevice` for the whole run, the number of configured canvas contexts always exactly one ahead of the number unconfigured (7 against 6 at the end), no uncaptured errors and no console errors. The preset lives with the renderer, not in a component, which is why it survives the remount.

- One bug was found this way and not by reading, and it is kept here although the scene it was in has gone. The particle pipelines were built with `layout: 'auto'`, whose derived layout holds only the bindings a shader happens to read. Taking the feature packet out of the render shader dropped binding 0 from that layout, and the bind group built for both halves became invalid: every frame failed validation and those presets drew nothing, with thousands of WebGPU errors in the console. Name a bind group layout rather than deriving one wherever two pipelines share a bind group; the next scene with a compute half and a render half has the same trap waiting for it.

Checked after taking the two scenes out, on pancakes (Windows 11) against the CI container: the frontend typechecks, all 87 unit tests pass, eslint is clean, and `e2e/visualizer.spec.ts` passes all four of its tests in headed Chromium, where an adapter exists. Headless Chromium, Firefox and WebKit have no adapter, so they run the artwork fallback test and skip the other three, which is the documented behaviour rather than a gap opened here. Not rechecked by hand: the fluid's look and its frame times on a real library. The numbers above were taken on the Mac before the removal and nothing in this change touches the fluid's shaders, its parameters or its uniform.

Not checked yet: a mid-range desktop GPU, and the fluid on a software rasteriser, which the reduced grid and sweep counts are written for but no machine here can run.
