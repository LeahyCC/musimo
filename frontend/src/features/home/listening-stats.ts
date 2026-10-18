import { HISTORY_LIMIT } from '../player/play-history'
import type { HistoryEntry } from '../player/play-history'

/* Everything the Home dashboard says about listening comes from the play history the player keeps
   in this browser. The server only holds all-time play counts, with no dates, so "this week" and
   "this month" can only be worked out here, and only for what was played on this device. */

const startOfDay = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export type DayBar = { day: number; label: string; songs: number }

export type WeekStats = {
  songs: number
  artists: number
  albums: number
  /** Added up from the length of each song played, not from how long it was actually heard. */
  seconds: number
  /** Oldest day first, ending today. */
  days: DayBar[]
  /** True when the history is full and its oldest entry is still inside the week, so older plays were dropped. */
  clipped: boolean
  /** The first and last day of the week, as the start of each day. */
  from: number
  to: number
}

/** The seven days ending today, and what the history says was played in them. */
export function weekStats(history: readonly HistoryEntry[], now: number): WeekStats {
  const today = startOfDay(now)
  // Calendar arithmetic rather than 24h steps, so a clock change does not shift a day.
  const first = new Date(today)
  first.setDate(first.getDate() - 6)
  const from = first.getTime()
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(from)
    date.setDate(date.getDate() + index)
    return {
      day: date.getTime(),
      label: date.toLocaleDateString(undefined, { weekday: 'narrow' }),
      songs: 0,
    }
  })
  const inWeek = history.filter((entry) => entry.playedAt >= from && entry.playedAt <= now)
  for (const entry of inWeek) {
    const slot = [...days].reverse().find((bar) => entry.playedAt >= bar.day)
    if (slot) slot.songs += 1
  }
  const oldest = history[history.length - 1]
  return {
    songs: inWeek.length,
    artists: new Set(inWeek.map((entry) => entry.artistId ?? entry.artist)).size,
    albums: new Set(inWeek.map((entry) => entry.albumId ?? `${entry.artist}/${entry.album}`)).size,
    seconds: inWeek.reduce((sum, entry) => sum + entry.duration, 0),
    days,
    clipped: history.length >= HISTORY_LIMIT && oldest !== undefined && oldest.playedAt >= from,
    from,
    to: today,
  }
}

export type PlayedSong = { entry: HistoryEntry; plays: number }

/**
 * Songs played more than once since the start of the month, most played first. A song heard once
 * is not "on repeat", and the history already merges back-to-back repeats, so the counts are
 * separate listens.
 */
export function mostPlayedThisMonth(
  history: readonly HistoryEntry[],
  now: number,
  limit: number,
): PlayedSong[] {
  const date = new Date(now)
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  const counts = new Map<string, PlayedSong>()
  for (const entry of history) {
    if (entry.playedAt < monthStart) continue
    const seen = counts.get(entry.id)
    if (seen) seen.plays += 1
    else counts.set(entry.id, { entry, plays: 1 })
  }
  return [...counts.values()]
    .filter((song) => song.plays > 1)
    .sort((a, b) => b.plays - a.plays || b.entry.playedAt - a.entry.playedAt)
    .slice(0, limit)
}

export type RecentAlbum = { id: string; name: string; artist: string; coverArt?: string }
export type RecentArtist = { id: string; name: string; coverArt?: string }

/** The albums played most recently, each once, newest first. */
export function recentAlbums(history: readonly HistoryEntry[], limit: number): RecentAlbum[] {
  const found = new Map<string, RecentAlbum>()
  for (const entry of history) {
    if (found.size >= limit) break
    if (!entry.albumId || found.has(entry.albumId)) continue
    found.set(entry.albumId, {
      id: entry.albumId,
      name: entry.album || 'Unknown album',
      artist: entry.artist,
      coverArt: entry.coverArt,
    })
  }
  return [...found.values()]
}

/** The artists played most recently, each once, newest first. */
export function recentArtists(history: readonly HistoryEntry[], limit: number): RecentArtist[] {
  const found = new Map<string, RecentArtist>()
  for (const entry of history) {
    if (found.size >= limit) break
    if (!entry.artistId || found.has(entry.artistId)) continue
    found.set(entry.artistId, { id: entry.artistId, name: entry.artist, coverArt: entry.coverArt })
  }
  return [...found.values()]
}

export function greeting(now: number) {
  const hour = new Date(now).getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** "3h 12m", or "42m" under an hour. */
export function listeningTime(seconds: number) {
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}
