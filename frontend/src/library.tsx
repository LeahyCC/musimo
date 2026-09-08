import { useDeferredValue, useMemo, useState } from 'react'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Disc3,
  Library,
  ListMusic,
  Pencil,
  Play,
  Plus,
  Radio as RadioIcon,
  Search,
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
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  libraryTracksSchema,
  lyricsSchema,
  playerCapabilitiesSchema,
  sonicMatchesSchema,
} from './api'
import type { LibraryAlbum, LibraryArtist, LibraryPlaylist, LibraryTrack } from './api'
import { InfiniteScroll } from './infinite-scroll'
import { durationText, usePlayer } from './player'

type Tab = 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'

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

function AlbumCard({ album, play }: { album: LibraryAlbum; play: () => void }) {
  return (
    <button className="library-card" onClick={play}>
      <span className="library-cover">
        {album.coverArt ? <img src={cover(album.coverArt)} alt="" loading="lazy" /> : <Disc3 />}
        <i>
          <Play size={19} fill="currentColor" />
        </i>
      </span>
      <strong>{album.name}</strong>
      <small>{album.artist}</small>
    </button>
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

export function LibraryPage() {
  const player = usePlayer()
  const client = useQueryClient()
  const [tab, setTab] = useState<Tab>('home')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const [sorts, setSorts] = useState<Record<Tab, string>>({
    home: 'newest',
    albums: 'newest',
    artists: 'name',
    tracks: 'title',
    playlists: 'name',
  })
  const [genre, setGenre] = useState('')
  const [year, setYear] = useState('')
  const [detail, setDetail] = useState<LibraryTrack[]>([])
  const [detailTitle, setDetailTitle] = useState('')
  const [playlistId, setPlaylistId] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [showPlaylistForm, setShowPlaylistForm] = useState(false)
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState('')
  const [artistAlbums, setArtistAlbums] = useState<LibraryAlbum[]>([])
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
      void openPlaylist(playlist.id)
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
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })

  const albumItems = useMemo(() => {
    const items = albums.data?.pages.flatMap((page) => page.items) ?? []
    const filtered = items.filter(
      (album) => (!genre || album.genre === genre) && (!year || album.year === Number(year)),
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
  }, [albums.data, genre, sort, year])
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
      (track) => (!genre || track.genre === genre) && (!year || track.year === Number(year)),
    )
    return [...filtered].sort((a, b) => {
      if (sort === 'artist') return textCompare(a.artist, b.artist) || textCompare(a.title, b.title)
      if (sort === 'album') return textCompare(a.album, b.album) || textCompare(a.title, b.title)
      if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0) || textCompare(a.title, b.title)
      if (sort === 'duration') return b.duration - a.duration || textCompare(a.title, b.title)
      return textCompare(a.title, b.title)
    })
  }, [genre, sort, tracks.data, year])
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

  const filterItems = tab === 'tracks' ? trackItems : albumItems
  const genres = [
    ...new Set(
      filterItems.map((item) => item.genre).filter((item): item is string => Boolean(item)),
    ),
  ].sort(textCompare)
  const years = [
    ...new Set(
      filterItems.map((item) => item.year).filter((item): item is number => item !== undefined),
    ),
  ].sort((a, b) => b - a)
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
  const showBrowser = !playlistId && detail.length === 0 && artistAlbums.length === 0

  async function openAlbum(id: string) {
    setLoadingDetail(true)
    try {
      const album = await api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema)
      setArtistAlbums([])
      setDetail(album.song)
      setDetailTitle(`${album.name} · ${album.artist}`)
      setPlaylistId('')
    } finally {
      setLoadingDetail(false)
    }
  }

  async function openArtist(id: string) {
    setLoadingDetail(true)
    try {
      const artist = await api(
        `library/artists/${encodeURIComponent(id)}`,
        libraryArtistDetailSchema,
      )
      setDetail([])
      setDetailTitle(artist.name)
      setArtistAlbums(artist.album)
      setPlaylistId('')
    } finally {
      setLoadingDetail(false)
    }
  }

  async function openPlaylist(id: string) {
    setLoadingDetail(true)
    try {
      const playlist = await api(
        `library/playlists/${encodeURIComponent(id)}`,
        libraryPlaylistDetailSchema,
      )
      setArtistAlbums([])
      setDetail(playlist.entry)
      setDetailTitle(playlist.name)
      setPlaylistName(playlist.name)
      setPlaylistId(id)
    } finally {
      setLoadingDetail(false)
    }
  }

  function changeTab(next: Tab) {
    setTab(next)
    setGenre('')
    setYear('')
    setDetail([])
    setArtistAlbums([])
    setPlaylistId('')
    setPlaylistName('')
    setShowPlaylistForm(false)
    setPlaylistTrackQuery('')
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
          {capabilities.data.sonic_similarity ? 'AUDIOMUSE READY' : 'NAVIDROME READY'}
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
              <label className="library-select">
                <select
                  aria-label="Filter by genre"
                  value={genre}
                  onChange={(event) => setGenre(event.target.value)}
                >
                  <option value="">All genres</option>
                  {genres.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="library-select">
                <select
                  aria-label="Filter by year"
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                >
                  <option value="">All years</option>
                  {years.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <span className="library-count">{currentItems.length} loaded</span>
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
              <button className="text-link" onClick={() => changeTab(tab)}>
                ← Back to {tab}
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
      {artistAlbums.length > 0 && (
        <section className="library-detail">
          <div className="section-heading">
            <h2>{detailTitle}</h2>
            <span>{artistAlbums.length} ALBUMS</span>
          </div>
          <div className="library-grid">
            {artistAlbums.map((album) => (
              <AlbumCard album={album} key={album.id} play={() => void openAlbum(album.id)} />
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
          <div className="library-grid">
            {albumItems.map((album) => (
              <AlbumCard album={album} key={album.id} play={() => void openAlbum(album.id)} />
            ))}
          </div>
        </section>
      )}
      {tab === 'artists' && showBrowser && (
        <div className="library-list">
          {artistItems.map((artist: LibraryArtist) => (
            <button key={artist.id} onClick={() => void openArtist(artist.id)}>
              <Disc3 size={20} />
              <strong>{artist.name}</strong>
              <small>{artist.albumCount ?? 0} albums</small>
            </button>
          ))}
        </div>
      )}
      {tab === 'tracks' && showBrowser && <TrackList tracks={trackItems} />}
      {tab === 'playlists' && showBrowser && (
        <div className="library-list">
          {playlistItems.map((playlist: LibraryPlaylist) => (
            <div className="library-list-row" key={playlist.id}>
              <button className="library-list-open" onClick={() => void openPlaylist(playlist.id)}>
                <ListMusic size={20} />
                <strong>{playlist.name}</strong>
                <small>{playlist.songCount ?? 0} tracks</small>
              </button>
              <button
                className="icon-button library-list-delete"
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
          <p>
            {track.artist}
            {track.album ? ` · ${track.album}` : ''}
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
            <p className="muted">No synced lyrics for this track.</p>
          )}
          {words.map((line, index) => (
            <p key={`${line.value}-${index}`}>{line.value || '♪'}</p>
          ))}
        </section>
      </div>
    </div>
  )
}
