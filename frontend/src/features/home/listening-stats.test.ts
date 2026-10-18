import { describe, expect, it } from 'vitest'

import { HISTORY_LIMIT } from '../player/play-history'
import type { HistoryEntry } from '../player/play-history'
import {
  greeting,
  listeningTime,
  mostPlayedThisMonth,
  recentAlbums,
  recentArtists,
  weekStats,
} from './listening-stats'

const NOW = new Date(2026, 9, 17, 15, 0).getTime()
const daysAgo = (days: number, hour = 12) => {
  const date = new Date(NOW)
  date.setDate(date.getDate() - days)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

const entry = (id: string, playedAt: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 200,
  playedAt,
  ...extra,
})

describe('weekStats', () => {
  it('counts only the seven days ending today and buckets them by day', () => {
    const history = [
      entry('a', daysAgo(0, 10)),
      entry('b', daysAgo(0, 9)),
      entry('c', daysAgo(6)),
      entry('d', daysAgo(7)),
    ]
    const stats = weekStats(history, NOW)
    expect(stats.songs).toBe(3)
    expect(stats.seconds).toBe(600)
    expect(stats.days).toHaveLength(7)
    expect(stats.days[6]?.songs).toBe(2)
    expect(stats.days[0]?.songs).toBe(1)
  })

  it('counts artists and albums once each', () => {
    const history = [
      entry('a', daysAgo(1), { artistId: 'x', albumId: 'p' }),
      entry('b', daysAgo(1), { artistId: 'x', albumId: 'p' }),
      entry('c', daysAgo(2), { artistId: 'y', albumId: 'q' }),
    ]
    const stats = weekStats(history, NOW)
    expect(stats.artists).toBe(2)
    expect(stats.albums).toBe(2)
  })

  it('says so when a full history may have dropped plays from the week', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, index) => entry(`s${index}`, daysAgo(1)))
    expect(weekStats(full, NOW).clipped).toBe(true)
    const old = [...full.slice(1), entry('old', daysAgo(30))]
    expect(weekStats(old, NOW).clipped).toBe(false)
    expect(weekStats([], NOW).clipped).toBe(false)
  })
})

describe('mostPlayedThisMonth', () => {
  it('ranks songs heard more than once this month and ignores older months', () => {
    const history = [
      entry('a', daysAgo(1)),
      entry('b', daysAgo(2)),
      entry('a', daysAgo(3)),
      entry('a', daysAgo(4)),
      entry('b', daysAgo(5)),
      entry('c', daysAgo(6)),
      entry('d', daysAgo(40)),
      entry('d', daysAgo(41)),
    ]
    const ranked = mostPlayedThisMonth(history, NOW, 5)
    expect(ranked.map((song) => [song.entry.id, song.plays])).toEqual([
      ['a', 3],
      ['b', 2],
    ])
  })

  it('is empty when nothing repeats', () => {
    expect(mostPlayedThisMonth([entry('a', daysAgo(1))], NOW, 5)).toEqual([])
  })
})

describe('recent shelves', () => {
  const history = [
    entry('1', daysAgo(0), { albumId: 'p', artistId: 'x' }),
    entry('2', daysAgo(1), { albumId: 'p', artistId: 'y' }),
    entry('3', daysAgo(2), { albumId: 'q', artistId: 'x' }),
    entry('4', daysAgo(3)),
  ]
  it('lists each album and artist once, newest first, skipping songs with no id', () => {
    expect(recentAlbums(history, 5).map((album) => album.id)).toEqual(['p', 'q'])
    expect(recentArtists(history, 5).map((artist) => artist.id)).toEqual(['x', 'y'])
  })

  it('stops at the limit', () => {
    expect(recentAlbums(history, 1)).toHaveLength(1)
  })
})

describe('greeting and time', () => {
  it('follows the hour', () => {
    expect(greeting(new Date(2026, 9, 17, 8).getTime())).toBe('Good morning')
    expect(greeting(new Date(2026, 9, 17, 14).getTime())).toBe('Good afternoon')
    expect(greeting(new Date(2026, 9, 17, 21).getTime())).toBe('Good evening')
  })

  it('writes minutes, then hours and minutes', () => {
    expect(listeningTime(42 * 60)).toBe('42m')
    expect(listeningTime(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(listeningTime(0)).toBe('0m')
  })
})
