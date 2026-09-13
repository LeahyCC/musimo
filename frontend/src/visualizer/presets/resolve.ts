/**
 * The mapping applied. Once a frame the renderer takes the preset's resting
 * numbers, adds what the features are worth through this table, and hands the
 * result to the scene and to the post stack:
 *
 *   value = sceneParams[to] + Σ gain × curve(feature[from])
 *
 * All of it happens on the CPU. No scene shader reads the feature packet for
 * a magnitude any more, so a preset can send treble to a knob that used to
 * take bass without a line of WGSL changing.
 *
 * Both functions write into an object the caller owns and keeps, because this
 * runs on every animation frame and there is nothing here worth allocating.
 */
import { F } from '../audio/FeatureExtractor'
import { isPostKnob, POST_KNOBS, POST_LANES } from '../post/params'
import type { PostParams } from '../post/params'
import type { AudioField, Curve, SceneValues, Tuning } from './knobs'
import type { Mapping } from './types'

/** What a mapping's `from` reads. `lowEnd` is the louder of sub and bass. */
export function feature(features: Float32Array, field: AudioField): number {
  if (field === 'lowEnd') return Math.max(features[F.sub] ?? 0, features[F.bass] ?? 0)
  return features[F[field]] ?? 0
}

/** How the feature is bent before the gain. Negative input never survives. */
export function bend(value: number, curve: Curve): number {
  const level = Math.max(0, value)
  if (curve === 'square') return level * level
  if (curve === 'sqrt') return Math.sqrt(level)
  if (curve === 'invert') return 1 - Math.min(1, level)
  return level
}

/**
 * The scene's knobs for this frame, written into `out`. Rows pointing at a
 * post target are skipped here and picked up by `resolvePost`.
 */
export function resolveScene(
  base: SceneValues,
  mapping: readonly Mapping<string>[],
  features: Float32Array,
  out: Record<string, number>,
): Tuning {
  for (const [key, value] of Object.entries(base)) out[key] = value
  for (const row of mapping) {
    const current = out[row.to]
    if (current === undefined) continue
    out[row.to] = current + row.gain * bend(feature(features, row.from), row.curve)
  }

  return out
}

/**
 * The stack for this frame, written into `out`. Every lane is copied from the
 * preset first, so a row that stops driving a lane leaves it at rest rather
 * than wherever the last frame pushed it; the stage toggles and the bloom
 * weights are the preset's and are not modulated.
 */
export function resolvePost(
  base: PostParams,
  mapping: readonly Mapping<string>[],
  features: Float32Array,
  out: PostParams,
): PostParams {
  out.enabled = base.enabled
  for (const stage of ['feedback', 'bloom', 'chromatic', 'tonemap', 'grain'] as const)
    out[stage].enabled = base[stage].enabled
  out.bloom.weights = [base.bloom.weights[0], base.bloom.weights[1], base.bloom.weights[2]]
  for (const knob of POST_KNOBS) POST_LANES[knob].write(out, POST_LANES[knob].read(base))
  for (const row of mapping) {
    if (!isPostKnob(row.to)) continue
    const lane = POST_LANES[row.to]
    lane.write(out, lane.read(out) + row.gain * bend(feature(features, row.from), row.curve))
  }

  return out
}
