import type { LibraryAlbum, LibraryTrack, SongDetail } from './api'

/** Below this a lossy file is worth trying to replace. */
export const LOW_BITRATE_KBPS = 192

// Formats that discard sound. M4A is here because it is almost always AAC; an ALAC file in one
// has a bitrate far above LOW_BITRATE_KBPS, so it never reads as low quality.
const LOSSY = new Set(['mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma'])

const numbers = new Intl.NumberFormat('en')

/** A number Navidrome sent, or undefined where it sent nothing or a zero standing for "unknown". */
function positive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/** "FLAC", "MP3". Falls back to the content type's subtype when the file has no extension. */
export function formatName(song: SongDetail) {
  const name = song.suffix || song.contentType?.split('/').pop() || ''
  return name.replace(/^\./, '').toUpperCase()
}

/** 44100 is "44.1 kHz" and 48000 is "48 kHz". */
export function sampleRateText(hertz: number) {
  return `${Number((hertz / 1000).toFixed(1))} kHz`
}

export function bitrateText(kbps: number) {
  return `${numbers.format(Math.round(kbps))} kbps`
}

export function channelsText(count: number) {
  if (count === 1) return 'Mono'
  if (count === 2) return 'Stereo'
  return `${count} channels`
}

export function fileSizeText(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** "FLAC, 44.1 kHz, 1,012 kbps", with whatever Navidrome did not send left out. */
export function fileSummary(song: SongDetail) {
  return [
    formatName(song),
    shown(song.samplingRate, sampleRateText),
    shown(song.bitRate, bitrateText),
  ]
    .filter(Boolean)
    .join(', ')
}

/** A lossy file whose bitrate is known and under LOW_BITRATE_KBPS. */
export function isLowQualityLossy(song: SongDetail) {
  const bitrate = positive(song.bitRate)
  return (
    bitrate !== undefined && bitrate < LOW_BITRATE_KBPS && LOSSY.has(formatName(song).toLowerCase())
  )
}

/** `show` of the number when Navidrome sent a usable one, otherwise nothing. */
function shown(value: number | undefined, show: (value: number) => string) {
  const number = positive(value)
  return number === undefined ? undefined : show(number)
}

/** The facts about the file that have a value, as label and text rows. */
export function fileRows(song: SongDetail) {
  const rows: [string, string | undefined][] = [
    ['Format', formatName(song) || undefined],
    ['Bitrate', shown(song.bitRate, bitrateText)],
    ['Sample rate', shown(song.samplingRate, sampleRateText)],
    ['Bit depth', shown(song.bitDepth, (bits) => `${bits}-bit`)],
    ['Channels', shown(song.channelCount, channelsText)],
    ['Size', shown(song.size, fileSizeText)],
    ['Path', song.path?.trim() || undefined],
  ]
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []))
}

/** Credits grouped by role, each name once. "producer" becomes "Producer". */
export function contributorGroups(song: SongDetail) {
  const groups = new Map<string, string[]>()
  for (const { role, subRole, artist } of song.contributors ?? []) {
    const name = artist.name.trim()
    if (!role || !name) continue
    const label = role.charAt(0).toUpperCase() + role.slice(1) + (subRole ? ` (${subRole})` : '')
    const names = groups.get(label) ?? []
    if (!names.includes(name)) names.push(name)
    groups.set(label, names)
  }
  return [...groups].map(([role, names]) => ({ role, names }))
}

/** A count such as a year or track number, or nothing where Navidrome sent none or a 0. */
function counted(value: number | undefined) {
  return shown(value, String)
}

/**
 * Where the track sits in the world: album, year, label, genre, position and credits. The song's
 * own tags win over the copy the queue carried, which is a trimmed one.
 */
export function releaseRows(song: SongDetail | undefined, track: LibraryTrack, labels: string[]) {
  const genres = (song?.genres ?? []).map((genre) => genre.name.trim()).filter(Boolean)
  const rows: [string, string | undefined][] = [
    ['Album', track.album || undefined],
    ['Year', counted(song?.year ?? track.year)],
    ['Label', labels.join(', ') || undefined],
    ['Genre', genres.join(', ') || song?.genre || track.genre || undefined],
    ['Track', counted(song?.track ?? track.track)],
    ['Disc', counted(song?.discNumber)],
    ...(song ? contributorGroups(song) : []).map(({ role, names }): [string, string] => [
      role,
      names.join(', '),
    ]),
  ]
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []))
}

/** The artist's other albums, newest first, undated ones last. */
export function otherAlbums(albums: LibraryAlbum[], currentId: string | undefined, limit: number) {
  return albums
    .filter((album) => album.id !== currentId)
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, limit)
}

/** When it was last played as a timestamp, or undefined where Navidrome sent none or nonsense. */
export function playedAt(song: SongDetail) {
  const time = song.played ? Date.parse(song.played) : Number.NaN
  return Number.isFinite(time) ? time : undefined
}
