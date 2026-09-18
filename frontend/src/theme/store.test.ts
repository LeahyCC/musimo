import { describe, expect, it } from 'vitest'

import { HEX_COLOR } from './schema'
import { draftTheme, exportTheme, resolveVars } from './store'
import { BUILT_IN_THEMES, DEFAULT_THEME } from './themes'
import { COLOR_TOKENS } from './tokens'

/* The DOM-facing half of the store (applying, storage events, the popout) is browser behaviour and
   belongs to `e2e/theme.spec.ts`. What is worth checking here is the handover between the two: the
   object written to `musimo.theme-vars` has to be exactly what `public/theme-boot.js` will accept,
   or a saved theme flashes the default on every load. */

const light = {
  ...DEFAULT_THEME,
  id: 'custom-paper',
  name: 'Paper',
  scheme: 'light' as const,
  colors: { ...DEFAULT_THEME.colors, '--color-canvas': '#f7f8f4' },
}

describe('resolveVars', () => {
  it('writes every token, and only tokens', () => {
    const resolved = resolveVars(DEFAULT_THEME)

    expect(Object.keys(resolved.vars)).toEqual(COLOR_TOKENS.map((token) => token.name))
    expect(resolved.vars['--color-canvas']).toBe(DEFAULT_THEME.colors['--color-canvas'])
  })

  it('carries the scheme, because the boot script sets color-scheme too', () => {
    expect(resolveVars(DEFAULT_THEME).scheme).toBe('dark')
    expect(resolveVars(light).scheme).toBe('light')
  })

  it('produces only what the boot script will accept', () => {
    // The same two patterns the boot script tests each entry against.
    const name = /^--color-[a-z0-9-]+$/
    const { vars, scheme } = resolveVars(light)

    expect(['dark', 'light']).toContain(scheme)
    for (const [key, value] of Object.entries(vars)) {
      expect(key).toMatch(name)
      expect(value, key).toMatch(HEX_COLOR)
    }
  })

  it('carries a skin only when the theme has one', () => {
    const skinned = BUILT_IN_THEMES.find((theme) => theme.id === 'win95-light')

    expect(skinned && resolveVars(skinned).skin).toBe('win95')
    expect('skin' in resolveVars(light)).toBe(false)
  })

  it('survives the round trip through the stored string', () => {
    const stored = JSON.parse(JSON.stringify(resolveVars(light))) as unknown

    expect(stored).toEqual(resolveVars(light))
  })
})

describe('draftTheme', () => {
  // A person's own theme is colors only, and an import refuses any other key.
  it('keeps the colors of a skinned theme and leaves the skin behind', () => {
    const skinned = BUILT_IN_THEMES.find((theme) => theme.id === 'win95-dark')
    if (!skinned) throw new Error('No Windows 95 dark theme')
    const draft = draftTheme(skinned)

    expect(draft.colors).toEqual(skinned.colors)
    expect('skin' in draft).toBe(false)
  })
})

describe('exportTheme', () => {
  it('writes a file that imports back as the same theme', () => {
    expect(JSON.parse(exportTheme(light))).toEqual(light)
  })
})
