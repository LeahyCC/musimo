import { describe, expect, it } from 'vitest'

import { editNote, overviewFacts, refreshedNote, staleLines } from './preview-text'
import type { Overview } from './proposals'

const song = (n: number) => `tr-${n.toString(16).padStart(16, '0')}`

function overview(
  measured: Partial<Overview['measured']> = {},
  unknown: Partial<Overview['unknown']> = {},
): Overview {
  return {
    measured: {
      track_count: 40,
      total_seconds: 9600,
      artist_count: 12,
      genres: [
        { name: 'Rock', count: 30 },
        { name: 'Pop', count: 6 },
      ],
      year_range: { min: 1990, max: 1999 },
      audio: null,
      ...measured,
    },
    unknown: {
      duration_tracks: 0,
      year_tracks: 0,
      genre_tracks: 0,
      artist_tracks: 0,
      missing_tracks: 0,
      ...unknown,
    },
  }
}

/** The facts for a revision whose approved total is the one its songs add up to now, unless
 *  a test says otherwise. */
const readFacts = (value: Overview, approved = value.measured.total_seconds) =>
  overviewFacts(value, approved)

describe('overviewFacts', () => {
  it('reads length, artists, genres and years from the songs, and lists nothing as unknown', () => {
    expect(readFacts(overview())).toEqual({
      measured: ['12 artists', 'Rock (30), Pop (6)', '1990–1999'],
      unknown: [],
    })
  })

  it('says nothing about tempo or loudness while no recipe is on', () => {
    const text = readFacts(overview()).measured.join(' ')
    expect(text).not.toMatch(/tempo|bpm|loudness/i)
  })

  it('reports a measured tempo only with how many songs it covers', () => {
    const facts = readFacts(
      overview({
        audio: {
          tempo: { min: 168.2, max: 176.4 },
          energy: { min: 0.04, max: 0.11 },
          tempo_coverage: { measured: 30, total: 40 },
          energy_coverage: { measured: 40, total: 40 },
        },
      }),
    )
    expect(facts.measured).toContain('Tempo 168–176 BPM, measured for 30 of 40 songs')
    expect(facts.measured).toContain(
      'Loudness 0.04–0.11 (RMS level, not mood), measured for 40 of 40 songs',
    )
    expect(facts.unknown).toEqual(['10 songs not measured for tempo'])
  })

  it('says so when a recipe is on and no song has a fresh measurement', () => {
    const facts = readFacts(
      overview({
        audio: {
          tempo: null,
          energy: null,
          tempo_coverage: { measured: 0, total: 40 },
          energy_coverage: { measured: 0, total: 40 },
        },
      }),
    )
    expect(facts.measured.join(' ')).not.toMatch(/BPM/)
    expect(facts.unknown).toEqual([
      'No song has a fresh tempo measurement',
      'No song has a fresh loudness measurement',
    ])
  })

  it('counts a missing length once, apart from a song since removed', () => {
    const facts = readFacts(
      overview(
        { total_seconds: 5400 },
        { duration_tracks: 5, missing_tracks: 3, year_tracks: 1, genre_tracks: 2 },
      ),
    )
    expect(facts.measured[0]).toBe('1 h 30 min from 35 songs with a length')
    expect(facts.unknown).toEqual([
      '2 songs with no length',
      '1 song with no year',
      '2 songs with no genre',
      '3 songs no longer in the library',
    ])
  })

  it('names both lengths when the songs no longer add up to the approved total', () => {
    // Approved at 2 h 40 min; one song has since changed length and the songs now sum to 2 h 35.
    const facts = readFacts(overview({ total_seconds: 9300 }), 9600)
    expect(facts.measured[0]).toBe('Length now 2 h 35 min, approved at 2 h 40 min')
    // A difference under a second is rounding, not a change.
    expect(readFacts(overview({ total_seconds: 9600.4 }), 9600).measured.join(' ')).not.toMatch(
      /approved/,
    )
  })

  it('leaves the total to the card unless some songs have no length', () => {
    expect(readFacts(overview()).measured.join(' ')).not.toMatch(/in all|min from/)
    expect(readFacts(overview({ track_count: 10 }, { duration_tracks: 2 })).measured[0]).toBe(
      '2 h 40 min from 8 songs with a length',
    )
  })

  it('shows the three biggest genres and counts the rest', () => {
    const genres = ['A', 'B', 'C', 'D', 'E'].map((name, count) => ({ name, count: 9 - count }))
    expect(readFacts(overview({ genres })).measured).toContain('A (9), B (8), C (7) and 2 more')
  })

  it('leaves a single year as one year and omits a range that is not known', () => {
    expect(readFacts(overview({ year_range: { min: 1992, max: 1992 } })).measured).toContain('1992')
    expect(readFacts(overview({ year_range: null })).measured.join(' ')).not.toMatch(/19/)
  })
})

