import { describe, expect, it } from 'vitest'

import { LIGHT_THEME } from '../e2e/theme-fixtures'
import { contrastRatio, parseHex } from './theme/color'
import { CONTRAST_PAIRS, MIN_CONTRAST } from './theme/contrast'
import { BUILT_IN_THEMES, DEFAULT_THEME } from './theme/themes'
import { GLOW_MIX, glowFor, washFor } from './wash'

const covers = [
  { r: 200, g: 30, b: 30, a: 1 },
  { r: 30, g: 60, b: 220, a: 1 },
  { r: 240, g: 220, b: 40, a: 1 },
  { r: 20, g: 20, b: 20, a: 1 },
  { r: 235, g: 235, b: 235, a: 1 },
]

describe('washFor', () => {
  it('gives the default theme a wash', () => {
    for (const cover of covers) {
      expect(washFor(cover, DEFAULT_THEME.colors)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it.each(BUILT_IN_THEMES)('never makes text on the canvas harder to read in $name', (theme) => {
    const canvas = parseHex(theme.colors['--color-canvas'])
    for (const cover of covers) {
      const wash = washFor(cover, theme.colors)
      // No wash is always safe, so only a wash that was returned has to prove itself.
      if (wash === null) continue
      const painted = parseHex(wash)
      expect(painted, wash).not.toBeNull()
      for (const pair of CONTRAST_PAIRS) {
        if (pair.background !== '--color-canvas') continue
        const ink = parseHex(theme.colors[pair.foreground])
        if (!ink || !canvas || !painted) continue
        const before = contrastRatio(ink, canvas)
        expect(contrastRatio(ink, painted), `${pair.label} over ${wash}`).toBeGreaterThanOrEqual(
          Math.min(MIN_CONTRAST, before) - 1e-9,
        )
      }
    }
  })

  it('is fainter than the cover it came from', () => {
    const cover = { r: 200, g: 30, b: 30, a: 1 }
    const wash = parseHex(washFor(cover, DEFAULT_THEME.colors) ?? '')
    const canvas = parseHex(DEFAULT_THEME.colors['--color-canvas'])
    expect(wash).not.toBeNull()
    expect(canvas).not.toBeNull()
    if (!wash || !canvas) return
    expect(Math.abs(wash.r - canvas.r)).toBeLessThan(Math.abs(cover.r - canvas.r))
  })

  it('leaves a canvas that is not a color without a wash', () => {
    const colors = { ...DEFAULT_THEME.colors, '--color-canvas': 'nonsense' }
    expect(washFor(covers[0] ?? { r: 0, g: 0, b: 0, a: 1 }, colors)).toBeNull()
  })
})

// The covers that have a color to show: the two near-greys are covers a glow can do little with.
const saturated = covers.slice(0, 3)
const largestChannelGap = (one: string, two: string): number => {
  const first = parseHex(one)
  const second = parseHex(two)
  if (!first || !second) throw new Error(`Not colors: ${one}, ${two}`)

  return Math.max(
    Math.abs(first.r - second.r),
    Math.abs(first.g - second.g),
    Math.abs(first.b - second.b),
  )
}

describe('glowFor', () => {
  it('is the cover a fixed share of the way from the canvas, and the same for any theme', () => {
    const canvas = parseHex(DEFAULT_THEME.colors['--color-canvas'])
    const cover = { r: 200, g: 30, b: 30, a: 1 }
    const glow = parseHex(glowFor(cover, DEFAULT_THEME.colors) ?? '')
    expect(canvas).not.toBeNull()
    expect(glow).not.toBeNull()
    if (!canvas || !glow) return
    expect(glow.r).toBeCloseTo(canvas.r + (cover.r - canvas.r) * GLOW_MIX, 0)
    expect(glow.g).toBeCloseTo(canvas.g + (cover.g - canvas.g) * GLOW_MIX, 0)
    expect(glow.b).toBeCloseTo(canvas.b + (cover.b - canvas.b) * GLOW_MIX, 0)
  })

  it('is clearly visible against the canvas in the default and the light fixture theme', () => {
    for (const theme of [DEFAULT_THEME, LIGHT_THEME]) {
      for (const cover of saturated) {
        const glow = glowFor(cover, theme.colors) ?? ''
        const gap = largestChannelGap(glow, theme.colors['--color-canvas'])
        expect(gap, `${theme.name} ${glow}`).toBeGreaterThan(60)
      }
    }
  })

  it('is stronger than the wash, which has to keep the text readable', () => {
    const cover = { r: 200, g: 30, b: 30, a: 1 }
    for (const theme of BUILT_IN_THEMES) {
      const wash = washFor(cover, theme.colors)
      const glow = glowFor(cover, theme.colors) ?? ''
      const canvas = theme.colors['--color-canvas']
      expect(largestChannelGap(glow, canvas), theme.name).toBeGreaterThanOrEqual(
        wash ? largestChannelGap(wash, canvas) : 0,
      )
    }
  })

  it('leaves a canvas that is not a color without a glow', () => {
    const colors = { ...DEFAULT_THEME.colors, '--color-canvas': 'nonsense' }
    expect(glowFor({ r: 200, g: 30, b: 30, a: 1 }, colors)).toBeNull()
  })
})
