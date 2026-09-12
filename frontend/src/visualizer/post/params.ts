/**
 * The post stack's parameters and the pure maths that turns them, plus the
 * current feature packet, into the uniform every pass reads. No GPU objects
 * here, so all of it is unit tested; `PostStack.ts` owns the textures and the
 * passes and nothing else decides a number.
 *
 * One plain object holds every stage, so a later presets step can hand the
 * renderer a patch per preset and the stack needs no new API for it.
 */
import { F } from '../audio/FeatureExtractor'

/** The previous frame, warped a little and decayed, added under the new one. */
export type FeedbackParams = {
  enabled: boolean
  /** How much of the decayed history survives, 0 to 1. */
  amount: number
  /** Per-frame decay of the history, 0 to 1. */
  decay: number
  /** Scale applied to the history each frame; above 1 pushes trails outward. */
  zoom: number
  /** Radians of rotation applied to the history each frame. */
  rotate: number
}

export type BloomParams = {
  enabled: boolean
  /** Luminance a pixel must pass to bloom at all. */
  threshold: number
  /** Width of the soft knee around the threshold, so notes fade in. */
  knee: number
  /** How much of the blurred levels is added back. */
  intensity: number
  /** Weight per blur level, widest last. */
  weights: [number, number, number]
}

/** Red and blue read at slightly different radii; the beat pushes them apart. */
export type ChromaticParams = {
  enabled: boolean
  /** Split at the corner with no beat, in texture coordinates. */
  amount: number
  /** Extra split at `beatPulse` 1. */
  beat: number
}

export type TonemapParams = {
  enabled: boolean
  exposure: number
  /**
   * Where the roll-off starts, 0 to 1. Below it nothing changes; above it a
   * value is bent toward 1 and never reaches it, so no core clips flat.
   */
  shoulder: number
}

export type GrainParams = {
  enabled: boolean
  /** Peak-to-peak noise added at the end, in output units. */
  amount: number
}

export type PostParams = {
  /** Off skips every stage, leaving the composite a straight copy. */
  enabled: boolean
  feedback: FeedbackParams
  bloom: BloomParams
  chromatic: ChromaticParams
  tonemap: TonemapParams
  grain: GrainParams
}

/** A partial update, one stage at a time; what a preset will hand over. */
export type PostPatch = {
  enabled?: boolean
  feedback?: Partial<FeedbackParams>
  bloom?: Partial<BloomParams>
  chromatic?: Partial<ChromaticParams>
  tonemap?: Partial<TonemapParams>
  grain?: Partial<GrainParams>
}

/** post.composite.wgsl has one texture binding per level, so they match. */
export const BLOOM_LEVELS = 3

/**
 * Tuned by eye on real tracks at 3840 by 2160; see docs/visualizer.md. The
 * field already fills most of the frame, so anything generous here turns it
 * into a milky haze. The feedback gain on a still image is
 * 1 / (1 - amount * decay), about 1.19, and the bloom threshold sits high
 * enough that only the attractor cores glow.
 */
export const DEFAULT_POST_PARAMS: PostParams = {
  enabled: true,
  feedback: { enabled: true, amount: 0.22, decay: 0.72, zoom: 1.012, rotate: 0.002 },
  bloom: {
    enabled: true,
    threshold: 0.85,
    knee: 0.2,
    intensity: 0.35,
    weights: [0.5, 0.32, 0.18],
  },
  chromatic: { enabled: true, amount: 0.0008, beat: 0.003 },
  tonemap: { enabled: true, exposure: 1, shoulder: 0.6 },
  grain: { enabled: true, amount: 0.02 },
}

/** Floats in the shared uniform; PostParams in post.common.wgsl must match. */
export const POST_UNIFORM_FLOATS = 28

const clone = (params: PostParams): PostParams => ({
  enabled: params.enabled,
  feedback: { ...params.feedback },
  bloom: { ...params.bloom, weights: [...params.bloom.weights] },
  chromatic: { ...params.chromatic },
  tonemap: { ...params.tonemap },
  grain: { ...params.grain },
})

export const defaultPostParams = () => clone(DEFAULT_POST_PARAMS)

