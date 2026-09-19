import { describe, expect, it } from 'vitest'

import type { LibraryTrack } from './api'
import {
  levelledVolume,
  parsePreamp,
  parseReplayGainMode,
  playsAlbumInOrder,
  replayGainMultiplier,
} from './replay-gain'

const song = (id: string, albumId?: string): LibraryTrack => ({
  id,
  title: id,
  artist: 'Artist',
  album: 'Album',
  albumId,
  duration: 100,
  playCount: 0,
})

describe('parseReplayGainMode', () => {
  it('defaults to track', () => {
    expect(parseReplayGainMode(null)).toBe('track')
    expect(parseReplayGainMode('loud')).toBe('track')
  })

  it('reads the three modes', () => {
    expect(parseReplayGainMode('off')).toBe('off')
    expect(parseReplayGainMode('track')).toBe('track')
    expect(parseReplayGainMode('album')).toBe('album')
  })
})

describe('parsePreamp', () => {
  it('reads an offered step and falls back to 0 otherwise', () => {
    expect(parsePreamp('-3')).toBe(-3)
    expect(parsePreamp('6')).toBe(6)
    expect(parsePreamp('4')).toBe(0)
    expect(parsePreamp('')).toBe(0)
    expect(parsePreamp(null)).toBe(0)
    expect(parsePreamp('loud')).toBe(0)
  })
})

describe('replayGainMultiplier', () => {
  const tagged = { trackGain: -6, albumGain: -3, trackPeak: 0.5, albumPeak: 0.7 }

  it('leaves a track without tags alone', () => {
    expect(replayGainMultiplier(undefined, 'track', false, 0)).toBe(1)
    expect(replayGainMultiplier({}, 'track', false, 3)).toBe(1)
    expect(replayGainMultiplier({ albumGain: -3 }, 'track', false, 3)).toBe(1)
  })

  it('does nothing when levelling is off', () => {
    expect(replayGainMultiplier(tagged, 'off', true, 6)).toBe(1)
  })

  it('turns the track gain in decibels into a multiplier', () => {
    expect(replayGainMultiplier({ trackGain: -6 }, 'track', false, 0)).toBeCloseTo(0.501, 3)
    expect(replayGainMultiplier({ trackGain: -20 }, 'track', false, 0)).toBeCloseTo(0.1, 5)
    expect(replayGainMultiplier({ trackGain: 0 }, 'track', false, 0)).toBe(1)
  })

  it('uses the track gain in track mode even while an album plays in order', () => {
    expect(replayGainMultiplier(tagged, 'track', true, 0)).toBeCloseTo(0.501, 3)
  })

  it('uses the album gain in album mode while the album plays in order', () => {
    expect(replayGainMultiplier(tagged, 'album', true, 0)).toBeCloseTo(0.708, 3)
  })

  it('uses the track gain in album mode when the album is not in order', () => {
    expect(replayGainMultiplier(tagged, 'album', false, 0)).toBeCloseTo(0.501, 3)
  })

  it('falls back to the track gain when there is no album gain', () => {
    const gain = { trackGain: -6, trackPeak: 0.5 }
    expect(replayGainMultiplier(gain, 'album', true, 0)).toBeCloseTo(0.501, 3)
  })

  it('adds the pre-amp to a tagged track', () => {
    expect(replayGainMultiplier({ trackGain: -6 }, 'track', false, 3)).toBeCloseTo(0.708, 3)
    expect(replayGainMultiplier({ trackGain: -6 }, 'track', false, -6)).toBeCloseTo(0.251, 3)
  })

  it('caps a boost so the peak stays under full scale', () => {
    // +6 dB is 2x, but a track peaking at 0.8 can only be lifted 1.25x.
    expect(replayGainMultiplier({ trackGain: 6, trackPeak: 0.8 }, 'track', false, 0)).toBeCloseTo(
      1.25,
      5,
    )

    // The pre-amp cannot get past the cap either.
    expect(replayGainMultiplier({ trackGain: 3, trackPeak: 0.8 }, 'track', false, 6)).toBeCloseTo(
      1.25,
      5,
    )
  })

  it('caps by the album peak when the album gain is in use', () => {
    const gain = { trackGain: 6, albumGain: 6, trackPeak: 0.5, albumPeak: 0.9 }
    expect(replayGainMultiplier(gain, 'album', true, 0)).toBeCloseTo(1 / 0.9, 5)
    expect(replayGainMultiplier(gain, 'track', true, 0)).toBeCloseTo(1.995, 3)
  })

  it('does not cap a cut, or a track with no usable peak', () => {
    expect(replayGainMultiplier({ trackGain: -6, trackPeak: 1 }, 'track', false, 0)).toBeCloseTo(
      0.501,
      3,
    )

    expect(replayGainMultiplier({ trackGain: 6, trackPeak: 0 }, 'track', false, 0)).toBeCloseTo(
      1.995,
      3,
    )
    expect(replayGainMultiplier({ trackGain: 6 }, 'track', false, 0)).toBeCloseTo(1.995, 3)
  })

  it('ignores values that are not numbers', () => {
    expect(replayGainMultiplier({ trackGain: Number.NaN }, 'track', false, 0)).toBe(1)
    expect(replayGainMultiplier({ trackGain: -6 }, 'track', false, Number.NaN)).toBeCloseTo(
      0.501,
      3,
    )
  })
})

describe('levelledVolume', () => {
  it('scales the volume the person set', () => {
    expect(levelledVolume(0.8, 0.5)).toBeCloseTo(0.4, 5)
    expect(levelledVolume(0.7, 1)).toBe(0.7)
  })

  it('never goes past what an audio element accepts', () => {
    expect(levelledVolume(0.9, 2)).toBe(1)
    expect(levelledVolume(0, 2)).toBe(0)
  })
})

describe('playsAlbumInOrder', () => {
  const album = [song('a', 'x'), song('b', 'x'), song('c', 'x')]

  it('is true inside an album played in order', () => {
    expect(playsAlbumInOrder(album, 0, false)).toBe(true)
    expect(playsAlbumInOrder(album, 1, false)).toBe(true)
    expect(playsAlbumInOrder(album, 2, false)).toBe(true)
  })

  it('is false under shuffle', () => {
    expect(playsAlbumInOrder(album, 1, true)).toBe(false)
  })

  it('is false for a lone song from an album', () => {
    const mixed = [song('a', 'x'), song('b', 'y'), song('c', 'z')]
    expect(playsAlbumInOrder(mixed, 1, false)).toBe(false)
  })

  it('is false for a song with no album, or a position outside the queue', () => {
    const untagged = [song('a'), song('b')]
    expect(playsAlbumInOrder(untagged, 0, false)).toBe(false)
    expect(playsAlbumInOrder(album, 5, false)).toBe(false)
    expect(playsAlbumInOrder(album, -1, false)).toBe(false)
  })
})
