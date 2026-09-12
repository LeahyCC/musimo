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

`frontend/src/visualizer/gpu/Device.ts` asks for a high-performance adapter and a device once, keeps them as a module singleton, logs `uncapturederror`, and clears the singleton when the browser reports the device lost so the next request starts fresh. An adapter whose info names SwiftShader or another software rasteriser is flagged, and each scene scales itself down on it: 20,000 particles, the small fluid grid with fewer sweeps, or half the march's step cap at half the canvas.

### Lifetime

The popout portals a fresh stage into the Picture-in-Picture document, so the stage subtree unmounts and remounts on every dock and popout transition. Nothing that is expensive or stateful may live in a component:

```
module singleton, survives remounts            per mount, made again each time
------------------------------------           -------------------------------
GPUDevice, feature uniform buffer              HTMLCanvasElement (scene + HUD)
pipelines, particle storage buffers            GPUCanvasContext, configure()
the post stack and its parameters              ResizeObserver, visibility hook
the feature worker and its client              requestAnimationFrame handle
frame clock, HUD history
```

The post stack's offscreen textures are sized from the canvas, so they belong to neither column: the singleton owns them and rebuilds them whenever the size changes, which a dock or popout move always does.

`gpu/Renderer.ts` is that singleton. A stage calls `attach(canvas, hudCanvas, onFailure)` on mount and `detach(canvas)` on unmount; `attach` configures the context, sizes the canvas to its CSS box times `devicePixelRatio`, and starts a loop on the canvas's own window, so a popout keeps drawing while the tab behind it is hidden and a hidden tab stops. On device loss the renderer drops the scene, the post stack and their buffers and tries once to come back on the same canvas; if that fails it calls `onFailure` and the stage falls back to artwork.

