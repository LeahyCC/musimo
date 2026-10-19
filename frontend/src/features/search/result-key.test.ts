import { describe, expect, it } from 'vitest'

import { resolvedDeezerId } from '../downloads/spotify-download'
import { resultKey } from './result-key'

describe('resultKey', () => {
  it('keeps a Spotify id off the Deezer track id', () => {
    expect(resultKey({ id: 0, spotify_id: 'abc' })).toBe('spotify:abc')
    expect(resultKey({ id: 42 })).toBe('42')
    expect(resultKey({ id: 0, spotify_id: '1234567890' })).toBe('spotify:1234567890')
    expect(resultKey({ id: 0, spotify_id: '1234567890' })).not.toBe('1234567890')
    expect(resolvedDeezerId({ id: 42 })).toBe(42)
    expect(resolvedDeezerId({ id: 0, spotify_id: 'abc' })).toBe(0)
    expect(resolvedDeezerId({ id: 0, spotify_id: '1234567890' })).toBe(0)
  })
})
