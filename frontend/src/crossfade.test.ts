import { describe, expect, it } from 'vitest'

import type { LibraryTrack } from './api'
import {
  crossfadeSpan,
  followsOnFromAlbum,
  MAX_CROSSFADE_SECONDS,
  parseCrossfade,
} from './crossfade'
import type { CrossfadeChoice } from './crossfade'

const song = (id: string, albumId?: string, duration = 200): LibraryTrack => ({
  id,
  title: id,
  artist: 'Artist',
  album: 'Album',
  albumId,
  duration,
  playCount: 0,
})

// Two tracks from different albums, queued one after the other, with the overlap due.
const base = (): CrossfadeChoice => ({
  seconds: 8,
  repeat: 'off',
  current: song('a', 'one'),
  currentIndex: 0,
  upcoming: song('b', 'two'),
  upcomingIndex: 1,
  length: 200,
  left: 7,
})

describe('parseCrossfade', () => {
  it('defaults to off', () => {
    expect(parseCrossfade(null)).toBe(0)
    expect(parseCrossfade('')).toBe(0)
    expect(parseCrossfade('long')).toBe(0)
  })

  it('reads whole seconds up to the longest', () => {
    expect(parseCrossfade('1')).toBe(1)
    expect(parseCrossfade('12')).toBe(MAX_CROSSFADE_SECONDS)
    expect(parseCrossfade('13')).toBe(0)
    expect(parseCrossfade('2.5')).toBe(0)
    expect(parseCrossfade('-3')).toBe(0)
  })
})

describe('followsOnFromAlbum', () => {
  it('is the next track of the same album, queued straight after', () => {
    expect(followsOnFromAlbum(song('a', 'x'), 3, song('b', 'x'), 4)).toBe(true)
  })

  it('is not for another album, a track with no album, or a gap in the queue', () => {
    expect(followsOnFromAlbum(song('a', 'x'), 3, song('b', 'y'), 4)).toBe(false)
    expect(followsOnFromAlbum(song('a'), 3, song('b'), 4)).toBe(false)
    expect(followsOnFromAlbum(song('a', 'x'), 3, song('b', 'x'), 6)).toBe(false)
  })

  it('is not the wrap from the last track back to the first', () => {
    expect(followsOnFromAlbum(song('b', 'x'), 9, song('a', 'x'), 0)).toBe(false)
  })
})

describe('crossfadeSpan', () => {
  it('overlaps by the setting once that much is left', () => {
    expect(crossfadeSpan({ ...base(), left: 8 })).toBe(8)
  })

  it('waits until the overlap is due', () => {
    expect(crossfadeSpan({ ...base(), left: 8.5 })).toBe(0)
  })

  it('never asks for more than what is left, so a late start still ends with the track', () => {
    expect(crossfadeSpan({ ...base(), left: 3 })).toBe(3)
  })

  it('is off when the setting is', () => {
    expect(crossfadeSpan({ ...base(), seconds: 0 })).toBe(0)
  })

  it('never crossfades repeat one', () => {
    expect(crossfadeSpan({ ...base(), repeat: 'one', upcoming: song('a', 'one'), left: 5 })).toBe(0)
  })

  it('leaves consecutive tracks of one album to gapless playback', () => {
    expect(crossfadeSpan({ ...base(), upcoming: song('b', 'one') })).toBe(0)
  })

  it('crossfades the same album when it is not played in order', () => {
    expect(crossfadeSpan({ ...base(), upcoming: song('c', 'one'), upcomingIndex: 5 })).toBe(7)
  })

  it('crossfades repeat all, including its wrap to the top of one album', () => {
    const wrap = {
      ...base(),
      repeat: 'all' as const,
      current: song('z', 'one'),
      currentIndex: 9,
      upcoming: song('a', 'one'),
      upcomingIndex: 0,
    }
    expect(crossfadeSpan(wrap)).toBe(7)
  })

  it('takes at most half of a short track, on either side of the join', () => {
    expect(crossfadeSpan({ ...base(), length: 10, left: 4 })).toBe(4)
    expect(crossfadeSpan({ ...base(), length: 10, left: 6 })).toBe(0)
    expect(crossfadeSpan({ ...base(), upcoming: song('b', 'two', 6), left: 3 })).toBe(3)
    expect(crossfadeSpan({ ...base(), upcoming: song('b', 'two', 6), left: 4 })).toBe(0)
  })

  it('leaves a join too close to the end to the ordinary handover', () => {
    expect(crossfadeSpan({ ...base(), left: 0.1 })).toBe(0)
  })

  it('does nothing without a real length', () => {
    expect(crossfadeSpan({ ...base(), length: NaN })).toBe(0)
    expect(crossfadeSpan({ ...base(), length: 0 })).toBe(0)
  })
})
