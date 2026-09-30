import { describe, expect, it } from 'vitest'

import { createMomentDetector, MOMENT_DEFAULTS } from './music-moments'

const FRAME = 16

/** Feeds `level` for `ms` from `start`, returning each moment with its time. */
function feed(
  detector: ReturnType<typeof createMomentDetector>,
  level: number,
  start: number,
  ms: number,
) {
  const moments: { at: number; kind: string }[] = []
  for (let now = start; now < start + ms; now += FRAME) {
    const kind = detector.sample(level, now)
    if (kind) moments.push({ at: now, kind })
  }
  return moments
}

describe('music moments', () => {
  it('calls a drop when the bass comes back after a quiet stretch', () => {
    const detector = createMomentDetector()
    expect(feed(detector, 0.1, 0, 30_000)).toEqual([])
    const moments = feed(detector, 0.6, 30_000, 2000)
    expect(moments[0]?.kind).toBe('drop')
    expect(moments[0]?.at).toBeLessThan(30_500)
  })

  it('never changes sooner than the minimum gap', () => {
    const detector = createMomentDetector()
    feed(detector, 0.1, 0, 5000)
    expect(feed(detector, 0.8, 5000, 5000)).toEqual([])
  })

  it('moves on after the longest gap when the music is steady', () => {
    const detector = createMomentDetector()
    const moments = feed(detector, 0.5, 0, MOMENT_DEFAULTS.maxGapMs + 1000)
    expect(moments).toEqual([{ at: expect.any(Number), kind: 'drift' }])
    expect(moments[0]?.at).toBeGreaterThanOrEqual(MOMENT_DEFAULTS.maxGapMs)
  })

  it('does nothing in silence', () => {
    const detector = createMomentDetector()
    expect(feed(detector, 0, 0, 200_000)).toEqual([])
  })

  it('starts the gap again when a preset is picked by hand', () => {
    const detector = createMomentDetector()
    feed(detector, 0.1, 0, 30_000)
    detector.restart(30_000)
    expect(feed(detector, 0.6, 30_000, 2000)).toEqual([])
  })
})
