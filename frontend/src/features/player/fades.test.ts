import { describe, expect, it } from 'vitest'

import { fadeInGain, fadeOutGain, rampDown } from './fades'

describe('rampDown', () => {
  it('holds full level until the last stretch, then falls to silence', () => {
    expect(rampDown(30, 5)).toBe(1)
    expect(rampDown(5, 5)).toBe(1)
    expect(rampDown(2.5, 5)).toBe(0.5)
    expect(rampDown(0, 5)).toBe(0)
    expect(rampDown(-1, 5)).toBe(0)
  })

  it('is not a fade while the time left is unknown', () => {
    expect(rampDown(Infinity, 5)).toBe(1)
  })

  it('still ends at silence with no fade length', () => {
    expect(rampDown(1, 0)).toBe(1)
    expect(rampDown(0, 0)).toBe(0)
  })
})

describe('crossfade curves', () => {
  it('start with the old track alone and end with the new one alone', () => {
    expect(fadeOutGain(0)).toBeCloseTo(1)
    expect(fadeInGain(0)).toBeCloseTo(0)
    expect(fadeOutGain(1)).toBeCloseTo(0)
    expect(fadeInGain(1)).toBeCloseTo(1)
  })

  it('keep the power steady all the way through', () => {
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(fadeOutGain(progress) ** 2 + fadeInGain(progress) ** 2).toBeCloseTo(1)
    }
  })

  it('stay within the ends when the progress overshoots', () => {
    expect(fadeOutGain(-1)).toBeCloseTo(1)
    expect(fadeInGain(2)).toBeCloseTo(1)
    expect(fadeInGain(NaN)).toBeCloseTo(0)
  })
})
