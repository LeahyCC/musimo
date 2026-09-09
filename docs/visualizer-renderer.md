# Native study renderer

`visualizer/src/study-renderer.ts` draws a study with WebGL2 on the owner's canvas. It sits behind `VisualizerEngine` beside the Butterchurn path: every entry in `studies` carries `renderer: 'butterchurn' | 'native'`, and `load` picks the path from it. Butterchurn keeps its iframe realm and its presets; a native study has no realm, compiles no JavaScript from preset text and never touches the host's globals.

## A study is a manifest

Types live in `visualizer/src/study-manifest.ts`. Manifests live in `visualizer/src/studies/`.

```
StudyManifest
  id, name, author
  passes    StudyPass[]          in order
  frame?    (context) => Record<string, number>
  settings? StudySetting[]       live numeric uniforms
  blur?     { source, levels: 3 }

StudyPass
  name        a GLSL identifier, also the sampler name other passes read
  glsl        a fragment body that assigns `ret`, a vec3
  output      'buffer' | 'screen'
  persistent? ping-pong: the pass reads its own previous frame
  scale?      resolution as a fraction of the canvas, default 1
  format?     'rgba16f' | 'rgba8', default rgba16f
```

The GLSL body follows Butterchurn's `shader_body` convention, so preset GLSL ports without edits: declare nothing, assign `ret`. The renderer wraps it.

```
  vec2 p = (uv - .5) * aspect.xy;
  ret = texture(sampler_feedback, uv).rgb * decay;
```

## Uniforms every pass gets

| Uniform                                   | Type  | Meaning                                                                                                                          |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `time`                                    | float | media seconds                                                                                                                    |
| `frame`                                   | float | media frame at 60 per second                                                                                                     |
| `resolution`                              | vec2  | canvas size in pixels                                                                                                            |
| `aspect`                                  | vec4  | `xy` multiplies `uv - .5` into square coordinates, `zw` inverts it. For wide output `(1, h/w, 1, w/h)`, Butterchurn's convention |
| `texsize`                                 | vec4  | `w, h, 1/w, 1/h` of **this pass's** target, which differs from `resolution` on a scaled pass                                     |
| `bass` `mid` `treb` `vol`                 | float | band levels                                                                                                                      |
| `bass_att` `mid_att` `treb_att` `vol_att` | float | their attack-smoothed companions                                                                                                 |
| `onset`                                   | float | spectral-flux onset, 0..1, scaled by sensitivity                                                                                 |
| `seed`                                    | float | the resolved seed, reduced modulo 2²⁴ so it stays exact in a single-precision uniform                                            |
| `motion` `trails` `sensitivity` `desat`   | float | the studio options, live                                                                                                         |
| `tintA` `tintB` `tintC`                   | vec3  | the theme's motif tints                                                                                                          |

Plus one float per `settings` entry, by name, and one per key the `frame` hook returns.

Varyings are `uv` in 0..1 and `uv_orig` as an alias of it. The preamble declares `precision highp float`.

### Samplers

- `sampler_noise_lq`, `sampler_noise_mq`, `sampler_noise_hq` — 256 by 256 RGBA8, REPEAT, mipmapped, linear. `lq` is white noise; `mq` and `hq` are cubically smoothed with zoom 4 and 8, ported from Butterchurn's `Noise.createNoiseTex`.
- `sampler_<pass>` — for every buffer pass already rendered this frame, and for a persistent pass its own previous frame.
- `sampler_blur1`, `sampler_blur2`, `sampler_blur3` — when `blur` is declared, three separable Gaussian levels at 1/2, 1/4 and 1/8 of the source pass's resolution, rendered straight after the source pass. Only passes _after_ the source pass can read them.

Buffers are LINEAR and CLAMP_TO_EDGE. WebGL2 filters half-float natively, so there is no extension to ask for. A pass that wants wrapping does it in GLSL.

## The frame hook

```ts
frame({ state, time, frame, audio, settings, options, journey }) {
  state.travel = ((state.travel ?? 0) + 0.35 * options.motion) % 4096
  return { travel: state.travel, decay: 0.93 }
}
```

This replaces Butterchurn's frame equations and its `q` variables. Every number it returns becomes a float uniform of that name in every pass.

`state` is a plain object the study mutates for its accumulators. It is reset to `{}` on `load` and at the start of every `startAt` reconstruction. `journey` carries the `JourneyState` from `JourneyController.sample(position)` whenever the engine has a score, so a study can map score state to its own uniforms rather than the engine special-casing it.