Each frame: read the analyser through the feature client (once the library element has played), stamp time and dt into the packet, upload it as one 64-byte uniform, run the scene's compute and render passes into the post stack's texture, run the stack over it onto the canvas, then draw the HUD if it is on. React owns mounting, unmounting and the controls only; no per-frame state touches it. The canvas carries `data-adapter`, `data-frame-ms`, `data-scene`, `data-detail` (the scene's workload, such as `250,000 particles`, `512 fluid` or `64-step raymarch`) and `data-post` so a screenshot or a test can read them.

### Popout and full screen

The design above was checked, not assumed. Across six dock, popout, dock round trips in desktop Chrome the page created one device and one particle storage buffer, reported no `uncapturederror`, and configured exactly one more canvas context than it unconfigured at every point, so nothing leaks with repeated toggling and the field never restarts. The popout's canvas is the size of its window at that window's pixel ratio and draws on that window's own animation frames, so it keeps moving while the tab is hidden behind it. The `captureStream` fallback the plan sketched was not needed and is not built.

Full screen in the tab renders at device pixel ratio: a 1920 by 1080 CSS box at ratio 2 gets a 3840 by 2160 canvas.

### Scenes

Three of them, behind the `Scene` interface in `scenes/Scene.ts`: `init`, `resize`, `update`, `render`, `dispose`, and a `detail` line naming what the scene is doing. The renderer holds exactly one, chosen from the stage's top bar and remembered as `musimo.visualizer-scene`; the default is the particle field. `scenes/catalog.ts` holds the ids, the labels and the sizes each scene offers, and imports nothing, so the top bar can read them without pulling the WebGPU tree into the main bundle.

Switching scenes disposes the old one, which destroys its buffers and textures, then builds the new one on the same device and resizes it to the canvas. Nothing else changes: the device, the feature buffer and the post stack all carry on.

#### Particles

`scenes/Particles.ts` with `shaders/common.wgsl`, `particles.compute.wgsl` and `particles.render.wgsl` (imported with `?raw`). Particles live in one storage buffer of 32-byte records (position, life, velocity, seed). A compute pass moves each one through a curl-noise flow field (simplex noise by Ashima Arts and Stefan Gustavson, MIT), toward three attractors that circle the middle, and integrates with drag and a soft spring; dead particles respawn in a ball, staggered on the first frame. The render pass draws one instanced quad per particle with no vertex buffer, additively blended, sized and lit by speed. Each particle is dimmed by the expected number landing on a pixel (count times point area over canvas area), so a small docked stage and a 4K full screen come out the same brightness. The target of 0.65 light units per pixel, the brightness floor and the attractor spread were set by eye on real tracks at 4K; the first cut looked dim and sparse on anything quieter than a test signal.

Audio mapping: bass (the louder of sub and bass) to attractor strength; treble to noise frequency and jitter; `beatPulse` to a radial push and a size bump; energy to flow strength, speed and how many dead particles respawn. Colour runs cool to warm with bass.

The count is chosen from the stage's top bar (100k, 250k, 500k, 1M) and remembered as `musimo.visualizer-particles`. The default is 250,000.

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

Audio mapping. Three emitters ride a Lissajous orbit, spread wider by energy, pushing along the tangent of their own path. Injection is an onset (packet index 8, its strength at 9): bass sets how hard the impulse pushes and how much dye it carries, and the onset strength grades it. A small trickle rides along between hits, scaled by the step so it does not depend on the frame rate, because a track with long quiet passages otherwise settles into a still frame. Treble raises the vorticity and thins the viscosity, so busy music keeps its detail. Energy sets both decay rates, since a loud passage injects far more and has to clear faster. `beatPulse` lifts the output intensity.

Colour comes from a 256-texel palette lookup table built on the CPU, deep blue through teal and green into warm orange and magenta and back to the first colour so the coordinate wraps with no seam. The dye carries its place in that table as a unit vector rather than a number, so two plumes that meet average their colours the short way round instead of sweeping the whole palette between them; the draw pass recovers the angle and reads the table. Dye density is bent through `1 - exp(-d)` before it is coloured, so a thick plume reads as its own colour rather than a flat white mass, and the intensity puts only the brightest of it past the bloom threshold.

The numbers were set by eye at 3840 by 2160 against real tracks, and the first cut was wrong in a way worth recording. The viscosity alpha started between 0.4 and 2.0, which at 120 frames a second is a box blur of the neighbours every frame: 4K showed enormous soft blobs with no structure in them at all. Dropping it to between 0.02 and 0.2, halving the splat radius and roughly doubling the vorticity turned the same passage into plumes with filaments down to a texel. Emitter spread then went the other way twice: wide enough to reach the corners left three separate plumes with black between them, so it settled between the two, with more dye and a slower decay so the plumes grow into each other.

The grid size is chosen from the stage's top bar and remembered as `musimo.visualizer-fluid-grid`. The default is 512. The two sizes are not just detail levels: 512 fills the frame with bold, soft-edged plumes and 1024 draws finer, wispier ones, because the same emitter radius is a smaller fraction of the larger grid.

`scenes/fluid.params.ts` is pure TypeScript with no GPU objects, like `post/params.ts`: the palette table, the visible extent, the emitter placement, the feature mapping and the uniform write all live there and are unit tested in `fluid.params.test.ts`.

#### Raymarch

`scenes/Raymarch.ts` with `shaders/raymarch.common.wgsl`, `raymarch.march.wgsl` and `raymarch.upscale.wgsl`, plus `scenes/raymarch.params.ts` for the numbers. One full-screen fragment pass, one ray a pixel through a Mandelbox distance field: each round folds the point back into the unit box, inflates it out of an inner ball or inverts it inside a shell, scales it and adds the point it started from, while a running derivative turns the folded length back into a distance. The fold in its own units is about ten across at the corners, which would put any sensible camera inside it, so the march divides through a constant and works on a shape a few units wide.

There is no simulation state at all, unlike the other two scenes: a frame is drawn from the uniform and nothing else. Nothing is lost when the stage remounts, nothing is rebuilt on a resize, and the 128-byte uniform is the whole of what the scene owns.

Shading is one light. The surface normal is four samples on a tetrahedron rather than six on the axes. The shadow is a second, much shorter march (18 steps, 5 units) that keeps the nearest the field came to the ray, so an edge is soft for the price of one sample; a face turned away from the light skips it entirely, which is half the surface on a convex fold and was the second most expensive thing in the pass. Ambient occlusion is free: a ray that took many steps to land was scraping past the fold, which is what a crevice does, so the step count is the occlusion term. That same count is the halo around a miss, and the only thing a miss draws; it is what the bloom picks up. Colour is a cosine ramp read at the surface's distance from the middle plus its step count, so a face and the filigree on it are not one flat tint.

Audio mapping: bass sets the fold scale, so the shape opens and closes with the low end; treble sets how many times the fold runs (6 to 12), which is where the fine detail comes from; `beatPulse` pulls the camera in, never past the shell, because inside the fold the distance estimate is no use and the frame turns to noise; energy drives the light and the halo, and the colour ramp drifts with time and bass.

The march is bounded twice, because it has no natural cost: a step cap and a distance cap, both in `raymarch.params.ts`. Without them a passage that folds the field tighter would make every ray creep and one bar could cost ten times the frame budget of the one before. The cap is chosen from the stage's top bar (64 or 112 steps) and remembered as `musimo.visualizer-raymarch-steps`; the default is 64. A software rasteriser gets half of whatever was chosen and marches at half the canvas each side, then the result is stretched back with one bilinear tap a pixel; that upsample pass is the only thing `Raymarch.ts` ever allocates a texture for.

The cap is a ceiling rather than the cost. Walking the same rays outside the browser, an average ray uses about half the cap at 64 and under a third at 112, and the share that leaves the march unfinished falls from six per cent to about one; that share is the soft fringe around the silhouette. This is why the two caps measure the same on the Mac below, and why the control is still worth having: it is what bounds the worst case on a slower machine.

`scenes/raymarch.params.ts` is pure TypeScript with no GPU objects, like the fluid's: the camera orbit, the step and distance caps, the feature mapping and the uniform write live there and are unit tested in `raymarch.params.test.ts`. The camera itself is three axes rather than a matrix, `cameraBasis` in `gpu/math.ts`, since a ray is built from them directly.

### Post stack

`post/PostStack.ts` sits between the scene and the swap chain. The scene no longer draws on the canvas at all: it draws into one of two `rgba16float` history textures, and the composite pass is the only thing that writes the canvas.

```
scene ──► history[current] ──► bright ──► blur x3 ──► composite ──► canvas
                ▲ add                                     ▲
                └── history[other], zoomed, turned, decayed
```

Half floats because the scene sums thousands of additively blended particles: its cores run well past 1, and in `bgra8unorm` everything above 1 was lost, which is why loud passages used to clip to a flat white blob. They are also filterable, which the warp and the blur both need.

The stages, in order:

- **Feedback.** The other history texture, scaled a little about the middle, turned a fraction of a degree and decayed, added under the new frame. The scene has already drawn into this pass's target, so the pass is additively blended rather than reading its own output. The two textures swap each frame. On a still image the gain is `1 / (1 - amount × decay)`, about 1.19 at the defaults; more than that and the field, which already fills most of the frame, turns into a milky haze.
- **Bloom.** A bright pass with a soft knee at half resolution, then three levels, each a horizontal blur that reads the level above (so it downsamples) and a vertical blur inside its own level. Five taps land between texels, so the hardware filtering makes each one a nine-tap Gaussian for the price of five. The composite adds the three levels back with their own weights.
- **Chromatic aberration.** Red and blue are read either side of green, by an offset that grows with the distance from the middle. The split is `amount + beat × beatPulse`, packet index 10, so it opens on every onset and closes again.
- **Tonemap.** A shoulder rather than a curve over the whole range: below the shoulder nothing changes, so the field keeps the brightness PR #56 tuned it to, and above it a value bends toward 1 and never reaches it. Rolling the brightest channel and letting the other two follow keeps a pixel's colour; rolling each channel on its own bleaches it toward white. The pass mixes from the first to the second across the first stop above the shoulder, so the field keeps its colour and only a real core goes white-hot. An extended Reinhard over the whole range was tried first and made every track flat and muddy.
- **Grain.** A hash of the pixel and a clock, added at the end.

Each stage has its own parameter object with an `enabled` flag, and `PostParams` holds all five plus a switch for the stack itself; a stage runs only when both are on. A later presets step sets a whole stack with one `renderer.setPost(patch)` call and needs no new API. `post/params.ts` holds the defaults and `writePostUniform`, which resolves every toggle on the CPU and writes the 112-byte uniform each pass reads, so the shaders have no branches in them. That file is pure TypeScript with unit tests in `params.test.ts`.

With every stage off the composite is a straight copy, which is what the frame times below call the stack off. Nothing in the interface turns a stage off; a development-only `window.musimoVisualizer` handle does, behind Vite's `DEV` flag, so a Playwright script can measure the difference. It is not in a production build.

Textures are rebuilt whenever the canvas size changes, which includes every dock and popout move, and dropped with the device on loss. The trails therefore start again from black on each move, while the particle field itself keeps running. At 3840 by 2160 the stack holds about 176 MB: two full-resolution history textures and six smaller ones for the bloom levels and their temporaries.

### HUD

H toggles `hud/Hud.ts`, a 2D canvas over the scene: the five band envelopes and energy as bars, the flux trace against its threshold with onset marks, beat, tempo, frame time, what the scene is doing, the adapter and which post stages are running. It ships in the build so a report from another machine can carry a screenshot.

## Code

- `frontend/src/visualizer/audio/AudioGraph.ts`: the context, the analyser and the attach and resume rules above.
- `frontend/src/visualizer/audio/FeatureExtractor.ts`, `features.protocol.ts` and `features.worker.ts`: the feature packet and the worker that produces it.
- `frontend/src/visualizer/gpu/Device.ts`, `gpu/Renderer.ts`, `gpu/math.ts`: the device singleton, the renderer and the camera maths.
- `frontend/src/visualizer/scenes/Scene.ts` and `scenes/catalog.ts`: the interface all three scenes meet, and the ids and sizes the top bar offers.
- `frontend/src/visualizer/scenes/Particles.ts` and `shaders/particles.*.wgsl`: the particle scene.
- `frontend/src/visualizer/scenes/Fluid.ts`, `scenes/fluid.params.ts` and `shaders/fluid.*.wgsl`: the fluid scene, its numbers and its passes.
- `frontend/src/visualizer/scenes/Raymarch.ts`, `scenes/raymarch.params.ts` and `shaders/raymarch.*.wgsl`: the raymarch scene, its caps and its one pass.
- `frontend/src/visualizer/post/PostStack.ts`, `post/params.ts` and `shaders/post.*.wgsl`: the post stack, its parameters and its passes.
- `frontend/src/visualizer/hud/Hud.ts`, `Visualizer.tsx`: the debug overlay and the React shell the stage mounts.
- `frontend/src/player.tsx`: the two audio elements, the handlers they share (each ignores events from the element that is not current), and the visibility resume.

## Checks

Unit tests cover the pure parts: the feature extractor with synthetic spectra (band collapse at both FFT sizes, envelope attack and release timing, every click in a click train detected with none between and the tempo found, jitter not read as onsets), the worker protocol handing buffers back, the camera maths, the post stack's parameters (a patch leaving the object it was given alone, the stack's own switch overriding the stages under it, each stage that is off writing values that make its term vanish, the chromatic split widening with `beatPulse`, the bloom level sizes, and nothing that the shaders divide by reaching zero), and the fluid's parameters (the grid size chosen and capped on a rasteriser, the visible extent of a square grid on a canvas of any shape including one with no area, every emitter landing inside the band the canvas shows at the loudest spread, the push being a unit vector, an onset injecting several times the trickle and bass raising it further, the trickle halving when the step halves, the step clamped, treble raising vorticity and thinning viscosity, energy clearing the dye faster, the palette coordinate staying inside the table, the palette starting and ending on the same colour, and no emitter slot writing a radius the shader would divide by), and the raymarch's (the step cap taken from the offered set or falling back to the default, halved but never emptied on a rasteriser, the march size half the canvas there and all of it otherwise and never zero texels, bass opening the fold, treble adding whole fold iterations, a beat pulling the camera in but never inside the shell, energy raising the light and the halo, the light direction being a unit vector, the camera basis staying orthonormal all round the orbit, the colour coordinate staying inside the ramp, the cap surviving the loudest packet, and no lane of the uniform reaching a value the shader would divide by). The camera basis is tested in `gpu/math.test.ts` for the orbit and for the one case where it is undefined, a camera looking straight along its own up vector.

