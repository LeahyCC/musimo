import { describe, expect, it } from 'vitest'

import type { LibraryTrack } from './api'
import { addToHistory, HISTORY_LIMIT, type HistoryEntry, historyTrack } from './play-history'
import { relativeTime } from './relative-time'

const song = (id: string): LibraryTrack => ({
  id,
  title: `Title ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 100,
  coverArt: `art-${id}`,
  playCount: 7,
})

describe('addToHistory', () => {
  it('puts the newest track first', () => {
    const first = addToHistory([], song('a'), 1)
    const second = addToHistory(first, song('b'), 2)
    expect(second.map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(second[0]?.playedAt).toBe(2)
  })

  it('keeps only what a row needs', () => {
    const [entry] = addToHistory([], song('a'), 1)
    expect(entry).not.toHaveProperty('playCount')
    expect(entry).toMatchObject({ id: 'a', title: 'Title a', coverArt: 'art-a', playedAt: 1 })
  })

  it('leaves the history as it was when the previous entry is the same track', () => {
    const once = addToHistory([], song('a'), 1)
    expect(addToHistory(once, song('a'), 2)).toBe(once)
  })

  it('records a track again once something else has played between', () => {
    const entries = [song('a'), song('b'), song('a')].reduce<readonly HistoryEntry[]>(
      (list, track, at) => addToHistory(list, track, at),
      [],
    )
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b', 'a'])
  })

  it('drops the oldest entries past the limit', () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, at) => song(String(at))).reduce<
      readonly HistoryEntry[]
    >((list, track, at) => addToHistory(list, track, at), [])
    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[0]?.id).toBe(String(HISTORY_LIMIT + 4))
    expect(entries.at(-1)?.id).toBe('5')
  })
})

describe('historyTrack', () => {
  it('rebuilds a track the player can play', () => {
    const [entry] = addToHistory([], song('a'), 1)
    expect(entry && historyTrack(entry)).toMatchObject({
      id: 'a',
      title: 'Title a',
      duration: 100,
      coverArt: 'art-a',
      playCount: 0,
    })
  })

  it('keeps the ReplayGain tags, so a replayed song is levelled', () => {
    const gain = { trackGain: -6, trackPeak: 0.9 }
    const [entry] = addToHistory([], { ...song('a'), replayGain: gain }, 1)
    expect(entry && historyTrack(entry).replayGain).toEqual(gain)
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 8, 19, 12)
  it('says just now under a minute, and for a clock that ran backwards', () => {
    expect(relativeTime(now - 20_000, now)).toBe('just now')
    expect(relativeTime(now + 5_000, now)).toBe('just now')
  })

  it('names the largest whole unit', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday')
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })
})
