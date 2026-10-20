import type { QueryClient } from '@tanstack/react-query'

import type { MusicResult } from '../../api'

export type DownloadPress = 'hide' | 'ask' | 'queue'
export type HouseChoice = 'house' | 'copy' | 'cancel'

const UNCERTAIN = new Set(['isrc', 'mbid', 'tags'])

/** Whether the download arrow hides, asks, or queues. An exact file hides. An uncertain match asks. */
export function downloadPress(item: { ownership: string; matched_by: string }): DownloadPress {
  if (item.matched_by === 'download' || item.matched_by === 'holding') return 'hide'
  if (item.ownership === 'owned' && !UNCERTAIN.has(item.matched_by)) return 'hide'
  if (UNCERTAIN.has(item.matched_by)) return 'ask'
  return 'queue'
}

export function houseBody(matchedBy: string): string {
  if (matchedBy === 'isrc')
    return 'A file already here has the same ISRC. Use that file, or save another copy.'
  if (matchedBy === 'mbid')
    return 'A file already here has the same MusicBrainz recording id. Use that file, or save another copy.'
  return 'A file already here matches the artist, title, and duration. Use that file, or save another copy.'
}

export function editionSentence(ownership: string, album: string): string {
  if (ownership !== 'edition') return ''
  return `That file is on "${album}", a different album.`
}

/** Which request a dialog choice makes. Cancel and Escape make none. */
export function choiceCall(choice: HouseChoice): 'holdings' | 'jobs' | null {
  if (choice === 'house') return 'holdings'
  if (choice === 'copy') return 'jobs'
  return null
}

export function needsChoiceSentence(count: number): string {
  const noun = count === 1 ? 'track' : 'tracks'
  return `${count} ${noun} match a file already here. Download those one at a time to choose.`
}

/** Link text after an album batch, and the choice sentence when it is not already that text. */
export function albumBatchStatus(
  queued: number,
  result: { jobs: unknown[]; needs_choice: number } | null,
): { link: string; choice: string } {
  const jobs = result?.jobs.length ?? 0
  const needs = result?.needs_choice ?? 0
  const choiceOnly = needs > 0 && queued === 0 && jobs === 0
  const link =
    queued > 0
      ? `${queued} queued`
      : jobs > 0
        ? `${jobs} queued`
        : choiceOnly
          ? needsChoiceSentence(needs)
          : 'Nothing missing'
  return { link, choice: needs > 0 && !choiceOnly ? needsChoiceSentence(needs) : '' }
}

/** How an artist-plan track counts before the batch is sent. `skip` comes from the server. */
export function artistQueueBucket(
  track: { owned: boolean; skip?: string },
  missingOnly: boolean,
  active: boolean,
): 'owned' | 'choice' | 'queued' | 'download' {
  if (track.skip === 'owned') return 'owned'
  if (track.skip === 'choice') return 'choice'
  if (missingOnly && track.owned) return 'owned'
  if (active) return 'queued'
  return 'download'
}

export type HeldCopy = {
  trackId: number
  spotifyId: string
  songId: string
  path: string
}

export function heldResult(item: MusicResult, held: HeldCopy): MusicResult {
  const same =
    item.kind === 'track' &&
    (item.id === held.trackId || (held.spotifyId !== '' && item.spotify_id === held.spotifyId))
  if (!same) return item
  return {
    ...item,
    ownership: 'owned',
    matched_by: 'holding',
    matched_song: held.songId,
    matched_paths: [held.path],
    matched_album: '',
  }
}

function rewriteHeld(data: unknown, held: HeldCopy): unknown {
  if (Array.isArray(data)) {
    let changed = false
    const next = data.map((item) => {
      const updated = rewriteHeld(item, held)
      if (updated !== item) changed = true
      return updated
    })
    return changed ? next : data
  }
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  if (record.kind === 'track' && typeof record.id === 'number')
    return heldResult(record as MusicResult, held)
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const updated = rewriteHeld(value, held)
    next[key] = updated
    if (updated !== value) changed = true
  }
  return changed ? next : data
}

/** The open search, album and artist lists start saying In library without another fetch. */
export function patchHeldCaches(client: QueryClient, held: HeldCopy): void {
  const apply = (data: unknown) => rewriteHeld(data, held)
  for (const key of ['search', 'album', 'artist-top'] as const)
    client.setQueriesData({ queryKey: [key] }, apply as never)
}
