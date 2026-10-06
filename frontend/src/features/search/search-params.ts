export const tabs = ['top', 'track', 'album', 'artist', 'podcast'] as const
export type Tab = (typeof tabs)[number]
export const sorts = ['relevance', 'title', 'artist', 'year', 'duration', 'popularity'] as const
export type Sort = (typeof sorts)[number]
const artistReleaseTypes = ['albums-eps', 'album', 'ep', 'single', 'all'] as const
const artistSorts = ['newest', 'oldest', 'title', 'title-desc'] as const

export type SearchState = {
  q?: string
  tab?: Tab
  explicit?: 'all' | 'clean' | 'explicit'
  from?: number
  until?: number
  min?: number
  max?: number
  preview?: boolean
  library?: 'all' | 'missing' | 'owned'
  sort?: Sort
}
export type ArtistSearch = {
  type?: (typeof artistReleaseTypes)[number]
  sort?: (typeof artistSorts)[number]
}
export function validateSearch(search: Record<string, unknown>): SearchState {
  const number = (value: unknown) =>
    value !== '' && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : undefined
  return {
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : undefined,
    tab: tabs.find((tab) => tab === search.tab),
    sort: sorts.find((sort) => sort === search.sort),
    explicit:
      search.explicit === 'clean' || search.explicit === 'explicit' ? search.explicit : undefined,
    library:
      search.library === 'owned' || search.library === 'missing' ? search.library : undefined,
    preview: search.preview === true || search.preview === 'true' || undefined,
    from: number(search.from),
    until: number(search.until),
    min: number(search.min),
    max: number(search.max),
  }
}

export function validateArtistSearch(search: Record<string, unknown>): ArtistSearch {
  return {
    type: artistReleaseTypes.find((type) => type === search.type),
    sort: artistSorts.find((sort) => sort === search.sort),
  }
}

export function saveLastSearch(state: SearchState) {
  try {
    sessionStorage.setItem('musimo.last-search', JSON.stringify(state))
  } catch {
    // Silently fail if sessionStorage is not available
  }
}

export function getLastSearch(): SearchState | null {
  try {
    const stored = sessionStorage.getItem('musimo.last-search')
    return stored ? validateSearch(JSON.parse(stored)) : null
  } catch {
    return null
  }
}
