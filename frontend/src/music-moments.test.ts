import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  autoPresetsOn,
  CALM_MOMENTS,
  createMomentDetector,
  MOMENT_DEFAULTS,
  prefersReducedMotion,
} from './music-moments'

const FRAME = 16

/** Feeds a steady level, returning each change. */
function feedLevel(
  detector: ReturnType<typeof createMomentDetector>,
  level: number,
  start: number,
  ms: number,
  progress = 0,
) {
  const moments: { at: number; scene: string; blend: number }[] = []
  for (let now = start; now < start + ms; now += FRAME) {
    const moment = detector.sample(level, now, progress, 0)
    if (moment) moments.push({ at: now, ...moment })
  }
  return moments
}

/**
 * A kick every `period` ms: a short spike of bass and flux, then the bed. `from` is the clock the
 * pattern is aligned to, so a restart can keep the same kicks.
 */
function feedBeats(
  detector: ReturnType<typeof createMomentDetector>,
  start: number,
  ms: number,
  progress: number,
  from = start,
  bed = 0.5,
  kick = 0.85,
) {
  const period = 500
  const moments: { at: number; scene: string; blend: number }[] = []
  for (let now = start; now < start + ms; now += FRAME) {
    const into = (((now - from) % period) + period) % period
    const hit = into < 32
    const moment = detector.sample(hit ? kick : bed, now, progress, hit ? 0.25 : 0)
    if (moment) moments.push({ at: now, ...moment })
  }
  return moments
}

describe('music moments', () => {
  it('calls a drop when the bass comes back after a quiet stretch', () => {
    const detector = createMomentDetector()
    expect(feedLevel(detector, 0.15, 0, 8_000)).toEqual([])
    const moments = feedLevel(detector, 0.75, 8_000, 1000)
    expect(moments[0]?.scene).toBe('hard')
    expect(moments[0]?.blend).toBe(MOMENT_DEFAULTS.blendEarly)
    expect(moments[0]?.at).toBeLessThan(8_600)
    expect(moments).toHaveLength(1)
  })

  it('does nothing in silence, even late in the song', () => {
    const detector = createMomentDetector()
    expect(feedLevel(detector, 0, 0, 30_000, 0.9)).toEqual([])
  })

  it('only changes on a big hit at the start of a song', () => {
    const detector = createMomentDetector()
    const moments = feedBeats(detector, 0, 15_000, 0)
    expect(moments.length).toBeLessThanOrEqual(1)
    expect(moments.every((moment) => moment.scene === 'hard' && moment.at < 2000)).toBe(true)
    expect(feedBeats(detector, 15_000, 8_000, 0, 0)).toEqual([])
  })

  it('changes every 8 beats in the middle, on a picture that pulses', () => {
    const detector = createMomentDetector()
    feedBeats(detector, 0, 8_000, 0)
    detector.restart(8_000, 0)
    const moments = feedBeats(detector, 8_000, 6_000, 0.5, 0)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.scene).toBe('pulse')
    expect(moments[0]?.blend).toBe(MOMENT_DEFAULTS.blendMiddle)
    expect((moments[0]?.at ?? 0) - 8_000).toBeGreaterThanOrEqual(7 * 500)
    expect((moments[0]?.at ?? 0) - 8_000).toBeLessThanOrEqual(8 * 500 + 64)
  })

  it('changes every 4 beats near the end, with a shorter melt', () => {
    const detector = createMomentDetector()
    feedBeats(detector, 0, 8_000, 0)
    detector.restart(8_000, 0)
    const moments = feedBeats(detector, 8_000, 4_000, 0.9, 0)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.scene).toBe('pulse')
    expect(moments[0]?.blend).toBe(MOMENT_DEFAULTS.blendLate)
    expect(moments[0]?.blend ?? 1).toBeLessThan(MOMENT_DEFAULTS.blendMiddle)
    expect((moments[0]?.at ?? 0) - 8_000).toBeGreaterThanOrEqual(3 * 500)
    expect((moments[0]?.at ?? 0) - 8_000).toBeLessThanOrEqual(4 * 500 + 64)
  })

  it('picks a calmer picture when the song has gone quiet', () => {
    const detector = createMomentDetector()
    feedBeats(detector, 0, 8_000, 0, 0, 0.75, 0.95)
    detector.restart(8_000, 0)
    const moments = feedBeats(detector, 8_000, 6_000, 0.5, 0, 0.2, 0.45)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.scene).toBe('soft')
  })

  it('does not cut again while the melt is still going', () => {
    const detector = createMomentDetector()
    const first = feedLevel(detector, 0.15, 0, 8_000)
    expect(first).toEqual([])
    const drop = feedLevel(detector, 0.8, 8_000, 1000)
    expect(drop).toHaveLength(1)
    const at = drop[0]?.at ?? 0
    expect(feedLevel(detector, 0.15, at + 200, 800)).toEqual([])
    expect(feedLevel(detector, 0.85, at + 1000, 800)).toEqual([])
    const again = feedLevel(detector, 0.85, at + MOMENT_DEFAULTS.blendEarly * 1000 + 500, 2000)
    expect(again[0]?.scene).toBe('hard')
  })

  it('starts the phrase again when a preset is picked by hand', () => {
    const detector = createMomentDetector()
    feedBeats(detector, 0, 8_000, 0)
    detector.restart(8_000, 0)
    feedBeats(detector, 8_000, 3_200, 0.5, 0)
    detector.restart(11_200, 0)
    expect(feedBeats(detector, 11_200, 3_200, 0.5, 0)).toEqual([])
    expect(feedBeats(detector, 14_400, 2_000, 0.5, 0)).toHaveLength(1)
  })

  it('finishes a melt before the next phrase, even on a fast song', () => {
    const beatMs = 60_000 / 180
    expect(MOMENT_DEFAULTS.blendLate * 1000).toBeLessThan(MOMENT_DEFAULTS.lateBeats * beatMs)
    expect(MOMENT_DEFAULTS.blendMiddle * 1000).toBeLessThan(MOMENT_DEFAULTS.middleBeats * beatMs)
  })
})

