import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID, SKINS } from './themes'
import { COLOR_TOKENS, TOKEN_GROUPS } from './tokens'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const sheet = read('../style.css')

/* The `@theme` block is what paints the app when no theme is applied, so the default theme in
   TypeScript has to say the same thing. Reading the sheet rather than trusting a copy is the whole
   point: the two would otherwise drift the first time a shade is nudged in one of them. */
const stylesheetColors = (): Record<string, string> => {
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(sheet)
  if (!block?.[1]) throw new Error('No @theme block in style.css')
  const withoutComments = block[1].replace(/\/\*[\s\S]*?\*\//g, '')
  const colors: Record<string, string> = {}
  // The name has to end in a real word, which is what leaves `--color-*: initial` out: that line
  // is the reset that drops Tailwind's stock palette, not a token anyone can theme.
  for (const [, name, value] of withoutComments.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) colors[name] = value.trim()
  }

  return colors
}

describe('the built-in registry', () => {
  it('has the default first and keeps its id', () => {
    expect(BUILT_IN_THEMES[0]).toBe(DEFAULT_THEME)
    expect(DEFAULT_THEME.id).toBe(DEFAULT_THEME_ID)
    expect(DEFAULT_THEME.scheme).toBe('dark')
  })

  it('gives every theme a value for every token, and no id twice', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(Object.keys(theme.colors).sort()).toEqual(COLOR_TOKENS.map((t) => t.name).sort())
    }
    const ids = BUILT_IN_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches the @theme block in style.css, token for token', () => {
    const fromSheet = stylesheetColors()

    expect(Object.keys(fromSheet).sort()).toEqual(COLOR_TOKENS.map((token) => token.name).sort())
    expect(fromSheet).toEqual(DEFAULT_THEME.colors)
  })
})

describe('skins', () => {
  it('names only skins that exist', () => {
    for (const theme of BUILT_IN_THEMES) {
      if ('skin' in theme) expect(SKINS, theme.id).toContain(theme.skin)
    }
  })

  // The boot script paints before the bundle loads, so it keeps its own copy of the list.
  it('are all known to the boot script and drawn by a sheet', () => {
    const boot = read('../../public/theme-boot.js')
    for (const skin of SKINS) {
      expect(boot, skin).toContain(`'${skin}'`)
      expect(read(`./${skin}.css`), skin).toContain(`[data-skin='${skin}']`)
    }
  })
})

describe('the token list', () => {
  it('names each token once and groups them all', () => {
    const names = COLOR_TOKENS.map((token) => token.name)
    expect(new Set(names).size).toBe(names.length)
    for (const token of COLOR_TOKENS) {
      expect(token.name, token.label).toMatch(/^--color-[a-z0-9-]+$/)
      expect(TOKEN_GROUPS, token.name).toContain(token.group)
      expect(token.label.length, token.name).toBeGreaterThan(0)
    }
  })

  it('gives every group at least one token', () => {
    for (const group of TOKEN_GROUPS) {
      expect(
        COLOR_TOKENS.some((token) => token.group === group),
        group,
      ).toBe(true)
    }
  })
})
