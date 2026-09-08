import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Disc3,
  Grid2X2,
  Library,
  List,
  ListMusic,
  Pencil,
  Play,
  Plus,
  Radio as RadioIcon,
  Search,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'

import {
  api,
  emptySchema,
  libraryAlbumDetailSchema,
  libraryAlbumsSchema,
  libraryArtistDetailSchema,
  libraryArtistsSchema,
  libraryArtistTracksSchema,
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  libraryTracksSchema,
  lyricsSchema,
  playerCapabilitiesSchema,
  sonicMatchesSchema,
} from './api'
import type { LibraryAlbum, LibraryArtist, LibraryPlaylist, LibraryTrack } from './api'
import { InfiniteScroll } from './infinite-scroll'
import { durationText, remember, stored, usePlayer } from './player'

export type LibraryTab = 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'
type Tab = LibraryTab
type Layout = 'grid' | 'list'

type LibraryPageProps = {
  view?: Tab
  albumId?: string
  artistId?: string
  playlistId?: string
  parentArtistId?: string
}

const SORTS: Record<Tab, { value: string; label: string }[]> = {
  home: [
    { value: 'newest', label: 'Recently added' },
    { value: 'title', label: 'Album A to Z' },
    { value: 'artist', label: 'Artist A to Z' },
    { value: 'year', label: 'Newest release' },
  ],
  albums: [
    { value: 'newest', label: 'Recently added' },
    { value: 'title', label: 'Album A to Z' },
    { value: 'artist', label: 'Artist A to Z' },
    { value: 'year', label: 'Newest release' },
  ],
  artists: [
    { value: 'name', label: 'Artist A to Z' },
    { value: 'albums', label: 'Most albums' },
  ],
  tracks: [
    { value: 'title', label: 'Track A to Z' },
    { value: 'artist', label: 'Artist A to Z' },
    { value: 'album', label: 'Album A to Z' },
    { value: 'year', label: 'Newest release' },
    { value: 'duration', label: 'Longest first' },
  ],
  playlists: [
    { value: 'name', label: 'Playlist A to Z' },
    { value: 'tracks', label: 'Most tracks' },
    { value: 'duration', label: 'Longest first' },
  ],
}

const cover = (coverArt?: string) =>
  coverArt ? `/api/player/art/${encodeURIComponent(coverArt)}` : ''

const textCompare = (left = '', right = '') =>
  left.localeCompare(right, undefined, { numeric: true })

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: Layout
  onChange: (layout: Layout) => void
}) {
  return (
    <div className="library-layout-toggle" role="group" aria-label="Library layout">
      <button
        className="icon-button"
        aria-label="Grid view"
        aria-pressed={layout === 'grid'}
        onClick={() => onChange('grid')}
      >
        <Grid2X2 size={17} />
      </button>
      <button
        className="icon-button"
        aria-label="List view"
        aria-pressed={layout === 'list'}
        onClick={() => onChange('list')}
      >
        <List size={18} />
      </button>
    </div>
  )
}

function FilterMenu({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const root = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  return (
    <details
      ref={root}
      className="library-filter"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {selected.length ? `${label} (${selected.length})` : `All ${label.toLowerCase()}`}
      </summary>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => onToggle(option)}
            />
            {option}
          </label>
        ))}
      </div>
    </details>
  )
}

function AlbumItem({
  album,
  layout,
  loading,
  onOpen,
  onPlay,
  onShuffle,
}: {
  album: LibraryAlbum
  layout: Layout
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
}) {
  if (layout === 'list')
    return (
      <div className="library-collection-row">
        <span className="library-collection-art">
          {album.coverArt ? <img src={cover(album.coverArt)} alt="" loading="lazy" /> : <Disc3 />}
        </span>
        <button className="library-collection-open" onClick={onOpen}>
          <strong>{album.name}</strong>
          <small>
            {album.artist} · {album.songCount} tracks
          </small>
        </button>
        <div className="library-collection-actions">
          <button
            className="icon-button"
            aria-label={`Play ${album.name}`}
            onClick={onPlay}
            disabled={loading}
          >
            <Play size={17} fill="currentColor" />
          </button>
          <button
            className="icon-button"
            aria-label={`Shuffle ${album.name}`}
            onClick={onShuffle}
            disabled={loading}
          >
            <Shuffle size={17} />
          </button>
        </div>
      </div>
    )

  return (
    <article className="library-card">
      <div className="library-card-art">
        <button className="library-cover" aria-label={`Open ${album.name}`} onClick={onOpen}>
          {album.coverArt ? <img src={cover(album.coverArt)} alt="" loading="lazy" /> : <Disc3 />}
        </button>
        <button
          className="library-card-play"
          aria-label={`Play ${album.name}`}
          onClick={onPlay}
          disabled={loading}
        >
          <Play size={19} fill="currentColor" />
        </button>
      </div>
      <button className="library-card-copy" onClick={onOpen}>
        <strong>{album.name}</strong>
        <small>{album.artist}</small>
      </button>
    </article>
  )
}

