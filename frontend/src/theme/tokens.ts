/* The theme contract: the colors a person can change, in the order the editor shows them. The
   names and the reasoning behind them live in `docs/tailwind-migration.md`; the values are the
   `@theme` block at the top of `src/style.css`, which `themes.ts` mirrors. */

/** The headings the editor groups its swatches under. */
export type TokenGroup = 'Surfaces' | 'Text' | 'Lines' | 'Accent' | 'Status'

export type TokenDefinition = {
  /** The custom property the sheet and the Tailwind utilities read. */
  readonly name: string
  /** What the editor calls it. A role, never a shade. */
  readonly label: string
  readonly group: TokenGroup
}

/** The order the groups appear in. */
export const TOKEN_GROUPS: readonly TokenGroup[] = ['Surfaces', 'Text', 'Lines', 'Accent', 'Status']

export const COLOR_TOKENS = [
  { name: '--color-canvas', label: 'Page background', group: 'Surfaces' },
  { name: '--color-sidebar', label: 'Navigation', group: 'Surfaces' },
  { name: '--color-raised', label: 'Cards and sheets', group: 'Surfaces' },
  { name: '--color-sunken', label: 'Inputs and toolbars', group: 'Surfaces' },
  { name: '--color-hover', label: 'Hover', group: 'Surfaces' },
  { name: '--color-active', label: 'Selected', group: 'Surfaces' },
  { name: '--color-media', label: 'Behind artwork', group: 'Surfaces' },
  { name: '--color-on-media', label: 'Text over artwork', group: 'Surfaces' },
  { name: '--color-scrim', label: 'Backdrops', group: 'Surfaces' },
  { name: '--color-shadow', label: 'Shadows', group: 'Surfaces' },
  { name: '--color-text', label: 'Text', group: 'Text' },
  { name: '--color-muted', label: 'Secondary text', group: 'Text' },
  { name: '--color-faint', label: 'Timestamps and eyebrows', group: 'Text' },
  { name: '--color-line', label: 'Borders', group: 'Lines' },
  { name: '--color-line-strong', label: 'Stronger borders', group: 'Lines' },
  { name: '--color-accent', label: 'Accent', group: 'Accent' },
  { name: '--color-accent-ink', label: 'Text on accent', group: 'Accent' },
  { name: '--color-accent-hot', label: 'Live accent', group: 'Accent' },
  { name: '--color-good', label: 'Ready', group: 'Status' },
  { name: '--color-good-bg', label: 'Ready background', group: 'Status' },
  { name: '--color-good-line', label: 'Ready border', group: 'Status' },
  { name: '--color-warn', label: 'Warning', group: 'Status' },
  { name: '--color-warn-bg', label: 'Warning background', group: 'Status' },
  { name: '--color-danger', label: 'Error', group: 'Status' },
  { name: '--color-danger-bg', label: 'Error background', group: 'Status' },
  { name: '--color-danger-line', label: 'Error border', group: 'Status' },
  { name: '--color-owned-bg', label: 'Owned background', group: 'Status' },
  { name: '--color-partial', label: 'Part way', group: 'Status' },
  { name: '--color-partial-bg', label: 'Part way background', group: 'Status' },
  { name: '--color-partial-line', label: 'Part way border', group: 'Status' },
] as const satisfies readonly TokenDefinition[]

/** Every property name a theme may carry, and nothing else. */
export type ColorToken = (typeof COLOR_TOKENS)[number]['name']

export const TOKEN_NAMES: readonly ColorToken[] = COLOR_TOKENS.map((token) => token.name)
