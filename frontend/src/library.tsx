import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Disc3,
  Grid2X2,
  Heart,
  Library,
  List,
  ListMusic,
  Pause,
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
  librarySelectionSchema,
  libraryTrackSearchSchema,
  libraryTracksSchema,
  lyricsSchema,
  playerCapabilitiesSchema,
  sonicMatchesSchema,
} from './api'
import type { LibraryAlbum, LibraryArtist, LibraryPlaylist, LibraryTrack } from './api'
import { InfiniteScroll } from './infinite-scroll'
import {
  durationText,
  remember,
  songCount,
  stored,
  useCollectionPlayback,
  usePlayer,
  usePlaylistSongs,
} from './player'

export type LibraryTab = 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'
type Tab = LibraryTab
type Layout = 'grid' | 'list'
type ArtistSection = 'albums' | 'songs'
type Collection = 'album' | 'artist' | 'playlist'

type LibraryPageProps = {
  view?: Tab
  albumId?: string
  artistId?: string
  playlistId?: string
  parentArtistId?: string
  artistSection?: ArtistSection
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
  // These values are the sort names the tracks endpoint accepts.
  tracks: [
    { value: 'title', label: 'Track A to Z' },
    { value: 'artist', label: 'Artist A to Z' },
    { value: 'album', label: 'Album A to Z' },
    { value: 'year', label: 'Newest release' },
    { value: 'duration', label: 'Longest first' },
    { value: 'newest', label: 'Recently added' },
  ],
  playlists: [
    { value: 'name', label: 'Playlist A to Z' },
    { value: 'tracks', label: 'Most tracks' },
    { value: 'duration', label: 'Longest first' },
    { value: 'changed', label: 'Recently updated' },
  ],
}
const ARTIST_ALBUM_SORTS = [
  { value: 'year', label: 'Newest release' },
  { value: 'oldest', label: 'Oldest release' },
  { value: 'title', label: 'Album A to Z' },
  { value: 'plays', label: 'Most played' },
]
const ARTIST_SONG_SORTS = [
  { value: 'album', label: 'Album order' },
  { value: 'title', label: 'Track A to Z' },
  { value: 'plays', label: 'Most played' },
  { value: 'duration', label: 'Longest first' },
  { value: 'year', label: 'Newest release' },
]

const cover = (coverArt?: string) =>
  coverArt ? `/api/player/art/${encodeURIComponent(coverArt)}` : ''

const textCompare = (left = '', right = '') =>
  left.localeCompare(right, undefined, { numeric: true })

const albumMeta = (album: LibraryAlbum) =>
  [album.artist, album.year ? String(album.year) : '', songCount(album.songCount)]
    .filter(Boolean)
    .join(' · ')

function sortArtistAlbums(albums: LibraryAlbum[], sort: string) {
  // Both date orders push an undated album to the end rather than pretending it is oldest.
  return [...albums].sort((a, b) => {
    if (sort === 'title') return textCompare(a.name, b.name)
    if (sort === 'plays') return b.playCount - a.playCount || textCompare(a.name, b.name)
    if (sort === 'oldest')
      return (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER)
    return (b.year ?? -1) - (a.year ?? -1) || textCompare(a.name, b.name)
  })
}

function sortArtistSongs(songs: LibraryTrack[], sort: string) {
  return [...songs].sort((a, b) => {
    if (sort === 'title') return textCompare(a.title, b.title)
    if (sort === 'plays') return b.playCount - a.playCount || textCompare(a.title, b.title)
    if (sort === 'duration') return b.duration - a.duration || textCompare(a.title, b.title)
    if (sort === 'year') return (b.year ?? -1) - (a.year ?? -1) || textCompare(a.title, b.title)
    return textCompare(a.album, b.album) || (a.track ?? 0) - (b.track ?? 0)
  })
}

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

