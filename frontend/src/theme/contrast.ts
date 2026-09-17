import { hexContrast } from './color'
import type { Theme } from './themes'
import type { ColorToken } from './tokens'

/* Which token pairs a person actually reads text through. `color.ts` does the arithmetic and knows
   nothing about themes; this is the theme rule that says which sums are worth showing. */

/** WCAG AA for body text. The editor warns below it and never refuses to save. */
export const MIN_CONTRAST = 4.5

export type ContrastPair = {
  label: string
  foreground: ColorToken
  background: ColorToken
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  {
    label: 'Text on the page background',
    foreground: '--color-text',
    background: '--color-canvas',
  },
  { label: 'Text on cards', foreground: '--color-text', background: '--color-raised' },
  { label: 'Secondary text on cards', foreground: '--color-muted', background: '--color-raised' },
  { label: 'Text on accent', foreground: '--color-accent-ink', background: '--color-accent' },
  {
    label: 'Error text on its background',
    foreground: '--color-danger',
    background: '--color-danger-bg',
  },
]

/** A ratio is null while a value is half-typed, which reads as "no number yet" rather than a fail. */
export type ContrastReading = ContrastPair & { ratio: number | null }

export const themeContrast = (colors: Theme['colors']): ContrastReading[] =>
  CONTRAST_PAIRS.map((pair) => ({
    ...pair,
    ratio: hexContrast(colors[pair.foreground], colors[pair.background]),
  }))
