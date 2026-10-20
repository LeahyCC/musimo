/**
 * Library list filters and the artist page sorts, as address-bar search params.
 *
 * The address is the record for the page you are on, so a refresh keeps it. Each view also
 * remembers its last choice for the rest of the browser visit, so a view tab or the back link
 * can open that address again. The router already owns the address (the same job as nuqs), and
 * these helpers only decide which values are worth keeping.
 */

export const libraryTabs = ['home', 'albums', 'artists', 'tracks', 'playlists'] as const
export type LibraryTab = (typeof libraryTabs)[number]

export const libraryPaths = {
  home: '/library',
  albums: '/library/albums',
  artists: '/library/artists',
  tracks: '/library/tracks',
  playlists: '/library/playlists',
} as const

// Keep these next to SORTS in library.tsx. The first value is what a bare address means.
export const librarySortValues = {
  home: ['newest', 'title', 'artist', 'year'],
  albums: ['newest', 'title', 'artist', 'year'],
  artists: ['name', 'albums', 'recent'],
  tracks: ['title', 'artist', 'album', 'year', 'duration', 'newest'],
  playlists: ['name', 'tracks', 'duration', 'changed'],
} as const

export const artistAlbumSorts = ['year', 'oldest', 'title', 'plays'] as const
export const artistSongSorts = ['album', 'title', 'plays', 'duration', 'year'] as const
export type ArtistAlbumSort = (typeof artistAlbumSorts)[number]
export type ArtistSongSort = (typeof artistSongSorts)[number]

const artistShows = ['favourites', 'played', 'unplayed'] as const
const playlistVisibility = ['public', 'private'] as const

export type LibraryListSearch = {
  q?: string
  sort?: string
  genre?: string[]
  year?: string[]
  show?: (typeof artistShows)[number]
  visibility?: (typeof playlistVisibility)[number]
}

const LIST_KEY = 'musimo.library-views'
const ARTIST_KEY = 'musimo.library-artist-sort'
const LAST_VIEW_KEY = 'musimo.library-last-view'

/** The four list views, in the order their tabs and sidebar rows show them. */
export const libraryViews = ['artists', 'albums', 'tracks', 'playlists'] as const
export type LibraryView = (typeof libraryViews)[number]

export function defaultLibrarySort(tab: LibraryTab) {
  return librarySortValues[tab][0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** One query value, or a repeated one, as a short list of text. Numbers are years. */
function textList(value: unknown) {
  const raw = Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value]
  const items = raw.map((item) => {
    if (typeof item === 'string') return item.trim()
    if (typeof item === 'number' && Number.isFinite(item)) return String(item)
    return ''
  })
  const unique = [...new Set(items.filter(Boolean).map((item) => item.slice(0, 80)))]
  return unique.length ? unique.slice(0, 40) : undefined
}

export function validateLibrarySearch(tab: LibraryTab, search: Record<string, unknown>) {
  const allowed: readonly string[] = librarySortValues[tab]
  const sort = allowed.find((item) => item === search.sort)
  const show = artistShows.find((item) => item === search.show)
  const visibility = playlistVisibility.find((item) => item === search.visibility)
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 200) : ''
  const result: LibraryListSearch = {}
  if (q) result.q = q
  if (sort && sort !== defaultLibrarySort(tab)) result.sort = sort
  const genre = textList(search.genre)
  const year = textList(search.year)
  if (genre) result.genre = genre
  if (year) result.year = year
  if (tab === 'artists' && show) result.show = show
  if (tab === 'playlists' && visibility) result.visibility = visibility
  return result
}

export function librarySearchActive(search: LibraryListSearch) {
  return Boolean(
    search.q ||
    search.sort ||
    search.genre?.length ||
    search.year?.length ||
    search.show ||
    search.visibility,
  )
}

function pickSort<T extends string>(allowed: readonly T[], fallback: T, value: unknown) {
  const sort = allowed.find((item) => item === value)
  return sort && sort !== fallback ? sort : undefined
}

export function validateArtistAlbumSearch(search: Record<string, unknown>): {
  sort?: ArtistAlbumSort
} {
  const sort = pickSort(artistAlbumSorts, 'year', search.sort)
  return sort ? { sort } : {}
}

export function validateArtistSongSearch(search: Record<string, unknown>): {
  sort?: ArtistSongSort
} {
  const sort = pickSort(artistSongSorts, 'album', search.sort)
  return sort ? { sort } : {}
}

function readSession(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function writeSession(key: string, value: unknown) {
  try {
    const text = JSON.stringify(value)
    if (sessionStorage.getItem(key) !== text) sessionStorage.setItem(key, text)
  } catch {
    // A private window, or storage that is full, still has the address.
  }
}

export function loadLibraryView(tab: LibraryTab): LibraryListSearch {
  const stored = readSession(LIST_KEY)
  if (!isRecord(stored)) return {}
  const view = stored[tab]
  return isRecord(view) ? validateLibrarySearch(tab, view) : {}
}

export function saveLibraryView(tab: LibraryTab, search: LibraryListSearch) {
  const stored = readSession(LIST_KEY)
  const views = isRecord(stored) ? { ...stored } : {}
  views[tab] = validateLibrarySearch(tab, search)
  writeSession(LIST_KEY, views)
}

/**
 * The list view the Library was last on in this visit, so a way back into the Library (its tab,
 * the palette, `/library`) opens where the person left it. That view brings back its own filters
 * (`loadLibraryView`). Before there is one, the first tab.
 */
export function lastLibraryView(): LibraryView {
  const stored = readSession(LAST_VIEW_KEY)
  return libraryViews.find((view) => view === stored) ?? libraryViews[0]
}

export function saveLastLibraryView(view: LibraryView) {
  writeSession(LAST_VIEW_KEY, view)
}

export function loadArtistSort(kind: 'albums'): ArtistAlbumSort | undefined
export function loadArtistSort(kind: 'songs'): ArtistSongSort | undefined
export function loadArtistSort(kind: 'albums' | 'songs') {
  const stored = readSession(ARTIST_KEY)
  if (!isRecord(stored)) return undefined
  return kind === 'songs'
    ? pickSort(artistSongSorts, 'album', stored.songs)
    : pickSort(artistAlbumSorts, 'year', stored.albums)
}

export function saveArtistSort(kind: 'albums' | 'songs', sort: string | undefined) {
  const stored = readSession(ARTIST_KEY)
  const views = isRecord(stored) ? { ...stored } : {}
  const clean =
    kind === 'songs'
      ? pickSort(artistSongSorts, 'album', sort)
      : pickSort(artistAlbumSorts, 'year', sort)
  if (clean) views[kind] = clean
  else delete views[kind]
  writeSession(ARTIST_KEY, views)
}
