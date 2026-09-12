/**
 * The fluid scene's numbers: the palette lookup table, where the emitters
 * sit, and how the feature packet drives the simulation. Pure TypeScript with
 * no GPU objects, like `post/params.ts`, so every choice here is unit tested
 * and `Fluid.ts` is left moving data between buffers.
 */
import { F } from '../audio/FeatureExtractor'
import { DEFAULT_FLUID_SIZE, FLUID_SIZES, SOFTWARE_FLUID_SIZE } from './catalog'

/** Emitters circling the grid. The WGSL array is this long. */
export const EMITTERS = 3
export const PALETTE_SIZE = 256

/** Floats in the sim uniform; the Sim struct in fluid.common.wgsl matches. */
export const SIM_UNIFORM_FLOATS = 16 + EMITTERS * 8

/** One injection. Positions and radii are fractions of the grid. */
export type Splat = {
  x: number
  y: number
  /** Unit direction the impulse pushes in. */
  dx: number
  dy: number
  /** Velocity added at the centre, in grid widths per second. */
  force: number
  /** Gaussian radius, in grid widths. */
  radius: number
  /** Dye added at the centre. */
  dye: number
  /** Where that dye sits in the palette, 0 to 1 and wrapping. */
  colour: number
}

export type FluidFrame = {
  /** Seconds the sim advances. Clamped, so a stalled tab cannot blow it up. */
  dt: number
  /** Decay of the velocity field, per second. */
  velocityDecay: number
  /** Decay of the dye, per second. */
  dyeDecay: number
  /** Vorticity confinement strength. */
  vorticity: number
  /** Jacobi alpha for the viscosity solve; larger smooths harder. */
  viscosity: number
  /** Multiplier on the dye's colour, before the post stack sees it. */
  intensity: number
  splats: Splat[]
}

/** The visible half-extents of the square grid, as `visibleExtent` gives them. */
export type Extent = { x: number; y: number }

const MAX_STEP = 1 / 30
const TWO_PI = Math.PI * 2

/**
 * How much of the square grid a canvas of this shape shows. The grid covers
 * the canvas and the overflow is cropped, so a round splat stays round; the
 * long side of the canvas sees the whole grid and the short side a band of
 * it. Emitters are placed inside that band so nothing is injected off screen.
 */
export function visibleExtent(width: number, height: number): Extent {
  const aspect = Math.max(1e-3, width) / Math.max(1e-3, height)
  return aspect >= 1 ? { x: 0.5, y: 0.5 / aspect } : { x: 0.5 * aspect, y: 0.5 }
}

/** The grid the sim runs on: the choice, or the small one on a rasteriser. */
export const simSize = (wanted: number, software: boolean) => {
  if (software) return SOFTWARE_FLUID_SIZE
  return FLUID_SIZES.includes(wanted) ? wanted : DEFAULT_FLUID_SIZE
}

/** Jacobi sweeps for the pressure solve. Fewer leaves the field divergent. */
export const pressureIterations = (software: boolean) => (software ? 8 : 24)

/** Jacobi sweeps for the viscosity solve. */
export const diffuseIterations = (software: boolean) => (software ? 1 : 2)

// A Lissajous figure per emitter. The tangent of the path is taken by
// difference rather than by hand, so the impulse pushes along the orbit
// whatever the curve is changed to.
const orbit = (phase: number) => ({
  x: Math.cos(phase) * 0.72 + Math.sin(phase * 2.3) * 0.24,
  y: Math.sin(phase * 0.9) * 0.7 + Math.cos(phase * 3.1) * 0.22,
})

/**
 * Everything the sim uniform needs for one frame.
 *
 * Injection is an onset event, packet index 8 with its strength at 9: bass
 * decides how hard the impulse pushes and how much dye it carries. A small
 * trickle rides along between hits, scaled by the step so it does not depend
 * on the frame rate, because a track with long quiet passages otherwise
 * settles into a still frame. Treble raises the vorticity and thins the
 * viscosity, so busy music keeps its detail. Energy sets both decays: a loud
 * passage injects far more, so it also has to clear faster.
 */
