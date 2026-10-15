import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hexContrast } from '../../theme/color'
import { MIN_CONTRAST } from '../../theme/contrast'
import {
  DEFAULT_PET_SETTINGS,
  parsePetSettings,
  PET_COLOURS,
  petMotion,
  petPaint,
  petPixels,
} from './pet-settings'

describe('parsePetSettings', () => {
  it('reads a complete, valid entry as it is', () => {
    const stored = {
      ...DEFAULT_PET_SETTINGS,
      kind: 'robot',
      name: 'Pip',
      colour: 'violet',
      size: 'large',
      position: 'right',
      chattiness: 'chatty',
      motion: 'off',
      sounds: true,
      hidden: true,
    }
    expect(parsePetSettings(stored)).toEqual(stored)
  })

  it('gives the default pet for anything that is not an object', () => {
    for (const raw of [undefined, null, 'cat', 3, [], true])
      expect(parsePetSettings(raw)).toEqual(DEFAULT_PET_SETTINGS)
  })

  it('resets only the fields it cannot read', () => {
    const parsed = parsePetSettings({
      kind: 'dragon',
      name: 'Pip',
      size: 'huge',
      position: 'right',
      sounds: 'yes',
      hidden: true,
      version: 99,
    })
    expect(parsed).toEqual({
      ...DEFAULT_PET_SETTINGS,
      name: 'Pip',
      position: 'right',
      hidden: true,
    })
  })

  it('trims names and refuses empty, long or control-character ones', () => {
    expect(parsePetSettings({ name: '  Pip  ' }).name).toBe('Pip')
    expect(parsePetSettings({ name: '   ' }).name).toBe(DEFAULT_PET_SETTINGS.name)
    expect(parsePetSettings({ name: 'x'.repeat(21) }).name).toBe(DEFAULT_PET_SETTINGS.name)
    expect(parsePetSettings({ name: 'Pi\u0007p' }).name).toBe(DEFAULT_PET_SETTINGS.name)
    expect(parsePetSettings({ name: 'x'.repeat(20) }).name).toBe('x'.repeat(20))
  })

  it('starts with sounds off, the pet shown and motion following the device', () => {
    expect(DEFAULT_PET_SETTINGS.sounds).toBe(false)
    expect(DEFAULT_PET_SETTINGS.hidden).toBe(false)
    expect(DEFAULT_PET_SETTINGS.motion).toBe('system')
  })
})

describe('storage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('keeps a change for the session when the browser refuses to store it', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const store = await import('./pet-settings')
    expect(store.setPetSettings({ name: 'Pip' })).toBe(false)
    // The new value still applies to this page.
    expect(store.setPetSettings({ kind: 'bird' })).toBe(false)
    vi.unstubAllGlobals()
  })

  it('writes the parsed settings under musimo.pet', async () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    })
    const store = await import('./pet-settings')
    expect(store.setPetSettings({ name: '  Pip ', size: 'small' })).toBe(true)
    expect(JSON.parse(saved.get('musimo.pet') ?? '{}')).toMatchObject({
      version: 1,
      name: 'Pip',
      size: 'small',
    })
    vi.unstubAllGlobals()
  })
})

describe('petPaint', () => {
  it('follows the theme for "theme"', () => {
    expect(petPaint('theme', 'dark')).toBeNull()
    expect(petPaint('theme', 'light')).toBeNull()
  })

  it('uses the family half that matches the scheme, with a face at AA', () => {
    for (const colour of PET_COLOURS.filter((entry) => entry !== 'theme')) {
      for (const scheme of ['dark', 'light'] as const) {
        const paint = petPaint(colour, scheme)
        expect(paint, `${colour} ${scheme}`).not.toBeNull()
        if (!paint) continue
        expect(hexContrast(paint.ink, paint.body)).toBeGreaterThanOrEqual(MIN_CONTRAST)
      }
    }
    expect(petPaint('slate', 'dark')?.body).not.toBe(petPaint('slate', 'light')?.body)
  })
})

describe('petPixels', () => {
  it('sizes the pet on a desktop', () => {
    expect([
      petPixels('small', false),
      petPixels('medium', false),
      petPixels('large', false),
    ]).toEqual([32, 44, 56])
  })

  it('caps a phone at medium, whichever is smaller', () => {
    expect(petPixels('small', true)).toBeLessThan(petPixels('medium', true))
    expect(petPixels('large', true)).toBe(petPixels('medium', true))
    expect(petPixels('medium', true)).toBeLessThanOrEqual(30)
  })
})

describe('petMotion', () => {
  it('follows the device by default and honours an explicit choice', () => {
    expect(petMotion('system', false)).toBe('full')
    expect(petMotion('system', true)).toBe('reduced')
    expect(petMotion('full', true)).toBe('full')
    expect(petMotion('off', false)).toBe('off')
  })
})