describe('staleLines', () => {
  const tracks = [
    { id: song(1), title: 'First Light' },
    { id: song(2), title: 'Orchard Song' },
  ]

  it('names each song and what moved', () => {
    expect(
      staleLines(
        [
          { field: `songs.${song(1)}`, message: 'The file is unavailable' },
          { field: `songs.${song(2)}.history`, message: 'Play history changed' },
          { field: 'local_day', message: 'The day changed' },
        ],
        tracks,
      ),
    ).toEqual([
      'First Light: the file is unavailable',
      'Orchard Song: play history changed',
      'The day changed',
    ])
  })

  it('does not know a song that left the library, and says the comparison song changed', () => {
    expect(
      staleLines(
        [
          { field: `songs.${song(7)}`, message: 'Not in the library' },
          { field: `reference.${song(2)}`, message: 'Tags, length or file changed' },
        ],
        tracks,
      ),
    ).toEqual([
      'A song: not in the library',
      'The song compared against: tags, length or file changed',
    ])
  })

  it('lists five changes and counts the rest', () => {
    const fields = Array.from({ length: 8 }, (_, n) => ({
      field: `songs.${song(n)}`,
      message: 'The file is unavailable',
    }))
    const lines = staleLines(fields, tracks)
    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toBe('and 3 other changes')
  })
})

describe('refreshedNote', () => {
  it('says what the refresh changed, so no song swaps silently', () => {
    expect(refreshedNote({ added: 1, removed: 2 })).toBe(
      'Refreshed the preview: 2 songs left, 1 song came in. Check it before you confirm.',
    )
    expect(refreshedNote({ added: 0, removed: 1 })).toMatch(/1 song left\./)
    expect(refreshedNote({ added: 0, removed: 0 })).toBe(
      'Refreshed. The same songs are still there.',
    )
  })
})

describe('editNote', () => {
  it('says how many songs an edit moved, in the words for one and for many', () => {
    expect(editNote('remove', { added: 0, removed: 1 })).toBe(
      'Removed 1 song. It won’t come back in this preview.',
    )
    expect(editNote('remove', { added: 0, removed: 2 })).toMatch(/^Removed 2 songs\. They won’t/)
    expect(editNote('add', { added: 1, removed: 0 })).toBe('Added 1 song that fit these filters.')
  })

  it('says so when an add found nothing, rather than reporting an add', () => {
    expect(editNote('add', { added: 0, removed: 0 })).toBe(
      'No other song fits these filters, so nothing was added.',
    )
  })

  it('names the pinned songs an Another set kept, and the songs it replaced', () => {
    expect(editNote('another', { added: 3, removed: 3 }, 2)).toBe(
      'Drew another set, keeping 2 pinned songs: 3 songs replaced.',
    )

    expect(editNote('another', { added: 0, removed: 0 })).toBe(
      'Drew another set, and the same songs came up.',
    )
  })
})
