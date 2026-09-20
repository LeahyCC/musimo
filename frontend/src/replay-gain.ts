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
 * The gain and peak a track is levelled by: the album's while `albumInOrder` in album mode, and
 * otherwise (or when the album gain is missing) the track's. Null when nothing usable is tagged.
 */
function chosenGain(
  gain: ReplayGain | undefined,
  mode: ReplayGainMode,
  albumInOrder: boolean,
): { decibels: number; peak: number | undefined } | null {
  if (mode === 'off' || !gain) return null
  const useAlbum = mode === 'album' && albumInOrder && finite(gain.albumGain)
  const decibels = useAlbum ? gain.albumGain : gain.trackGain
  if (!finite(decibels)) return null
  return { decibels, peak: useAlbum ? gain.albumPeak : gain.trackPeak }
}

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
  const chosen = chosenGain(gain, mode, albumInOrder)
  if (!chosen) return 1
  const { decibels, peak } = chosen
  const multiplier = 10 ** ((decibels + (Number.isFinite(preampDb) ? preampDb : 0)) / 20)
  return finite(peak) && peak > 0 ? Math.min(multiplier, 1 / peak) : multiplier
}

/**
 * True when the tag that levels this track also says how loud its loudest sample is. Only then is
 * a multiplier above 1 known to fit under full scale, because `replayGainMultiplier` caps it at
 * 1 / peak. Without a peak a boost could clip, so it is left out.
 */
export function replayGainHasPeak(
  gain: ReplayGain | undefined,
  mode: ReplayGainMode,
  albumInOrder: boolean,
): boolean {
  const peak = chosenGain(gain, mode, albumInOrder)?.peak
  return finite(peak) && peak > 0
}

/**
 * What an audio element's `volume` should be: the person's setting scaled by the gain. An element
 * cannot go above 1, so on its own a boost only shows while the slider leaves room for it. See
 * `splitLevel` for the part above 1.
 */
export const levelledVolume = (volume: number, multiplier: number): number =>
  Math.max(0, Math.min(1, volume * multiplier))

/**
 * Splits a level into an element's `volume` and a gain stage's `gain`, for an element whose sound
 * runs through one. The element keeps everything up to 1, so the two multiply back to the level:
 * 0.4 x 1.5 is volume 0.6 with a gain of 1, and 0.8 x 1.5 is volume 1 with a gain of 1.2. When the
 * element has no gain stage, or the boost is not known to be safe (`boostable` false), the gain
 * stays 1 and the volume is capped as `levelledVolume` does.
 */
export function splitLevel(
  volume: number,
  multiplier: number,
  boostable: boolean,
): { volume: number; gain: number } {
  const level = Math.max(0, volume * multiplier)
  if (!boostable || level <= 1) return { volume: levelledVolume(volume, multiplier), gain: 1 }
  return { volume: 1, gain: level }
}