describe('reduced motion', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Late in a song the defaults change about every 2 s; calm moments wait 8 s and melt slowly.
  it('spaces changes at least 8 s apart late in a song, with a long melt', () => {
    const detector = createMomentDetector(CALM_MOMENTS)
    feedBeats(detector, 0, 8_000, 0)
    detector.restart(8_000, 0)
    const moments = feedBeats(detector, 8_000, 30_000, 0.9, 0)
    expect(moments.length).toBeGreaterThan(1)
    expect(moments.every((moment) => moment.blend >= 2)).toBe(true)
    for (let i = 1; i < moments.length; i++)
      expect((moments[i]?.at ?? 0) - (moments[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(8_000)
    expect(feedBeats(createMomentDetector(), 8_000, 30_000, 0.9, 0).length).toBeGreaterThan(
      moments.length,
    )
  })

  it('also waits out the gap after a change made by hand', () => {
    const detector = createMomentDetector(CALM_MOMENTS)
    feedBeats(detector, 0, 8_000, 0)
    detector.restart(8_000, 0)
    expect(feedBeats(detector, 8_000, 7_900, 0.9, 0)).toEqual([])
  })

  it('starts "Change with the music" off for reduced motion unless it was chosen', () => {
    expect(autoPresetsOn('', false)).toBe(true)
    expect(autoPresetsOn('', true)).toBe(false)
    expect(autoPresetsOn('on', true)).toBe(true)
    expect(autoPresetsOn('off', false)).toBe(false)
  })

  it('reads the system setting, and says no where it cannot be read', () => {
    expect(prefersReducedMotion()).toBe(false)
    vi.stubGlobal('window', {})
    expect(prefersReducedMotion()).toBe(false)
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
    })
    expect(prefersReducedMotion()).toBe(true)
  })
})
