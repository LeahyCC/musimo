import { describe, expect, it } from 'vitest'

import {
  BAR_FILL,
  barCountFor,
  barsPath,
  DEFAULT_BARS,
  MIN_BAR_HEIGHT,
  MIN_BARS,
  playedPercent,
  resamplePeaks,
} from './waveform'

describe('barCountFor', () => {
  it('fits one bar to each slot of the measured width', () => {
    expect(barCountFor(800, 800)).toBe(200)
    expect(barCountFor(330, 800)).toBe(83)
  })

  it('never asks for more bars than there are peaks, nor fewer than a readable few', () => {
    expect(barCountFor(4000, 800)).toBe(800)
    expect(barCountFor(400, 100)).toBe(100)
    expect(barCountFor(20, 800)).toBe(MIN_BARS)
  })

  it('uses a default before the bar has been measured', () => {
    expect(barCountFor(0, 800)).toBe(DEFAULT_BARS)
    expect(barCountFor(0, 60)).toBe(60)
  })
})

describe('resamplePeaks', () => {
  it('keeps the loudest peak of each slice', () => {
    expect(resamplePeaks([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([0.9, 0.3, 0.5])
  })

  it('leaves the peaks alone when there are no more bars than peaks', () => {
    expect(resamplePeaks([0.1, 0.2, 0.3], 3)).toEqual([0.1, 0.2, 0.3])
    expect(resamplePeaks([0.1, 0.2, 0.3], 50)).toEqual([0.1, 0.2, 0.3])
  })

  it('returns one bar for a count below one, and one silent bar for no peaks', () => {
    expect(resamplePeaks([0.4, 0.8], 0)).toEqual([0.8])
    expect(resamplePeaks([], 5)).toEqual([0])
  })
})

describe('barsPath', () => {
  it('draws one centred rectangle per bar, each in its own slot', () => {
    const path = barsPath([1, 0.5])
    const margin = (1 - BAR_FILL) / 2
    expect(path).toBe(
      `M${margin} 0h${BAR_FILL}v100h-${BAR_FILL}z` +
        `M${1 + margin} 25h${BAR_FILL}v50h-${BAR_FILL}z`,
    )
  })

  it('gives silence a sliver and clamps a stray value', () => {
    const height = (bar: number) => Number(/v([\d.]+)h/.exec(barsPath([bar]))?.[1])
    expect(height(0)).toBe(MIN_BAR_HEIGHT)
    expect(height(3)).toBe(100)
    expect(height(-1)).toBe(MIN_BAR_HEIGHT)
  })
})

describe('playedPercent', () => {
  it('is how far along the track the playhead is', () => {
    expect(playedPercent(15, 30)).toBe(50)
    expect(playedPercent(0, 30)).toBe(0)
  })

  it('stays within the bar for a position past the end, and for no length yet', () => {
    expect(playedPercent(40, 30)).toBe(100)
    expect(playedPercent(5, 0)).toBe(0)
    expect(playedPercent(Number.NaN, 30)).toBe(0)
  })
})