Playwright can prove structure, not pixels: headless engines have no WebGPU adapter and a WebGPU canvas renders black in a screenshot. `e2e/visualizer.spec.ts` checks the artwork fallback and its one-time notice with `navigator.gpu` removed, and, only where the browser has an adapter, the default visualizer view, the V and H keys, the toggle button, the remembered choice, the post stages named in `data-post`, and the scene select naming the scene in `data-scene`, swapping the size control beside it and surviving a reload. The preview checks in `e2e/app.spec.ts` drive the preview element and the phone player checks drive the library element, so the split cannot regress silently.

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
- The post stack, on the same Mac in headed Chromium 153 at 1920 by 1080 and ratio 2, against the real library, the same four tracks played from the start with the stage in full screen. Frame time is `data-frame-ms` after eight seconds, first with every stage on, then with the stack switched off, which leaves the composite a straight copy. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit and the stack costs nothing measurable:

  | Stage size, Donkey Rhubarb                             | 100k         | 250k         | 500k         | 1M             |
  | ------------------------------------------------------ | ------------ | ------------ | ------------ | -------------- |
  | 320 by 320, ratio 1 (docked), stack on / off           | 8.3 / 8.4 ms | 8.3 / 8.4 ms | 8.3 / 8.2 ms | 8.4 / 8.4 ms   |
  | 1920 by 1080 at ratio 2 (3840 by 2160), stack on / off | 8.4 / 8.4 ms | 8.4 / 8.3 ms | 8.4 / 8.3 ms | 11.1 / 10.9 ms |

  At 250k and 3840 by 2160, stack on then off: Donkey Rhubarb 8.3 / 8.2, Above & Beyond 8.4 / 8.4, CamelPhat 8.3 / 8.3, Andy C 8.4 / 8.3 ms. The only case that leaves the cap is a million particles at 4K, where the stack adds about 0.2 ms.

