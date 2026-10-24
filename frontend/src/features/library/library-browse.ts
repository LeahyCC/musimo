import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'

import {
  defaultLibrarySort,
  type LibraryListSearch,
  libraryPaths,
  librarySearchActive,
  type LibraryTab,
  loadArtistSort,
  loadLibraryView,
  saveArtistSort,
  saveLastLibraryView,
  saveLibraryView,
  validateArtistAlbumSearch,
  validateArtistSongSearch,
  validateLibrarySearch,
} from './library-params'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

function sameSearch(left: LibraryListSearch, right: LibraryListSearch) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** A fresh seed to deal a Scramble order from, in the range the server accepts. */
function scrambleSeed() {
  return Math.floor(Math.random() * 2_147_483_646) + 1
}

/** Navigations run in order, so a filter change still wins if it happens while a restore is in flight. */
function useLibraryGo() {
  const navigate = useNavigate()
  const chain = useRef(Promise.resolve())
  return useCallback(
    (tab: LibraryTab, search: LibraryListSearch, replace = false) => {
      const clean = validateLibrarySearch(tab, search)
      const to = libraryPaths[tab]
      const step = chain.current.then(() => navigate({ to, search: clean, replace }))
      chain.current = step.then(
        () => undefined,
        () => undefined,
      )

      return step
    },
    [navigate],
  )
}

/**
 * Search box, sort and filters for one library view.
 *
 * The address is what a refresh and the browser's Back button read. A bare address is filled
 * from the last choice for that view, which is how a tab or the back link finds it again.
 * The search box keeps its own text so the address catching up cannot drop a character.
 */
export function useLibraryBrowse(tab: LibraryTab, active: boolean) {
  const go = useLibraryGo()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const raw = useRouterState({ select: (state) => state.location.search })
  // A route change reaches this hook before the page unmounts. That next address is not
  // this view's, and saving it would forget the choice the user just made.
  const onList = active && pathname === libraryPaths[tab]
  const fromUrl = useMemo(
    () => (onList ? validateLibrarySearch(tab, asRecord(raw)) : {}),
    [onList, raw, tab],
  )
  const remembered = useRef<LibraryListSearch | null>(null)
  if (remembered.current === null)
    remembered.current = onList && !librarySearchActive(fromUrl) ? loadLibraryView(tab) : {}

  // Set once the address shows the remembered choice, or the user has edited it.
  const [synced, setSynced] = useState(
    () => !onList || librarySearchActive(fromUrl) || !librarySearchActive(remembered.current ?? {}),
  )
  // What the user asked for, until the address shows it. Null means "read the address".
  const [pending, setPending] = useState<LibraryListSearch | null>(null)
  const search = pending ?? (synced ? fromUrl : remembered.current)
  const [query, setQuery] = useState(search.q ?? '')
  const deferredQuery = useDeferredValue(query.trim())
  const pendingQuery = useRef<string | null>(null)
  const latest = useRef(search)
  latest.current = search

  useEffect(() => {
    if (!onList || synced) return
    const target = remembered.current
    if (!target) return
    setPending(target)
    void go(tab, target, true)
  }, [go, onList, synced, tab])

  useEffect(() => {
    if (!onList || !pending) return
    if (sameSearch(fromUrl, pending)) setPending(null)
    if (librarySearchActive(fromUrl) || sameSearch(fromUrl, pending)) setSynced(true)
  }, [fromUrl, onList, pending])

  // The view itself, the moment it is open, so leaving the Library and coming back lands here.
  useEffect(() => {
    if (onList && tab !== 'home') saveLastLibraryView(tab)
  }, [onList, tab])

  useEffect(() => {
    if (!onList || !synced) return
    saveLibraryView(
      tab,
      validateLibrarySearch(tab, { ...latest.current, q: query.trim() || undefined }),
    )
  }, [onList, query, search, synced, tab])

  useEffect(() => {
    // A change we just asked for is still on its way. Wait for that address, and do not
    // copy an older one back into the box. Another page's address is not this box either.
    if (!onList || !synced || pending) return
    const next = fromUrl.q ?? ''
    if (pendingQuery.current !== null) {
      if (pendingQuery.current === next) pendingQuery.current = null
      return
    }
    setQuery(next)
  }, [fromUrl.q, onList, pending, synced])

  const skipQueryWrite = useRef(true)
  useEffect(() => {
    if (!onList || !synced) return
    if (skipQueryWrite.current) {
      skipQueryWrite.current = false
      return
    }
    if (deferredQuery === (latest.current.q ?? '')) return
    const next = validateLibrarySearch(tab, { ...latest.current, q: deferredQuery || undefined })
    pendingQuery.current = next.q ?? ''
    setPending(next)
    void go(tab, next, true)
  }, [deferredQuery, go, onList, synced, tab])

  function commit(patch: Partial<LibraryListSearch>) {
    const next = validateLibrarySearch(tab, {
      ...latest.current,
      ...patch,
      q: query.trim() || undefined,
    })
    pendingQuery.current = (next.q ?? '') === (fromUrl.q ?? '') ? null : (next.q ?? '')
    setPending(next)
    setSynced(true)
    void go(tab, next, true)
  }

  function toggle(key: 'genre' | 'year', value: string) {
    const current = latest.current[key] ?? []
    const items = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]
    commit({ [key]: items.length ? items : undefined })
  }

  return {
    query,
    setQuery,
    deferredQuery,
    sort: search.sort ?? defaultLibrarySort(tab),
    seed: search.seed ?? 0,
    genres: search.genre ?? [],
    years: search.year ?? [],
    show: search.show ?? '',
    visibility: search.visibility ?? 'all',
    setSort: (value: string) =>
      // Picking Scramble deals a fresh order; staying in one keeps the seed it has.
      commit({
        sort: value === defaultLibrarySort(tab) ? undefined : value,
        seed: value === 'scramble' ? (latest.current.seed ?? scrambleSeed()) : undefined,
      }),
    /** Deal the scramble again from a new seed. */
    reshuffle: () => commit({ sort: 'scramble', seed: scrambleSeed() }),
    toggleGenre: (value: string) => toggle('genre', value),
    toggleYear: (value: string) => toggle('year', value),
    setShow: (value: string) =>
      commit({
        show:
          value === 'favourites' || value === 'played' || value === 'unplayed' ? value : undefined,
      }),
    setVisibility: (value: string) =>
      commit({ visibility: value === 'public' || value === 'private' ? value : undefined }),
    clearFilters: () =>
      commit({ genre: undefined, year: undefined, show: undefined, visibility: undefined }),
    open: (next: LibraryTab) => {
      if (onList)
        saveLibraryView(
          tab,
          validateLibrarySearch(tab, { ...latest.current, q: query.trim() || undefined }),
        )
      void go(next, loadLibraryView(next))
    },
  }
}

