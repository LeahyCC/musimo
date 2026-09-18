import type { Theme } from '../src/theme/themes'

/* A light theme for the browser suite. It is deliberately the opposite of the built-in one, so a
   surface that still paints its own color shows up as a dark patch rather than blending in.

   Every text pair the app relies on clears WCAG AA at 4.5:1 here (text on canvas, raised and
   sunken, and accent-ink on accent); `src/theme/color.test.ts` holds the built-in theme to the
   same bar. Keep that true when a value changes. */
export const LIGHT_THEME: Theme = {
  id: 'custom-paper',
  name: 'Paper',
  scheme: 'light',
  colors: {
    '--color-canvas': '#f5f7f2',
    '--color-sidebar': '#e7ebe2',
    '--color-raised': '#ffffff',
    '--color-sunken': '#eef1ea',
    '--color-hover': '#e2e7dc',
    '--color-active': '#d4e0cb',
    '--color-media': '#0b0d0a',
    '--color-on-media': '#ffffff',
    '--color-scrim': '#000000',
    '--color-shadow': '#000000',
    '--color-text': '#1b2318',
    '--color-muted': '#465043',
    '--color-faint': '#525c4f',
    '--color-line': '#cdd5c6',
    '--color-line-strong': '#aab5a2',
    '--color-accent': '#2e5c22',
    '--color-accent-ink': '#ffffff',
    '--color-accent-hot': '#3a6b18',
    '--color-good': '#2e5c22',
    '--color-good-bg': '#dfeed6',
    '--color-good-line': '#7d9b71',
    '--color-warn': '#6d4a06',
    '--color-warn-bg': '#f6ecd6',
    '--color-danger': '#8a2b16',
    '--color-danger-bg': '#f8e3dc',
    '--color-danger-line': '#bd8875',
    '--color-owned-bg': '#dcead2',
    '--color-partial': '#6b5109',
    '--color-partial-bg': '#f3ecd8',
    '--color-partial-line': '#c3b78c',
  },
}

/** What the boot script reads out of `musimo.theme-vars`. */
export const themeVars = (theme: Theme) => ({ scheme: theme.scheme, vars: { ...theme.colors } })

/** `rgb(17, 23, 22)`: how a computed style reports a six digit hex. */
export function rgb(hex: string): string {
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16)

  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`
}