- The white-out is gone. Without the stack, CamelPhat's Easier drives a third of the frame to a flat white mass with no particles visible inside it, and Donkey Rhubarb does the same on its loud passages. With the stack the same moments are a warm core that fades into the colour of the field, and individual particles are still visible inside it. The trails read as a slow radial smear from the zoom, the split opens on each onset, and no track produced a clipped area at any of the four counts.
- Tuning took several passes, all recorded here because the first two looked worse than no stack at all. An extended Reinhard over the whole range removed the clipping but flattened every track into a muddy grey-brown, so the curve became a shoulder that leaves everything below it alone. A generous feedback (amount 0.55, decay 0.86) and bloom (threshold 0.5, intensity 0.75) filled the gaps between particles and turned the field into a milky haze, so both were cut hard: the feedback gain is now 1.19 on a still image and the bloom threshold is 0.85, high enough that only the cores glow.
- Popout round trip with the stack on, six times, in headed Chromium: one `requestAdapter` and one `requestDevice`, the number of configured canvas contexts never below zero or above one, no `uncapturederror` and no console errors. Both canvases carried all five stages in `data-post` and advancing frame times throughout, the popout at 3840 by 2160 and the docked stage at 640 by 640, so the stack rebuilds its textures for each size without restarting the field. One cycle read about 22 ms in both windows and the rest sat at the cap.
- Tempo, replaying those recordings through the extractor exactly as it runs (480-frame window, one reading a second, median of five): Donkey Rhubarb reads 140 for 59% of readings and 69 for most of the rest, where the first version read 70 throughout; Above & Beyond reads 129 for 62%. Both drum and bass tracks read 111 to 115, two thirds of the truth, because the dotted-quarter pattern of their drums correlates more than the beat. A 3:2 rule that fixed one of them broke Above & Beyond, so it was not kept. Nothing uses tempo yet; if something comes to, it needs a better method than flux autocorrelation for drum and bass.