/** Where All songs or the album list opens, including the order last chosen for that page. */
export function artistPageLocation(kind: 'albums' | 'songs', artistId: string) {
  if (kind === 'songs') {
    const sort = loadArtistSort('songs')
    return {
      to: '/library/artists/$artistId/songs' as const,
      params: { artistId },
      search: sort ? { sort } : {},
    }
  }
  const sort = loadArtistSort('albums')
  return {
    to: '/library/artists/$artistId' as const,
    params: { artistId },
    search: sort ? { sort } : {},
  }
}

function rememberedSort(kind: 'albums' | 'songs' | null, urlSort: string | undefined) {
  if (!kind || urlSort) return undefined
  return kind === 'songs' ? loadArtistSort('songs') : loadArtistSort('albums')
}

/**
 * Album order on an artist page, or song order on All songs. The address holds a non-default
 * order. A bare address picks up the last order for that page.
 */
export function useArtistSort(kind: 'albums' | 'songs' | null, artistId: string) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const raw = useRouterState({ select: (state) => state.location.search })
  // All songs and the album list are different addresses. Each one only keeps its own order.
  const onPage =
    kind === 'songs'
      ? pathname === `/library/artists/${artistId}/songs`
      : kind === 'albums' && artistId !== ''
        ? pathname === `/library/artists/${artistId}`
        : false
  const fromUrl = useMemo((): { sort?: string } => {
    if (!onPage) return {}
    const search = asRecord(raw)
    if (kind === 'songs') return validateArtistSongSearch(search)
    if (kind === 'albums') return validateArtistAlbumSearch(search)
    return {}
  }, [kind, onPage, raw])
  const fallback = kind === 'songs' ? 'album' : 'year'
  const scope = `${kind ?? ''}:${artistId}`
  const scopeSeen = useRef(scope)
  const [held, setHeld] = useState<string | undefined>(() => rememberedSort(kind, fromUrl.sort))
  // The artist route stays mounted when the id changes. Treat that as a new page, or the
  // previous artist's empty address deletes the order this one should have kept.
  if (scopeSeen.current !== scope) {
    scopeSeen.current = scope
    setHeld(rememberedSort(kind, fromUrl.sort))
  }
  const sort = fromUrl.sort ?? held ?? fallback

  function publish(next: 'albums' | 'songs', value: string | undefined) {
    if (next === 'songs') {
      const sort = validateArtistSongSearch({ sort: value }).sort
      saveArtistSort('songs', sort)
      return navigate({
        to: '/library/artists/$artistId/songs',
        params: { artistId },
        search: sort ? { sort } : {},
        replace: true,
      })
    }
    const sort = validateArtistAlbumSearch({ sort: value }).sort
    saveArtistSort('albums', sort)
    return navigate({
      to: '/library/artists/$artistId',
      params: { artistId },
      search: sort ? { sort } : {},
      replace: true,
    })
  }

  useEffect(() => {
    if (!onPage || !kind || !artistId) return
    if (fromUrl.sort) {
      saveArtistSort(kind, fromUrl.sort)
      setHeld(undefined)
      return
    }

    if (held) {
      void publish(kind, held)
      return
    }
    saveArtistSort(kind, undefined)
  }, [artistId, fromUrl.sort, held, kind, onPage])

  return {
    sort,
    setSort: (value: string) => {
      if (!kind || !artistId) return
      setHeld(undefined)
      void publish(kind, value === fallback ? undefined : value)
    },
  }
}
