/**
 * The raymarch scene's numbers: where the camera sits, how far the march is
 * allowed to run, and how the feature packet bends the fold. Pure TypeScript
 * with no GPU objects, like `fluid.params.ts` and `post/params.ts`, so every
 * choice here is unit tested and `Raymarch.ts` is left moving data about.
 *
 * The two caps that matter are here rather than in the shader. A march has no
 * natural cost: a loud passage that folds the field tighter makes every ray
 * take more steps, and without a step cap and a distance cap one bar of music
 * could cost ten times the frame budget of the one before it.
 */
import { F } from '../audio/FeatureExtractor'
import { cameraBasis } from '../gpu/math'
import type { Basis, Vec3 } from '../gpu/math'
import { DEFAULT_RAYMARCH_STEPS, RAYMARCH_STEPS, SOFTWARE_RAYMARCH_SCALE } from './catalog'

/** Floats in the march uniform; the March struct in raymarch.common.wgsl matches. */
export const MARCH_UNIFORM_FLOATS = 32

/** Half the vertical field of view, as its tangent. */
const FOV_TANGENT = Math.tan(Math.PI / 7)
/** How far the camera orbits, and how far a beat is allowed to pull it in. */
const ORBIT = 7.0
const BEAT_PUSH = 0.9
const CLOSEST = 5.6
/** Mandelbox fold scale. Bass moves it across this range. */
const FOLD_MIN = 2.02
const FOLD_SPAN = 0.5
/** Fold iterations. Treble moves it across this range, a whole one at a time. */
const ITERATIONS_MIN = 6
const ITERATIONS_SPAN = 6
/** A ray stops when the field is nearer than this times the distance run. */
const EPSILON = 0.0016
/** Steps are shortened by this much, since the fold's estimate can overshoot. */
const RELAX = 0.9
/** Nothing is drawn past this; the fold is a few units across. */
const FAR = 22

export type MarchFrame = {
  eye: Vec3
  basis: Basis
  fovTangent: number
  /** Mandelbox fold scale, from bass. */
  fold: number
  /** Fold iterations, from treble. A whole number. */
  iterations: number
  /** The step cap for this frame. */
  steps: number
  far: number
  /** Surface threshold, per unit of distance run. */
  epsilon: number
  relax: number
  /** Unit direction the one light comes from. */
  light: Vec3
  /** How hard it lights, from energy. */
  lightStrength: number
  /** How tightly its shadow closes up. */
  shadowSoftness: number
  /** Halo from the step count, so a miss is not simply black. */
  glow: number
  /** How hard the step count darkens a crevice. */
  occlusion: number
  /** Where the surface sits in the colour ramp, 0 to 1 and wrapping. */
  shift: number
}

/**
 * The step cap for this frame. A CPU rasteriser gets half of whatever was
 * chosen, and marches at half the canvas on top of that.
 */
export function marchSteps(wanted: number, software: boolean): number {
  const cap = RAYMARCH_STEPS.includes(wanted) ? wanted : DEFAULT_RAYMARCH_STEPS
  return software ? Math.max(16, Math.round(cap / 2)) : cap
}

/** The fraction of the canvas the march itself runs at. */
export const renderScale = (software: boolean) => (software ? SOFTWARE_RAYMARCH_SCALE : 1)

/** The march's own size for a canvas, never smaller than a single texel. */
export function marchSize(width: number, height: number, software: boolean) {
  const scale = renderScale(software)
  return {
    width: Math.max(1, Math.round(Math.max(1, width) * scale)),
    height: Math.max(1, Math.round(Math.max(1, height) * scale)),
  }
}

/**
 * Everything the march uniform needs for one frame.
 *
 * Bass sets the fold scale, so the shape itself opens and closes with the low
 * end. Treble sets how many times the fold runs, which is where the fine
 * detail comes from, so busy music grows filigree and a quiet passage keeps
 * the plain shell. `beatPulse` pulls the camera in and back out, energy drives
 * the light and the halo, and the colour ramp drifts with time and bass.
 */
export function marchFrame(features: Float32Array, steps: number): MarchFrame {
  const time = features[F.time] ?? 0
  const bass = Math.max(features[F.sub] ?? 0, features[F.bass] ?? 0)
  const treble = features[F.treble] ?? 0
  const energy = features[F.energy] ?? 0
  const beat = features[F.beatPulse] ?? 0

  // A slow orbit that rises and falls, pulled in on the beat but never past
  // the shell: inside the fold the distance estimate is no use and the frame
  // turns to noise.
  const radius = Math.max(CLOSEST, ORBIT - beat * BEAT_PUSH - energy * 0.4)
  const yaw = time * 0.07
  const pitch = Math.sin(time * 0.11) * 0.38 + 0.12
  const eye: Vec3 = [
    Math.sin(yaw) * Math.cos(pitch) * radius,
    Math.sin(pitch) * radius,
    Math.cos(yaw) * Math.cos(pitch) * radius,
  ]

  const lightYaw = time * 0.23 + 1.1
  const light: Vec3 = [Math.sin(lightYaw) * 0.75, 0.62, Math.cos(lightYaw) * 0.75]
  const length = Math.hypot(light[0], light[1], light[2]) || 1

  return {
    eye,
    basis: cameraBasis(eye, [0, 0, 0], [0, 1, 0]),
    fovTangent: FOV_TANGENT,
    fold: FOLD_MIN + bass * FOLD_SPAN,
    iterations: ITERATIONS_MIN + Math.round(treble * ITERATIONS_SPAN),
    steps: Math.max(8, Math.round(steps)),
    far: FAR,
    epsilon: EPSILON,
    relax: RELAX,
    light: [light[0] / length, light[1] / length, light[2] / length],
    lightStrength: 1.5 + energy * 2.2,
    shadowSoftness: 10 + treble * 14,
    glow: 0.25 + energy * 0.5 + beat * 0.3,
    occlusion: 0.35 + (1 - energy) * 0.25,
    shift: (time * 0.021 + bass * 0.14) % 1,
  }
}

/**
 * Fill the march uniform. The layout is the March struct in
 * raymarch.common.wgsl: the eye and the three camera axes, each carrying one
 * scalar in its fourth lane, then the march's size, its caps, the light and
 * the look.
 */
export function writeMarchUniform(
  frame: MarchFrame,
  width: number,
  height: number,
  out: Float32Array,
): Float32Array {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  out[0] = frame.eye[0]
  out[1] = frame.eye[1]
  out[2] = frame.eye[2]
  out[3] = frame.fovTangent
  out[4] = frame.basis.right[0]
  out[5] = frame.basis.right[1]
  out[6] = frame.basis.right[2]
  out[7] = frame.fold
  out[8] = frame.basis.up[0]
  out[9] = frame.basis.up[1]
  out[10] = frame.basis.up[2]
  // The shader compares the field against this times the distance run, so a
  // zero would march the full cap on every ray and never report a hit.
  out[11] = Math.max(frame.epsilon, 1e-5)
  out[12] = frame.basis.forward[0]
  out[13] = frame.basis.forward[1]
  out[14] = frame.basis.forward[2]
  out[15] = 0
  out[16] = w
  out[17] = h
  out[18] = w / h
  out[19] = 0
  out[20] = frame.steps
  out[21] = frame.far
  out[22] = frame.iterations
  out[23] = frame.relax
  out[24] = frame.light[0]
  out[25] = frame.light[1]
  out[26] = frame.light[2]
  out[27] = frame.lightStrength
  out[28] = frame.glow
  out[29] = frame.occlusion
  out[30] = frame.shift
  out[31] = frame.shadowSoftness
  return out
}