- The fluid scene, on the same Mac in headed Chromium 153 against the real library, the post stack on throughout. Each of the four tracks was searched for, started from the tracks list and opened with in-app navigation so the analyser survived, then left playing for ten and a half seconds before `data-frame-ms` was read; the artist on the footer was checked each time, because the tracks list reloads asynchronously and a click that lands early starts whatever was there before. The four numbers in each cell are Donkey Rhubarb, Above & Beyond, CamelPhat and Andy C in that order, and the particle field at 250k is the control. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit; no cell left the cap and none logged a console error:

  | Stage size                                             | Fluid 512             | Fluid 1024            | 250k particles        |
  | ------------------------------------------------------ | --------------------- | --------------------- | --------------------- |
  | 320 by 320, ratio 1 (docked)                           | 8.3, 8.2, 8.3, 8.4 ms | 8.4, 8.3, 8.3, 8.3 ms | 8.4, 8.4, 8.4, 8.3 ms |
  | 1920 by 1080 at ratio 2 (3840 by 2160, as full screen) | 8.2, 8.3, 8.4, 8.4 ms | 8.3, 8.7, 8.2, 8.4 ms | 8.3, 8.3, 8.2, 8.4 ms |

  Full screen cannot be requested without a gesture under automation, so the 3840 by 2160 case forces the stage to a 1920 by 1080 CSS box at ratio 2, which is the same canvas.

