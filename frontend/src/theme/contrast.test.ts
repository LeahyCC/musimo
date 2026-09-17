import { describe, expect, it } from 'vitest'

import { CONTRAST_PAIRS, MIN_CONTRAST, themeContrast } from './contrast'
import { DEFAULT_THEME } from './themes'
import { TOKEN_NAMES } from './tokens'

describe('theme contrast', () => {
  it('reads every pair out of a theme', () => {
    const readings = themeContrast(DEFAULT_THEME.colors)

    expect(readings).toHaveLength(CONTRAST_PAIRS.length)
    for (const reading of readings) {
      expect(reading.ratio, reading.label).not.toBeNull()
      expect(reading.ratio ?? 0, reading.label).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
  })

  it('names only tokens a theme carries', () => {
    for (const pair of CONTRAST_PAIRS) {
      expect(TOKEN_NAMES).toContain(pair.foreground)
      expect(TOKEN_NAMES).toContain(pair.background)
    }
  })

  it('reports no number for a half-typed value rather than a failing one', () => {
    const readings = themeContrast({ ...DEFAULT_THEME.colors, '--color-text': '#e8ece' })

    expect(readings.find((reading) => reading.foreground === '--color-text')?.ratio).toBeNull()
  })
})
