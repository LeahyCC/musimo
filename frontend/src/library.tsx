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
import { cx } from './cx'
import { InfiniteScroll } from './infinite-scroll'
import { NowPlayingStage } from './now-playing-popout'
import {
  durationText,
  remember,
  songCount,
  stored,
  useCollectionPlayback,
  usePlayer,
  usePlaylistSongs,
} from './player'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  Field,
  IconButton,
  InlineError,
  Panel,
  Tag,
  textLinkClassName,
} from './ui'

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

// Shared between the album, artist and playlist list rows: an album/artist/playlist art
// square, a name, a meta line and a trailing action cluster on a sunken pill.
const collectionRowClass =
  'group grid min-w-0 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-[12px] rounded-[8px] border border-line bg-sunken px-[10px] py-[7px] hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)] max-phone:grid-cols-[42px_minmax(0,1fr)_auto] max-phone:gap-[9px]'
const collectionArtClass =
  'grid h-[48px] w-[48px] place-items-center overflow-hidden rounded-md bg-raised text-faint max-phone:h-[42px] max-phone:w-[42px]'
const collectionOpenClass =
  'grid min-w-0 gap-[4px] border-0 bg-none px-0 py-[8px] text-left text-inherit'
const collectionActionsClass = 'flex items-center gap-[4px] max-phone:gap-0'
const collectionIconButtonClassName = 'h-[36px] w-[36px]'

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: Layout
  onChange: (layout: Layout) => void
}) {
  return (
    <div
      className="flex rounded-[8px] border border-line bg-sunken p-[3px]"
      role="group"
      aria-label="Library layout"
    >
      <IconButton
        aria-label="Grid view"
        aria-pressed={layout === 'grid'}
        onClick={() => onChange('grid')}
        className="h-[34px] w-[34px] rounded-md aria-pressed:bg-accent aria-pressed:text-accent-ink"
      >
        <Grid2X2 size={17} />
      </IconButton>
      <IconButton
        aria-label="List view"
        aria-pressed={layout === 'list'}
        onClick={() => onChange('list')}
        className="h-[34px] w-[34px] rounded-md aria-pressed:bg-accent aria-pressed:text-accent-ink"
      >
        <List size={18} />
      </IconButton>
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

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        setOpen(false)
        event.preventDefault()
      }
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  return (
    <details
      ref={root}
      className="relative min-w-[125px] rounded-[8px] border border-line bg-sunken text-muted max-phone:flex-1"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-[11px] pr-[30px] pl-[12px] text-text coarse:flex coarse:min-h-11 coarse:items-center">
        {selected.length ? `${label} (${selected.length})` : `All ${label.toLowerCase()}`}
      </summary>
      <div className="absolute top-[calc(100%+5px)] left-0 z-overlay grid max-h-[260px] min-w-[190px] overflow-auto overscroll-contain rounded-[8px] border border-line bg-sunken p-[8px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)] max-phone:w-full max-phone:min-w-0">
        {options.map((option) => (
          <label
            key={option}
            className="flex items-center gap-[9px] px-[5px] py-[7px] text-small text-text coarse:min-h-11"
          >
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => onToggle(option)}
              className="accent-accent"
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
  variant,
  size,
  disabled,
  onPlay,
}: {
  source: string
  name?: string
  text?: string
  variant: 'icon' | 'primary' | 'card-play'
  size: number
  disabled?: boolean
  onPlay: () => void
}) {
  const playback = useCollectionPlayback(source)
  // A labelled button reads from its own text; an icon-only one needs the name.
  const label = text ? undefined : `${playback.playing ? 'Pause' : 'Play'} ${name}`
  // Already this collection's queue, so resume it. Calling onPlay would refetch and restart
  // from the first track, losing where the listener paused.
  const onClick = () => (playback.active ? playback.toggle() : onPlay())
  const content = (
    <>
      {playback.playing ? <Pause size={size} /> : <Play size={size} fill="currentColor" />}
      {text ? ` ${playback.playing ? 'Pause' : text}` : null}
    </>
  )
  if (variant === 'icon')
    return (
      <IconButton aria-label={label} disabled={disabled} onClick={onClick}>
        {content}
      </IconButton>
    )
  if (variant === 'primary')
    return (
      <Button
        variant="primary"
        data-active={playback.active}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {content}
      </Button>
    )
  return (
    <button
      className={cx(
        'library-card-play absolute right-[10px] bottom-[10px] grid h-[38px] w-[38px] translate-y-[5px] place-items-center rounded-pill border-0 bg-accent text-accent-ink opacity-0 transition-[opacity,transform] duration-[140ms] ease-in-out',
        'group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100',
        'no-hover:translate-y-0 no-hover:opacity-100 coarse:h-11 coarse:w-11',
        playback.active && 'translate-y-0 opacity-100',
      )}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {content}
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
      <div className={collectionRowClass}>
        <span className={collectionArtClass}>
          {album.coverArt ? (
            <img
              src={cover(album.coverArt)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <Disc3 />
          )}
        </span>
        <button className={collectionOpenClass} onClick={onOpen}>
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap">{album.name}</strong>
          <small className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
            {albumMeta(album)}
          </small>
        </button>
        <div className={collectionActionsClass}>
          <CollectionPlayButton
            source={`album:${album.id}`}
            name={album.name}
            variant="icon"
            size={17}
            disabled={loading}
            onPlay={onPlay}
          />
          <IconButton
            aria-label={`Shuffle ${album.name}`}
            onClick={onShuffle}
            disabled={loading}
            className="h-[36px] w-[36px]"
          >
            <Shuffle size={17} />
          </IconButton>
        </div>
      </div>
    )

  return (
    <article className="library-card group min-w-0">
      <div className="relative">
        <button
          className="library-cover relative grid aspect-square w-full place-items-center overflow-hidden rounded-[10px] border border-line bg-raised p-0 text-faint"
          aria-label={`Open ${album.name}`}
          onClick={onOpen}
        >
          {album.coverArt ? (
            <img
              src={cover(album.coverArt)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <Disc3 />
          )}
        </button>
        <CollectionPlayButton
          source={`album:${album.id}`}
          name={album.name}
          variant="card-play"
          size={19}
          disabled={loading}
          onPlay={onPlay}
        />
      </div>
      <button
        className="library-card-copy block w-full border-0 bg-none p-0 text-left text-inherit"
        onClick={onOpen}
      >
        <strong className="mt-[8px] block overflow-hidden text-ellipsis whitespace-nowrap">
          {album.name}
        </strong>
        <small className="mt-[4px] block overflow-hidden text-ellipsis whitespace-nowrap text-muted">
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
    <article
      className={cx(
        'library-artist-card min-w-0 gap-[10px] rounded-[9px] border border-line bg-raised p-[12px] hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)]',
        layout === 'grid' ? 'grid justify-items-center text-center' : 'flex items-center',
      )}
    >
      <button
        className={cx(
          'min-w-0 flex-1 gap-[10px] border-0 bg-none p-0 text-left text-inherit',
          layout === 'grid' ? 'grid justify-items-center text-center' : 'flex items-center',
        )}
        onClick={onOpen}
      >
        <span
          className={cx(
            'library-artist-art grid flex-none place-items-center overflow-hidden rounded-pill bg-raised text-faint',
            layout === 'grid' ? 'h-[104px] w-[104px]' : 'h-[52px] w-[52px]',
          )}
        >
          {artist.coverArt ? (
            <img
              src={cover(artist.coverArt)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <Disc3 />
          )}
        </span>
        <span className="grid min-w-0">
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap">{artist.name}</strong>
          <small className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
            {artist.albumCount ?? 0} {artist.albumCount === 1 ? 'album' : 'albums'}
          </small>
        </span>
      </button>
      <div className={collectionActionsClass}>
        <CollectionPlayButton
          source={`artist:${artist.id}`}
          name={artist.name}
          variant="icon"
          size={17}
          disabled={loading}
          onPlay={onPlay}
        />
        <IconButton
          aria-label={`Shuffle ${artist.name}`}
          onClick={onShuffle}
          disabled={loading}
          className={collectionIconButtonClassName}
        >
          <Shuffle size={17} />
        </IconButton>
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
    <div className="library-tracks grid">
      {tracks.map((track, index) => {
        // A playlist may hold the same song twice, and the same song appears in several
        // collections, so the queue and the position are both part of "the playing row".
        const current =
          player.source === source &&
          player.currentIndex === index &&
          player.libraryTrack?.id === track.id
        const playing = current && player.playing
        return (
          <div
            className="library-track-row flex items-center border-b border-line"
            key={`${track.id}-${index}`}
          >
            <button
              className={cx(
                'library-track-play grid w-full grid-cols-[34px_minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] items-center gap-[12px] rounded-md border-0 bg-transparent px-[12px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11 max-phone:grid-cols-[24px_minmax(0,1fr)_24px]',
                current && 'bg-hover',
              )}
              aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
              onClick={() =>
                current ? player.toggle() : player.playLibrary(tracks, index, source)
              }
            >
              <span className="text-small text-muted">{track.track ?? index + 1}</span>
              <span className="grid gap-[3px]">
                <strong>{track.title}</strong>
                <small className="text-small text-muted">{track.artist}</small>
              </span>
              <small className="text-small text-muted max-phone:hidden">{track.album}</small>
              <time className="text-small text-muted max-phone:hidden">
                {durationText(track.duration)}
              </time>
              {playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            </button>
            {onRemove && (
              <IconButton
                className="mr-[5px] w-[38px] flex-none"
                aria-label={`Remove ${track.title} from playlist`}
                // Removal is positional, so a second click during the first would send an
                // index measured against the old list and delete a different song.
                disabled={removing}
                onClick={() => onRemove(index)}
              >
                <X size={16} />
              </IconButton>
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
      <p className="text-small text-muted">
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
  const tickClass = 'fill-muted text-[11px]'
  return (
    <div className="grid gap-[8px] overflow-x-auto rounded-[10px] border border-line bg-sunken p-[14px]">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        className="h-auto w-full min-w-[320px] max-w-[620px]"
        aria-label={`Play counts from ${points[0]?.year} to ${points[points.length - 1]?.year}. ${busiest.name} leads with ${busiest.playCount} plays.`}
      >
        <line x1={left} y1={y(0)} x2={width - right} y2={y(0)} className="stroke-line" />
        <line x1={left} y1={top} x2={left} y2={y(0)} className="stroke-line" />
        <text x={left - 8} y={top + 4} className={cx(tickClass, '[text-anchor:end]')}>
          {peak}
        </text>
        <text x={left - 8} y={y(0) + 4} className={cx(tickClass, '[text-anchor:end]')}>
          0
        </text>
        <path d={line} className="fill-none stroke-accent stroke-2 [stroke-linejoin:round]" />
        {points.map((album, index) => (
          <circle
            key={album.id}
            cx={x(index)}
            cy={y(album.playCount)}
            r={4}
            className="fill-accent"
          >
            <title>{`${album.name} (${album.year}) · ${album.playCount} plays`}</title>
          </circle>
        ))}
        {points.map((album, index) =>
          index === 0 || index === points.length - 1 ? (
            <text
              key={`${album.id}-label`}
              x={x(index)}
              y={height - 9}
              className={cx(tickClass, index === 0 ? '[text-anchor:start]' : '[text-anchor:end]')}
            >
              {album.year}
            </text>
          ) : null,
        )}
      </svg>
      <small className="text-small text-muted">
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
      <strong className="flex items-center gap-[6px] overflow-hidden">
        {liked && <Heart size={13} fill="currentColor" className="flex-none" />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {playlist.name}
        </span>
      </strong>
      <small className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
        {songCount(playlist.songCount ?? 0)}
        {playlist.duration ? ` · ${durationText(playlist.duration)}` : ''}
        {playlist.public ? ' · public' : ''}
      </small>
    </>
  )
  return (
    <div
      className={
        layout === 'grid'
          ? 'library-list-row group flex items-center gap-[6px] rounded-[9px] border border-line bg-raised hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)]'
          : collectionRowClass
      }
    >
      {layout === 'grid' ? (
        <button
          className="library-list-open grid min-w-0 flex-1 grid-cols-[28px_minmax(0,1fr)] items-center gap-x-[10px] gap-y-[3px] rounded-[8px] border-0 bg-raised p-[16px] text-left text-inherit"
          onClick={onOpen}
        >
          <ListMusic size={20} className="row-span-2" />
          {copy}
        </button>
      ) : (
        <>
          <span className={collectionArtClass}>
            <ListMusic size={20} />
          </span>
          <button className={collectionOpenClass} onClick={onOpen}>
            {copy}
          </button>
        </>
      )}
      <div className={cx(collectionActionsClass, layout === 'grid' && 'pr-[6px]')}>
        <CollectionPlayButton
          source={`playlist:${playlist.id}`}
          name={playlist.name}
          variant="icon"
          size={17}
          disabled={loading}
          onPlay={onPlay}
        />
        <IconButton
          aria-label={`Shuffle ${playlist.name}`}
          onClick={onShuffle}
          disabled={loading}
          className={collectionIconButtonClassName}
        >
          <Shuffle size={17} />
        </IconButton>
        {!liked && (
          <IconButton
            className="mr-[4px] self-center p-[8px] opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100"
            aria-label={`Delete playlist ${playlist.name}`}
            onClick={onDelete}
            disabled={deleting}
          >
            <Trash2 size={16} />
          </IconButton>
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

  // Renders under the heading it belongs to (e.g. "Fresh in your library") rather than above
  // the whole browser, so a failed load never reads as if the page itself is broken.
  const libraryLoadError = showBrowser && activeQuery.isError && (
    <InlineError role="alert">
      <span>{activeQuery.error.message}</span>
      <Button onClick={() => void activeQuery.refetch()}>Retry</Button>
    </InlineError>
  )

  if (capabilities.isLoading) return <p role="status">Connecting to your library…</p>
  if (!capabilities.data?.available)
    return (
      <EmptyPanel className="min-h-[55vh]">
        <Library size={36} />
        <h1>Your music library lives here.</h1>
        <p>{capabilities.data?.detail ?? 'Navidrome is not ready.'}</p>
        <Link
          data-ui="button"
          className={buttonClassName('primary', 'mx-auto')}
          to="/settings"
          hash="library"
        >
          Connect Navidrome
        </Link>
      </EmptyPanel>
    )

  return (
    <>
      <div className="page-heading mb-[24px]">
        <div>
          <p className="eyebrow">YOUR MUSIC, READY TO PLAY</p>
          <h1>Library</h1>
        </div>
        <Tag className="grid" role="status">
          <span className="[grid-area:1/1]" style={{ visibility: busy ? 'hidden' : undefined }}>
            {capabilities.data.sonic_similarity ? 'AUDIOMUSE CONNECTED' : 'NAVIDROME READY'}
          </span>
          {busy && <span className="[grid-area:1/1]">Opening music…</span>}
        </Tag>
      </div>
      <nav
        className="flex gap-[6px] overflow-x-auto border-b border-line mb-[28px] max-phone:mb-[20px] max-phone:gap-0 max-phone:overflow-visible"
        aria-label="Library views"
      >
        {(['home', 'albums', 'artists', 'tracks', 'playlists'] as Tab[]).map((item) => (
          <button
            className={cx(
              'border-0 border-b-2 bg-none px-[14px] py-[11px] capitalize coarse:min-h-11 max-phone:min-w-0 max-phone:flex-1 max-phone:px-[2px] max-phone:py-[12px] max-phone:text-[13px] max-phone:text-center',
              tab === item ? 'border-accent text-text' : 'border-transparent text-muted',
            )}
            key={item}
            aria-pressed={tab === item}
            onClick={() => changeTab(item)}
          >
            {item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      {showBrowser && (
        <div className="flex flex-wrap items-center gap-[10px] mb-[22px]">
          <label className="library-search flex w-[min(420px,100%)] items-center rounded-[8px] border border-line bg-sunken px-[12px] text-muted">
            <Search size={17} />
            <input
              className="w-full border-0 bg-transparent p-[11px] text-inherit outline-0"
              aria-label={`Search ${tab === 'home' ? 'albums' : tab}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${tab === 'home' ? 'albums' : tab}`}
            />
            {query && (
              <button
                className="grid place-items-center border-0 bg-none p-[7px] text-muted coarse:min-h-11 coarse:min-w-11"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <label className="flex min-h-[42px] items-center gap-[7px] rounded-[8px] border border-line bg-sunken px-[10px] text-muted">
            <SlidersHorizontal size={16} />
            <select
              className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-[16px]"
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
            <label className="flex min-h-[42px] items-center gap-[7px] rounded-[8px] border border-line bg-sunken px-[10px] text-muted">
              <select
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-[16px]"
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
                  type="button"
                  data-ui="text-link"
                  className={textLinkClassName('px-[5px] py-[9px]')}
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
          <div className="flex items-center gap-[10px] ml-auto max-phone:ml-0">
            <span className="library-count text-small whitespace-nowrap text-muted">
              {tab === 'tracks'
                ? `${trackItems.length} of ${trackTotal} loaded`
                : `${currentItems.length} loaded`}
            </span>
            {tab !== 'tracks' && <LayoutToggle layout={layout} onChange={setLayout} />}
          </div>
          {tab === 'playlists' && (
            <Button variant="primary" onClick={() => setShowPlaylistForm(true)}>
              <Plus size={16} /> New playlist
            </Button>
          )}
        </div>
      )}
      {showBrowser && tab === 'playlists' && showPlaylistForm && (
        <form
          className="flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-raised p-[14px] mb-[20px]"
          onSubmit={(event) => {
            event.preventDefault()
            const name = newName.trim()
            if (name) createPlaylist.mutate(name)
          }}
        >
          <label className="grid min-w-[min(320px,100%)] gap-[6px] text-small text-muted">
            Playlist name
            <Field
              autoFocus
              value={newName}
              maxLength={200}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={createPlaylist.isPending}>
            {createPlaylist.isPending ? 'Creating…' : 'Create'}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setShowPlaylistForm(false)
              setNewName('')
            }}
          >
            Cancel
          </Button>
          {createPlaylist.isError && (
            <ErrorBanner className="w-full m-0">{createPlaylist.error.message}</ErrorBanner>
          )}
        </form>
      )}
      {showBrowser && activeQuery.isLoading && (
        <p role="status">Loading {tab === 'home' ? 'albums' : tab}…</p>
      )}
      {(albumId || playlistId) && (
        <section className="library-detail grid gap-[16px]">
          <div className="section-heading">
            <div>
              <button
                type="button"
                data-ui="text-link"
                className={textLinkClassName()}
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
              <h2 className="flex items-center gap-[8px]">
                {playlistLiked && <Heart size={17} fill="currentColor" />}
                {detailTitle}
              </h2>
              {!(albumDetail.isLoading || playlistDetail.isLoading) && (
                <small className="library-count text-small whitespace-nowrap text-muted">
                  {songCount(detailTracks.length)}
                  {playlist?.duration ? ` · ${durationText(playlist.duration)}` : ''}
                </small>
              )}
            </div>
            <div className="button-row">
              <CollectionPlayButton
                source={detailSource}
                text="Play all"
                variant="primary"
                size={15}
                disabled={!detailTracks.length}
                onPlay={() => player.playLibrary(detailTracks, 0, detailSource)}
              />
              <Button
                onClick={() => player.shuffleLibrary(detailTracks, detailSource)}
                disabled={!detailTracks.length}
              >
                <Shuffle size={15} /> Shuffle
              </Button>
              {playlist && (
                <Button
                  onClick={() => {
                    setRenameValue(playlist.name)
                    setRenaming(!renaming)
                  }}
                  aria-expanded={renaming}
                >
                  <Pencil size={15} /> Rename
                </Button>
              )}
              {playlist && !playlistLiked && (
                <Button
                  variant="danger"
                  onClick={() => confirmDelete(playlist)}
                  disabled={deletePlaylist.isPending}
                >
                  <Trash2 size={15} /> Delete
                </Button>
              )}
            </div>
          </div>
          {playlist && renaming && (
            <form
              className="flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-raised p-[14px] mb-[20px]"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renameValue.trim()
                if (name && name !== playlist.name) renamePlaylist.mutate({ id: playlist.id, name })
                else setRenaming(false)
              }}
            >
              <label className="grid min-w-[min(320px,100%)] gap-[6px] text-small text-muted">
                Playlist name
                <Field
                  autoFocus
                  value={renameValue}
                  maxLength={200}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </label>
              <Button type="submit" variant="primary" disabled={renamePlaylist.isPending}>
                {renamePlaylist.isPending ? 'Saving…' : 'Save name'}
              </Button>
              <Button type="button" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              {renamePlaylist.isError && (
                <ErrorBanner className="w-full m-0">{renamePlaylist.error.message}</ErrorBanner>
              )}
            </form>
          )}
          {deletePlaylist.isError && (
            <ErrorBanner role="alert">{deletePlaylist.error.message}</ErrorBanner>
          )}
          {(albumDetail.isLoading || playlistDetail.isLoading) && (
            <p role="status">Loading songs…</p>
          )}
          {detailError && (
            <InlineError role="alert">
              <span>{detailError.message}</span>
              <Button
                onClick={() => void (playlistId ? playlistDetail.refetch() : albumDetail.refetch())}
              >
                Retry
              </Button>
            </InlineError>
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
            <section className="border-t border-line pt-[12px]">
              <div className="section-heading">
                <h3>Add songs</h3>
                <span>Search your library</span>
              </div>
              <label className="library-search flex w-[min(420px,100%)] items-center rounded-[8px] border border-line bg-sunken px-[12px] text-muted">
                <Search size={17} />
                <input
                  className="w-full border-0 bg-transparent p-[11px] text-inherit outline-0"
                  aria-label="Search songs to add"
                  value={playlistTrackQuery}
                  onChange={(event) => setPlaylistTrackQuery(event.target.value)}
                  placeholder="Search songs to add"
                />
              </label>
              {playlistTracks.isLoading && <p role="status">Searching songs…</p>}
              {playlistTracks.isError && <ErrorBanner>{playlistTracks.error.message}</ErrorBanner>}
              <div className="playlist-add-list grid gap-[6px] mt-[12px]">
                {playlistTracks.data?.items.map((track) => {
                  const index = playlist.entry.findIndex((item) => item.id === track.id)
                  const member = index >= 0
                  return (
                    <div
                      key={track.id}
                      className="flex items-center justify-between gap-[12px] rounded-md border border-line bg-raised px-[12px] py-[9px]"
                    >
                      <span className="grid min-w-0 gap-[3px]">
                        <strong>{track.title}</strong>
                        <small className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                          {track.artist} · {track.album}
                        </small>
                      </span>
                      <Button
                        variant={member ? 'default' : 'primary'}
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
                      </Button>
                    </div>
                  )
                })}
              </div>
              {playlistSongs.mutation.isError && (
                <ErrorBanner>{playlistSongs.mutation.error.message}</ErrorBanner>
              )}
            </section>
          )}
        </section>
      )}
      {artistId && artistDetail.isError && (
        <InlineError role="alert">
          <span>{artistDetail.error.message}</span>
          <Button onClick={() => void artistDetail.refetch()}>Retry</Button>
        </InlineError>
      )}
      {artistId && artistDetail.data && (
        <section className="library-detail grid gap-[16px]">
          <button
            type="button"
            data-ui="text-link"
            className={textLinkClassName()}
            onClick={() => changeTab('artists')}
          >
            ← Back to artists
          </button>
          <div className="library-artist-heading flex items-center gap-[16px] max-phone:flex-wrap max-phone:items-start">
            <span className="grid h-[84px] w-[84px] flex-none basis-[84px] place-items-center overflow-hidden rounded-pill bg-raised text-faint">
              {artistDetail.data.coverArt ? (
                <img
                  src={cover(artistDetail.data.coverArt)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <Disc3 />
              )}
            </span>
            <div className="flex-1">
              <h2 className="mb-[4px]">{artistDetail.data.name}</h2>
              <span>
                {artistSongsMode ? `${artistSongs.length} SONGS` : `${artistAlbums.length} ALBUMS`}
              </span>
            </div>
            <div className="button-row max-phone:w-full">
              <CollectionPlayButton
                source={`artist:${artistId}`}
                text="Play all"
                variant="primary"
                size={15}
                disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
                onPlay={() =>
                  artistSongsMode
                    ? player.playLibrary(artistSongs, 0, `artist:${artistId}`)
                    : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: false })
                }
              />
              <Button
                onClick={() =>
                  artistSongsMode
                    ? player.shuffleLibrary(artistSongs, `artist:${artistId}`)
                    : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: true })
                }
                disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
              >
                <Shuffle size={15} /> Shuffle
              </Button>
              <Button
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
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-[10px] mt-[4px] mb-[12px]">
            <label className="flex min-h-[42px] items-center gap-[7px] rounded-[8px] border border-line bg-sunken px-[10px] text-muted">
              <SlidersHorizontal size={16} />
              <select
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-[16px]"
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
            <ErrorBanner role="alert">{artistTracks.error.message}</ErrorBanner>
          )}
          {artistSongsMode && artistTracks.isLoading && <p role="status">Loading songs…</p>}
          {artistSongsMode ? (
            <TrackList tracks={artistSongs} source={`artist:${artistId}`} />
          ) : (
            <>
              <div
                className={
                  layout === 'grid'
                    ? 'library-grid grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-x-[16px] gap-y-[22px]'
                    : 'grid grid-cols-1 gap-[6px]'
                }
              >
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
              <section className="grid gap-[10px] mt-[26px]">
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
          {libraryLoadError}
          <div
            className={
              layout === 'grid'
                ? 'library-grid grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-x-[16px] gap-y-[22px]'
                : 'grid grid-cols-1 gap-[6px]'
            }
          >
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
        <div>
          {libraryLoadError}
          <div
            className={
              layout === 'grid'
                ? 'library-artist-grid grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-[12px]'
                : 'grid grid-cols-1 gap-[6px]'
            }
          >
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
        </div>
      )}
      {tab === 'tracks' && showBrowser && (
        <section className="library-detail grid gap-[16px]">
          {libraryLoadError}
          <div className="library-list-actions flex items-center gap-[4px]">
            <div className="flex flex-col gap-[6px]">
              <CollectionPlayButton
                source={trackSource}
                text="Play all"
                variant="primary"
                size={15}
                disabled={busy || !trackTotal}
                onPlay={() => playTracks.mutate({ shuffled: false })}
              />
              {trackTotal > 500 && (
                <small className="text-small text-muted">
                  Plays the first 500 of {trackTotal.toLocaleString()} matching songs.
                </small>
              )}
            </div>
            <div className="flex flex-col gap-[6px]">
              <Button
                onClick={() => playTracks.mutate({ shuffled: true })}
                disabled={busy || !trackTotal}
              >
                <Shuffle size={15} /> Shuffle
              </Button>
              {trackTotal > 500 && (
                <small className="text-small text-muted">
                  Plays a random 500 of {trackTotal.toLocaleString()} matching songs.
                </small>
              )}
            </div>
          </div>
          {/* Both buttons share one note when the whole selection fits; the per-button notes
              only differ once the 500-song queue limit splits their behaviour. */}
          {trackTotal <= 500 && (
            <small className="block text-small text-muted mt-[8px] mb-[16px]">
              Covers every matching song, not just the loaded ones.
            </small>
          )}
          {playTracks.isError && <ErrorBanner role="alert">{playTracks.error.message}</ErrorBanner>}
          <TrackList tracks={trackItems} source={trackSource} />
        </section>
      )}
      {tab === 'playlists' && showBrowser && (
        <div>
          {libraryLoadError}
          <div
            className={
              layout === 'grid'
                ? 'library-list grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-[10px]'
                : 'grid grid-cols-1 gap-[6px]'
            }
          >
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
        </div>
      )}
      {playCollection.isError && (
        <ErrorBanner role="alert">{playCollection.error.message}</ErrorBanner>
      )}
      {showBrowser &&
        !activeQuery.isLoading &&
        !activeQuery.isError &&
        currentItems.length === 0 && (
          <p className="px-[16px] py-[64px] text-center text-muted">
            No {tab === 'home' ? 'albums' : tab} found.
          </p>
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
      <EmptyPanel className="min-h-[55vh]">
        <Disc3 size={40} />
        <h1>Nothing playing yet.</h1>
        <Link data-ui="button" className={buttonClassName('primary', 'mx-auto')} to="/library">
          Open your library
        </Link>
      </EmptyPanel>
    )

  const words = lyrics.data?.items[0]?.line ?? []
  return (
    <div className="now-page">
      <section className="now-hero">
        <NowPlayingStage />
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
          <div className="button-row now-actions">
            {capabilities.data?.sonic_similarity && (
              <Button
                variant="primary"
                onClick={() => audioMuse.mutate()}
                disabled={audioMuse.isPending}
              >
                <RadioIcon size={16} />{' '}
                {audioMuse.isPending ? 'Building radio…' : 'Start AudioMuse radio'}
              </Button>
            )}
            {/* The footer's own add button is hidden on phones, so the page offers one too. */}
            <Button onClick={player.openPlaylistPicker}>
              <Plus size={16} /> Add to playlist
            </Button>
          </div>
          {audioMuse.isError && <ErrorBanner>{audioMuse.error.message}</ErrorBanner>}
        </div>
      </section>
      <div className="now-columns">
        <Panel className="queue-panel">
          <div className="section-heading">
            <h2>Up next</h2>
            <span>{player.queue.length} TRACKS</span>
          </div>
          <TrackList tracks={player.queue} source={player.source} />
        </Panel>
        <Panel className="lyrics-panel">
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
        </Panel>
      </div>
    </div>
  )
}
