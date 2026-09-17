import { describe, expect, it } from 'vitest'

import { CUSTOM_THEMES_VERSION, customThemesSchema, MAX_CUSTOM_THEMES, themeSchema } from './schema'
import { DEFAULT_THEME } from './themes'
import { COLOR_TOKENS } from './tokens'

const aTheme = (colors: Record<string, string> = {}) => ({
  id: 'custom-1',
  name: 'Paper',
  scheme: 'light',
  colors: { ...DEFAULT_THEME.colors, ...colors },
})

const list = (themes: unknown[]) => ({ version: CUSTOM_THEMES_VERSION, themes })

describe('themeSchema', () => {
  it('accepts a whole theme', () => {
    const parsed = themeSchema.safeParse(aTheme())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.colors).toEqual(DEFAULT_THEME.colors)
  })

  it('takes six and eight digit hex values', () => {
    expect(themeSchema.safeParse(aTheme({ '--color-scrim': '#00000080' })).success).toBe(true)
    expect(themeSchema.safeParse(aTheme({ '--color-canvas': '#ABCDEF' })).success).toBe(true)
  })

  it('fills a token the saved theme never had from the default', () => {
    const colors: Record<string, string> = { ...DEFAULT_THEME.colors }
    delete colors['--color-partial-line']
    delete colors['--color-on-media']
    const parsed = themeSchema.safeParse({ ...aTheme(), colors })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.colors['--color-partial-line']).toBe(
      DEFAULT_THEME.colors['--color-partial-line'],
    )
    expect(Object.keys(parsed.data?.colors ?? {})).toHaveLength(COLOR_TOKENS.length)
  })

  it('refuses a token name the app does not paint with', () => {
    expect(themeSchema.safeParse(aTheme({ '--color-mystery': '#112233' })).success).toBe(false)
    expect(themeSchema.safeParse(aTheme({ background: '#112233' })).success).toBe(false)
  })

  it('refuses a value that is not a six or eight digit hex', () => {
    for (const value of ['#fff', '#12345', 'red', 'var(--color-canvas)', 'rgb(0 0 0)', '']) {
      expect(themeSchema.safeParse(aTheme({ '--color-canvas': value })).success, value).toBe(false)
    }
  })

  it('refuses a url, whichever way it is dressed up', () => {
    for (const value of [
      'url(https://example.test/x.png)',
      'url(#a)',
      '#000000; background: url(x)',
    ]) {
      expect(themeSchema.safeParse(aTheme({ '--color-canvas': value })).success, value).toBe(false)
    }
  })

  it('bounds the name', () => {
    expect(themeSchema.safeParse({ ...aTheme(), name: '' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...aTheme(), name: ' ' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...aTheme(), name: 'a'.repeat(40) }).success).toBe(true)
    expect(themeSchema.safeParse({ ...aTheme(), name: 'a'.repeat(41) }).success).toBe(false)
  })

  it('refuses a broken id, an unknown scheme and an extra field', () => {
    expect(themeSchema.safeParse({ ...aTheme(), id: 'custom 1' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...aTheme(), id: '' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...aTheme(), scheme: 'sepia' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...aTheme(), radius: 8 }).success).toBe(false)
  })

  it('refuses what is not a theme at all', () => {
    for (const value of [null, 'a theme', 42, [], {}]) {
      expect(themeSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe('customThemesSchema', () => {
  it('accepts a versioned list', () => {
    const parsed = customThemesSchema.safeParse(list([aTheme(), { ...aTheme(), id: 'custom-2' }]))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.themes).toHaveLength(2)
  })

  it('caps how many themes are kept', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...aTheme(), id: `custom-${index}` }))

    expect(customThemesSchema.safeParse(list(many(MAX_CUSTOM_THEMES))).success).toBe(true)
    expect(customThemesSchema.safeParse(list(many(MAX_CUSTOM_THEMES + 1))).success).toBe(false)
  })

  it('refuses a list without a version it knows, or with a bad member', () => {
    expect(customThemesSchema.safeParse({ themes: [] }).success).toBe(false)
    expect(customThemesSchema.safeParse({ version: 99, themes: [] }).success).toBe(false)
    expect(customThemesSchema.safeParse(list([aTheme({ '--color-canvas': 'red' })])).success).toBe(
      false,
    )
  })
})
