import { describe, expect, it } from 'vitest'

import { familyOf, resolveFollowSystem, themeFamilies } from './follow-system'
import { BUILT_IN_THEMES, DEFAULT_THEME } from './themes'
import type { Theme } from './themes'

const families = themeFamilies(BUILT_IN_THEMES)
const slate = families.find((family) => family.id === 'slate')
const custom: Theme = { ...DEFAULT_THEME, id: 'custom-plum', name: 'Plum' }

describe('themeFamilies', () => {
  it('finds the six families, each with a dark and a light half', () => {
    expect(families.map((family) => family.name)).toEqual([
      'Musimo',
      'Slate',
      'Sunset',
      'Violet',
      'Graphite',
      'Windows 95',
    ])
    for (const family of families) {
      expect(family.dark.scheme).toBe('dark')
      expect(family.light.scheme).toBe('light')
    }
  })

  it('accounts for every built-in theme', () => {
    expect(families.flatMap((family) => [family.dark.id, family.light.id]).sort()).toEqual(
      BUILT_IN_THEMES.map((theme) => theme.id).sort(),
    )
  })

  it('leaves out a theme with no other half', () => {
    const lone = BUILT_IN_THEMES.filter((theme) => theme.id !== 'slate-light')

    expect(themeFamilies(lone).some((family) => family.id === 'slate')).toBe(false)
  })
})

describe('familyOf', () => {
  it('names the family from either half', () => {
    expect(familyOf('slate-dark', families)).toBe(slate)
    expect(familyOf('slate-light', families)).toBe(slate)
  })

  it('has no family for a theme of the person’s own, or an id that names nothing', () => {
    expect(familyOf(custom.id, families)).toBeUndefined()
    expect(familyOf('gone', families)).toBeUndefined()
  })
})

describe('resolveFollowSystem', () => {
  it('is the chosen theme when Follow system is off, whatever the device asks for', () => {
    expect(resolveFollowSystem('slate-dark', false, 'light', families)).toBe('slate-dark')
    expect(resolveFollowSystem('slate-light', false, 'dark', families)).toBe('slate-light')
  })

  it('swaps to the half the device asks for, in the same family', () => {
    expect(resolveFollowSystem('slate-dark', true, 'light', families)).toBe('slate-light')
    expect(resolveFollowSystem('slate-light', true, 'dark', families)).toBe('slate-dark')
    expect(resolveFollowSystem('win95-light', true, 'dark', families)).toBe('win95-dark')
  })

  it('keeps the chosen half when it already matches', () => {
    expect(resolveFollowSystem('sunset-dark', true, 'dark', families)).toBe('sunset-dark')
    expect(resolveFollowSystem('sunset-light', true, 'light', families)).toBe('sunset-light')
  })

  it('does not touch a theme that has no other half', () => {
    expect(resolveFollowSystem(custom.id, true, 'light', families)).toBe(custom.id)
    expect(resolveFollowSystem('gone', true, 'light', families)).toBe('gone')
  })
})