export function fluidFrame(features: Float32Array, dt: number, visible: Extent): FluidFrame {
  const step = Math.min(MAX_STEP, Math.max(0.001, dt))
  const time = features[F.time] ?? 0
  const bass = Math.max(features[F.sub] ?? 0, features[F.bass] ?? 0)
  const treble = features[F.treble] ?? 0
  const energy = features[F.energy] ?? 0
  const beat = features[F.beatPulse] ?? 0
  const hit = (features[F.onset] ?? 0) > 0.5 ? 0.3 + (features[F.onsetStrength] ?? 0) * 0.7 : 0

  const splats: Splat[] = []
  for (let index = 0; index < EMITTERS; index++) {
    const phase = time * 0.19 + (index * TWO_PI) / EMITTERS
    const here = orbit(phase)
    const ahead = orbit(phase + 0.05)
    const run = Math.hypot(ahead.x - here.x, ahead.y - here.y) || 1
    const spread = 0.42 + energy * 0.38
    splats.push({
      x: 0.5 + here.x * spread * visible.x,
      y: 0.5 + here.y * spread * visible.y,
      dx: (ahead.x - here.x) / run,
      dy: (ahead.y - here.y) / run,
      force: (0.45 + energy * 0.6) * step + hit * (0.3 + bass * 1.1),
      radius: 0.012 + bass * 0.016,
      dye: (1.6 + energy * 2) * step + hit * (1.1 + bass * 1),
      colour: (time * 0.035 + index / EMITTERS + treble * 0.12) % 1,
    })
  }

  return {
    dt: step,
    velocityDecay: 0.18 + energy * 0.22,
    dyeDecay: 0.22 + energy * 0.95,
    vorticity: 12 + treble * 38,
    viscosity: 0.02 + (1 - treble) * 0.18,
    intensity: 1.15 + beat * 0.5,
    splats,
  }
}

type Stop = { at: number; colour: readonly [number, number, number] }

/**
 * Deep blue through teal and green into warm orange and magenta, then back to
 * the first colour so the coordinate can wrap without a seam. The dye carries
 * its place in here as a unit vector, so two plumes that meet average their
 * colours the short way round rather than sweeping the whole palette.
 */
export const PALETTE_STOPS: readonly Stop[] = [
  { at: 0, colour: [0.04, 0.09, 0.34] },
  { at: 0.2, colour: [0.04, 0.45, 0.66] },
  { at: 0.38, colour: [0.14, 0.74, 0.54] },
  { at: 0.56, colour: [0.92, 0.72, 0.22] },
  { at: 0.74, colour: [0.94, 0.31, 0.26] },
  { at: 0.88, colour: [0.72, 0.22, 0.72] },
  { at: 1, colour: [0.04, 0.09, 0.34] },
]

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255)

/** The palette as one row of `rgba8unorm` texels, ready for `writeTexture`. */
export function paletteLut(size = PALETTE_SIZE): Uint8Array {
  const out = new Uint8Array(size * 4)
  for (let index = 0; index < size; index++) {
    const at = size > 1 ? index / (size - 1) : 0
    let next = 1
    while (next < PALETTE_STOPS.length - 1 && (PALETTE_STOPS[next]?.at ?? 1) < at) next++
    const from = PALETTE_STOPS[next - 1] ?? PALETTE_STOPS[0]
    const to = PALETTE_STOPS[next] ?? from
    if (!from || !to) continue
    const span = to.at - from.at
    const mix = span > 0 ? (at - from.at) / span : 0
    for (let part = 0; part < 3; part++)
      out[index * 4 + part] = channel(
        (from.colour[part] ?? 0) + ((to.colour[part] ?? 0) - (from.colour[part] ?? 0)) * mix,
      )
    out[index * 4 + 3] = 255
  }

  return out
}

/**
 * Fill the sim uniform. The layout is the Sim struct in fluid.common.wgsl:
 * grid, texel, two vec4s of settings, the cover scale, then one pair of
 * vec4s per emitter.
 */
export function writeSimUniform(
  frame: FluidFrame,
  size: number,
  visible: Extent,
  out: Float32Array,
): Float32Array {
  out[0] = size
  out[1] = size
  out[2] = 1 / size
  out[3] = 1 / size
  out[4] = frame.dt
  out[5] = frame.velocityDecay
  out[6] = frame.dyeDecay
  out[7] = frame.vorticity
  out[8] = frame.viscosity
  out[9] = frame.intensity
  out[10] = 0
  out[11] = 0
  // Canvas coordinates times this land in the grid; it is the visible band.
  out[12] = visible.x * 2
  out[13] = visible.y * 2
  out[14] = 0
  out[15] = 0
  for (let index = 0; index < EMITTERS; index++) {
    const splat = frame.splats[index]
    const base = 16 + index * 8
    out[base] = splat?.x ?? 0.5
    out[base + 1] = splat?.y ?? 0.5
    out[base + 2] = splat?.dx ?? 0
    out[base + 3] = splat?.dy ?? 0
    out[base + 4] = splat?.force ?? 0
    // The shader divides by the radius squared, so an empty slot still gets
    // a radius rather than a zero.
    out[base + 5] = Math.max(splat?.radius ?? 0.02, 0.001)
    out[base + 6] = splat?.dye ?? 0
    out[base + 7] = splat?.colour ?? 0
  }

  return out
}
