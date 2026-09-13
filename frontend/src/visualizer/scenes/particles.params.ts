/**
 * The particle field's numbers: how hard the flow pushes, how far the
 * attractors reach, how bright a particle comes out. Pure TypeScript with no
 * GPU objects, like `fluid.params.ts` and `raymarch.params.ts`.
 *
 * Until presets these numbers lived in `particles.compute.wgsl` with the
 * feature packet multiplied into them on the GPU. They are on the CPU now and
 * arrive already modulated, so the shader reads the packet for nothing but
 * the clock, and a preset can point any feature at any of them.
 */
import type { ParticleKnob, Tuning } from '../presets/knobs'
import { PARTICLE_KNOBS } from '../presets/knobs'

export type ParticleParams = Record<ParticleKnob, number>

/** Floats in the params uniform; the Params struct in common.wgsl matches. */
export const PARTICLE_UNIFORM_FLOATS = 40
/** Where the tuning block starts, after the camera, the size and the count. */
const TUNING = 24

/**
 * The field as PR #56 tuned it by eye on real tracks at 3840 by 2160. The
 * three knobs that rest at zero (`attract`, `push`, `jitter`) do nothing
 * until a feature drives them, which is exactly what they did before.
 */
export const PARTICLE_DEFAULTS: ParticleParams = {
  /** Strength of the curl-noise flow field. */
  flow: 0.9,
  /** Spatial frequency of that noise; higher is finer. */
  noiseFrequency: 0.7,
  /** Pull toward the three orbiting attractors. */
  attract: 0,
  /** Outward push from the middle. */
  push: 0,
  /** Random acceleration added each frame. */
  jitter: 0,
  /** Spring holding the cloud together. */
  spring: 0.15,
  /** Velocity lost per second. */
  drag: 1.4,
  /** Fastest a particle may travel, in world units per second. */
  speedCap: 3,
  /** Multiplier on how far a particle moves for its velocity. */
  advance: 0.7,
  /** Chance a dead particle comes back this frame. */
  respawn: 0.15,
  /** How fast the attractors circle. */
  orbitSpeed: 0.35,
  /** How far out they circle. */
  orbitRadius: 0.8,
  /** Pushes the colour from cool to warm; the particle's seed spreads it. */
  warmth: -0.2,
  /** Brightness before speed adds to it. */
  brightness: 0.35,
  /** How much a fast particle adds to its own brightness. */
  speedLight: 0.4,
  /** Multiplier on a particle's size; 1 is the resting size. */
  sizeBump: 1,
}

/** The resolved knobs as this scene's own object, defaults for the rest. */
export function particleParams(tuning: Tuning): ParticleParams {
  const out = { ...PARTICLE_DEFAULTS }
  for (const knob of PARTICLE_KNOBS) out[knob] = tuning[knob] ?? PARTICLE_DEFAULTS[knob]
  return out
}

/**
 * Point size in framebuffer pixels, so full screen at ratio 2 keeps the look
 * a docked stage has.
 */
export const pointSize = (height: number) => 1.6 + (Math.max(1, height) / 720) * 1.2

/**
 * Additive blending sums every particle a pixel receives, so each one is
 * dimmed by how many are expected to land there: the count times a point's
 * area over the canvas area. That keeps a small docked stage and a 4K full
 * screen at the same brightness instead of one washing out to white.
 */
export function coverIntensity(count: number, size: number, width: number, height: number) {
  const area = Math.max(1, width) * Math.max(1, height)
  const cover = (count * Math.PI * size * size) / area
  return Math.min(1, Math.max(0.006, 0.65 / cover))
}

/**
 * Fill the params uniform. The layout is the Params struct in common.wgsl:
 * the camera matrix, the canvas, the count and the reset flag, the point size
 * and the coverage, then four vec4s of tuning.
 */
export function writeParticleUniform(
  params: ParticleParams,
  camera: Float32Array,
  width: number,
  height: number,
  count: number,
  reset: boolean,
  floats: Float32Array,
  uints: Uint32Array,
) {
  const size = pointSize(height)
  floats.set(camera, 0)
  floats[16] = width
  floats[17] = height
  uints[18] = count
  uints[19] = reset ? 1 : 0
  floats[20] = size
  floats[21] = coverIntensity(count, size, width, height)
  floats[TUNING] = params.flow
  // The shader multiplies the position by this before sampling the noise, so
  // a zero would sample one point for every particle and the flow would stop.
  floats[TUNING + 1] = Math.max(0.01, params.noiseFrequency)
  floats[TUNING + 2] = params.attract
  floats[TUNING + 3] = params.push
  floats[TUNING + 4] = params.jitter
  floats[TUNING + 5] = params.spring
  floats[TUNING + 6] = params.drag
  // A cap of zero would freeze every particle where it stands.
  floats[TUNING + 7] = Math.max(0.01, params.speedCap)
  floats[TUNING + 8] = params.advance
  floats[TUNING + 9] = params.respawn
  floats[TUNING + 10] = params.orbitSpeed
  floats[TUNING + 11] = params.orbitRadius
  floats[TUNING + 12] = params.warmth
  floats[TUNING + 13] = params.brightness
  floats[TUNING + 14] = params.speedLight
  floats[TUNING + 15] = Math.max(0, params.sizeBump)
}