function ArtistItem({
  artist,
  layout,
  loading,
  onOpen,
  onPlay,
  onShuffle,
}: {
  artist: LibraryArtist
  layout: Layout
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
}) {
  return (
    <article className={`library-artist-card ${layout}`}>
      <button className="library-artist-open" onClick={onOpen}>
        <span className="library-artist-art">
          {artist.coverArt ? <img src={cover(artist.coverArt)} alt="" loading="lazy" /> : <Disc3 />}
        </span>
        <span>
          <strong>{artist.name}</strong>
          <small>{artist.albumCount ?? 0} albums</small>
        </span>
      </button>
      <div className="library-collection-actions">
        <button
          className="icon-button"
          aria-label={`Play ${artist.name}`}
          onClick={onPlay}
          disabled={loading}
        >
          <Play size={17} fill="currentColor" />
        </button>
        <button
          className="icon-button"
          aria-label={`Shuffle ${artist.name}`}
          onClick={onShuffle}
          disabled={loading}
        >
          <Shuffle size={17} />
        </button>
      </div>
    </article>
  )
}

function TrackList({
  tracks,
  onRemove,
}: {
  tracks: LibraryTrack[]
  onRemove?: (index: number) => void
}) {
  const player = usePlayer()
  return (
    <div className="library-tracks">
      {tracks.map((track, index) => (
        <div className="library-track-row" key={track.id}>
          <button
            className={`library-track-play ${player.libraryTrack?.id === track.id ? 'playing' : ''}`}
            onClick={() => player.playLibrary(tracks, index)}
          >
            <span>{track.track ?? index + 1}</span>
            <span>
              <strong>{track.title}</strong>
              <small>{track.artist}</small>
            </span>
            <small>{track.album}</small>
            <time>{durationText(track.duration)}</time>
            <Play size={15} fill="currentColor" />
          </button>
          {onRemove && (
            <button
              className="icon-button library-track-remove"
              aria-label={`Remove ${track.title} from playlist`}
              onClick={() => onRemove(index)}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function LibraryPage({
  view = 'home',
  albumId = '',
  artistId = '',
  playlistId: routePlaylistId = '',
  parentArtistId = '',
}: LibraryPageProps = {}) {
  const player = usePlayer()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>(view)
  const [layout, setLayout] = useState<Layout>(() =>
    stored('musimo.library-layout', 'grid') === 'list' ? 'list' : 'grid',
  )
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const [sorts, setSorts] = useState<Record<Tab, string>>({
    home: 'newest',
    albums: 'newest',
    artists: 'name',
    tracks: 'title',
    playlists: 'name',
  })
  const [selectedGenres, setSelectedGenres] = useState<string[]>([])
  const [selectedYears, setSelectedYears] = useState<string[]>([])
  const [detail, setDetail] = useState<LibraryTrack[]>([])
  const [detailTitle, setDetailTitle] = useState('')
  const [playlistId, setPlaylistId] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [showPlaylistForm, setShowPlaylistForm] = useState(false)
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState('')
  const [artistAlbums, setArtistAlbums] = useState<LibraryAlbum[]>([])
  const [activeArtist, setActiveArtist] = useState<LibraryArtist | null>(null)
  const [albumParent, setAlbumParent] = useState<{ id: string; name: string } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const sort = sorts[tab]
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
  const albums = useInfiniteQuery({
    queryKey: ['library-albums', tab, deferredQuery, sort],
    queryFn: ({ pageParam, signal }) =>
      api(
        `library/albums?q=${encodeURIComponent(deferredQuery)}&sort=${sort === 'newest' ? 'newest' : 'alphabeticalByName'}&offset=${pageParam}&size=60`,
        libraryAlbumsSchema,
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: capabilities.data?.available === true && (tab === 'home' || tab === 'albums'),
  })
  const artists = useInfiniteQuery({
    queryKey: ['library-artists', deferredQuery],
    queryFn: ({ pageParam, signal }) =>
      api(
        `library/artists?q=${encodeURIComponent(deferredQuery)}&offset=${pageParam}&size=100`,
        libraryArtistsSchema,
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: capabilities.data?.available === true && tab === 'artists',
  })
  const tracks = useInfiniteQuery({
    queryKey: ['library-tracks', deferredQuery],
    queryFn: ({ pageParam, signal }) =>
      api(
        `library/tracks?q=${encodeURIComponent(deferredQuery)}&offset=${pageParam}&size=100`,
        libraryTracksSchema,
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: capabilities.data?.available === true && tab === 'tracks',
  })
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: capabilities.data?.available === true && tab === 'playlists',
  })
  const playlistTracks = useQuery({
    queryKey: ['library-playlist-tracks', playlistTrackQuery],
    queryFn: ({ signal }) =>
      api(
        `library/tracks?q=${encodeURIComponent(playlistTrackQuery)}&offset=0&size=20`,
        libraryTracksSchema,
        { signal },
      ),
    enabled:
      capabilities.data?.available === true &&
      Boolean(playlistId) &&
      Boolean(playlistTrackQuery.trim()),
  })
  const createPlaylist = useMutation({
    mutationFn: (name: string) =>
      api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: (playlist) => {
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      setShowPlaylistForm(false)
      setPlaylistName('')
      void navigate({
        to: '/library/playlists/$playlistId',
        params: { playlistId: playlist.id },
      })
    },
  })
  const updatePlaylist = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: (playlist) => {
      setDetailTitle(playlist.name)
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })
  const playlistSongs = useMutation({
    mutationFn: ({ playlist, song, index }: { playlist: string; song?: string; index?: number }) =>
      api(`library/playlists/${encodeURIComponent(playlist)}/songs`, libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          song === undefined ? { song_index_to_remove: index } : { song_id_to_add: song },
        ),
      }),
    onSuccess: (playlist) => {
      setDetail(playlist.entry)
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })
  const deletePlaylist = useMutation({
    mutationFn: (id: string) =>
      api(`library/playlists/${encodeURIComponent(id)}`, emptySchema, { method: 'DELETE' }),
    onSuccess: () => {
      setPlaylistId('')
      setDetail([])
      setDetailTitle('')
      void navigate({ to: '/library/playlists' })
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })

  const albumItems = useMemo(() => {
    const items = albums.data?.pages.flatMap((page) => page.items) ?? []
    const filtered = items.filter(
      (album) =>
        (!selectedGenres.length || (album.genre && selectedGenres.includes(album.genre))) &&
        (!selectedYears.length || (album.year && selectedYears.includes(String(album.year)))),
    )
    if (sort === 'title') return [...filtered].sort((a, b) => textCompare(a.name, b.name))
    if (sort === 'artist')
      return [...filtered].sort(
        (a, b) => textCompare(a.artist, b.artist) || textCompare(a.name, b.name),
      )
    if (sort === 'year')
      return [...filtered].sort(
        (a, b) => (b.year ?? 0) - (a.year ?? 0) || textCompare(a.name, b.name),
      )
    return filtered
  }, [albums.data, selectedGenres, selectedYears, sort])
  const artistItems = useMemo(() => {
    const items = artists.data?.pages.flatMap((page) => page.items) ?? []
    return [...items].sort((a, b) =>
      sort === 'albums'
        ? (b.albumCount ?? 0) - (a.albumCount ?? 0) || textCompare(a.name, b.name)
        : textCompare(a.name, b.name),
    )
  }, [artists.data, sort])
  const trackItems = useMemo(() => {
    const items = tracks.data?.pages.flatMap((page) => page.items) ?? []
    const filtered = items.filter(
      (track) =>
        (!selectedGenres.length || (track.genre && selectedGenres.includes(track.genre))) &&
        (!selectedYears.length || (track.year && selectedYears.includes(String(track.year)))),
    )
    return [...filtered].sort((a, b) => {
      if (sort === 'artist') return textCompare(a.artist, b.artist) || textCompare(a.title, b.title)
      if (sort === 'album') return textCompare(a.album, b.album) || textCompare(a.title, b.title)
      if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0) || textCompare(a.title, b.title)
      if (sort === 'duration') return b.duration - a.duration || textCompare(a.title, b.title)
      return textCompare(a.title, b.title)
    })
  }, [selectedGenres, selectedYears, sort, tracks.data])
  const playlistItems = useMemo(() => {
    const needle = deferredQuery.toLocaleLowerCase()
    const items = (playlists.data?.items ?? []).filter((item) =>
      item.name.toLocaleLowerCase().includes(needle),
    )
    return [...items].sort((a, b) => {
      if (sort === 'tracks') return (b.songCount ?? 0) - (a.songCount ?? 0)
      if (sort === 'duration') return (b.duration ?? 0) - (a.duration ?? 0)
      return textCompare(a.name, b.name)
    })
  }, [deferredQuery, playlists.data, sort])

  const filterItems =
    tab === 'tracks'
      ? (tracks.data?.pages.flatMap((page) => page.items) ?? [])
      : (albums.data?.pages.flatMap((page) => page.items) ?? [])
  const genres = [
    ...new Set(
      filterItems.map((item) => item.genre).filter((item): item is string => Boolean(item)),
    ),
  ].sort(textCompare)
  const years = [
    ...new Set(
      filterItems.map((item) => item.year).filter((item): item is number => item !== undefined),
    ),
  ]
    .sort((a, b) => b - a)
    .map(String)
  const currentItems =
    tab === 'artists'
      ? artistItems
      : tab === 'tracks'
        ? trackItems
        : tab === 'playlists'
          ? playlistItems
          : albumItems
  const activeQuery =
    tab === 'artists'
      ? artists
      : tab === 'tracks'
        ? tracks
        : tab === 'playlists'
          ? playlists
          : albums
  const hasMore =
    tab === 'artists'
      ? artists.hasNextPage
      : tab === 'tracks'
        ? tracks.hasNextPage
        : tab === 'playlists'
          ? false
          : albums.hasNextPage
  const loadingMore =
    tab === 'artists'
      ? artists.isFetchingNextPage
      : tab === 'tracks'
        ? tracks.isFetchingNextPage
        : tab === 'playlists'
          ? false
          : albums.isFetchingNextPage
  const showBrowser = !albumId && !artistId && !routePlaylistId

  useEffect(() => remember('musimo.library-layout', layout), [layout])

  useEffect(() => {
    let current = true
    setTab(view)
    setDetail([])
    setDetailTitle('')
    setArtistAlbums([])
    setActiveArtist(null)
    setAlbumParent(null)
    setPlaylistId('')
    setPlaylistName('')
    const hasDetail = Boolean(albumId || artistId || routePlaylistId)
    setLoadingDetail(hasDetail)
    if (!hasDetail) return () => undefined

    const load = async () => {
      try {
        if (albumId) {
          const album = await api(
            `library/albums/${encodeURIComponent(albumId)}`,
            libraryAlbumDetailSchema,
          )
          if (!current) return
          setDetail(album.song)
          setDetailTitle(album.name)
          if (parentArtistId) setAlbumParent({ id: parentArtistId, name: album.artist || 'artist' })
        } else if (artistId) {
          const artist = await api(
            `library/artists/${encodeURIComponent(artistId)}`,
            libraryArtistDetailSchema,
          )
          if (!current) return
          setDetailTitle(artist.name)
          setArtistAlbums(artist.album)
          setActiveArtist(artist)
        } else if (routePlaylistId) {
          const playlist = await api(
            `library/playlists/${encodeURIComponent(routePlaylistId)}`,
            libraryPlaylistDetailSchema,
          )
          if (!current) return
          setDetail(playlist.entry)
          setDetailTitle(playlist.name)
          setPlaylistName(playlist.name)
          setPlaylistId(routePlaylistId)
        }
      } finally {
        if (current) setLoadingDetail(false)
      }
    }
    void load()
    return () => {
      current = false
    }
  }, [albumId, artistId, parentArtistId, routePlaylistId, view])

  async function playAlbum(id: string, shuffled = false) {
    setLoadingDetail(true)
    try {
      const album = await api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema)
      if (shuffled) player.shuffleLibrary(album.song)
      else player.playLibrary(album.song)
    } finally {
      setLoadingDetail(false)
    }
  }

  async function playPlaylist(id: string, shuffled = false) {
    setLoadingDetail(true)
    try {
      const playlist = await api(
        `library/playlists/${encodeURIComponent(id)}`,
        libraryPlaylistDetailSchema,
      )
      if (shuffled) player.shuffleLibrary(playlist.entry)
      else player.playLibrary(playlist.entry)
    } finally {
      setLoadingDetail(false)
    }
  }

  async function playArtist(id: string, shuffled = false) {
    setLoadingDetail(true)
    try {
      const result = await api(
        `library/artists/${encodeURIComponent(id)}/tracks`,
        libraryArtistTracksSchema,
      )
      if (shuffled) player.shuffleLibrary(result.items)
      else player.playLibrary(result.items)
    } finally {
      setLoadingDetail(false)
    }
  }

  function changeTab(next: Tab) {
    setSelectedGenres([])
    setSelectedYears([])
    setShowPlaylistForm(false)
    setPlaylistTrackQuery('')
    const paths = {
      home: '/library',
      albums: '/library/albums',
      artists: '/library/artists',
      tracks: '/library/tracks',
      playlists: '/library/playlists',
    } as const
    void navigate({ to: paths[next] })
  }

  function loadMore() {
    if (tab === 'artists') void artists.fetchNextPage()
    else if (tab === 'tracks') void tracks.fetchNextPage()
    else if (tab !== 'playlists') void albums.fetchNextPage()
  }

  if (capabilities.isLoading) return <p role="status">Connecting to your library…</p>
  if (!capabilities.data?.available)
    return (
      <section className="empty-panel library-empty">
        <Library size={36} />
        <h1>Your music library lives here.</h1>
        <p>{capabilities.data?.detail ?? 'Navidrome is not ready.'}</p>
        <a className="button primary" href="/settings#library">
          Connect Navidrome
        </a>
      </section>
    )

  return (
    <>
      <div className="page-heading library-heading">
        <div>
          <p className="eyebrow">YOUR MUSIC, READY TO PLAY</p>
          <h1>Library</h1>
        </div>
        <span className={`tag ${capabilities.data.sonic_similarity ? 'good' : ''}`}>
          {capabilities.data.sonic_similarity ? 'AUDIOMUSE CONNECTED' : 'NAVIDROME READY'}
        </span>
      </div>
      <nav className="library-tabs" aria-label="Library views">
        {(['home', 'albums', 'artists', 'tracks', 'playlists'] as Tab[]).map((item) => (
          <button
            className={tab === item ? 'active' : ''}
            key={item}
            onClick={() => changeTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {showBrowser && (
        <div className="library-tools">
          <label className="library-search">
            <Search size={17} />
            <input
              aria-label={`Search ${tab === 'home' ? 'albums' : tab}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${tab === 'home' ? 'albums' : tab}`}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={15} />
              </button>
            )}
          </label>
          <label className="library-select">
            <SlidersHorizontal size={16} />
            <select
              aria-label={`Sort ${tab}`}
              value={sort}
              onChange={(event) => setSorts({ ...sorts, [tab]: event.target.value })}
            >
              {SORTS[tab].map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {(tab === 'home' || tab === 'albums' || tab === 'tracks') && (
            <>
              <FilterMenu
                label="Genres"
                options={genres}
                selected={selectedGenres}
                onToggle={(value) =>
                  setSelectedGenres((current) =>
                    current.includes(value)
                      ? current.filter((item) => item !== value)
                      : [...current, value],
                  )
                }
              />
              <FilterMenu
                label="Years"
                options={years}
                selected={selectedYears}
                onToggle={(value) =>
                  setSelectedYears((current) =>
                    current.includes(value)
                      ? current.filter((item) => item !== value)
                      : [...current, value],
                  )
                }
              />
              {(selectedGenres.length > 0 || selectedYears.length > 0) && (
                <button
                  className="text-link library-clear-filters"
                  onClick={() => {
                    setSelectedGenres([])
                    setSelectedYears([])
                  }}
                >
                  Clear filters
                </button>
              )}
            </>
          )}
          <div className="library-toolbar-end">
            <span className="library-count">{currentItems.length} loaded</span>
            {tab !== 'tracks' && <LayoutToggle layout={layout} onChange={setLayout} />}
          </div>
          {tab === 'playlists' && (
            <button className="button primary" onClick={() => setShowPlaylistForm(true)}>
              <Plus size={16} /> New playlist
            </button>
          )}
        </div>
      )}
      {showBrowser && tab === 'playlists' && showPlaylistForm && (
        <form
          className="playlist-form"
          onSubmit={(event) => {
            event.preventDefault()
            const name = playlistName.trim()
            if (name) createPlaylist.mutate(name)
          }}
        >
          <label>
            Playlist name
            <input
              autoFocus
              value={playlistName}
              maxLength={200}
              onChange={(event) => setPlaylistName(event.target.value)}
            />
          </label>
          <button className="button primary" disabled={createPlaylist.isPending}>
            {createPlaylist.isPending ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setShowPlaylistForm(false)
              setPlaylistName('')
            }}
          >
            Cancel
          </button>
          {createPlaylist.isError && <p className="error">{createPlaylist.error.message}</p>}
        </form>
      )}
      {loadingDetail && <p role="status">Opening music…</p>}
      {showBrowser && activeQuery.isLoading && <p role="status">Loading {tab}…</p>}
      {showBrowser && activeQuery.isError && (
        <div className="inline-error" role="alert">
          <span>{activeQuery.error.message}</span>
          <button className="button" onClick={() => void activeQuery.refetch()}>
            Retry
          </button>
        </div>
      )}
      {(detail.length > 0 || playlistId) && (
        <section className="library-detail">
          <div className="section-heading">
            <div>
              <button
                className="text-link"
                onClick={() => {
                  if (albumParent)
                    void navigate({
                      to: '/library/artists/$artistId',
                      params: { artistId: albumParent.id },
                    })
                  else changeTab(playlistId ? 'playlists' : 'albums')
                }}
              >
                ← Back to {albumParent?.name ?? (playlistId ? 'playlists' : 'albums')}
              </button>
              <h2>{detailTitle}</h2>
            </div>
            <div className="button-row">
              <button
                className="button primary"
                onClick={() => player.playLibrary(detail)}
                disabled={!detail.length}
              >
                <Play size={15} fill="currentColor" /> Play all
              </button>
              {playlistId && (
                <button
                  className="button danger"
                  onClick={() => {
                    if (window.confirm(`Delete playlist “${detailTitle}”?`))
                      deletePlaylist.mutate(playlistId)
                  }}
                  disabled={deletePlaylist.isPending}
                >
                  <Trash2 size={15} /> Delete
                </button>
              )}
            </div>
          </div>
          {playlistId && (
            <form
              className="playlist-form"
              onSubmit={(event) => {
                event.preventDefault()
                const name = playlistName.trim()
                if (name && name !== detailTitle) updatePlaylist.mutate({ id: playlistId, name })
              }}
            >
              <label>
                Playlist name
                <input
                  value={playlistName}
                  maxLength={200}
                  onChange={(event) => setPlaylistName(event.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={updatePlaylist.isPending || playlistName.trim() === detailTitle}
              >
                <Pencil size={15} /> Rename
              </button>
              {updatePlaylist.isError && <p className="error">{updatePlaylist.error.message}</p>}
            </form>
          )}
          <TrackList
            tracks={detail}
            onRemove={
              playlistId
                ? (index) => playlistSongs.mutate({ playlist: playlistId, index })
                : undefined
            }
          />
          {playlistId && (
            <section className="playlist-add">
              <div className="section-heading">
                <h3>Add tracks</h3>
                <span>Search your library</span>
              </div>
              <label className="library-search">
                <Search size={17} />
                <input
                  aria-label="Search tracks to add"
                  value={playlistTrackQuery}
                  onChange={(event) => setPlaylistTrackQuery(event.target.value)}
                  placeholder="Search tracks to add"
                />
              </label>
              {playlistTracks.isLoading && <p role="status">Searching tracks…</p>}
              {playlistTracks.isError && <p className="error">{playlistTracks.error.message}</p>}
              <div className="playlist-add-list">
                {playlistTracks.data?.items.map((track) => (
                  <div key={track.id}>
                    <span>
                      <strong>{track.title}</strong>
                      <small>
                        {track.artist} · {track.album}
                      </small>
                    </span>
                    <button
                      className="button"
                      onClick={() => playlistSongs.mutate({ playlist: playlistId, song: track.id })}
                      disabled={playlistSongs.isPending}
                    >
                      <Plus size={15} /> Add
                    </button>
                  </div>
                ))}
              </div>
              {playlistSongs.isError && <p className="error">{playlistSongs.error.message}</p>}
            </section>
          )}
        </section>
      )}
      {activeArtist && (
        <section className="library-detail">
          <button className="text-link" onClick={() => changeTab('artists')}>
            ← Back to artists
          </button>
          <div className="library-artist-heading">
            <span className="library-artist-art large">
              {activeArtist.coverArt ? (
                <img src={cover(activeArtist.coverArt)} alt="" />
              ) : (
                <Disc3 />
              )}
            </span>
            <div>
              <h2>{detailTitle}</h2>
              <span>{artistAlbums.length} ALBUMS</span>
            </div>
            <div className="button-row">
              <button
                className="button primary"
                onClick={() => void playArtist(activeArtist.id)}
                disabled={loadingDetail || !artistAlbums.length}
              >
                <Play size={15} fill="currentColor" /> Play all
              </button>
              <button
                className="button"
                onClick={() => void playArtist(activeArtist.id, true)}
                disabled={loadingDetail || !artistAlbums.length}
              >
                <Shuffle size={15} /> Shuffle
              </button>
            </div>
          </div>
          <div className={layout === 'grid' ? 'library-grid' : 'library-collection-list'}>
            {artistAlbums.map((album) => (
              <AlbumItem
                album={album}
                key={album.id}
                layout={layout}
                loading={loadingDetail}
                onOpen={() =>
                  void navigate({
                    to: '/library/artists/$artistId/albums/$albumId',
                    params: { artistId: activeArtist.id, albumId: album.id },
                  })
                }
                onPlay={() => void playAlbum(album.id)}
                onShuffle={() => void playAlbum(album.id, true)}
              />
            ))}
          </div>
        </section>
      )}
      {(tab === 'home' || tab === 'albums') && showBrowser && (
        <section>
          <div className="section-heading">
            <h2>
              {deferredQuery
                ? 'Album results'
                : tab === 'home'
                  ? 'Fresh in your library'
                  : 'Albums'}
            </h2>
          </div>
          <div className={layout === 'grid' ? 'library-grid' : 'library-collection-list'}>
            {albumItems.map((album) => (
              <AlbumItem
                album={album}
                key={album.id}
                layout={layout}
                loading={loadingDetail}
                onOpen={() =>
                  void navigate({
                    to: '/library/albums/$albumId',
                    params: { albumId: album.id },
                  })
                }
                onPlay={() => void playAlbum(album.id)}
                onShuffle={() => void playAlbum(album.id, true)}
              />
            ))}
          </div>
        </section>
      )}
      {tab === 'artists' && showBrowser && (
        <div className={layout === 'grid' ? 'library-artist-grid' : 'library-collection-list'}>
          {artistItems.map((artist: LibraryArtist) => (
            <ArtistItem
              artist={artist}
              key={artist.id}
              layout={layout}
              loading={loadingDetail}
              onOpen={() =>
                void navigate({
                  to: '/library/artists/$artistId',
                  params: { artistId: artist.id },
                })
              }
              onPlay={() => void playArtist(artist.id)}
              onShuffle={() => void playArtist(artist.id, true)}
            />
          ))}
        </div>
      )}
      {tab === 'tracks' && showBrowser && (
        <section className="library-detail">
          <div className="library-list-actions">
            <button
              className="button primary"
              onClick={() => player.playLibrary(trackItems)}
              disabled={!trackItems.length}
            >
              <Play size={15} fill="currentColor" /> Play all
            </button>
            <button
              className="button"
              onClick={() => player.shuffleLibrary(trackItems)}
              disabled={!trackItems.length}
            >
              <Shuffle size={15} /> Shuffle
            </button>
          </div>
          <TrackList tracks={trackItems} />
        </section>
      )}
      {tab === 'playlists' && showBrowser && (
        <div className={layout === 'grid' ? 'library-list' : 'library-collection-list'}>
          {playlistItems.map((playlist: LibraryPlaylist) => (
            <div
              className={layout === 'grid' ? 'library-list-row' : 'library-collection-row'}
              key={playlist.id}
            >
              {layout === 'grid' ? (
                <button
                  className="library-list-open"
                  onClick={() =>
                    void navigate({
                      to: '/library/playlists/$playlistId',
                      params: { playlistId: playlist.id },
                    })
                  }
                >
                  <ListMusic size={20} />
                  <strong>{playlist.name}</strong>
                  <small>{playlist.songCount ?? 0} tracks</small>
                </button>
              ) : (
                <>
                  <span className="library-collection-art">
                    <ListMusic size={20} />
                  </span>
                  <button
                    className="library-collection-open"
                    onClick={() =>
                      void navigate({
                        to: '/library/playlists/$playlistId',
                        params: { playlistId: playlist.id },
                      })
                    }
                  >
                    <strong>{playlist.name}</strong>
                    <small>{playlist.songCount ?? 0} tracks</small>
                  </button>
                </>
              )}
              <div className={layout === 'grid' ? '' : 'library-collection-actions'}>
                {layout === 'list' && (
                  <>
                    <button
                      className="icon-button"
                      aria-label={`Play ${playlist.name}`}
                      onClick={() => void playPlaylist(playlist.id)}
                      disabled={loadingDetail}
                    >
                      <Play size={17} fill="currentColor" />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Shuffle ${playlist.name}`}
                      onClick={() => void playPlaylist(playlist.id, true)}
                      disabled={loadingDetail}
                    >
                      <Shuffle size={17} />
                    </button>
                  </>
                )}
                <button
                  className={`icon-button ${layout === 'grid' ? 'library-list-delete' : ''}`}
                  aria-label={`Delete playlist ${playlist.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete playlist “${playlist.name}”?`))
                      deletePlaylist.mutate(playlist.id)
                  }}
                  disabled={deletePlaylist.isPending}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showBrowser &&
        !activeQuery.isLoading &&
        !activeQuery.isError &&
        currentItems.length === 0 && (
          <p className="library-no-results">No {tab === 'home' ? 'albums' : tab} found.</p>
        )}
      {showBrowser && hasMore && (
        <InfiniteScroll hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
      )}
    </>
  )
}

export function NowPlayingPage() {
  const player = usePlayer()
  const track = player.libraryTrack
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
  })
  const lyrics = useQuery({
    queryKey: ['lyrics', track?.id],
    queryFn: ({ signal }) =>
      api(`player/lyrics/${encodeURIComponent(track?.id ?? '')}`, lyricsSchema, { signal }),
    enabled: Boolean(track),
    retry: false,
  })
  const audioMuse = useMutation({
    mutationFn: () =>
      api(`player/radio/${encodeURIComponent(track?.id ?? '')}?count=40`, sonicMatchesSchema),
    onSuccess: (result) => {
      if (track) player.playLibrary([track, ...result.items.map((item) => item.entry)])
    },
  })

  if (!track)
    return (
      <section className="empty-panel library-empty">
        <Disc3 size={40} />
        <h1>Nothing playing yet.</h1>
        <a className="button primary" href="/library">
          Open your library
        </a>
      </section>
    )

  const words = lyrics.data?.items[0]?.line ?? []
  return (
    <div className="now-page">
      <section className="now-hero">
        <div className="now-art">
          {track.coverArt ? <img src={cover(track.coverArt)} alt="" /> : <Disc3 />}
        </div>
        <div>
          <p className="eyebrow">NOW PLAYING</p>
          <h1>{track.title}</h1>
          <p className="now-byline">
            {track.artistId ? (
              <Link to="/library/artists/$artistId" params={{ artistId: track.artistId }}>
                {track.artist}
              </Link>
            ) : (
              track.artist
            )}
            {track.album && (
              <>
                {' · '}
                {track.albumId ? (
                  <Link to="/library/albums/$albumId" params={{ albumId: track.albumId }}>
                    {track.album}
                  </Link>
                ) : (
                  track.album
                )}
              </>
            )}
          </p>
          {capabilities.data?.sonic_similarity && (
            <button
              className="button primary"
              onClick={() => audioMuse.mutate()}
              disabled={audioMuse.isPending}
            >
              <RadioIcon size={16} />{' '}
              {audioMuse.isPending ? 'Building radio…' : 'Start AudioMuse radio'}
            </button>
          )}
          {audioMuse.isError && <p className="error">{audioMuse.error.message}</p>}
        </div>
      </section>
      <div className="now-columns">
        <section className="panel queue-panel">
          <div className="section-heading">
            <h2>Up next</h2>
            <span>{player.queue.length} TRACKS</span>
          </div>
          <TrackList tracks={player.queue} />
        </section>
        <section className="panel lyrics-panel">
          <div className="section-heading">
            <h2>Lyrics</h2>
          </div>
          {lyrics.isLoading && <p>Loading lyrics…</p>}
          {!lyrics.isLoading && !words.length && (
            <p className="muted">No lyrics found for this track.</p>
          )}
          {words.map((line, index) => (
            <p key={`${line.value}-${index}`}>{line.value || '♪'}</p>
          ))}
        </section>
      </div>
    </div>
  )
}