/** Play turns into Pause while this exact collection owns the queue. */
function CollectionPlayButton({
  source,
  name,
  text,
  className,
  size,
  disabled,
  onPlay,
}: {
  source: string
  name?: string
  text?: string
  className: string
  size: number
  disabled?: boolean
  onPlay: () => void
}) {
  const playback = useCollectionPlayback(source)
  return (
    <button
      className={`${className}${playback.active ? ' active' : ''}`}
      // A labelled button reads from its own text; an icon-only one needs the name.
      aria-label={text ? undefined : `${playback.playing ? 'Pause' : 'Play'} ${name}`}
      disabled={disabled}
      // Already this collection's queue, so resume it. Calling onPlay would refetch and
      // restart from the first track, losing where the listener paused.
      onClick={() => (playback.active ? playback.toggle() : onPlay())}
    >
      {playback.playing ? <Pause size={size} /> : <Play size={size} fill="currentColor" />}
      {text ? ` ${playback.playing ? 'Pause' : text}` : null}
    </button>
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
          <small>{albumMeta(album)}</small>
        </button>
        <div className="library-collection-actions">
          <CollectionPlayButton
            source={`album:${album.id}`}
            name={album.name}
            className="icon-button"
            size={17}
            disabled={loading}
            onPlay={onPlay}
          />
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
        <CollectionPlayButton
          source={`album:${album.id}`}
          name={album.name}
          className="library-card-play"
          size={19}
          disabled={loading}
          onPlay={onPlay}
        />
      </div>
      <button className="library-card-copy" onClick={onOpen}>
        <strong>{album.name}</strong>
        <small>
          {album.artist}
          {album.year ? ` · ${album.year}` : ''}
        </small>
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
        <CollectionPlayButton
          source={`artist:${artist.id}`}
          name={artist.name}
          className="icon-button"
          size={17}
          disabled={loading}
          onPlay={onPlay}
        />
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
  source,
  removing = false,
  onRemove,
}: {
  tracks: LibraryTrack[]
  source: string
  removing?: boolean
  onRemove?: (index: number) => void
}) {
  const player = usePlayer()
  return (
    <div className="library-tracks">
      {tracks.map((track, index) => {
        // A playlist may hold the same song twice, and the same song appears in several
        // collections, so the queue and the position are both part of "the playing row".
        const current =
          player.source === source &&
          player.currentIndex === index &&
          player.libraryTrack?.id === track.id
        const playing = current && player.playing
        return (
          <div className="library-track-row" key={`${track.id}-${index}`}>
            <button
              className={`library-track-play ${current ? 'playing' : ''}`}
              aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
              onClick={() =>
                current ? player.toggle() : player.playLibrary(tracks, index, source)
              }
            >
              <span>{track.track ?? index + 1}</span>
              <span>
                <strong>{track.title}</strong>
                <small>{track.artist}</small>
              </span>
              <small>{track.album}</small>
              <time>{durationText(track.duration)}</time>
              {playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            </button>
            {onRemove && (
              <button
                className="icon-button library-track-remove"
                aria-label={`Remove ${track.title} from playlist`}
                // Removal is positional, so a second click during the first would send an
                // index measured against the old list and delete a different song.
                disabled={removing}
                onClick={() => onRemove(index)}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Play counts per release, oldest to newest, as a rough popularity trend. */
function PopularityChart({ albums }: { albums: LibraryAlbum[] }) {
  const points = albums.filter((album) => album.year).sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  const peak = points.reduce((most, album) => Math.max(most, album.playCount), 0)
  if (points.length < 2 || peak === 0)
    return (
      <p className="muted small">
        Navidrome has not recorded enough plays for these releases to chart yet.
      </p>
    )
  const width = 620
  const height = 170
  const left = 44
  const right = 14
  const top = 16
  const bottom = 30
  const x = (index: number) => left + (index * (width - left - right)) / (points.length - 1)
  const y = (plays: number) => top + (1 - plays / peak) * (height - top - bottom)
  const line = points
    .map(
      (album, index) =>
        `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(album.playCount).toFixed(1)}`,
    )
    .join(' ')
  const busiest = points.reduce((best, album) => (album.playCount > best.playCount ? album : best))
  return (
    <div className="popularity-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Play counts from ${points[0]?.year} to ${points[points.length - 1]?.year}. ${busiest.name} leads with ${busiest.playCount} plays.`}
      >
        <line x1={left} y1={y(0)} x2={width - right} y2={y(0)} className="axis" />
        <line x1={left} y1={top} x2={left} y2={y(0)} className="axis" />
        <text x={left - 8} y={top + 4} className="tick end">
          {peak}
        </text>
        <text x={left - 8} y={y(0) + 4} className="tick end">
          0
        </text>
        <path d={line} className="trend" />
        {points.map((album, index) => (
          <circle key={album.id} cx={x(index)} cy={y(album.playCount)} r={4} className="node">
            <title>{`${album.name} (${album.year}) · ${album.playCount} plays`}</title>
          </circle>
        ))}
        {points.map((album, index) =>
          index === 0 || index === points.length - 1 ? (
            <text
              key={`${album.id}-label`}
              x={x(index)}
              y={height - 9}
              className={`tick ${index === 0 ? 'start' : 'end'}`}
            >
              {album.year}
            </text>
          ) : null,
        )}
      </svg>
      <small>
        {busiest.name} is the most played at {busiest.playCount.toLocaleString()} plays.
      </small>
    </div>
  )
}

function PlaylistRow({
  playlist,
  layout,
  liked,
  loading,
  deleting,
  onOpen,
  onPlay,
  onShuffle,
  onDelete,
}: {
  playlist: LibraryPlaylist
  layout: Layout
  liked: boolean
  loading: boolean
  deleting: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
  onDelete: () => void
}) {
  const copy = (
    <>
      <strong>
        {liked && <Heart size={13} fill="currentColor" />}
        {playlist.name}
      </strong>
      <small>
        {songCount(playlist.songCount ?? 0)}
        {playlist.duration ? ` · ${durationText(playlist.duration)}` : ''}
        {playlist.public ? ' · public' : ''}
      </small>
    </>
  )
  return (
    <div className={layout === 'grid' ? 'library-list-row' : 'library-collection-row'}>
      {layout === 'grid' ? (
        <button className="library-list-open" onClick={onOpen}>
          <ListMusic size={20} />
          {copy}
        </button>
      ) : (
        <>
          <span className="library-collection-art">
            <ListMusic size={20} />
          </span>
          <button className="library-collection-open" onClick={onOpen}>
            {copy}
          </button>
        </>
      )}
      <div className="library-collection-actions">
        <CollectionPlayButton
          source={`playlist:${playlist.id}`}
          name={playlist.name}
          className="icon-button"
          size={17}
          disabled={loading}
          onPlay={onPlay}
        />
        <button
          className="icon-button"
          aria-label={`Shuffle ${playlist.name}`}
          onClick={onShuffle}
          disabled={loading}
        >
          <Shuffle size={17} />
        </button>
        {!liked && (
          <button
            className="icon-button library-row-delete"
            aria-label={`Delete playlist ${playlist.name}`}
            onClick={onDelete}
            disabled={deleting}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

export function LibraryPage({
  view = 'home',
  albumId = '',
  artistId = '',
  playlistId = '',
  parentArtistId = '',
  artistSection = 'albums',
}: LibraryPageProps = {}) {
  const player = usePlayer()
  const client = useQueryClient()
  const navigate = useNavigate()
  const tab = view
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
  const [visibility, setVisibility] = useState('all')
  const [artistAlbumSort, setArtistAlbumSort] = useState('year')
  const [artistSongSort, setArtistSongSort] = useState('album')
  const [newName, setNewName] = useState('')
  const [showPlaylistForm, setShowPlaylistForm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState('')
  const deferredPlaylistQuery = useDeferredValue(playlistTrackQuery.trim())
  const artistSongsMode = artistSection === 'songs'
  const sort = sorts[tab]
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
  const ready = capabilities.data?.available === true
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
    enabled: ready && (tab === 'home' || tab === 'albums'),
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
    enabled: ready && tab === 'artists',
  })
  // Search, filter, sort, totals and shuffle are the server's job so they cover the whole
  // library rather than the pages this browser happens to have scrolled through.
  const trackSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort: sorts.tracks })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    return params.toString()
  }, [deferredQuery, selectedGenres, selectedYears, sorts])
  const tracks = useInfiniteQuery({
    queryKey: ['library-tracks', trackSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/tracks?${trackSearch}&offset=${pageParam}&size=100`, libraryTracksSchema, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: ready && tab === 'tracks',
    // Without this a filter change empties the filter menus and disables Play all until the
    // new page lands, which on a large library is seconds.
    placeholderData: keepPreviousData,
  })
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: ready && (tab === 'playlists' || Boolean(playlistId)),
  })
  const albumDetail = useQuery({
    queryKey: ['library-album', albumId],
    queryFn: ({ signal }) =>
      api(`library/albums/${encodeURIComponent(albumId)}`, libraryAlbumDetailSchema, { signal }),
    enabled: ready && Boolean(albumId),
  })
  const artistDetail = useQuery({
    queryKey: ['library-artist', artistId],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(artistId)}`, libraryArtistDetailSchema, { signal }),
    enabled: ready && Boolean(artistId),
  })
  const artistTracks = useQuery({
    queryKey: ['library-artist-tracks', artistId],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(artistId)}/tracks`, libraryArtistTracksSchema, {
        signal,
      }),
    enabled: ready && Boolean(artistId),
  })
  // The player writes to this same key, so adding a song there shows here without a reload.
  const playlistDetail = useQuery({
    queryKey: ['library-playlist', playlistId],
    queryFn: ({ signal }) =>
      api(`library/playlists/${encodeURIComponent(playlistId)}`, libraryPlaylistDetailSchema, {
        signal,
      }),
    enabled: ready && Boolean(playlistId),
  })
  // One upstream page is all this box needs, and the value is deferred so a keystroke does
  // not start a request of its own.
  const playlistTracks = useQuery({
    queryKey: ['library-track-search', deferredPlaylistQuery],
    queryFn: ({ signal }) =>
      api(
        `library/tracks/search?q=${encodeURIComponent(deferredPlaylistQuery)}&size=20`,
        libraryTrackSearchSchema,
        { signal },
      ),
    enabled: ready && Boolean(playlistId) && Boolean(deferredPlaylistQuery),
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
      setNewName('')
      void navigate({
        to: '/library/playlists/$playlistId',
        params: { playlistId: playlist.id },
      })
    },
  })
  const renamePlaylist = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: (playlist) => {
      client.setQueryData(['library-playlist', playlist.id], playlist)
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      // Liked is read under its own key by the footer player, so a rename has to reach it.
      void client.invalidateQueries({ queryKey: ['library-playlist-liked'] })
      setRenaming(false)
    },
  })
  const playlistSongs = usePlaylistSongs()
  const deletePlaylist = useMutation({
    mutationFn: (id: string) =>
      api(`library/playlists/${encodeURIComponent(id)}`, emptySchema, { method: 'DELETE' }),
    onSuccess: () => {
      void navigate({ to: '/library/playlists' })
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })
  const playCollection = useMutation({
    mutationFn: async ({ kind, id }: { kind: Collection; id: string; shuffled: boolean }) => {
      if (kind === 'album')
        return (await api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema))
          .song
      if (kind === 'playlist')
        return (
          await api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema)
        ).entry
      return (
        await api(`library/artists/${encodeURIComponent(id)}/tracks`, libraryArtistTracksSchema)
      ).items
    },
    onSuccess: (items, { kind, id, shuffled }) => {
      const source = `${kind}:${id}`
      if (shuffled) player.shuffleLibrary(items, source)
      else player.playLibrary(items, 0, source)
    },
  })
  // The filters are part of the identity: a Jazz selection and a Rock selection are two
  // different queues, and one Pause button must not stand for both.
  const trackSource = `tracks:${trackSearch}`
  const playTracks = useMutation({
    mutationFn: ({ shuffled }: { shuffled: boolean }) =>
      api(`library/tracks/selection?${trackSearch}&shuffle=${shuffled}`, librarySelectionSchema),
    onSuccess: (selection, { shuffled }) => {
      if (shuffled) player.shuffleLibrary(selection.items, trackSource)
      else player.playLibrary(selection.items, 0, trackSource)
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
  const trackItems = useMemo(
    () => tracks.data?.pages.flatMap((page) => page.items) ?? [],
    [tracks.data],
  )
  const trackTotal = tracks.data?.pages[0]?.total ?? 0
  const likedId = playlists.data?.liked_id ?? ''
  const playlistItems = useMemo(() => {
    const needle = deferredQuery.toLocaleLowerCase()
    const items = (playlists.data?.items ?? []).filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(needle) &&
        (visibility === 'all' ||
          (visibility === 'public' ? item.public : !item.public) ||
          item.id === likedId),
    )
    const ordered = [...items].sort((a, b) => {
      if (sort === 'tracks') return (b.songCount ?? 0) - (a.songCount ?? 0)
      if (sort === 'duration') return (b.duration ?? 0) - (a.duration ?? 0)
      if (sort === 'changed') return textCompare(b.changed, a.changed)
      return textCompare(a.name, b.name)
    })
    // Liked is the one playlist Musimo maintains, so it stays at the top of every view.
    return ordered.sort((a, b) => Number(b.id === likedId) - Number(a.id === likedId))
  }, [deferredQuery, likedId, playlists.data, sort, visibility])
  const artistAlbums = useMemo(
    () => sortArtistAlbums(artistDetail.data?.album ?? [], artistAlbumSort),
    [artistDetail.data, artistAlbumSort],
  )
  const artistSongs = useMemo(
    () => sortArtistSongs(artistTracks.data?.items ?? [], artistSongSort),
    [artistTracks.data, artistSongSort],
  )

  const albumFacets = albums.data?.pages.flatMap((page) => page.items) ?? []
  const trackFacets = tracks.data?.pages[0]
  const genres =
    tab === 'tracks'
      ? (trackFacets?.genres ?? [])
      : [
          ...new Set(
            albumFacets.map((item) => item.genre).filter((item): item is string => Boolean(item)),
          ),
        ].sort(textCompare)
  const years =
    tab === 'tracks'
      ? (trackFacets?.years ?? []).map(String)
      : [
          ...new Set(
            albumFacets
              .map((item) => item.year)
              .filter((item): item is number => item !== undefined),
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
  const showBrowser = !albumId && !artistId && !playlistId
  const albumParent = parentArtistId
    ? { id: parentArtistId, name: albumDetail.data?.artist || 'artist' }
    : null
  const playlist = playlistDetail.data
  const playlistLiked = Boolean(playlist) && playlist?.id === likedId
  const detailTracks = playlist?.entry ?? albumDetail.data?.song ?? []
  const detailTitle = playlist?.name ?? albumDetail.data?.name ?? ''
  const detailSource = playlist ? `playlist:${playlist.id}` : `album:${albumId}`
  const detailError = playlistId ? playlistDetail.error : albumId ? albumDetail.error : null
  const busy =
    playCollection.isPending ||
    playTracks.isPending ||
    albumDetail.isLoading ||
    artistDetail.isLoading ||
    playlistDetail.isLoading

  useEffect(() => remember('musimo.library-layout', layout), [layout])

  useEffect(() => {
    setRenaming(false)
    setPlaylistTrackQuery('')
  }, [playlistId])

  function changeTab(next: Tab) {
    setSelectedGenres([])
    setSelectedYears([])
    setVisibility('all')
    setShowPlaylistForm(false)
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

  function confirmDelete(target: LibraryPlaylist | { id: string; name: string }) {
    if (window.confirm(`Delete playlist “${target.name}”?`)) deletePlaylist.mutate(target.id)
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
        <span
          className={`tag library-status ${capabilities.data.sonic_similarity ? 'good' : ''}`}
          role="status"
        >
          <span style={{ visibility: busy ? 'hidden' : undefined }}>
            {capabilities.data.sonic_similarity ? 'AUDIOMUSE CONNECTED' : 'NAVIDROME READY'}
          </span>
          {busy && <span>Opening music…</span>}
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
          {tab === 'playlists' && (
            <label className="library-select">
              <select
                aria-label="Filter playlists"
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
              >
                <option value="all">All playlists</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </label>
          )}
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
            <span className="library-count">
              {tab === 'tracks'
                ? `${trackItems.length} of ${trackTotal} loaded`
                : `${currentItems.length} loaded`}
            </span>
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
            const name = newName.trim()
            if (name) createPlaylist.mutate(name)
          }}
        >
          <label>
            Playlist name
            <input
              autoFocus
              value={newName}
              maxLength={200}
              onChange={(event) => setNewName(event.target.value)}
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
              setNewName('')
            }}
          >
            Cancel
          </button>
          {createPlaylist.isError && <p className="error">{createPlaylist.error.message}</p>}
        </form>
      )}
      {showBrowser && activeQuery.isLoading && <p role="status">Loading {tab}…</p>}
      {showBrowser && activeQuery.isError && (
        <div className="inline-error" role="alert">
          <span>{activeQuery.error.message}</span>
          <button className="button" onClick={() => void activeQuery.refetch()}>
            Retry
          </button>
        </div>
      )}
      {(albumId || playlistId) && (
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
              <h2>
                {playlistLiked && <Heart size={17} fill="currentColor" />}
                {detailTitle}
              </h2>
              <small className="library-count">
                {songCount(detailTracks.length)}
                {playlist?.duration ? ` · ${durationText(playlist.duration)}` : ''}
              </small>
            </div>
            <div className="button-row">
              <CollectionPlayButton
                source={detailSource}
                text="Play all"
                className="button primary"
                size={15}
                disabled={!detailTracks.length}
                onPlay={() => player.playLibrary(detailTracks, 0, detailSource)}
              />
              <button
                className="button"
                onClick={() => player.shuffleLibrary(detailTracks, detailSource)}
                disabled={!detailTracks.length}
              >
                <Shuffle size={15} /> Shuffle
              </button>
              {playlist && (
                <button
                  className="button"
                  onClick={() => {
                    setRenameValue(playlist.name)
                    setRenaming(!renaming)
                  }}
                  aria-expanded={renaming}
                >
                  <Pencil size={15} /> Rename
                </button>
              )}
              {playlist && !playlistLiked && (
                <button
                  className="button danger"
                  onClick={() => confirmDelete(playlist)}
                  disabled={deletePlaylist.isPending}
                >
                  <Trash2 size={15} /> Delete
                </button>
              )}
            </div>
          </div>
          {playlist && renaming && (
            <form
              className="playlist-form"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renameValue.trim()
                if (name && name !== playlist.name) renamePlaylist.mutate({ id: playlist.id, name })
                else setRenaming(false)
              }}
            >
              <label>
                Playlist name
                <input
                  autoFocus
                  value={renameValue}
                  maxLength={200}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </label>
              <button className="button primary" disabled={renamePlaylist.isPending}>
                {renamePlaylist.isPending ? 'Saving…' : 'Save name'}
              </button>
              <button type="button" className="button" onClick={() => setRenaming(false)}>
                Cancel
              </button>
              {renamePlaylist.isError && <p className="error">{renamePlaylist.error.message}</p>}
            </form>
          )}
          {deletePlaylist.isError && (
            <p className="error" role="alert">
              {deletePlaylist.error.message}
            </p>
          )}
          {(albumDetail.isLoading || playlistDetail.isLoading) && (
            <p role="status">Loading songs…</p>
          )}
          {detailError && (
            <div className="inline-error" role="alert">
              <span>{detailError.message}</span>
              <button
                className="button"
                onClick={() => void (playlistId ? playlistDetail.refetch() : albumDetail.refetch())}
              >
                Retry
              </button>
            </div>
          )}
          <TrackList
            tracks={detailTracks}
            source={detailSource}
            removing={Boolean(playlist) && playlistSongs.busy(playlist?.id ?? '')}
            onRemove={
              playlist
                ? (index) => playlistSongs.mutation.mutate({ playlistId: playlist.id, index })
                : undefined
            }
          />
          {playlist && (
            <section className="playlist-add">
              <div className="section-heading">
                <h3>Add songs</h3>
                <span>Search your library</span>
              </div>
              <label className="library-search">
                <Search size={17} />
                <input
                  aria-label="Search songs to add"
                  value={playlistTrackQuery}
                  onChange={(event) => setPlaylistTrackQuery(event.target.value)}
                  placeholder="Search songs to add"
                />
              </label>
              {playlistTracks.isLoading && <p role="status">Searching songs…</p>}
              {playlistTracks.isError && <p className="error">{playlistTracks.error.message}</p>}
              <div className="playlist-add-list">
                {playlistTracks.data?.items.map((track) => {
                  const index = playlist.entry.findIndex((item) => item.id === track.id)
                  const member = index >= 0
                  return (
                    <div key={track.id}>
                      <span>
                        <strong>{track.title}</strong>
                        <small>
                          {track.artist} · {track.album}
                        </small>
                      </span>
                      <button
                        className={member ? 'button' : 'button primary'}
                        aria-label={`${member ? 'Remove' : 'Add'} ${track.title} ${member ? 'from' : 'to'} ${playlist.name}`}
                        onClick={() =>
                          playlistSongs.mutation.mutate(
                            member
                              ? { playlistId: playlist.id, index }
                              : { playlistId: playlist.id, songId: track.id },
                          )
                        }
                        disabled={playlistSongs.busy(playlist.id)}
                      >
                        {member ? (
                          <>
                            <X size={15} /> Remove
                          </>
                        ) : (
                          <>
                            <Plus size={15} /> Add
                          </>
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>
              {playlistSongs.mutation.isError && (
                <p className="error">{playlistSongs.mutation.error.message}</p>
              )}
            </section>
          )}
        </section>
      )}
      {artistId && artistDetail.isError && (
        <div className="inline-error" role="alert">
          <span>{artistDetail.error.message}</span>
          <button className="button" onClick={() => void artistDetail.refetch()}>
            Retry
          </button>
        </div>
      )}
      {artistId && artistDetail.data && (
        <section className="library-detail">
          <button className="text-link" onClick={() => changeTab('artists')}>
            ← Back to artists
          </button>
          <div className="library-artist-heading">
            <span className="library-artist-art large">
              {artistDetail.data.coverArt ? (
                <img src={cover(artistDetail.data.coverArt)} alt="" />
              ) : (
                <Disc3 />
              )}
            </span>
            <div>
              <h2>{artistDetail.data.name}</h2>
              <span>
                {artistSongsMode ? `${artistSongs.length} SONGS` : `${artistAlbums.length} ALBUMS`}
              </span>
            </div>
            <div className="button-row">
              <CollectionPlayButton
                source={`artist:${artistId}`}
                text="Play all"
                className="button primary"
                size={15}
                disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
                onPlay={() =>
                  artistSongsMode
                    ? player.playLibrary(artistSongs, 0, `artist:${artistId}`)
                    : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: false })
                }
              />
              <button
                className="button"
                onClick={() =>
                  artistSongsMode
                    ? player.shuffleLibrary(artistSongs, `artist:${artistId}`)
                    : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: true })
                }
                disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
              >
                <Shuffle size={15} /> Shuffle
              </button>
              <button
                className="button"
                onClick={() =>
                  void navigate({
                    to: artistSongsMode
                      ? '/library/artists/$artistId'
                      : '/library/artists/$artistId/songs',
                    params: { artistId },
                  })
                }
                disabled={!artistSongsMode && (artistTracks.isLoading || !artistSongs.length)}
              >
                <ListMusic size={15} /> {artistSongsMode ? 'Albums' : 'All songs'}
              </button>
            </div>
          </div>
          <div className="library-tools artist-tools">
            <label className="library-select">
              <SlidersHorizontal size={16} />
              <select
                aria-label={artistSongsMode ? 'Sort songs' : 'Sort albums'}
                value={artistSongsMode ? artistSongSort : artistAlbumSort}
                onChange={(event) =>
                  artistSongsMode
                    ? setArtistSongSort(event.target.value)
                    : setArtistAlbumSort(event.target.value)
                }
              >
                {(artistSongsMode ? ARTIST_SONG_SORTS : ARTIST_ALBUM_SORTS).map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {!artistSongsMode && <LayoutToggle layout={layout} onChange={setLayout} />}
          </div>
          {artistSongsMode && artistTracks.isError && (
            <p className="error" role="alert">
              {artistTracks.error.message}
            </p>
          )}
          {artistSongsMode && artistTracks.isLoading && <p role="status">Loading songs…</p>}
          {artistSongsMode ? (
            <TrackList tracks={artistSongs} source={`artist:${artistId}`} />
          ) : (
            <>
              <div className={layout === 'grid' ? 'library-grid' : 'library-collection-list'}>
                {artistAlbums.map((album) => (
                  <AlbumItem
                    album={album}
                    key={album.id}
                    layout={layout}
                    loading={busy}
                    onOpen={() =>
                      void navigate({
                        to: '/library/artists/$artistId/albums/$albumId',
                        params: { artistId, albumId: album.id },
                      })
                    }
                    onPlay={() =>
                      playCollection.mutate({ kind: 'album', id: album.id, shuffled: false })
                    }
                    onShuffle={() =>
                      playCollection.mutate({ kind: 'album', id: album.id, shuffled: true })
                    }
                  />
                ))}
              </div>
              <section className="artist-popularity">
                <div className="section-heading">
                  <h3>Popularity</h3>
                  <span>Navidrome play counts by release year</span>
                </div>
                <PopularityChart albums={artistDetail.data.album} />
              </section>
            </>
          )}
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
                loading={busy}
                onOpen={() =>
                  void navigate({
                    to: '/library/albums/$albumId',
                    params: { albumId: album.id },
                  })
                }
                onPlay={() =>
                  playCollection.mutate({ kind: 'album', id: album.id, shuffled: false })
                }
                onShuffle={() =>
                  playCollection.mutate({ kind: 'album', id: album.id, shuffled: true })
                }
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
              loading={busy}
              onOpen={() =>
                void navigate({
                  to: '/library/artists/$artistId',
                  params: { artistId: artist.id },
                })
              }
              onPlay={() =>
                playCollection.mutate({ kind: 'artist', id: artist.id, shuffled: false })
              }
              onShuffle={() =>
                playCollection.mutate({ kind: 'artist', id: artist.id, shuffled: true })
              }
            />
          ))}
        </div>
      )}
      {tab === 'tracks' && showBrowser && (
        <section className="library-detail">
          <div className="library-list-actions">
            <CollectionPlayButton
              source={trackSource}
              text="Play all"
              className="button primary"
              size={15}
              disabled={busy || !trackTotal}
              onPlay={() => playTracks.mutate({ shuffled: false })}
            />
            <button
              className="button"
              onClick={() => playTracks.mutate({ shuffled: true })}
              disabled={busy || !trackTotal}
            >
              <Shuffle size={15} /> Shuffle
            </button>
            <small className="muted">
              {trackTotal > 500
                ? `Plays a random 500 of ${trackTotal.toLocaleString()} matching songs.`
                : 'Covers every matching song, not just the loaded ones.'}
            </small>
          </div>
          {playTracks.isError && (
            <p className="error" role="alert">
              {playTracks.error.message}
            </p>
          )}
          <TrackList tracks={trackItems} source={trackSource} />
        </section>
      )}
      {tab === 'playlists' && showBrowser && (
        <div className={layout === 'grid' ? 'library-list' : 'library-collection-list'}>
          {playlistItems.map((item: LibraryPlaylist) => (
            <PlaylistRow
              key={item.id}
              playlist={item}
              layout={layout}
              liked={item.id === likedId}
              loading={busy}
              deleting={deletePlaylist.isPending}
              onOpen={() =>
                void navigate({
                  to: '/library/playlists/$playlistId',
                  params: { playlistId: item.id },
                })
              }
              onPlay={() =>
                playCollection.mutate({ kind: 'playlist', id: item.id, shuffled: false })
              }
              onShuffle={() =>
                playCollection.mutate({ kind: 'playlist', id: item.id, shuffled: true })
              }
              onDelete={() => confirmDelete(item)}
            />
          ))}
        </div>
      )}
      {playCollection.isError && (
        <p className="error" role="alert">
          {playCollection.error.message}
        </p>
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
      if (track) player.playLibrary([track, ...result.items.map((item) => item.entry)], 0, 'radio')
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
          <TrackList tracks={player.queue} source={player.source} />
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
