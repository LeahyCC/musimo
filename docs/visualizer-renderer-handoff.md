# Visualizer renderer handoff

9 September 2026. The replacement described below is complete: Butterchurn is gone and every study runs on the native renderer.

9 September 2026. Branch `feature/music-visualizer`. Continue from here in a fresh session. Colin decided to replace Butterchurn with a small WebGL2 renderer of our own so the visualizer can support a wide range of effects. The feature is not being scrapped: everything outside the renderer stays.

## Decision

```
KEEP  (engine-agnostic, verified)          REPLACE
  owner contract: canvas + PCM + media       Butterchurn (3.0.0-beta.5)
  time in, fixed 60 Hz steps, seek rebuild     8-bit feedback, clamps at 1.0
  song analysis, score, JourneyController      one warp + one comp pass, fixed
  studio page, transport, record, panel        JS-compiled equations
  replay / determinism tests, docs             iframe realm, canvas blit
```

Why: Colin's reference effects (fractal mandalas with infinite depth, Julia spirals, Mandelbulb, liquid contour fields, wireframe grids, photo kaleidoscopes) need float buffers, several passes, line geometry and a texture input. Butterchurn gives one 8-bit feedback pass and one display pass. Verified in `visualizer/node_modules/butterchurn/dist/butterchurn.js`: feedback textures are `RGBA`/`UNSIGNED_BYTE` (line 11587); pipeline is warp → up to three blur passes → comp → 2D-canvas blit; `aspect` uniform is `(1, h/w, 1, w/h)` for wide output.

## What exists today

- `visualizer/src/engine.ts`: `VisualizerEngine`. Owner supplies canvas, stereo PCM at 44.1 kHz, width, optional score and studio options. `load(study)`, `startAt(seconds)` (rebuilds up to 120 frames from the seed), `advance(seconds)`. Keep this interface; the new renderer sits behind it.
- `visualizer/src/renderer-sandbox.ts`: the Butterchurn iframe realm. Goes away with Butterchurn.
- `visualizer/src/journey.ts`, `journey-preset.ts`, `songs/`: score and controller. Keep. The Dive study is Sherwin Maxawow's liquid (warp + comp GLSL, about 40 lines, plus simple frame/pixel equations) with tints and transitions driven by `q21..q30`. Port it to the new renderer; `journey-preset.ts` shows every replacement made to the original.
- `visualizer/src/effects-presets.ts`: Phosphor, Kaleidoscope V1, Prism, each with its own feedback, motion and sources. `kaleidoscope-v2-preset.ts` (fractal feedback + log-polar tunnel) and `kaleidoscope-v3-preset.ts` (kaleidoscopic IFS evaluated per pixel, orbit-trap colouring, log-polar tunnel with two drifting Möbius centres). V3 is the approach that matches the references; its GLSL is engine-agnostic and moves over unchanged.
- `visualizer/src/studio-options.ts`: theme, motion, trails, sensitivity, seed. Currently baked into shader text at build time (one rebuild per change). In the new renderer these become uniforms, live, no rebuild.
- `visualizer/src/main.ts`, `index.html`: the studio page at `http://127.0.0.1:5180`. Study picker includes `kaleidoscope2` and `kaleidoscope3`.
- Tests: `tests/*.test.ts` (node), `tests/replay.browser.mjs` (determinism, seeks, isolation), `tests/preview.browser.mjs`, `tests/soak.browser.mjs`. Colin asked for no test work during the study iterations; the replay check is still the right acceptance for the new renderer.

None of today's shader work was compiled or viewed: the session's tool gate was down throughout. Expect GLSL typos in V1 rework, V2 and V3. The page reports them as "Visual unavailable: …".

## The new renderer

`visualizer/src/study-renderer.ts`, roughly 400 lines.

- WebGL2 on the owner's canvas directly. `EXT_color_buffer_float` for RGBA16F ping-pong buffers; fall back to RGBA8 with a warning.
- A study is a manifest: passes in order, each a fragment shader with named inputs (previous frame, other passes, noise textures, an optional image/video texture) and an output (persistent buffer or screen). Optional line-geometry pass for wireframe effects.
- Uniforms every pass gets: `time`, `frame`, `resolution`, `aspect`, band levels `bass/mid/treb/vol` and their attack-smoothed `_att`, an onset value, `seed`, and the study's live settings.
- Band analysis: our own, about 100 lines, over the 1,024-sample window `samplePcm` already produces. Butterchurn's `AudioLevels` (512-point FFT, band splits, attenuated averages) is the reference for matching today's feel.
- Deterministic: fixed step, instance-local noise textures seeded from `seed`, no `Math.random` at render time. Same `startAt` reconstruction policy. Exact checkpoints (float readback) become possible later.
- Reserved-name and precision notes carry over: `highp float`, avoid relying on `fract` of large accumulators beyond ~1e5.

## Cards, in order (kungfu)

1. Study renderer core: buffers, passes, uniforms, noise, manifest loader, `VisualizerEngine` wiring behind a `renderer: 'butterchurn' | 'native'` switch.
2. Band analysis + onset, matched against Butterchurn's levels on the Dive recording.
3. Kaleidoscope V3 as the first native study, plus live settings as uniforms (folds, depth speed, spin, glow). Julia spiral and liquid-contour studies as cheap second and third.
4. Dive port: Sherwin liquid + journey q-driven tints, transitions (noise dissolve, zoom-through). Acceptance: replay check passes on the native renderer.
5. Remove Butterchurn, the sandbox, `vendor.d.ts`, `THIRD_PARTY_NOTICES` entries; update README and build record.

Run the board per `Rules/kungfu.md`: Sensei to `suggest`, PR auto-fixers off, PRs into `feature/music-visualizer`, Claude spawns, reviews and merges. Colin tests every card on the studio page at 5180.

## Still open from today

- Docs and README describe the old studies.
- Colin's reference link `https://github.com/pedrotrschneider/shader-fractals` (Godot fold-and-iterate fractals, licence unverified) and a Pinterest gif `https://i.pinimg.com/originals/59/96/1b/59961bd64c3a5d20db2d47d3b97c2914.gif` were not fetched; check both.
- Per-study settings panel (replaces the single shared Customize panel).
