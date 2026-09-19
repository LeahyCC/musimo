import type { LibraryTrack, ReplayGain } from './api'

export type ReplayGainMode = 'off' | 'track' | 'album'

export const REPLAY_GAIN_MODES: readonly ReplayGainMode[] = ['off', 'track', 'album']
export const DEFAULT_REPLAY_GAIN_MODE: ReplayGainMode = 'track'
/** The pre-amp choices in decibels. Small on purpose: this trims the levelling, it is not a boost knob. */
export const PREAMP_OPTIONS: readonly number[] = [-6, -3, 0, 3, 6]
export const DEFAULT_PREAMP_DB = 0

/** The saved mode, or the default when it is missing or is not one of the three. */
export const parseReplayGainMode = (value: string | null): ReplayGainMode =>
  REPLAY_GAIN_MODES.find((mode) => mode === value) ?? DEFAULT_REPLAY_GAIN_MODE

/** The saved pre-amp, or the default when it is missing or is not one of the offered steps. */
export const parsePreamp = (value: string | null): number => {
  const decibels = value === null || value.trim() === '' ? NaN : Number(value)
  return PREAMP_OPTIONS.find((option) => option === decibels) ?? DEFAULT_PREAMP_DB
}

/**
 * True while the track at `index` is being played as part of its album: shuffle is off and a
 * neighbour in the queue is from the same album. A lone track from an album, or an album cut up
 * by shuffle or by songs queued in between, is not, and gets its track gain instead.
 */
export function playsAlbumInOrder(
  queue: readonly LibraryTrack[],
  index: number,
  shuffle: boolean,
): boolean {
  const albumId = queue[index]?.albumId
  if (shuffle || !albumId) return false
  return queue[index - 1]?.albumId === albumId || queue[index + 1]?.albumId === albumId
}

const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value)

/**
 * The factor to multiply a track's volume by, from its ReplayGain tags. 1 means play it as it is:
 * levelling is off, the track has no usable tag, or the gain is 0 dB.
 *
 * Album mode uses the album gain while `albumInOrder`, and otherwise (or when the album gain is
 * missing) the track gain. The pre-amp is added only to a track that has a gain, so an untagged
 * track never changes. The result is capped at 1 / peak so the loudest sample cannot pass full scale.
 */
export function replayGainMultiplier(
  gain: ReplayGain | undefined,
  mode: ReplayGainMode,
  albumInOrder: boolean,
  preampDb: number,
): number {
  if (mode === 'off' || !gain) return 1
  const useAlbum = mode === 'album' && albumInOrder && finite(gain.albumGain)
  const decibels = useAlbum ? gain.albumGain : gain.trackGain
  if (!finite(decibels)) return 1
  const peak = useAlbum ? gain.albumPeak : gain.trackPeak
  const multiplier = 10 ** ((decibels + (Number.isFinite(preampDb) ? preampDb : 0)) / 20)
  return finite(peak) && peak > 0 ? Math.min(multiplier, 1 / peak) : multiplier
}

/**
 * What an audio element's `volume` should be: the person's setting scaled by the gain. An element
 * cannot go above 1, so a boost only shows while the slider leaves room for it.
 */
export const levelledVolume = (volume: number, multiplier: number): number =>
  Math.max(0, Math.min(1, volume * multiplier))
