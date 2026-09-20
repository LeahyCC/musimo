import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addSearch,
  readSearches,
  SEARCHES_KEY,
  SEARCHES_LIMIT,
  writeSearches,
} from './recent-searches'

describe('addSearch', () => {
  it('puts the newest search first', () => {
    expect(addSearch(['Radiohead'], 'Khruangbin')).toEqual(['Khruangbin', 'Radiohead'])
  })

  it('moves a repeat to the front instead of listing it twice', () => {
    expect(addSearch(['Nina Simone', 'Radiohead'], 'radiohead')).toEqual([
      'radiohead',
      'Nina Simone',
    ])
  })

  it('replaces a half-typed word with the word it became', () => {
    const typed = addSearch(addSearch(addSearch([], 'da'), 'daft'), 'daft punk')
    expect(typed).toEqual(['daft punk'])
  })

  it('keeps an earlier search that the new one merely resembles further down the list', () => {
    expect(addSearch(['Radiohead', 'Daft'], 'Daft Punk')).toEqual([
      'Daft Punk',
      'Radiohead',
      'Daft',
    ])
  })

  it('ignores a single character and tidies whitespace', () => {
    expect(addSearch(['Radiohead'], 'd')).toEqual(['Radiohead'])
    expect(addSearch([], '  nina    simone ')).toEqual(['nina simone'])
  })

  it('caps the list', () => {
    let list: string[] = []
    for (let index = 0; index < SEARCHES_LIMIT + 4; index++) {
      list = addSearch(list, `artist ${index}`)
    }
    expect(list).toHaveLength(SEARCHES_LIMIT)
    expect(list[0]).toBe(`artist ${SEARCHES_LIMIT + 3}`)
  })
})

describe('stored searches', () => {
  // The tests run in Node, which has no browser storage, so a Map stands in for it.
  const stored = new Map<string, string>()
  beforeEach(() => {
    stored.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips through storage', () => {
    writeSearches(['Radiohead', 'Nina Simone'])
    expect(readSearches()).toEqual(['Radiohead', 'Nina Simone'])
  })

  it('reads nothing from a value that is not a list of text', () => {
    stored.set(SEARCHES_KEY, '{"a":1}')
    expect(readSearches()).toEqual([])
    stored.set(SEARCHES_KEY, 'not json')
    expect(readSearches()).toEqual([])
    stored.set(SEARCHES_KEY, JSON.stringify(['ok', 3, null]))
    expect(readSearches()).toEqual(['ok'])
  })
})
