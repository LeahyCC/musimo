import type { LibraryTrack } from '../../api'
import { lengthText } from './bot-replies'
import type { Overview } from './proposals'

/* The words around a stored preview: what its songs show, what could not be read, and what a
   commit found different. All of it comes from the server's own numbers. A fact the server did
   not measure is listed under "not known", never filled in from a genre or a guess. */

export type OverviewFacts = {
  /** Read from the songs as they are now. */
  measured: string[]
  /** What the songs could not tell. Empty when everything was read. */
  unknown: string[]
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const GENRES_SHOWN = 3

function span(low: number, high: number, digits: number): string {
  const text = (value: number) => value.toFixed(digits)
  return text(low) === text(high) ? text(low) : `${text(low)}–${text(high)}`
}

/**
 * `approvedSeconds` is the total stored with the revision, which is what the card's Total line
 * and what a commit approves. The overview's own total is added up from the songs as they are now,
 * and the two can differ once a song changes or leaves. The card shows the approved one as its
 * total and mentions the other only when it differs, or to say some songs have no length.
 */
export function overviewFacts(overview: Overview, approvedSeconds: number): OverviewFacts {
  const { measured, unknown } = overview
  const facts: string[] = []
  const gaps: string[] = []
  // The server counts a song since removed among those with no length. It is told apart below.
  const noLength = Math.max(0, unknown.duration_tracks - unknown.missing_tracks)
  const moved = Math.abs(measured.total_seconds - approvedSeconds) >= 1
  if (moved)
    facts.push(
      `Length now ${lengthText(measured.total_seconds)}, approved at ${lengthText(approvedSeconds)}`,
    )
  else if (noLength > 0 && measured.total_seconds > 0)
    facts.push(
      `${lengthText(measured.total_seconds)} from ${plural(measured.track_count - unknown.duration_tracks, 'song')} with a length`,
    )
  if (measured.artist_count > 0) facts.push(plural(measured.artist_count, 'artist'))
  if (measured.genres.length > 0) {
    const top = measured.genres
      .slice(0, GENRES_SHOWN)
      .map((genre) => `${genre.name} (${genre.count})`)
      .join(', ')
    const more = measured.genres.length - GENRES_SHOWN
    facts.push(more > 0 ? `${top} and ${more} more` : top)
  }
  const years = measured.year_range
  if (years) facts.push(years.min === years.max ? `${years.min}` : `${years.min}–${years.max}`)

  // Present only while a tempo and energy recipe is on, and only from songs it measured.
  const audio = measured.audio
  if (audio) {
    const total = audio.tempo_coverage.total
    if (audio.tempo)
      facts.push(
        `Tempo ${span(audio.tempo.min, audio.tempo.max, 0)} BPM, measured for ${audio.tempo_coverage.measured} of ${plural(total, 'song')}`,
      )
    if (audio.energy)
      facts.push(
        `Loudness ${span(audio.energy.min, audio.energy.max, 2)} (RMS level, not mood), measured for ${audio.energy_coverage.measured} of ${plural(total, 'song')}`,
      )
    if (!audio.tempo) gaps.push('No song has a fresh tempo measurement')
    else if (audio.tempo_coverage.measured < total)
      gaps.push(`${plural(total - audio.tempo_coverage.measured, 'song')} not measured for tempo`)
    if (!audio.energy) gaps.push('No song has a fresh loudness measurement')
    else if (audio.energy_coverage.measured < total)
      gaps.push(
        `${plural(total - audio.energy_coverage.measured, 'song')} not measured for loudness`,
      )
  }

  if (noLength > 0) gaps.push(`${plural(noLength, 'song')} with no length`)
  if (unknown.year_tracks > 0) gaps.push(`${plural(unknown.year_tracks, 'song')} with no year`)
  if (unknown.genre_tracks > 0) gaps.push(`${plural(unknown.genre_tracks, 'song')} with no genre`)
  if (unknown.artist_tracks > 0)
    gaps.push(`${plural(unknown.artist_tracks, 'song')} with no artist`)
  if (unknown.missing_tracks > 0)
    gaps.push(`${plural(unknown.missing_tracks, 'song')} no longer in the library`)
  return { measured: facts, unknown: gaps }
}

const SHOWN_CHANGES = 5

/** "songs.tr-…/history" → the song's title and what moved, in plain words. */
export function staleLines(
  fields: readonly { field: string; message: string }[],
  tracks: readonly Pick<LibraryTrack, 'id' | 'title'>[],
): string[] {
  const titles = new Map(tracks.map((track) => [track.id, track.title]))
  const lines = fields.slice(0, SHOWN_CHANGES).map(({ field, message }) => {
    const id = /^(?:songs|reference)\.(tr-[0-9a-f]{16})/.exec(field)?.[1]
    if (id === undefined) return message
    const label = field.startsWith('reference.') ? 'The song compared against' : titles.get(id)
    return `${label ?? 'A song'}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`
  })
  const rest = fields.length - lines.length
  return rest > 0 ? [...lines, `and ${plural(rest, 'other change')}`] : lines
}

/** What a refresh did to the list, said after it so nothing changes silently. */
export function refreshedNote(change: { added: number; removed: number }): string {
  if (!change.added && !change.removed) return 'Refreshed. The same songs are still there.'
  const parts = [
    ...(change.removed ? [`${plural(change.removed, 'song')} left`] : []),
    ...(change.added ? [`${plural(change.added, 'song')} came in`] : []),
  ]
  return `Refreshed the preview: ${parts.join(', ')}. Check it before you confirm.`
}