The renderer discovers the hook's uniform names by calling it once at load with idle inputs and a scratch state, because the shader preamble has to declare them before the first frame. The keys of that first result are the contract: a key returned only on later frames is ignored.

## Live settings

A `settings` entry becomes a float uniform of that name in every pass and an
entry in the `settings` object the frame hook receives.

```ts
settings: [{ name: 'folds', label: 'Folds', min: 4, max: 16, step: 1, default: 8 }]
```

`engine.setSetting(name, value)` writes one. Nothing rebuilds: the value is set
on the next `render`, so a slider can follow a drag. `engine.studySettings`
reads them all back and `engine.studyManifest` hands out the declarations, which
is what the studio page generates its "This study" panel from.

Settings are part of the deterministic frame, not a display-only grade. The hook
reads them, so the accumulators a reconstruction rebuilds depend on them. An
owner that persists settings therefore has to put them into the engine **before**
`startAt`, or the rebuilt history belongs to the values the study started with.
The studio page does this in `prepareRenderer`, between `load` and `startAt`.

Values arriving from storage or a query string are untrusted. `setSetting`
rejects a name the manifest never declared and a non-finite number, but it does
not clamp: the owner clamps to the declared `min` and `max`, because those are
the bounds the shader was written against.

## Determinism

- The hook must be pure. It must never read `Math.random`, `Date` or `performance`; a seek replays frames and would otherwise not reproduce.
- Noise textures are generated at load from `seed` with mulberry32. Nothing in the render path reads `Math.random`.
- The `seed` uniform is reduced modulo 2²⁴. Above that a float32 uniform cannot tell neighbouring seeds apart. The noise textures use the full seed, so two adjacent seeds always give different pictures.
- `fract` of an accumulator loses its fractional bits somewhere above 1e5 in a highp float. Wrap accumulators in the frame hook; `tunnel` wraps `travel` at 4096.

A seek does not reload a native study. `startAt` clears the pass buffers, builds a fresh `AudioLevelAnalyser`, resets `state` to `{}` and replays up to 120 frames. A canvas only ever yields one WebGL context, and `dispose()` loses that context deliberately, so loading a second native study needs a new engine on a new canvas — which is what the studio page already does on every rebuild.

## Fallback

Persistent buffers are RGBA16F ping-pong pairs through `EXT_color_buffer_float`. Without the extension every buffer falls back to RGBA8, the renderer warns once on the console, and `engine.floatBuffers` reports `false`. Feedback then clamps at 1.0 the way Butterchurn's 8-bit buffers do.

## Band levels

`visualizer/src/audio-levels.ts` is a port of Butterchurn's `FFT`, `AudioProcessor.processAudio` and `AudioLevels`: a 1024-point FFT of the window `samplePcm` produces, 512 magnitudes, the equalize table `-0.02 * ln((512 - i) / 512)`, and bands split at 20, 320, 2800 and 11025 Hz. It is pure and DOM-free.

Each band edge is `clamp(round(hz / bucketHz) - 1, 0, 511)`, with `bucketHz = 44100 / 1024 ≈ 43.07 Hz`. That puts bass on bins `[0, 6)`, mid on `[6, 64)` and treble on `[64, 255)`. A band's `val` is its immediate magnitude sum divided by a long-run average of itself (rate 0.9 for the first 50 frames, 0.992 after, both quoted at 30 fps and adjusted for the renderer's fixed 60 fps step); `att` divides a short-run average (rate 0.2 rising, 0.5 falling, same adjustment) by that same long average.

Two properties of that design are worth knowing before writing a study against these numbers:

- `val` is a **ratio**, not a level: each band is divided by its own long-run average. A steady tone therefore drives every band back towards 1.0 within a few seconds, and 1.0 means "normal for this band", not "loud". Silence reads as exactly 1.0 once the long average falls under its floor.
- The equalize curve multiplies the lowest bins by nearly zero and the top of the treble band by 0.12, and `samplePcm` hands over 8-bit bytes. The quantisation floor of any loud sound outweighs a pure low fundamental in the treble sum, so a 60 Hz test tone does _not_ read as `bass > treb`. It does read as `bass > mid`, and the bass band tracks bass content far more than treble content does. Real broadband music is unaffected.

`visualizer/tests/levels.browser.mjs` drives a Butterchurn `sherwin` engine and a native `tunnel` engine on the same Dive recording from `startAt(0)`, steps both through the first 20 seconds at 60 Hz and compares every frame after the first 50 (once both analysers are past the fast/slow long-average switch). The worst relative difference across `bass`, `mid`, `treb` and their `_att` companions was 0: the port is bit-identical to Butterchurn's own analyser on real audio, not only on synthetic test frames.

