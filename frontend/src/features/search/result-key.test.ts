import { describe, expect, it } from 'vitest'

import { resolvedDeezerId } from '../downloads/spotify-download'
import { resultKey } from './result-key'

describe('resultKey', () => {
  it('keeps a Spotify id off the Deezer track id', () => {
    expect(resultKey({ id: 0, spotify_id: 'abc' })).toBe('spotify:abc')
    expect(resultKey({ id: 42 })).toBe('42')
    expect(resolvedDeezerId({ id: 42 })).toBe(42)
    expect(resolvedDeezerId({ id: 0, spotify_id: 'abc' })).toBe(0)
  })
})
