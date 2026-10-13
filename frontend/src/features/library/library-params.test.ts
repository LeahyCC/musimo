import { afterEach, describe, expect, it } from 'vitest'

import {
  loadArtistSort,
  loadLibraryView,
  saveArtistSort,
  saveLibraryView,
  validateArtistAlbumSearch,
  validateArtistSongSearch,
  validateLibrarySearch,
} from './library-params'

const memory = new Map<string, string>()

afterEach(() => {
  memory.clear()
})

function installStorage() {
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
    removeItem: (key: string) => {
      memory.delete(key)
    },
  }
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true })
}

describe('validateLibrarySearch', () => {
  it('keeps a non-default sort, a query and repeated filters', () => {
    expect(
      validateLibrarySearch('tracks', {
        q: '  cinder ',
        sort: 'duration',
        genre: ['Jazz', 'Jazz', ''],
        year: [1999, '2011'],
        show: 'favourites',
      }),
    ).toEqual({ q: 'cinder', sort: 'duration', genre: ['Jazz'], year: ['1999', '2011'] })
  })

  it('drops a default sort, an unknown sort and filters that belong to another view', () => {
    expect(validateLibrarySearch('artists', { sort: 'name', visibility: 'public' })).toEqual({})
    expect(validateLibrarySearch('playlists', { sort: 'nope', visibility: 'public' })).toEqual({
      visibility: 'public',
    })

    expect(validateLibrarySearch('albums', { sort: 'duration', genre: 'Ambient' })).toEqual({
      genre: ['Ambient'],
    })
  })
})

describe('validateArtist searches', () => {
  it('keeps an album order and a song order, and drops the one each page starts on', () => {
    expect(validateArtistAlbumSearch({ sort: 'oldest' })).toEqual({ sort: 'oldest' })
    expect(validateArtistAlbumSearch({ sort: 'year' })).toEqual({})
    expect(validateArtistSongSearch({ sort: 'plays' })).toEqual({ sort: 'plays' })
    expect(validateArtistSongSearch({ sort: 'oldest' })).toEqual({})
  })
})

describe('remembered views', () => {
  it('round-trips a view and an artist order, and ignores a bad saved value', () => {
    installStorage()
    saveLibraryView('tracks', { sort: 'duration', genre: ['Jazz'], show: 'played' })
    expect(loadLibraryView('tracks')).toEqual({ sort: 'duration', genre: ['Jazz'] })
    expect(loadLibraryView('albums')).toEqual({})

    saveArtistSort('albums', 'oldest')
    saveArtistSort('songs', 'album')
    expect(loadArtistSort('albums')).toBe('oldest')
    expect(loadArtistSort('songs')).toBeUndefined()
  })
})
