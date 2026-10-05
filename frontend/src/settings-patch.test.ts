import { describe, expect, it } from 'vitest'

import { settingsPatch } from './settings-patch'

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
