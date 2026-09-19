import { describe, expect, it } from 'vitest'

import { contrastRatio, hexContrast, mixRgb, parseHex, relativeLuminance, toHex } from './color'
import { BUILT_IN_THEMES } from './themes'

describe('mixRgb and toHex', () => {
  const black = { r: 0, g: 0, b: 0, a: 1 }
  const white = { r: 255, g: 255, b: 255, a: 1 }

  it('moves part of the way from one color to the other', () => {
    expect(mixRgb(black, white, 0)).toEqual(black)
    expect(mixRgb(black, white, 1)).toEqual(white)
    expect(mixRgb(black, white, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 })
  })

  it('writes six digits, rounded and held to the range', () => {
    expect(toHex(white)).toBe('#ffffff')
    expect(toHex({ r: 17, g: 23, b: 22, a: 1 })).toBe('#111716')
    expect(toHex({ r: 127.5, g: -4, b: 300, a: 1 })).toBe('#8000ff')
  })

  it('reads back what it wrote', () => {
    expect(parseHex(toHex({ r: 195, g: 228, b: 162, a: 1 }))).toEqual({
      r: 195,
      g: 228,
      b: 162,
      a: 1,
    })
  })
})

describe('parseHex', () => {
  it('reads the three lengths a person can type', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseHex('#1a2')).toEqual({ r: 17, g: 170, b: 34, a: 1 })
    expect(parseHex('#111716')).toEqual({ r: 17, g: 23, b: 22, a: 1 })
    expect(parseHex('#000000ff')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseHex('  #C3E4A2  ')).toEqual({ r: 195, g: 228, b: 162, a: 1 })
  })

  it('reads the alpha channel as a fraction', () => {
    expect(parseHex('#00000000')?.a).toBe(0)
    expect(parseHex('#00000080')?.a).toBeCloseTo(0.502, 3)
  })

  it('refuses anything that is not a hex color', () => {
    for (const value of ['', '#', '#12', '#12345', 'red', 'url(x)', 'rgb(0,0,0)', '#12345g']) {
      expect(parseHex(value), value).toBeNull()
    }
  })
})

describe('contrast', () => {
  const white = { r: 255, g: 255, b: 255, a: 1 }
  const black = { r: 0, g: 0, b: 0, a: 1 }

  it('matches the WCAG reference figures', () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 10)
    expect(contrastRatio(white, black)).toBeCloseTo(21, 10)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 10)
    // Mid grey against each end, the pair every contrast tool is checked against.
    expect(hexContrast('#ffffff', '#808080')).toBeCloseTo(3.9494, 4)
    expect(hexContrast('#000000', '#767676')).toBeCloseTo(4.6233, 4)
  })

  it('puts the sRGB channel weights where WCAG puts them', () => {
    expect(relativeLuminance(black)).toBe(0)
    expect(relativeLuminance(white)).toBeCloseTo(1, 10)
    expect(relativeLuminance({ r: 0, g: 255, b: 0, a: 1 })).toBeCloseTo(0.7152, 6)
  })

  it('reads the pair either way round', () => {
    expect(hexContrast('#000', '#fff')).toBeCloseTo(21, 10)
    expect(hexContrast('#fff', '#000')).toBeCloseTo(21, 10)
  })

  it('reports nothing rather than a number for a value that is not a color', () => {
    expect(hexContrast('nonsense', '#fff')).toBeNull()
    expect(hexContrast('#fff', 'nonsense')).toBeNull()
  })

  it.each(BUILT_IN_THEMES)('keeps $name readable', (theme) => {
    const colors = theme.colors
    const pairs: [string, string][] = [
      [colors['--color-text'], colors['--color-canvas']],
      [colors['--color-text'], colors['--color-raised']],
      [colors['--color-text'], colors['--color-sunken']],
      [colors['--color-accent-ink'], colors['--color-accent']],
    ]
    for (const [ink, behind] of pairs) {
      expect(hexContrast(ink, behind) ?? 0, `${ink} on ${behind}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
