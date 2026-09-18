import { hexContrast } from './color'
import { HEX_COLOR } from './schema'
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
  {
    label: 'Secondary text on the page background',
    foreground: '--color-muted',
    background: '--color-canvas',
  },
  { label: 'Secondary text on cards', foreground: '--color-muted', background: '--color-raised' },
  {
    label: 'Faint text on the page background',
    foreground: '--color-faint',
    background: '--color-canvas',
  },
  {
    label: 'Secondary text in the navigation',
    foreground: '--color-muted',
    background: '--color-sidebar',
  },
  { label: 'Accent on cards', foreground: '--color-accent', background: '--color-raised' },
  // The selected navigation item and the selected row both draw the accent on this surface.
  {
    label: 'Accent on a selected item',
    foreground: '--color-accent',
    background: '--color-active',
  },
  { label: 'Text on accent', foreground: '--color-accent-ink', background: '--color-accent' },
  // The downloads badge and the queue pill.
  {
    label: 'Text on the live accent',
    foreground: '--color-accent-ink',
    background: '--color-accent-hot',
  },
  {
    label: 'Good text on its background',
    foreground: '--color-good',
    background: '--color-good-bg',
  },
  {
    label: 'Warning text on its background',
    foreground: '--color-warn',
    background: '--color-warn-bg',
  },
  {
    label: 'Error text on its background',
    foreground: '--color-danger',
    background: '--color-danger-bg',
  },
  {
    label: 'Part-way text on its background',
    foreground: '--color-partial',
    background: '--color-partial-bg',
  },
  { label: 'Text over artwork', foreground: '--color-on-media', background: '--color-media' },
]

/** A ratio is null while a value is half-typed, which reads as "no number yet" rather than a fail. */
export type ContrastReading = ContrastPair & { ratio: number | null }

export const themeContrast = (colors: Theme['colors']): ContrastReading[] =>
  CONTRAST_PAIRS.map((pair) => ({
    ...pair,
    // The arithmetic also reads three and four digit hex. A theme does not, so neither does this:
    // the report must not show a number for a value the editor is refusing.
    ratio:
      HEX_COLOR.test(colors[pair.foreground]) && HEX_COLOR.test(colors[pair.background])
        ? hexContrast(colors[pair.foreground], colors[pair.background])
        : null,
  }))
