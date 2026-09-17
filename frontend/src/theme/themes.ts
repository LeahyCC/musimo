import type { ColorToken } from './tokens'

/* The themes that ship with the app. One for now: the look the app has always had, written out so
   a person's own theme is the same kind of thing as the built-in one. Adding another is adding an
   object to the array below and nothing else.

   `musimo-dark` must stay equal to the `@theme` block in `src/style.css`, because that block is
   what paints the app when no theme is applied. `themes.test.ts` parses the sheet and compares the
   two, so the pair cannot drift. */

/** Sets `color-scheme`, so native dialogs, scrollbars and form controls follow the theme. */
export type ColorScheme = 'dark' | 'light'

export type Theme = {
  /** `musimo-dark` for the built-in, `custom-<uuid>` for a person's own. */
  id: string
  name: string
  scheme: ColorScheme
  colors: Record<ColorToken, string>
}

export const DEFAULT_THEME_ID = 'musimo-dark'

export const BUILT_IN_THEMES = [
  {
    id: DEFAULT_THEME_ID,
    name: 'Musimo dark',
    scheme: 'dark',
    colors: {
      '--color-canvas': '#111716',
      '--color-sidebar': '#0e1312',
      '--color-raised': '#17201b',
      '--color-sunken': '#151c19',
      '--color-hover': '#1e2a23',
      '--color-active': '#263327',
      '--color-media': '#020305',
      '--color-on-media': '#ffffff',
      '--color-scrim': '#000000',
      '--color-shadow': '#000000',
      '--color-text': '#e8ece8',
      '--color-muted': '#93a39b',
      '--color-faint': '#819088',
      '--color-line': '#2a3630',
      '--color-line-strong': '#344035',
      '--color-accent': '#c3e4a2',
      '--color-accent-ink': '#172014',
      '--color-accent-hot': '#d9ff73',
      '--color-good': '#c3e4a2',
      '--color-good-bg': '#283a28',
      '--color-good-line': '#4b6743',
      '--color-warn': '#f8ca76',
      '--color-warn-bg': '#342e1d',
      '--color-danger': '#efbaa2',
      '--color-danger-bg': '#39251f',
      '--color-danger-line': '#674343',
      '--color-owned-bg': '#2a3a27',
      '--color-partial': '#e4cc9c',
      '--color-partial-bg': '#3a3224',
      '--color-partial-line': '#4b4b3a',
    },
  },
] as const satisfies readonly Theme[]

export const DEFAULT_THEME: Theme = BUILT_IN_THEMES[0]
