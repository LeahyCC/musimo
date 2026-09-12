import { describe, expect, it } from 'vitest'

import { F, PACKET_LENGTH } from '../audio/FeatureExtractor'
import {
  BLOOM_LEVELS,
  bloomLevelSize,
  bloomSourceSize,
  defaultPostParams,
  mergePostParams,
  POST_UNIFORM_FLOATS,
  postIsActive,
  postSummary,
  writePostUniform,
} from './params'
import type { PostParams } from './params'

const packet = (values: Partial<Record<keyof typeof F, number>> = {}) => {
  const out = new Float32Array(PACKET_LENGTH)
  for (const [name, value] of Object.entries(values)) out[F[name as keyof typeof F]] = value
  return out
}

const write = (params: PostParams, features = packet(), width = 1920, height = 1080) =>
  writePostUniform(params, features, width, height, new Float32Array(POST_UNIFORM_FLOATS))

describe('post parameters', () => {
  it('applies a patch without touching the object it was given', () => {
    const base = defaultPostParams()
    const patched = mergePostParams(base, {
      bloom: { intensity: 2, weights: [1, 0, 0] },
      grain: { enabled: false },
    })

    expect(patched.bloom.intensity).toBe(2)
    expect(patched.bloom.weights).toEqual([1, 0, 0])
    expect(patched.grain.enabled).toBe(false)
    // Untouched stages keep their values, and the original is unchanged.
    expect(patched.feedback).toEqual(base.feedback)
    expect(base.bloom.intensity).toBe(defaultPostParams().bloom.intensity)
    expect(base.grain.enabled).toBe(true)
  })

  it('is inactive only when the stack or every stage is off', () => {
    const base = defaultPostParams()
    expect(postIsActive(base)).toBe(true)
    expect(postIsActive(mergePostParams(base, { enabled: false }))).toBe(false)
    const nothing = mergePostParams(base, {
      feedback: { enabled: false },
      bloom: { enabled: false },
      chromatic: { enabled: false },
      tonemap: { enabled: false },
      grain: { enabled: false },
    })

    expect(postIsActive(nothing)).toBe(false)
    expect(postSummary(nothing)).toBe('off')
    expect(postSummary(mergePostParams(base, { bloom: { enabled: false } }))).toBe(
      'feedback chroma tonemap grain',
    )
    // The stack's own switch overrides the stages under it.
    const stackOff = mergePostParams(base, { enabled: false })
    expect(postSummary(stackOff)).toBe('off')
    expect(write(stackOff, packet({ beatPulse: 1 }))[16]).toBe(0)
    expect(write(stackOff)[10]).toBe(0)
  })

  it('halves each bloom level and never goes under a pixel', () => {
    expect(bloomLevelSize(1920, 1080, 0)).toEqual({ width: 960, height: 540 })
    expect(bloomLevelSize(1920, 1080, BLOOM_LEVELS - 1)).toEqual({ width: 240, height: 135 })
    expect(bloomLevelSize(3, 1, 2)).toEqual({ width: 1, height: 1 })
  })

  it('spaces a horizontal blur by the texels of the texture it reads', () => {
    // The first level reads what the bright pass wrote at its own size, not
    // the canvas; the rest read the level above and halve it on the way in.
    expect(bloomSourceSize(1920, 1080, 0)).toEqual(bloomLevelSize(1920, 1080, 0))
    for (let level = 1; level < BLOOM_LEVELS; level++) {
      expect(bloomSourceSize(1920, 1080, level)).toEqual(bloomLevelSize(1920, 1080, level - 1))
    }
  })
})

describe('the post uniform', () => {
  it('carries the resolution and its reciprocal', () => {
    const out = write(defaultPostParams(), packet(), 800, 400)
    expect([out[0], out[1]]).toEqual([800, 400])
    expect(out[2]).toBeCloseTo(1 / 800)
    expect(out[3]).toBeCloseTo(1 / 400)
  })

  it('widens the chromatic split with the beat pulse and never below the resting split', () => {
    const params = mergePostParams(defaultPostParams(), {
      chromatic: { enabled: true, amount: 0.001, beat: 0.004 },
    })

    expect(write(params, packet({ beatPulse: 0 }))[16]).toBeCloseTo(0.001)
    expect(write(params, packet({ beatPulse: 0.5 }))[16]).toBeCloseTo(0.003)
    expect(write(params, packet({ beatPulse: 1 }))[16]).toBeCloseTo(0.005)
  })

  it('zeroes each stage that is off, leaving the identity warp behind', () => {
    const off = mergePostParams(defaultPostParams(), {
      feedback: { enabled: false },
      bloom: { enabled: false },
      chromatic: { enabled: false },
      tonemap: { enabled: false },
      grain: { enabled: false },
    })

    const out = write(off, packet({ beatPulse: 1 }))
    expect([out[4], out[5], out[7]]).toEqual([0, 0, 0])
    // A zero zoom would divide by nothing in the shader.
    expect(out[6]).toBe(1)
    expect([out[10], out[12], out[13], out[14], out[15]]).toEqual([0, 0, 0, 0, 0])
    expect(out[16]).toBe(0)
    // An exposure of one and a mix of zero leave the colour as it was.
    expect([out[20], out[22]]).toEqual([1, 0])
    expect(out[24]).toBe(0)
  })

  it('passes the bloom weights and the tonemap through when they are on', () => {
    const params = mergePostParams(defaultPostParams(), {
      bloom: { threshold: 0.4, knee: 0.2, intensity: 0.8, weights: [0.5, 0.3, 0.2] },
      tonemap: { enabled: true, exposure: 1.2, shoulder: 0.5 },
    })

    // Single precision, so every value comes back a rounding away.
    const out = write(params)
    const slice = (from: number, count: number) =>
      Array.from({ length: count }, (_, offset) => out[from + offset] ?? 0)

    for (const [got, want] of [
      [slice(8, 3), [0.4, 0.2, 0.8]],
      [slice(12, 4), [0.5, 0.3, 0.2, 1]],
      [slice(20, 3), [1.2, 0.5, 1]],
    ]) {
      want?.forEach((value, index) => expect(got?.[index]).toBeCloseTo(value))
    }
  })

  it('keeps the grain clock small enough for the hash to stay noisy', () => {
    expect(write(defaultPostParams(), packet({ time: 12.5 }))[25]).toBeCloseTo(12.5)
    expect(write(defaultPostParams(), packet({ time: 4321 }))[25]).toBeCloseTo(321)
  })

  it('never lets a zero knee or a shoulder with no headroom divide in the shader', () => {
    const params = mergePostParams(defaultPostParams(), {
      bloom: { knee: 0 },
      tonemap: { shoulder: 1 },
    })

    const out = write(params)
    expect(out[9]).toBeGreaterThan(0)
    expect(out[21]).toBeLessThan(1)
  })
})
