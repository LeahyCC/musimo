import { z } from 'zod'

import { replayGainSchema } from '../../api'
import type { LibraryTrack } from '../../api'
import { readStoredJson, writeStored } from '../../lib/storage'

export const HISTORY_KEY = 'musimo.play-history'
export const HISTORY_LIMIT = 200
/** Seconds of a track that must play before it counts as heard. A shorter track counts at its end. */
export const HISTORY_LISTEN_SECONDS = 10

// Only what a row shows and what playing the song again needs. The cover and the artist and album
// ids are there because the player's footer and Now Playing read them off the track. The
// ReplayGain tags are there so a song played again from here is levelled like any other.
const historyEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  duration: z.number(),
  artistId: z.string().optional(),
  albumId: z.string().optional(),
  coverArt: z.string().optional(),
  replayGain: replayGainSchema.optional(),
  playedAt: z.number(),
  /** Set when the listen came through the Deezer account rather than a library file. */
  playedFrom: z.literal('deezer').optional(),
})
export type HistoryEntry = z.infer<typeof historyEntrySchema>

/** Whatever was stored, or nothing when it is missing, unreadable or not a history at all. */
export function readHistory(): HistoryEntry[] {
  const parsed = z.array(historyEntrySchema).safeParse(readStoredJson(HISTORY_KEY))
  return parsed.success ? parsed.data.slice(0, HISTORY_LIMIT) : []
}

export function writeHistory(entries: readonly HistoryEntry[]) {
  writeStored(HISTORY_KEY, JSON.stringify(entries))
}

/**
 * The history with `track` listened to at `playedAt`: newest first, capped, and unchanged (the
 * same array) when the track is the one heard just before, so a repeat does not fill the list.
 */
export function addToHistory(
  entries: readonly HistoryEntry[],
  track: LibraryTrack,
  playedAt: number,
): readonly HistoryEntry[] {
  if (entries[0]?.id === track.id) return entries
  const entry: HistoryEntry = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    artistId: track.artistId,
    albumId: track.albumId,
    coverArt: track.coverArt,
    replayGain: track.replayGain,
    playedAt,
    playedFrom: track.origin === 'deezer' ? 'deezer' : undefined,
  }
  return [entry, ...entries].slice(0, HISTORY_LIMIT)
}

/** The track a history row plays again. Play counts stay with the library, so the copy carries none. */
export const historyTrack = (entry: HistoryEntry): LibraryTrack => ({
  id: entry.id,
  title: entry.title,
  artist: entry.artist,
  album: entry.album,
  duration: entry.duration,
  artistId: entry.artistId,
  albumId: entry.albumId,
  coverArt: entry.coverArt,
  replayGain: entry.replayGain,
  playCount: 0,
  origin: entry.playedFrom === 'deezer' ? 'deezer' : 'library',
  deezerId: entry.playedFrom === 'deezer' ? Number(entry.id.replace('dz-', '')) : undefined,
})