- What the stage showed on each track, screenshotted at 3840 by 2160. Donkey Rhubarb, whose percussion is sparse, gives three well separated plumes with soft round heads and long filamented tails, and the trickle carries the field through its quiet stretches rather than letting it settle. CamelPhat's Easier nearly fills the frame by 45 seconds with two interlocking masses of orange, magenta and teal whose edges curl down to a texel; the same passage at 1024 is thinner and wispier, because the emitter radius is a smaller fraction of the larger grid. Andy C's Back & Forth throws fast edge to edge streaks with heavy colour fringing along them, since its onsets are almost continuous and the post stack's chromatic split opens on every one. Above & Beyond sits between the two, three separate coloured plumes growing steadily. No track produced a flat white mass at either grid.

- Scene switching, twelve times between the particle field and the fluid while a track played: one `requestAdapter` and one `requestDevice` for the whole run, no `uncapturederror`, no console errors, and the canvas context configured once and never reconfigured, since only the scene is rebuilt. `data-scene` and `data-detail` followed the select each time and the frame time stayed at 8.3 to 8.4 ms throughout.

- Popout round trip with the fluid drawing, six times: one adapter and one device, the number of configured canvas contexts always exactly one ahead of the number unconfigured, no uncaptured errors and no console errors. Both canvases carried `fluid` and `512 fluid` with advancing frame times, the docked stage came back at 320 by 320, and playback was never interrupted across the whole run.

- The grid select, eight switches between 512 and 1024 while a track played: `data-detail` followed each time, no console errors, the frame time held, and the choice survived a reload as `musimo.visualizer-fluid-grid`.

