import { describe, expect, it } from 'vitest'

import type { LibraryTrack, SongDetail } from './api'
import {
  contributorGroups,
  fileRows,
  fileSizeText,
  fileSummary,
  isLowQualityLossy,
  otherAlbums,
  playedAt,
  releaseRows,
  sampleRateText,
} from './track-info'

const song = (over: Partial<SongDetail> = {}): SongDetail => ({ id: 'song-1', ...over })

describe('fileSummary', () => {
  it('reads format, sample rate and bitrate', () => {
    expect(fileSummary(song({ suffix: 'flac', samplingRate: 44100, bitRate: 1012 }))).toBe(
      'FLAC, 44.1 kHz, 1,012 kbps',
    )
  })

  it('leaves out what Navidrome did not send, and a zero standing for unknown', () => {
    expect(fileSummary(song({ suffix: 'mp3', bitRate: 320 }))).toBe('MP3, 320 kbps')
    expect(fileSummary(song({ suffix: 'ogg', samplingRate: 0, bitRate: 0 }))).toBe('OGG')
    expect(fileSummary(song())).toBe('')
  })

  it('falls back to the content type when the file has no extension', () => {
    expect(fileSummary(song({ contentType: 'audio/flac' }))).toBe('FLAC')
  })
})

describe('sampleRateText', () => {
  it('drops a pointless .0', () => {
    expect(sampleRateText(44100)).toBe('44.1 kHz')
    expect(sampleRateText(48000)).toBe('48 kHz')
    expect(sampleRateText(96000)).toBe('96 kHz')
  })
})

describe('fileSizeText', () => {
  it('picks the unit that keeps the number short', () => {
    expect(fileSizeText(300)).toBe('1 KB')
    expect(fileSizeText(512 * 1024)).toBe('512 KB')
    expect(fileSizeText(35_840_000)).toBe('34.2 MB')
    expect(fileSizeText(2 * 1024 ** 3)).toBe('2.00 GB')
  })
})

describe('fileRows', () => {
  it('lists only the facts that have a value', () => {
    const rows = fileRows(
      song({
        suffix: 'flac',
        bitRate: 1012,
        samplingRate: 44100,
        bitDepth: 0,
        channelCount: 2,
        size: 35_840_000,
        path: 'Artist/Album/01 Track.flac',
      }),
    )
    expect(rows.map((row) => row.label)).toEqual([
      'Format',
      'Bitrate',
      'Sample rate',
      'Channels',
      'Size',
      'Path',
    ])
    expect(rows.find((row) => row.label === 'Channels')?.value).toBe('Stereo')
  })

  it('has no rows for a song with no file facts', () => {
    expect(fileRows(song())).toEqual([])
  })

  it('names bit depth when it is known', () => {
    expect(fileRows(song({ bitDepth: 24 })).map((row) => row.value)).toEqual(['24-bit'])
  })
})

describe('isLowQualityLossy', () => {
  it('flags a lossy file under 192 kbps', () => {
    expect(isLowQualityLossy(song({ suffix: 'mp3', bitRate: 128 }))).toBe(true)
    expect(isLowQualityLossy(song({ suffix: 'opus', bitRate: 191 }))).toBe(true)
  })

  it('leaves 192 kbps and above alone', () => {
    expect(isLowQualityLossy(song({ suffix: 'mp3', bitRate: 192 }))).toBe(false)
    expect(isLowQualityLossy(song({ suffix: 'mp3', bitRate: 320 }))).toBe(false)
  })

  it('never flags lossless, or a bitrate that is not known', () => {
    expect(isLowQualityLossy(song({ suffix: 'flac', bitRate: 100 }))).toBe(false)
    expect(isLowQualityLossy(song({ suffix: 'mp3' }))).toBe(false)
    expect(isLowQualityLossy(song({ suffix: 'mp3', bitRate: 0 }))).toBe(false)
  })
})

describe('contributorGroups', () => {
  it('groups by role, names each person once and capitalises the role', () => {
    const groups = contributorGroups(
      song({
        contributors: [
          { role: 'producer', artist: { name: 'Maker' } },
          { role: 'producer', artist: { name: 'Second' } },
          { role: 'producer', artist: { name: 'Maker' } },
          { role: 'performer', subRole: 'bass', artist: { name: 'Low End' } },
        ],
      }),
    )
    expect(groups).toEqual([
      { role: 'Producer', names: ['Maker', 'Second'] },
      { role: 'Performer (bass)', names: ['Low End'] },
    ])
  })

  it('is empty when there are no credits', () => {
    expect(contributorGroups(song())).toEqual([])
  })
})

const queued: LibraryTrack = {
  id: 'song-1',
  title: 'Delta',
  artist: 'Harbor Static',
  album: 'Clear Water',
  duration: 200,
  playCount: 0,
}

describe('releaseRows', () => {
  it('lists what is known, with the song’s tags winning over the queued copy', () => {
    const rows = releaseRows(
      song({
        year: 2019,
        genres: [{ name: 'Ambient' }, { name: 'Drone' }],
        track: 3,
        discNumber: 2,
        contributors: [{ role: 'producer', artist: { name: 'Maker' } }],
      }),
      { ...queued, year: 2001, genre: 'Rock', track: 9 },
      ['Static Records'],
    )
    expect(rows).toEqual([
      { label: 'Album', value: 'Clear Water' },
      { label: 'Year', value: '2019' },
      { label: 'Label', value: 'Static Records' },
      { label: 'Genre', value: 'Ambient, Drone' },
      { label: 'Track', value: '3' },
      { label: 'Disc', value: '2' },
      { label: 'Producer', value: 'Maker' },
    ])
  })

  it('shows only the album for a track with nothing else known yet', () => {
    expect(releaseRows(undefined, queued, [])).toEqual([{ label: 'Album', value: 'Clear Water' }])
  })

  it('treats a year or position of 0 as absent', () => {
    const rows = releaseRows(song({ year: 0, track: 0, discNumber: 0 }), queued, [])
    expect(rows.map((row) => row.label)).toEqual(['Album'])
  })
})

describe('otherAlbums', () => {
  const album = (id: string, year?: number) => ({
    id,
    name: id,
    artist: 'Harbor Static',
    songCount: 10,
    duration: 0,
    playCount: 0,
    year,
  })

  it('leaves out the current album, newest first, and stops at the limit', () => {
    const albums = [album('a', 2010), album('b'), album('c', 2020), album('d', 2015), album('e')]
    expect(otherAlbums(albums, 'd', 3).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('is empty when the artist has only this album', () => {
    expect(otherAlbums([album('a', 2010)], 'a', 8)).toEqual([])
  })
})

describe('playedAt', () => {
  it('reads Navidrome’s timestamp', () => {
    expect(playedAt(song({ played: '2026-09-01T18:30:00Z' }))).toBe(Date.UTC(2026, 8, 1, 18, 30))
  })

  it('is undefined when it is missing or unreadable', () => {
    expect(playedAt(song())).toBeUndefined()
    expect(playedAt(song({ played: 'never' }))).toBeUndefined()
  })
})
