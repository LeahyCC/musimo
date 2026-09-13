import { describe, expect, it } from 'vitest'

import { F, PACKET_LENGTH } from '../audio/FeatureExtractor'
import { defaultPostParams } from '../post/params'
import { bend, feature, resolvePost, resolveScene } from './resolve'
import type { Mapping } from './types'

const packet = (values: Partial<Record<keyof typeof F, number>>) => {
  const out = new Float32Array(PACKET_LENGTH)
  for (const [name, value] of Object.entries(values)) out[F[name as keyof typeof F]] = value
  return out
}

describe('feature', () => {
  it('reads the packet by name', () => {
    expect(feature(packet({ treble: 0.4 }), 'treble')).toBeCloseTo(0.4)
    expect(feature(packet({ beatPulse: 1 }), 'beatPulse')).toBe(1)
  })

  it('gives lowEnd the louder of sub and bass', () => {
    expect(feature(packet({ sub: 0.2, bass: 0.7 }), 'lowEnd')).toBeCloseTo(0.7)
    expect(feature(packet({ sub: 0.9, bass: 0.1 }), 'lowEnd')).toBeCloseTo(0.9)
  })
})

describe('bend', () => {
  it('keeps 0 at 0 and 1 at 1 except where inverting', () => {
    for (const curve of ['linear', 'square', 'sqrt'] as const) {
      expect(bend(0, curve)).toBe(0)
      expect(bend(1, curve)).toBeCloseTo(1)
    }

    expect(bend(0, 'invert')).toBe(1)
    expect(bend(1, 'invert')).toBe(0)
  })

  it('squares and roots in between', () => {
    expect(bend(0.5, 'square')).toBeCloseTo(0.25)
    expect(bend(0.25, 'sqrt')).toBeCloseTo(0.5)
  })

  it('never lets a negative feature through', () => {
    expect(bend(-1, 'linear')).toBe(0)
    expect(bend(-1, 'square')).toBe(0)
    expect(bend(-1, 'sqrt')).toBe(0)
    expect(bend(-1, 'invert')).toBe(1)
  })
})

describe('resolveScene', () => {
  const base = { flow: 1, jitter: 0 }

  it('is the resting value where nothing drives a knob', () => {
    const out = resolveScene(base, [], packet({ energy: 1 }), {})
    expect(out).toEqual({ flow: 1, jitter: 0 })
  })

  it('adds gain times the bent feature', () => {
    const mapping: Mapping<'flow' | 'jitter'>[] = [
      { from: 'energy', to: 'flow', gain: 2, curve: 'linear' },
      { from: 'treble', to: 'jitter', gain: 4, curve: 'square' },
    ]
    const out = resolveScene(base, mapping, packet({ energy: 0.5, treble: 0.5 }), {})
    expect(out.flow).toBeCloseTo(2)
    expect(out.jitter).toBeCloseTo(1)
  })

  it('adds several rows onto one knob', () => {
    const mapping: Mapping<'flow'>[] = [
      { from: 'energy', to: 'flow', gain: 1, curve: 'linear' },
      { from: 'beatPulse', to: 'flow', gain: 3, curve: 'linear' },
    ]
    expect(resolveScene({ flow: 1 }, mapping, packet({ energy: 1, beatPulse: 1 }), {}).flow).toBe(5)
  })

  it('takes a negative gain, which is how a feature thins a number', () => {
    const mapping: Mapping<'flow'>[] = [{ from: 'treble', to: 'flow', gain: -0.5, curve: 'linear' }]
    expect(resolveScene({ flow: 1 }, mapping, packet({ treble: 1 }), {}).flow).toBeCloseTo(0.5)
  })

  it('ignores a row aimed at the post stack', () => {
    const mapping: Mapping<'flow'>[] = [
      { from: 'energy', to: 'bloom.intensity', gain: 9, curve: 'linear' },
    ]
    const out = resolveScene({ flow: 1 }, mapping, packet({ energy: 1 }), {})
    expect(out).toEqual({ flow: 1 })
  })

  it('rewrites the object it is given rather than keeping last frame', () => {
    const out: Record<string, number> = {}
    const mapping: Mapping<'flow'>[] = [{ from: 'energy', to: 'flow', gain: 2, curve: 'linear' }]
    resolveScene({ flow: 1 }, mapping, packet({ energy: 1 }), out)
    expect(out.flow).toBe(3)
    resolveScene({ flow: 1 }, mapping, packet({ energy: 0 }), out)
    expect(out.flow).toBe(1)
  })
})

describe('resolvePost', () => {
  it('copies every lane, the switches and the weights from the preset', () => {
    const base = defaultPostParams()
    base.enabled = true
    base.grain.enabled = false
    base.bloom.intensity = 0.9
    base.bloom.weights = [0.4, 0.35, 0.25]
    const out = defaultPostParams()
    resolvePost(base, [], packet({}), out)
    expect(out.bloom.intensity).toBe(0.9)
    expect(out.bloom.weights).toEqual([0.4, 0.35, 0.25])
    expect(out.grain.enabled).toBe(false)
    // A copy, so a later frame cannot write back into the preset.
    expect(out.bloom.weights).not.toBe(base.bloom.weights)
  })

  it('adds a mapped lane on top of the preset', () => {
    const base = defaultPostParams()
    base.bloom.intensity = 0.3
    const out = defaultPostParams()
    const mapping: Mapping<'flow'>[] = [
      { from: 'energy', to: 'bloom.intensity', gain: 0.4, curve: 'linear' },
    ]
    resolvePost(base, mapping, packet({ energy: 0.5 }), out)
    expect(out.bloom.intensity).toBeCloseTo(0.5)
    expect(base.bloom.intensity).toBe(0.3)
  })

  it('falls back to the resting value once the feature does', () => {
    const base = defaultPostParams()
    base.feedback.amount = 0.2
    const out = defaultPostParams()
    const mapping: Mapping<'flow'>[] = [
      { from: 'treble', to: 'feedback.amount', gain: 0.2, curve: 'linear' },
    ]
    resolvePost(base, mapping, packet({ treble: 1 }), out)
    expect(out.feedback.amount).toBeCloseTo(0.4)
    resolvePost(base, mapping, packet({ treble: 0 }), out)
    expect(out.feedback.amount).toBeCloseTo(0.2)
  })

  it('ignores a row aimed at the scene', () => {
    const base = defaultPostParams()
    const out = defaultPostParams()
    const mapping: Mapping<'flow'>[] = [{ from: 'energy', to: 'flow', gain: 9, curve: 'linear' }]
    resolvePost(base, mapping, packet({ energy: 1 }), out)
    expect(out).toEqual(base)
  })
})
