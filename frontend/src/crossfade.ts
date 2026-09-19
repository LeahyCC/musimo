import type { LibraryTrack } from './api'

export const MAX_CROSSFADE_SECONDS = 12
export const DEFAULT_CROSSFADE_SECONDS = 0
/** Off, then each whole second up to the longest overlap. */
export const CROSSFADE_OPTIONS: readonly number[] = Array.from(
  { length: MAX_CROSSFADE_SECONDS + 1 },
  (_, seconds) => seconds,
)

/** The saved overlap, or Off when it is missing or is not one of the offered whole seconds. */
export const parseCrossfade = (value: string | null): number => {
  const seconds = value === null || value.trim() === '' ? NaN : Number(value)
  return CROSSFADE_OPTIONS.find((option) => option === seconds) ?? DEFAULT_CROSSFADE_SECONDS
}

// Under this much left a crossfade would be a click, so the ordinary handover does it.
const MIN_OVERLAP_SECONDS = 0.25

export type CrossfadeChoice = {
  /** The listener's setting, in seconds. 0 is Off. */
  seconds: number
  repeat: 'off' | 'all' | 'one'
  current: LibraryTrack
  currentIndex: number
  upcoming: LibraryTrack
  upcomingIndex: number
  /** The playing track's real length and what is left of it, from the element. */
  length: number
  left: number
}

/**
 * True when `upcoming` is the next track of the same album, queued straight after `current`. That
 * pair is what gapless playback is for: an album is mastered to run on, and a crossfade would blur
 * the join the artist made.
 */
export const followsOnFromAlbum = (
  current: LibraryTrack,
  currentIndex: number,
  upcoming: LibraryTrack,
  upcomingIndex: number,
): boolean =>
  upcomingIndex === currentIndex + 1 &&
  Boolean(current.albumId) &&
  current.albumId === upcoming.albumId

/**
 * How many seconds the two tracks should overlap, or 0 to leave the join to gapless playback.
 * It is 0 while Off, for repeat one, and for consecutive tracks of one album. A track short enough
 * that the overlap would be most of it gets no more than half, and once the overlap is due it
 * never asks for more than what is left, so a late start still ends when the track does.
 */
export function crossfadeSpan(choice: CrossfadeChoice): number {
  if (choice.seconds <= 0 || choice.repeat === 'one') return 0
  if (
    followsOnFromAlbum(choice.current, choice.currentIndex, choice.upcoming, choice.upcomingIndex)
  )
    return 0
  if (!Number.isFinite(choice.length) || choice.length <= 0) return 0
  let span = Math.min(choice.seconds, choice.length / 2)
  if (choice.upcoming.duration > 0) span = Math.min(span, choice.upcoming.duration / 2)
  if (choice.left > span) return 0
  const overlap = Math.min(span, choice.left)
  return overlap < MIN_OVERLAP_SECONDS ? 0 : overlap
}
