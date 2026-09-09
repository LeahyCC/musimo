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
| `onset`                                   | float | currently always 0; a later card defines it                                                                                      |
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

## Determinism

- The hook must be pure. It must never read `Math.random`, `Date` or `performance`; a seek replays frames and would otherwise not reproduce.
- Noise textures are generated at load from `seed` with mulberry32. Nothing in the render path reads `Math.random`.
- The `seed` uniform is reduced modulo 2²⁴. Above that a float32 uniform cannot tell neighbouring seeds apart. The noise textures use the full seed, so two adjacent seeds always give different pictures.
- `fract` of an accumulator loses its fractional bits somewhere above 1e5 in a highp float. Wrap accumulators in the frame hook; `tunnel` wraps `travel` at 4096.

A seek does not reload a native study. `startAt` clears the pass buffers, builds a fresh `AudioLevelAnalyser`, resets `state` to `{}` and replays up to 120 frames. A canvas only ever yields one WebGL context, and `dispose()` loses that context deliberately, so loading a second native study needs a new engine on a new canvas — which is what the studio page already does on every rebuild.

## Fallback

Persistent buffers are RGBA16F ping-pong pairs through `EXT_color_buffer_float`. Without the extension every buffer falls back to RGBA8, the renderer warns once on the console, and `engine.floatBuffers` reports `false`. Feedback then clamps at 1.0 the way Butterchurn's 8-bit buffers do.

## Band levels

`visualizer/src/audio-levels.ts` is a port of Butterchurn's `FFT`, `AudioProcessor.processAudio` and `AudioLevels`: a 1024-point FFT of the window `samplePcm` produces, 512 magnitudes, the equalize table `-0.02 * ln((512 - i) / 512)`, and bands split at 20, 320, 2800 and 11025 Hz. It is pure and DOM-free. Verified against the pinned Butterchurn build on the same synthetic frames: identical to the bit.

Two properties of that design are worth knowing before writing a study against these numbers:

- `val` is a **ratio**, not a level: each band is divided by its own long-run average. A steady tone therefore drives every band back towards 1.0 within a few seconds, and 1.0 means "normal for this band", not "loud". Silence reads as exactly 1.0 once the long average falls under its floor.
- The equalize curve multiplies the lowest bins by nearly zero and the top of the treble band by 0.12, and `samplePcm` hands over 8-bit bytes. The quantisation floor of any loud sound outweighs a pure low fundamental in the treble sum, so a 60 Hz test tone does _not_ read as `bass > treb`. It does read as `bass > mid`, and the bass band tracks bass content far more than treble content does. Real broadband music is unaffected.

## Adding a study

1. Write `visualizer/src/studies/<id>.ts` exporting a `StudyManifest`.
2. Register it in `visualizer/src/studies/index.ts`.
3. Add an entry to `studies` in `visualizer/src/engine.ts` with `renderer: 'native'`.
4. Add an `<option>` to the picker in `visualizer/index.html`.

The loader rejects a pass, setting or hook key that is not a plain GLSL identifier or that collides with a built-in uniform, so a name clash fails at load with a readable message rather than inside a shader compile.
