import type { LibraryTrack } from '../../api'

export const STARTERS = [
  'An hour of my favourite 90s music',
  'Play some hip hop',
  'Something like this song',
  'Songs I haven’t played yet',
] as const

export const LIKE_STARTER = 'Something like this song'

/** "Something like this song" needs a song from the library to be playing; the rest always work. */
export const startersFor = (playing: LibraryTrack | null | undefined) =>
  STARTERS.filter((starter) => starter !== LIKE_STARTER || playing)
