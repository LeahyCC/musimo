import { describe, expect, it } from 'vitest'

import { albumCountLabel, groupAlbumEditions, parseAlbumTitle, yearSpan } from './album-editions'

const album = (id: string, name: string) => ({ id, name })

describe('parseAlbumTitle', () => {
  it('leaves a plain title alone', () => {
    expect(parseAlbumTitle('Circles')).toEqual({ base: 'Circles', edition: '' })
  })

  it('takes edition words out of brackets and after a dash', () => {
    expect(parseAlbumTitle('Circles (Deluxe)')).toEqual({ base: 'Circles', edition: 'Deluxe' })
    expect(parseAlbumTitle('Circles [Expanded Edition]')).toEqual({
      base: 'Circles',
      edition: 'Expanded Edition',
    })

    expect(parseAlbumTitle('Circles - 2011 Remaster')).toEqual({
      base: 'Circles',
      edition: '2011 Remaster',
    })

    expect(parseAlbumTitle('Circles – 25th Anniversary Edition')).toEqual({
      base: 'Circles',
      edition: '25th Anniversary Edition',
    })
  })

  it('takes off several trailing groups in turn', () => {
    expect(parseAlbumTitle('Circles (Deluxe Edition) [Remastered]')).toEqual({
      base: 'Circles',
      edition: 'Deluxe Edition, Remastered',
    })
  })

  it('keeps a bracket that is not an edition', () => {
    expect(parseAlbumTitle('Circles (Live)').base).toBe('Circles (Live)')
    expect(parseAlbumTitle('Circles (2011)').base).toBe('Circles (2011)')
    expect(parseAlbumTitle('Circles (Acoustic Version)').base).toBe('Circles (Acoustic Version)')
  })

  it('does not treat a hyphen inside a word as a dash', () => {
    expect(parseAlbumTitle('Half-Life').base).toBe('Half-Life')
    expect(parseAlbumTitle('Re-Mastered').base).toBe('Re-Mastered')
  })

  it('keeps a title that is nothing but edition words', () => {
    expect(parseAlbumTitle('(Deluxe)').base).toBe('(Deluxe)')
  })
})

describe('groupAlbumEditions', () => {
  it('groups editions of one album, whatever the case and punctuation', () => {
    const groups = groupAlbumEditions([
      album('1', 'Circles'),
      album('2', 'CIRCLES (Deluxe Edition)'),
      album('3', 'Circles - 2020 Remaster'),
      album('4', 'Circles!'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.editions.map((item) => item.album.id)).toEqual(['1', '2', '3', '4'])
    expect(groups[0]?.name).toBe('Circles')
  })

  it('does not group titles that only look alike', () => {
    const groups = groupAlbumEditions([
      album('1', 'Blue'),
      album('2', 'Blue Moon'),
      album('3', 'Blue (Deluxe)'),
      album('4', 'Blue Moon (Remastered)'),
      album('5', 'Blue (Live)'),
    ])
    expect(groups.map((group) => group.editions.map((item) => item.album.id))).toEqual([
      ['1', '3'],
      ['2', '4'],
      ['5'],
    ])
  })

  it('keeps the first-seen order of the groups', () => {
    const groups = groupAlbumEditions([
      album('1', 'Beta'),
      album('2', 'Alpha'),
      album('3', 'Beta (Deluxe)'),
    ])
    expect(groups.map((group) => group.name)).toEqual(['Beta', 'Alpha'])
  })

  it('leads with the plain album, or the first when every one has edition words', () => {
    const withPlain = groupAlbumEditions([album('1', 'Circles (Deluxe)'), album('2', 'Circles')])
    expect(withPlain[0]?.lead.id).toBe('2')
    const allWords = groupAlbumEditions([
      album('1', 'Circles (Deluxe)'),
      album('2', 'Circles (Expanded)'),
    ])
    expect(allWords[0]?.lead.id).toBe('1')
    // The shared name drops the edition words rather than borrowing the lead's.
    expect(allWords[0]?.name).toBe('Circles')
  })

  it('leaves a group of one exactly as titled', () => {
    const [group] = groupAlbumEditions([album('1', 'Circles (Deluxe Edition)')])
    expect(group?.editions).toHaveLength(1)
    expect(group?.name).toBe('Circles (Deluxe Edition)')
  })

  it('does not merge titles made only of punctuation', () => {
    expect(groupAlbumEditions([album('1', '...'), album('2', '???')])).toHaveLength(2)
  })
})

describe('albumCountLabel', () => {
  it('shows only albums when each has one edition', () => {
    expect(albumCountLabel(1, 1)).toBe('1 album')
    expect(albumCountLabel(2, 2)).toBe('2 albums')
  })

  it('adds the editions when they differ', () => {
    expect(albumCountLabel(48, 56)).toBe('48 albums, 56 editions')
    expect(albumCountLabel(1, 2)).toBe('1 album, 2 editions')
  })
})

describe('yearSpan', () => {
  it('is one year, a range, or nothing', () => {
    expect(yearSpan([2015])).toBe('2015')
    expect(yearSpan([2025, 2015, 2015])).toBe('2015–2025')
    expect(yearSpan([undefined, 0])).toBe('')
    expect(yearSpan([undefined, 2020])).toBe('2020')
  })
})
