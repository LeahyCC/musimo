import { describe, expect, it } from 'vitest'

import { contrastRatio, parseHex } from './theme/color'
import { CONTRAST_PAIRS, MIN_CONTRAST } from './theme/contrast'
import { BUILT_IN_THEMES, DEFAULT_THEME } from './theme/themes'
import { washFor } from './wash'

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
