import { describe, expect, it } from 'vitest'

import { bassBands } from './audio-graph'

describe('bass bands', () => {
  it('reads the level and only the upward jump', () => {
    const previous = new Float64Array(8)
    const bins = new Uint8Array(8)
    bins[1] = 255
    const first = bassBands(bins, previous, 1, 5)
    expect(first.level).toBeCloseTo(0.25)
    expect(first.flux).toBeCloseTo(0.25)

    bins[1] = 0
    const second = bassBands(bins, previous, 1, 5)
    expect(second.level).toBe(0)
    expect(second.flux).toBe(0)
  })
})
