import { describe, expect, it } from 'vitest'

import { settingsSchema } from './api'
import { cleanArl, settingsPatch, withYoutubeCookies } from './settings-patch'

describe('settingsPatch', () => {
  it('leaves the saved Deezer cookie alone unless one is typed or removed', () => {
    expect(settingsPatch({ library_label: 'Music' }, false)).toEqual({ library_label: 'Music' })
    expect(settingsPatch({ deezer_arl: '   ' }, false)).toEqual({})
    expect(settingsPatch({ deezer_arl: ' abc ' }, false)).toEqual({ deezer_arl: 'abc' })
  })

  it('sends an empty cookie only for Remove cookie', () => {
    expect(settingsPatch({ library_label: 'Music' }, true)).toEqual({
      library_label: 'Music',
      deezer_arl: '',
    })
    expect(settingsPatch({ deezer_arl: 'abc' }, true)).toEqual({ deezer_arl: '' })
  })
})

describe('cleanArl', () => {
  // A cookie copied from a browser's cookie list or a header often keeps its name.
  it('drops a leading arl= and the spaces around the value', () => {
    expect(cleanArl('  arl=abc123 ')).toBe('abc123')
    expect(cleanArl('ARL = abc123')).toBe('abc123')
    expect(cleanArl('abc123')).toBe('abc123')
    expect(cleanArl('   ')).toBe('')
  })

  it('sends the cleaned cookie in the save', () => {
    expect(settingsPatch({ deezer_arl: 'arl=abc' }, false)).toEqual({ deezer_arl: 'abc' })
    expect(settingsPatch({ deezer_arl: ' arl= ' }, false)).toEqual({})
  })
})

describe('withYoutubeCookies', () => {
  it('changes only whether the cookies file is saved', () => {
    const settings = settingsSchema.parse({
      library_label: field('Music'),
      output_format: field('original'),
      concurrency: field(2),
      max_attempts: field(3),
      retry_base_seconds: field(5),
      retry_cap_seconds: field(60),
      destination: field('/music'),
      naming_template: field('{artist}'),
      youtube_cookies: { value: true, origin: 'file', locked: false },
      navidrome_url: field(''),
      navidrome_mode: field('off'),
      navidrome_library_id: field(0),
    })
    const after = withYoutubeCookies(settings, false)
    expect(after.youtube_cookies).toEqual({ value: false, origin: 'file', locked: false })
    expect(after.library_label).toBe(settings.library_label)
    expect(settings.youtube_cookies.value).toBe(true)
  })
})

function field<T>(value: T) {
  return { value, origin: 'database', locked: false }
}