## Onset

`AudioLevelAnalyser` also tracks onset, a 0..1 measure of how much louder the spectrum just got. Each frame:

1. Half-wave-rectified spectral flux: `sum(max(0, spectrum[bin] - previousSpectrum[bin]))` over all 512 equalized bins, so a drop in level contributes nothing. The first frame after a reset has no previous spectrum and counts as zero flux, so a seek reconstruction does not begin with a flash.
2. The flux is placed between two running references: a slow baseline (rate 0.992 at the renderer's 60 fps, 0.9 for the first 50 frames after a reset so it settles inside the seek budget) and a recent peak that halves every two seconds. `ratio = clamp((flux - baseline) / max(peak - baseline, 2 * baseline), 0, 1)`. A steady passage has flux near its own baseline and reads close to 0; a hit reaches the recent peak and reads 1. The floor of twice the baseline stops the ordinary jitter of a steady passage grading itself as onsets when no hit has set the scale. Dividing by the baseline alone does not work: the mean of that ratio is 1 by construction, so sustained music sat at 1 and hid every hit.
3. The ratio is smoothed with an attack constant of 0.16 s when it is rising and a release constant of 0.65 s when it is falling: the same two constants `JourneyController` uses for its own onset feature, so the native path's transients move on the same timescale as the score's.

The module has no opinion on studio options: the engine reads `AudioLevelAnalyser.onset` and multiplies it by `sensitivity` before setting the `onset` uniform. `visualizer/tests/audio-levels.test.ts` checks silence holds it at exactly 0, a 2 Hz click train produces a clear peak at each click that settles low before the next one, a sustained broadband signal settles near 0 within two seconds while a burst inside it still registers, and the value never leaves 0..1.

## Adding a study

1. Write `visualizer/src/studies/<id>.ts` exporting a `StudyManifest`. `studies/common.ts` holds what the existing studies share: the relief lighting snippet, a seed-derived phase, the band smoother and the accumulator wrap.
2. Register it in `visualizer/src/studies/index.ts`.
3. Add an entry to `studies` in `visualizer/src/engine.ts` with `renderer: 'native'`, keeping `name` and `author` the same as the manifest's.
4. Add an `<option>` to the picker in `visualizer/index.html`. The settings panel needs nothing: it reads the manifest.
5. Add the id to `STUDIES` in `visualizer/tests/native.browser.mjs`, which then asks it the determinism, seek and settings questions along with the rest.
6. Look at it. `node tests/soak.browser.mjs <id> <seekSeconds> <soakSeconds> <name>` seeks, simulates without real-time playback and screenshots the canvas into `test-results/`. A study can look right at twenty seconds and be a grey field at a hundred, so soak it well past the first minute.

The loader rejects a pass, setting or hook key that is not a plain GLSL identifier or that collides with a built-in uniform, so a name clash fails at load with a readable message rather than inside a shader compile. Two names it cannot catch: a setting or hook key that shadows a GLSL built-in function, `step` or `mix` for example, compiles into an error at the call site instead.

### Notes from the studies written so far

- Do not import from `effects-presets.ts`. It pulls a Butterchurn preset JSON in at module scope, so one string costs the whole package. The relief snippet lives in `studies/common.ts` for that reason, with its attribution.
- Every study must respond to the seed, or the seed assertion in the native check fails. Studies that sample the noise textures get this for free; a study that does not, such as `kaleidoscope3` or `julia`, uses `SEED_PHASE` from `studies/common.ts` to turn the `seed` uniform into a drift phase.
- Watch the feature size a fractal lands at. Kaleidoscope V3's IFS scale sets how quickly an orbit runs away and so how coarse its cells are; the preset's drift took it low enough that the whole tile fell under a pixel and the mandala read as grey noise. Its drift now stays above that floor.

## The studies

| Study           | id              | Passes                            | Settings                 |
| --------------- | --------------- | --------------------------------- | ------------------------ |
| Native tunnel   | `tunnel`        | persistent feedback, blur, screen | pull, folds, glow        |
| Kaleidoscope V3 | `kaleidoscope3` | persistent fractal, blur, screen  | folds, depth, spin, glow |
| Julia spiral    | `julia`         | screen                            | zoom, spiral, bands      |
| Liquid contours | `contours`      | persistent field, screen          | lines, flow              |