- The raymarch scene, on the same Mac in headed Chromium 153 against the real library, the post stack on throughout. The same four tracks, each searched for, started from the tracks list and opened with in-app navigation, with the artist on the footer checked before anything was read, because the saved queue comes back from the backend a moment after the page loads and a click that lands early is overwritten by whatever played last. Each cell is `data-frame-ms` after ten and a half seconds, and the particle field at 250k is the control. The display runs at 120 Hz, so 8.3 ms means the GPU is not the limit:

  | Stage size, track                                      | Raymarch 64 | Raymarch 112 | 250k particles |
  | ------------------------------------------------------ | ----------- | ------------ | -------------- |
  | 320 by 320, ratio 1 (docked), Donkey Rhubarb           | 8.4 ms      | 8.2 ms       | 8.3 ms         |
  | 320 by 320, Above & Beyond                             | 8.4 ms      | 8.3 ms       | 8.4 ms         |
  | 320 by 320, CamelPhat                                  | 8.4 ms      | 8.2 ms       | 8.3 ms         |
  | 320 by 320, Andy C                                     | 8.4 ms      | 8.4 ms       | 8.4 ms         |
  | 1920 by 1080 at ratio 2 (3840 by 2160), Donkey Rhubarb | 18.6 ms     | 18.6 ms      | 8.4 ms         |
  | 3840 by 2160, Above & Beyond                           | 18.7 ms     | 18.1 ms      | 8.4 ms         |
  | 3840 by 2160, CamelPhat                                | 16.5 ms     | 15.0 ms      | 8.3 ms         |
  | 3840 by 2160, Andy C                                   | 19.5 ms     | 18.4 ms      | 8.4 ms         |

  Docked, the march is at the cap like everything else. At 3840 by 2160 it is not: a fill-bound pass shading eight million pixels through a fractal costs 15 to 20 ms on this machine, so full screen runs at 50 to 65 frames a second rather than 120. That is the honest number for this scene and the reason the caps exist. The two caps do not separate: 112 measured the same as 64, or a little faster, because what the frame costs is how much of the screen the fold covers and how many times it is folded, not the ceiling on a ray that has already stopped. Full screen cannot be requested without a gesture under automation, so the 4K case forces the stage to a 1920 by 1080 CSS box at ratio 2, which is the same canvas.

- What the stage showed, screenshotted at 3840 by 2160. The fold reads as a folded box with its faces cut away into galleries and filigree, lit from one side with the crevices dark and a coloured halo around the silhouette. On Donkey Rhubarb, whose treble is gentle, the fold runs six or seven times and the faces stay broad and plain, and the camera sits back. CamelPhat's Easier and Andy C's Back & Forth drive it the other way: the fold runs to twelve, the faces break into filigree down to a pixel at 4K, and the camera is pulled in on almost every onset, so the shape breathes at the beat. Colour drifts through the ramp over a minute or two, from deep blue and teal to green and gold, with the bloom taking the halo and nothing clipping to a flat white mass.

- Scene switching, twelve times around all three scenes while a track played: one `requestAdapter` and one `requestDevice` for the whole run, one `configure` and no `unconfigure`, no `uncapturederror` and no console errors. `data-scene` and `data-detail` followed the select every time and the frame time stayed at 8.3 to 8.4 ms docked throughout.

- The step select, six switches between 64 and 112 while a track played: `data-detail` followed each time, no console errors, the frame time held, and the choice survived a reload as `musimo.visualizer-raymarch-steps`.

- Popout round trip with the march drawing, six times: one adapter and one device for the whole run, the number of configured canvas contexts always exactly one ahead of the number unconfigured (7 against 6 at the end), no uncaptured errors and no console errors. Both canvases carried `raymarch` and `64-step raymarch` with advancing frame times, the docked stage came back at 320 by 320 each time, and playback was never interrupted across the run.

Not checked yet: a mid-range desktop GPU, and the fluid and the raymarch on a software rasteriser, which the reduced grid, sweep counts, halved step cap and half-resolution march are written for but no machine here can run.