/** A new object with the patch applied; neither argument is touched. */
export function mergePostParams(base: PostParams, patch: PostPatch): PostParams {
  const merged = clone(base)
  if (patch.enabled !== undefined) merged.enabled = patch.enabled
  Object.assign(merged.feedback, patch.feedback)
  Object.assign(merged.bloom, patch.bloom)
  Object.assign(merged.chromatic, patch.chromatic)
  Object.assign(merged.tonemap, patch.tonemap)
  Object.assign(merged.grain, patch.grain)
  if (patch.bloom?.weights) merged.bloom.weights = [...patch.bloom.weights]
  return merged
}

export type PostStage = 'feedback' | 'bloom' | 'chromatic' | 'tonemap' | 'grain'

const STAGES: readonly PostStage[] = ['feedback', 'bloom', 'chromatic', 'tonemap', 'grain']

/** A stage runs only when both it and the whole stack are on. */
export const stageEnabled = (params: PostParams, stage: PostStage) =>
  params.enabled && params[stage].enabled

/**
 * True when at least one stage runs. With none of them the composite is a
 * straight copy of what the scene drew, which is the measurement the frame
 * times in docs/visualizer.md call the stack off.
 */
export const postIsActive = (params: PostParams) =>
  STAGES.some((stage) => stageEnabled(params, stage))

/** One line for the debug overlay: the stages that are on, or `off`. */
export function postSummary(params: PostParams): string {
  const on = STAGES.filter((stage) => stageEnabled(params, stage))
  return on.length ? on.map((stage) => (stage === 'chromatic' ? 'chroma' : stage)).join(' ') : 'off'
}

/** Half, quarter, eighth of the canvas, never smaller than one pixel. */
export const bloomLevelSize = (width: number, height: number, level: number) => ({
  width: Math.max(1, Math.floor(width / 2 ** (level + 1))),
  height: Math.max(1, Math.floor(height / 2 ** (level + 1))),
})

/**
 * The texture a level's horizontal blur reads. Every level but the first
 * reads the level above and halves it on the way in; the first reads what the
 * bright pass already wrote at its own size. The taps are spaced by this
 * texture's texels, so reading the canvas size here would blur level 0 half
 * as wide sideways as it does vertically.
 */
export const bloomSourceSize = (width: number, height: number, level: number) =>
  bloomLevelSize(width, height, Math.max(0, level - 1))

/**
 * Fill the shared uniform. Everything a stage's toggle decides is resolved
 * here rather than branched on in WGSL: a disabled stage writes zeroes that
 * make its term vanish, so the shaders stay straight-line.
 */
export function writePostUniform(
  params: PostParams,
  features: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
): Float32Array {
  const beat = features[F.beatPulse] ?? 0
  out[0] = width
  out[1] = height
  out[2] = 1 / Math.max(1, width)
  out[3] = 1 / Math.max(1, height)

  const feedback = params.feedback
  const trails = stageEnabled(params, 'feedback')
  out[4] = trails ? feedback.amount : 0
  out[5] = trails ? feedback.decay : 0
  // The shader divides by the zoom, so an off stage still writes the identity
  // warp rather than a zero.
  out[6] = trails ? feedback.zoom : 1
  out[7] = trails ? feedback.rotate : 0

  const bloom = params.bloom
  const glow = stageEnabled(params, 'bloom')
  out[8] = bloom.threshold
  out[9] = Math.max(bloom.knee, 0.0001)
  out[10] = glow ? bloom.intensity : 0
  out[11] = 0
  for (let level = 0; level < BLOOM_LEVELS; level++)
    out[12 + level] = glow ? (bloom.weights[level] ?? 0) : 0
  out[15] = glow ? 1 : 0

  // The beat only ever widens the split, so a track with no onsets keeps the
  // resting amount rather than collapsing to none.
  out[16] = stageEnabled(params, 'chromatic')
    ? params.chromatic.amount + params.chromatic.beat * beat
    : 0
  out[17] = 0
  out[18] = 0
  out[19] = 0

  const tone = stageEnabled(params, 'tonemap')
  out[20] = tone ? params.tonemap.exposure : 1
  // A shoulder of 1 would leave no headroom to bend the top into.
  out[21] = Math.min(Math.max(params.tonemap.shoulder, 0), 0.98)
  out[22] = tone ? 1 : 0
  out[23] = 0

  out[24] = stageEnabled(params, 'grain') ? params.grain.amount : 0
  // The hash in the shader loses its bite on large numbers, so the clock the
  // grain rides wraps every thousand seconds.
  out[25] = (features[F.time] ?? 0) % 1000
  out[26] = 0
  out[27] = 0
  return out
}
