import {
  type Dispatch,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronUp,
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
  Search,
  Shuffle,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react'

import { AboutPanel } from './about-track'
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
  playerCapabilitiesSchema,
} from './api'
import type { LibraryAlbum, LibraryArtist, LibraryPlaylist, LibraryTrack } from './api'
import { cx } from './cx'
import { InfiniteScroll } from './infinite-scroll'
import { LyricsPanel } from './lyrics'
import { NowPlayingControls } from './now-playing-controls'
import { NowPlayingStage, useNowPlayingPopout } from './now-playing-popout'
import { pageKeyIsFree, ShortcutsDialog, usePageShortcuts } from './now-playing-shortcuts'
import { NowPlayingWash } from './now-playing-wash'
import { PageTitle } from './page-title'
import { historyTrack } from './play-history'
import {
  artUrl,
  durationText,
  queueEntryKey,
  remember,
  songCount,
  stored,
  useCollectionPlayback,
  usePlayer,
  usePlaylistSongs,
} from './player'
import { relativeTime } from './relative-time'
import { RowMenu } from './row-menu'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  Field,
  IconButton,
  InlineError,
  Panel,
  sectionCaptionClassName,
  sectionHeadingClassName,
  sectionTitleClassName,
  tabId,
  TabList,
  tabPanelId,
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
  /** A song of the open album to mark, from the About tab's "Open album" link. */
  highlightTrackId?: string
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
    { value: 'recent', label: 'Recently added' },
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
      <IconButton size="box" aria-label={label} disabled={disabled} onClick={onClick}>
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
        'library-card-play absolute right-[10px] bottom-[10px] grid h-[38px] w-[38px] place-items-center rounded-pill border-0 bg-accent text-accent-ink transition-[opacity,transform] duration-[140ms] ease-in-out',
        'group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100',
        'no-hover:translate-y-0 no-hover:opacity-100 coarse:h-11 coarse:w-11',
        playback.active ? 'translate-y-0 opacity-100' : 'translate-y-[5px] opacity-0',
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
  onQueue,
}: {
  album: LibraryAlbum
  layout: Layout
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
  /** Queues the whole album: right after the playing track, or at the end. */
  onQueue: (upNext: boolean) => void
}) {
  const menu = (
    <RowMenu
      label={`More actions for ${album.name}`}
      disabled={loading}
      actions={queueActions(
        () => onQueue(true),
        () => onQueue(false),
      )}
    />
  )
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
          <strong className="truncate">{album.name}</strong>
          <small className="truncate text-muted">{albumMeta(album)}</small>
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
            size="box"
            aria-label={`Shuffle ${album.name}`}
            onClick={onShuffle}
            disabled={loading}
          >
            <Shuffle size={17} />
          </IconButton>
          {menu}
        </div>
      </div>
    )

  return (
    <article className="library-card group min-w-0">
      <div className="relative">
        {/* Over the artwork, so it takes the page's wash to stay readable, and shows on hover or
            focus like the play button beside it. */}
        <div className="absolute top-[6px] right-[6px] z-raised rounded-pill bg-canvas/93 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100">
          {menu}
        </div>
        <button
          className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-[10px] border border-line bg-raised p-0 text-faint"
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
        <strong className="mt-[8px] block truncate">{album.name}</strong>
        <small className="mt-[4px] block truncate text-muted">
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
  const albums = `${artist.albumCount ?? 0} ${artist.albumCount === 1 ? 'album' : 'albums'}`
  const art = artist.coverArt ? (
    <img
      src={cover(artist.coverArt)}
      alt=""
      loading="lazy"
      className="h-full w-full object-cover"
    />
  ) : (
    <Disc3 />
  )

  // The grid mirrors the album card (big art, copy below, play on hover) so the two tabs
  // browse the same way. The art stays round so an artist never reads as an album.
  if (layout === 'grid')
    return (
      <article className="library-artist-card group min-w-0">
        <div className="relative">
          <button
            className="grid aspect-square w-full place-items-center overflow-hidden rounded-pill border border-line bg-raised p-0 text-faint"
            aria-label={`Open ${artist.name}`}
            onClick={onOpen}
          >
            {art}
          </button>
          <CollectionPlayButton
            source={`artist:${artist.id}`}
            name={artist.name}
            variant="card-play"
            size={19}
            disabled={loading}
            onPlay={onPlay}
          />
        </div>
        <button
          className="block w-full border-0 bg-none p-0 text-center text-inherit"
          onClick={onOpen}
        >
          <strong className="mt-[8px] block truncate">{artist.name}</strong>
          <small className="mt-[4px] block truncate text-muted">{albums}</small>
        </button>
      </article>
    )

  return (
    <article className="library-artist-card flex min-w-0 items-center gap-[10px] rounded-[9px] border border-line bg-raised p-[12px] hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)]">
      <button
        className="flex min-w-0 flex-1 items-center gap-[10px] border-0 bg-none p-0 text-left text-inherit"
        onClick={onOpen}
      >
        <span className="grid h-[52px] w-[52px] flex-none place-items-center overflow-hidden rounded-pill bg-raised text-faint">
          {art}
        </span>
        <span className="grid min-w-0">
          <strong className="truncate">{artist.name}</strong>
          <small className="truncate text-muted">{albums}</small>
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
          size="box"
          aria-label={`Shuffle ${artist.name}`}
          onClick={onShuffle}
          disabled={loading}
        >
          <Shuffle size={17} />
        </IconButton>
      </div>
    </article>
  )
}

/** The two things any song, album or playlist row can do with the queue. */
const queueActions = (playNext: () => void, addToQueue: () => void) => [
  { label: 'Play next', onSelect: playNext },
  { label: 'Add to queue', onSelect: addToQueue },
]

/** Brings the row Now Playing's About tab pointed at into view once it is on screen. */
const showRow = (row: HTMLElement | null) => row?.scrollIntoView({ block: 'center' })

function TrackList({
  tracks,
  source,
  highlightId = '',
  removing = false,
  onRemove,
}: {
  tracks: LibraryTrack[]
  source: string
  /** A song to mark as the playing one even where the queue did not start from this list. */
  highlightId?: string
  removing?: boolean
  onRemove?: (index: number) => void
}) {
  const player = usePlayer()
  const highlighted = highlightId ? tracks.findIndex((track) => track.id === highlightId) : -1
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
        const marked = current || index === highlighted
        return (
          <div
            className="library-track-row flex items-center border-b border-line"
            key={`${track.id}-${index}`}
          >
            <button
              ref={index === highlighted ? showRow : undefined}
              aria-current={marked ? 'true' : undefined}
              className={cx(
                'library-track-play grid w-full grid-cols-[34px_minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] items-center gap-[12px] rounded-md border-0 px-[12px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11 max-phone:grid-cols-[24px_minmax(0,1fr)_24px]',
                marked ? 'bg-hover' : 'bg-transparent',
              )}
              aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
              onClick={() =>
                current ? player.toggle() : player.playLibrary(tracks, index, source)
              }
            >
              <span className="text-small text-muted">{track.track ?? index + 1}</span>
              <span className="grid min-w-0 gap-[3px]">
                <strong>{track.title}</strong>
                <small className="text-small text-muted">{track.artist}</small>
              </span>
              <small className="min-w-0 text-small text-muted max-phone:hidden">
                {track.album}
              </small>
              <time className="text-small text-muted max-phone:hidden">
                {durationText(track.duration)}
              </time>
              {playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            </button>
            <RowMenu
              className="mr-[5px]"
              label={`More actions for ${track.title}`}
              actions={queueActions(
                () => player.playNext([track]),
                () => player.addToQueue([track]),
              )}
            />
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
  const tickClass = 'fill-muted text-tiny'
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
  onQueue,
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
  /** Queues the whole playlist: right after the playing track, or at the end. */
  onQueue: (upNext: boolean) => void
  onDelete: () => void
}) {
  const copy = (
    <>
      <strong className="flex items-center gap-[6px] overflow-hidden">
        {liked && <Heart size={13} fill="currentColor" className="flex-none" />}
        <span className="min-w-0 truncate">{playlist.name}</span>
      </strong>
      <small className="truncate text-muted">
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
          size="box"
          aria-label={`Shuffle ${playlist.name}`}
          onClick={onShuffle}
          disabled={loading}
        >
          <Shuffle size={17} />
        </IconButton>
        <RowMenu
          label={`More actions for ${playlist.name}`}
          disabled={loading}
          actions={queueActions(
            () => onQueue(true),
            () => onQueue(false),
          )}
        />
        {!liked && (
          <IconButton
            size="box"
            className="mr-[4px] self-center opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100"
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

async function collectionTracks(kind: Collection, id: string) {
  if (kind === 'album')
    return (await api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema)).song
  if (kind === 'playlist')
    return (await api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema))
      .entry
  return (await api(`library/artists/${encodeURIComponent(id)}/tracks`, libraryArtistTracksSchema))
    .items
}

export function LibraryPage({
  view = 'home',
  albumId = '',
  artistId = '',
  playlistId = '',
  parentArtistId = '',
  artistSection = 'albums',
  highlightTrackId = '',
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
  const [artistShow, setArtistShow] = useState('')
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
  // Albums, artists and tracks are all filtered and sorted by the server, so a filter covers
  // the whole library rather than the pages this browser has scrolled through.
  const albumSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort: sorts[tab] })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    return params.toString()
  }, [deferredQuery, selectedGenres, selectedYears, sorts, tab])
  const albums = useInfiniteQuery({
    queryKey: ['library-albums', albumSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/albums?${albumSearch}&offset=${pageParam}&size=60`, libraryAlbumsSchema, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: ready && (tab === 'home' || tab === 'albums'),
  })
  const artistSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort: sorts.artists })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    if (artistShow) params.set('show', artistShow)
    return params.toString()
  }, [artistShow, deferredQuery, selectedGenres, selectedYears, sorts])
  const artists = useInfiniteQuery({
    queryKey: ['library-artists', artistSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/artists?${artistSearch}&offset=${pageParam}&size=100`, libraryArtistsSchema, {
        signal,
      }),
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
  const favouriteArtist = useMutation({
    mutationFn: ({ id, favourite }: { id: string; favourite: boolean }) =>
      api(`library/artists/${encodeURIComponent(id)}/favourite`, emptySchema, {
        method: favourite ? 'PUT' : 'DELETE',
      }),
    onSuccess: (_, { id }) => {
      void client.invalidateQueries({ queryKey: ['library-artist', id] })
      void client.invalidateQueries({ queryKey: ['library-artists'] })
    },
  })
  const playCollection = useMutation({
    mutationFn: ({ kind, id }: { kind: Collection; id: string; shuffled: boolean }) =>
      collectionTracks(kind, id),
    onSuccess: (items, { kind, id, shuffled }) => {
      const source = `${kind}:${id}`
      if (shuffled) player.shuffleLibrary(items, source)
      else player.playLibrary(items, 0, source)
    },
  })
  // An album or playlist card has not loaded its songs, so queueing one reads them first.
  const queueCollection = useMutation({
    mutationFn: ({ kind, id }: { kind: 'album' | 'playlist'; id: string; upNext: boolean }) =>
      collectionTracks(kind, id),
    onSuccess: (items, { upNext }) => {
      if (upNext) player.playNext(items)
      else player.addToQueue(items)
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

  const albumItems = useMemo(
    () => albums.data?.pages.flatMap((page) => page.items) ?? [],
    [albums.data],
  )
  const albumTotal = albums.data?.pages[0]?.total ?? 0
  const artistItems = useMemo(
    () => artists.data?.pages.flatMap((page) => page.items) ?? [],
    [artists.data],
  )
  const artistTotal = artists.data?.pages[0]?.total ?? 0
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

  // Each tab's first page carries the whole library's filter choices.
  const facets =
    tab === 'tracks'
      ? tracks.data?.pages[0]
      : tab === 'artists'
        ? artists.data?.pages[0]
        : albums.data?.pages[0]
  const genres = facets?.genres ?? []
  const years = (facets?.years ?? []).map(String)
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
    queueCollection.isPending ||
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
    setArtistShow('')
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
      <EmptyPanel tall>
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
      <PageTitle eyebrow="YOUR MUSIC, READY TO PLAY" title="Library">
        <Tag role="status">
          {/* Both labels share one cell so the tag keeps its width while the busy one shows. */}
          <span className="grid">
            <span className="[grid-area:1/1]" style={{ visibility: busy ? 'hidden' : undefined }}>
              NAVIDROME READY
            </span>
            {busy && <span className="[grid-area:1/1]">Opening music…</span>}
          </span>
        </Tag>
      </PageTitle>
      <nav
        className="flex gap-[6px] overflow-x-auto border-b border-line mb-[28px] max-phone:mb-[20px] max-phone:gap-0 max-phone:overflow-visible"
        aria-label="Library views"
      >
        {(['home', 'albums', 'artists', 'tracks', 'playlists'] as Tab[]).map((item) => (
          <button
            data-ui="tab"
            className={cx(
              'border-0 border-b-2 bg-none px-[14px] py-[11px] capitalize coarse:min-h-11 max-phone:min-w-0 max-phone:flex-1 max-phone:px-[2px] max-phone:py-[12px] max-phone:text-body max-phone:text-center',
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
          <label className="flex w-[min(420px,100%)] items-center rounded-[8px] border border-line bg-sunken px-[12px] text-muted">
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
              className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-base"
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
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-base"
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
          {tab === 'artists' && (
            <label className="flex min-h-[42px] items-center gap-[7px] rounded-[8px] border border-line bg-sunken px-[10px] text-muted">
              <select
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-base"
                aria-label="Show artists"
                value={artistShow}
                onChange={(event) => setArtistShow(event.target.value)}
              >
                <option value="">All artists</option>
                <option value="favourites">Favourites</option>
                <option value="played">Played</option>
                <option value="unplayed">Never played</option>
              </select>
            </label>
          )}
          {(tab === 'home' || tab === 'albums' || tab === 'artists' || tab === 'tracks') && (
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
              {(selectedGenres.length > 0 || selectedYears.length > 0 || artistShow) && (
                <button
                  type="button"
                  data-ui="text-link"
                  className={textLinkClassName('px-[5px] py-[9px]')}
                  onClick={() => {
                    setSelectedGenres([])
                    setSelectedYears([])
                    setArtistShow('')
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
                : tab === 'artists'
                  ? `${artistItems.length} of ${artistTotal} loaded`
                  : tab === 'playlists'
                    ? `${currentItems.length} loaded`
                    : `${albumItems.length} of ${albumTotal} loaded`}
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
          <div className={sectionHeadingClassName}>
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
              <h2 className="flex items-center gap-[8px] text-base">
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
            <div className="flex flex-wrap items-center gap-[16px]">
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
              <RowMenu
                label={`More actions for ${detailTitle}`}
                disabled={!detailTracks.length}
                actions={queueActions(
                  () => player.playNext(detailTracks),
                  () => player.addToQueue(detailTracks),
                )}
              />
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
            highlightId={albumId ? highlightTrackId : ''}
            removing={Boolean(playlist) && playlistSongs.busy(playlist?.id ?? '')}
            onRemove={
              playlist
                ? (index) => playlistSongs.mutation.mutate({ playlistId: playlist.id, index })
                : undefined
            }
          />
          {playlist && (
            <section className="border-t border-line pt-[12px]">
              <div className={sectionHeadingClassName}>
                <h3>Add songs</h3>
                <span className={sectionCaptionClassName}>Search your library</span>
              </div>
              <label className="flex w-[min(420px,100%)] items-center rounded-[8px] border border-line bg-sunken px-[12px] text-muted">
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
                        <small className="truncate text-muted">
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
                {(artistSongsMode
                  ? songCount(artistSongs.length)
                  : `${artistAlbums.length} ${artistAlbums.length === 1 ? 'album' : 'albums'}`
                ).toUpperCase()}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-[16px] max-phone:w-full">
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
                aria-pressed={Boolean(artistDetail.data.starred)}
                disabled={favouriteArtist.isPending}
                onClick={() =>
                  favouriteArtist.mutate({
                    id: artistId,
                    favourite: !artistDetail.data?.starred,
                  })
                }
              >
                <Star size={15} fill={artistDetail.data.starred ? 'currentColor' : 'none'} />{' '}
                {artistDetail.data.starred ? 'Favourite' : 'Add to favourites'}
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
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-base"
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
                    onQueue={(upNext) =>
                      queueCollection.mutate({ kind: 'album', id: album.id, upNext })
                    }
                  />
                ))}
              </div>
              <section className="grid gap-[10px] mt-[26px]">
                <div className={sectionHeadingClassName}>
                  <h3>Popularity</h3>
                  <span className={sectionCaptionClassName}>
                    Navidrome play counts by release year
                  </span>
                </div>
                <PopularityChart albums={artistDetail.data.album} />
              </section>
            </>
          )}
        </section>
      )}
      {(tab === 'home' || tab === 'albums') && showBrowser && (
        <section>
          <div className={sectionHeadingClassName}>
            <h2 className={sectionTitleClassName}>
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
                onQueue={(upNext) =>
                  queueCollection.mutate({ kind: 'album', id: album.id, upNext })
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
                ? 'library-artist-grid grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-x-[16px] gap-y-[22px]'
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
                onQueue={(upNext) =>
                  queueCollection.mutate({ kind: 'playlist', id: item.id, upNext })
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
      {queueCollection.isError && (
        <ErrorBanner role="alert">{queueCollection.error.message}</ErrorBanner>
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

const lyricLineClassName = 'py-[8px] text-section text-text'

/* Up next, Lyrics, About and History share one panel, so none starts below the fold and Lyrics is
   a tap away however long the queue is. */
const PANEL_TABS = [
  { id: 'up-next', label: 'Up next' },
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'about', label: 'About' },
  { id: 'history', label: 'History' },
] as const
type PanelTab = (typeof PANEL_TABS)[number]['id']
const PANEL_TAB_KEY = 'musimo.now-playing-tab'
/** Where a history row starts its track, so Up next can say what the queue came from. */
const HISTORY_SOURCE = 'history'
/* The panel scrolls inside itself beside the stage. On a phone the page is what scrolls, so the
   panel just grows. */
const tabPanelClassName =
  'min-h-0 flex-1 overflow-auto overscroll-contain max-phone:overflow-visible'

/**
 * What the queue was started from, worded for after "Playing from", or an empty string where the
 * player does not know (a restored queue) or the name has not arrived yet. The player keeps only
 * an id such as `playlist:abc`, so the name comes from the reads the library pages already make
 * and share through the query cache.
 */
function usePlayingFrom(source: string) {
  const split = source.indexOf(':')
  const kind = split < 0 ? source : source.slice(0, split)
  const id = split < 0 ? '' : source.slice(split + 1)
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: kind === 'playlist',
  })
  const album = useQuery({
    queryKey: ['library-album', id],
    queryFn: ({ signal }) =>
      api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema, { signal }),
    enabled: kind === 'album',
  })
  const artist = useQuery({
    queryKey: ['library-artist', id],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(id)}`, libraryArtistDetailSchema, { signal }),
    enabled: kind === 'artist',
  })
  if (kind === 'playlist') {
    const name = playlists.data?.items.find((item) => item.id === id)?.name
    return name ? `playlist ${name}` : ''
  }
  if (kind === 'queue') return 'your queue'
  if (kind === HISTORY_SOURCE) return 'your history'
  if (kind === 'album') return album.data ? `album ${album.data.name}` : ''
  if (kind === 'artist') return artist.data ? `artist ${artist.data.name}` : ''
  if (kind === 'tracks') {
    // The rest of the id is the Tracks view's own query string; only the search is worth saying.
    const search = new URLSearchParams(id).get('q')
    return search ? `tracks matching "${search}"` : 'your tracks'
  }
  return ''
}

/** Where a dragged Up next row would land: the gap before row `slot`, counted in the whole queue. */
type QueueDrag = { from: number; slot: number }

// A drag this close to the panel's top or bottom edge scrolls it, so a long queue can be reached.
const DRAG_EDGE = 36
const DRAG_STEP = 14

/**
 * Up next: what follows the playing track, and the ways to change it. A row is dragged by its
 * handle, and the same move is on the keyboard as Alt with an arrow key on the row, or as the
 * move buttons. Each change is announced, since a reordered list looks the same to a screen reader.
 */
function UpNext() {
  const player = usePlayer()
  const client = useQueryClient()
  const list = useRef<HTMLDivElement>(null)
  const focusAfter = useRef<{ key: string; control: string } | null>(null)
  const dragging = useRef<QueueDrag | null>(null)
  const [drag, setDrag] = useState<QueueDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const playingFrom = usePlayingFrom(player.source)
  // Up next is what comes after the playing track, so the track itself is never its first row.
  const following = player.currentIndex + 1
  const upcoming = player.queue.slice(following)
  const savePlaylist = useMutation({
    mutationFn: (playlistName: string) =>
      api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playlistName, song_ids: player.queue.map((item) => item.id) }),
      }),
    onSuccess: (playlist) => {
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      setAnnouncement(`Saved ${songCount(player.queue.length)} as playlist ${playlist.name}.`)
      setNaming(false)
      setName('')
    },
  })

  // A change can move the row that had focus, or remove it. Put focus back on that control, or on
  // the panel when there is nothing left to hold it, so the keyboard never starts again from the top.
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    const row = list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(target.key)}"]`)
    const control =
      row?.querySelector<HTMLElement>(`[data-control="${target.control}"]:not(:disabled)`) ??
      row?.querySelector<HTMLElement>('[data-control="play"]')
    const panel = list.current?.closest<HTMLElement>('[role="tabpanel"]')
    ;(control ?? panel)?.focus()
  }, [player.queue])

  useEffect(() => {
    if (!drag) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') updateDrag(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [drag !== null])

  function updateDrag(next: QueueDrag | null) {
    dragging.current = next
    setDrag(next)
  }

  /** `control` is the button to hand focus back to; a drag by pointer leaves focus alone. */
  function moveTo(from: number, to: number, control?: string) {
    const track = player.queue[from]
    if (!track || to < following || to >= player.queue.length || to === from) return
    if (control) focusAfter.current = { key: queueEntryKey(track), control }
    player.moveInQueue(from, to)
    setAnnouncement(`Moved ${track.title} to position ${to - following + 1} of ${upcoming.length}.`)
  }

  function remove(index: number) {
    const track = player.queue[index]
    if (!track) return
    const neighbour =
      player.queue[index + 1] ?? (index > following ? player.queue[index - 1] : undefined)
    focusAfter.current = { key: neighbour ? queueEntryKey(neighbour) : '', control: 'remove' }
    player.removeFromQueue(index)
    setAnnouncement(`Removed ${track.title}. ${songCount(upcoming.length - 1)} up next.`)
  }

  function clear() {
    focusAfter.current = { key: '', control: '' }
    player.clearQueue()
    setAnnouncement(`Cleared the queue. ${songCount(upcoming.length)} removed.`)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed) savePlaylist.mutate(trimmed)
  }

  // The gap the pointer is over: before the first row whose middle is below it, else the end.
  function slotAt(clientY: number) {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-queue-index]') ?? [])
    const before = rows.find((row) => {
      const box = row.getBoundingClientRect()
      return clientY < box.top + box.height / 2
    })
    return before ? Number(before.dataset.queueIndex) : player.queue.length
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>, index: number) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    updateDrag({ from: index, slot: index })
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const current = dragging.current
    if (!current) return
    const panel = list.current?.closest<HTMLElement>('[role="tabpanel"]')
    if (panel) {
      const box = panel.getBoundingClientRect()
      if (event.clientY < box.top + DRAG_EDGE) panel.scrollBy({ top: -DRAG_STEP })
      else if (event.clientY > box.bottom - DRAG_EDGE) panel.scrollBy({ top: DRAG_STEP })
    }
    const slot = slotAt(event.clientY)
    if (slot !== current.slot) updateDrag({ ...current, slot })
  }

  function endDrag() {
    const current = dragging.current
    updateDrag(null)
    if (!current) return
    // Dropping into the gap after the row itself, or the gap before it, changes nothing. Past it,
    // the row's own removal shifts the gap up by one.
    moveTo(current.from, current.slot > current.from ? current.slot - 1 : current.slot)
  }

  return (
    <>
      <div className="mb-[8px] flex items-baseline justify-between gap-[12px]">
        <p className="min-w-0 truncate text-small">
          {playingFrom && (
            <>
              Playing from <span className="text-text">{playingFrom}</span>
            </>
          )}
        </p>
        <span className={cx(sectionCaptionClassName, 'shrink-0')}>
          {player.queue.length} {player.queue.length === 1 ? 'TRACK' : 'TRACKS'}
        </span>
      </div>
      <div className="mb-[8px] flex flex-wrap items-center gap-[8px]">
        <Button onClick={clear} disabled={!upcoming.length}>
          <Trash2 size={15} /> Clear queue
        </Button>
        <Button
          aria-expanded={naming}
          disabled={!player.queue.length}
          onClick={() => setNaming(!naming)}
        >
          <ListMusic size={15} /> Save as playlist
        </Button>
      </div>
      {naming && (
        <form
          className="mb-[10px] flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-sunken p-[12px]"
          onSubmit={submit}
        >
          <label className="grid min-w-[min(200px,100%)] flex-1 gap-[6px] text-small text-muted">
            Playlist name
            <Field
              autoFocus
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={savePlaylist.isPending || !name.trim()}>
            {savePlaylist.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" onClick={() => setNaming(false)}>
            Cancel
          </Button>
          {savePlaylist.isError && (
            <ErrorBanner className="m-0 w-full" role="alert">
              {savePlaylist.error.message}
            </ErrorBanner>
          )}
        </form>
      )}
      <div ref={list}>
        {upcoming.length ? (
          upcoming.map((track, position) => {
            const index = following + position
            const key = queueEntryKey(track)
            const last = index === player.queue.length - 1
            return (
              <div
                key={key}
                data-entry={key}
                data-queue-index={index}
                className={cx(
                  'flex items-center gap-[2px] border-b border-line',
                  drag?.from === index && 'opacity-50',
                  // A line where the row would land: above this row, or below the last one.
                  drag?.slot === index && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
                  last &&
                    drag?.slot === player.queue.length &&
                    'shadow-[inset_0_-2px_0_0_var(--color-accent)]',
                )}
              >
                {/* Pointer only. The keyboard moves a row with the buttons or Alt and an arrow. */}
                <span
                  aria-hidden="true"
                  className="grid w-[22px] flex-none cursor-grab touch-none place-items-center self-stretch text-faint select-none hover:text-muted active:cursor-grabbing coarse:w-[28px]"
                  onPointerDown={(event) => startDrag(event, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => updateDrag(null)}
                >
                  ⠿
                </span>
                <button
                  type="button"
                  data-control="play"
                  className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-[12px] rounded-md border-0 bg-transparent px-[8px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11"
                  aria-label={`Play ${track.title}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => player.playLibrary(player.queue, index, player.source)}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
                      return
                    event.preventDefault()
                    moveTo(index, index + (event.key === 'ArrowUp' ? -1 : 1), 'play')
                  }}
                >
                  <span className="grid min-w-0 gap-[3px]">
                    <strong className="truncate">{track.title}</strong>
                    <small className="truncate text-small text-muted">{track.artist}</small>
                  </span>
                  <time className="text-small text-muted max-phone:hidden">
                    {durationText(track.duration)}
                  </time>
                </button>
                <IconButton
                  data-control="up"
                  size="compact"
                  aria-label={`Move ${track.title} up`}
                  disabled={position === 0}
                  onClick={() => moveTo(index, index - 1, 'up')}
                >
                  <ChevronUp size={16} />
                </IconButton>
                <IconButton
                  data-control="down"
                  size="compact"
                  aria-label={`Move ${track.title} down`}
                  disabled={last}
                  onClick={() => moveTo(index, index + 1, 'down')}
                >
                  <ChevronDown size={16} />
                </IconButton>
                <IconButton
                  data-control="remove"
                  size="compact"
                  aria-label={`Remove ${track.title} from the queue`}
                  onClick={() => remove(index)}
                >
                  <X size={16} />
                </IconButton>
              </div>
            )
          })
        ) : (
          <p className={lyricLineClassName}>Nothing else is queued.</p>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </>
  )
}

// The times are relative, so they are worked out again each minute the panel is on show.
const HISTORY_TICK = 60_000

/** What this browser has played, newest first. A row plays the track again. */
function History({ visible }: { visible: boolean }) {
  const player = usePlayer()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), HISTORY_TICK)
    return () => window.clearInterval(timer)
  }, [visible])

  function clear() {
    if (window.confirm('Clear your play history? This cannot be undone.')) player.clearHistory()
  }

  return (
    <>
      <div className="mb-[8px] flex flex-wrap items-center justify-between gap-[8px]">
        <Button onClick={clear} disabled={!player.history.length}>
          <Trash2 size={15} /> Clear history
        </Button>
        <span className={cx(sectionCaptionClassName, 'shrink-0')}>
          {player.history.length} {player.history.length === 1 ? 'TRACK' : 'TRACKS'}
        </span>
      </div>
      {player.history.length ? (
        player.history.map((entry) => {
          const track = historyTrack(entry)
          return (
            <div
              key={`${entry.playedAt}-${entry.id}`}
              className="flex items-center gap-[2px] border-b border-line"
            >
              <button
                type="button"
                className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-[12px] rounded-md border-0 bg-transparent px-[8px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11"
                aria-label={`Play ${entry.title}`}
                onClick={() => {
                  // With a queue loaded, the song slots in after the playing one and plays, so
                  // looking back three songs does not throw away everything that was lined up.
                  if (player.libraryTrack) {
                    player.playNext([track])
                    player.next()
                  } else player.playLibrary([track], 0, HISTORY_SOURCE)
                }}
              >
                <span className="grid min-w-0 gap-[3px]">
                  <strong className="truncate">{entry.title}</strong>
                  <small className="truncate text-small text-muted">{entry.artist}</small>
                </span>
                <time
                  className="text-small text-muted"
                  dateTime={new Date(entry.playedAt).toISOString()}
                >
                  {relativeTime(entry.playedAt, now)}
                </time>
              </button>
              <RowMenu
                className="mr-[5px]"
                label={`More actions for ${entry.title}`}
                actions={queueActions(
                  () => player.playNext([track]),
                  () => player.addToQueue([track]),
                )}
              />
            </div>
          )
        })
      ) : (
        <p className={lyricLineClassName}>Nothing played yet.</p>
      )}
    </>
  )
}

// Up next, Lyrics, About and History in one panel that fills the column beside the stage, or a
// screen's height of its own under a large stage. `className` sets which.
function NowPlayingTabs({
  track,
  className,
  lyricsView,
  onLyricsView,
}: {
  track: LibraryTrack
  className?: string
  /** Whether the lyrics view (large type) is open. The page owns it, to hide itself beneath it. */
  lyricsView: boolean
  onLyricsView: Dispatch<SetStateAction<boolean>>
}) {
  const idBase = useId()
  const [tab, setTab] = useState<PanelTab>(() => {
    const saved = stored(PANEL_TAB_KEY, 'up-next')
    return PANEL_TABS.find((item) => item.id === saved)?.id ?? 'up-next'
  })
  const choose = (next: PanelTab) => {
    setTab(next)
    remember(PANEL_TAB_KEY, next)
  }
  const toggleLarge = useCallback(() => onLyricsView((on) => !on), [onLyricsView])

  // L opens the lyrics view, and closes it. From the other tab it opens Lyrics and the view, so the
  // key always shows something; the view's own Escape is in `lyrics.tsx`. Q goes to Up next, and
  // closes the view. Typing in a field keeps its own letters, and so does an open dialog, the
  // command palette included. A full screen stage has the whole screen, so L leaves it alone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const letter = event.key.toLowerCase()
      if ((letter !== 'l' && letter !== 'q') || event.repeat) return
      if (document.fullscreenElement || !pageKeyIsFree(event)) return
      if (letter === 'q') {
        if (tab === 'up-next') return
        setTab('up-next')
        remember(PANEL_TAB_KEY, 'up-next')
        onLyricsView(false)
      } else if (tab === 'lyrics') onLyricsView((on) => !on)
      else {
        setTab('lyrics')
        remember(PANEL_TAB_KEY, 'lyrics')
        onLyricsView(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, onLyricsView])

  return (
    <Panel className={cx('flex min-w-0 flex-col', className)}>
      <TabList
        label="Now Playing panel"
        idBase={idBase}
        tabs={PANEL_TABS}
        value={tab}
        onChange={choose}
        className="mb-[14px]"
      />
      {/* Both panels stay in the document, so every tab's `aria-controls` names something that
          exists; the one not chosen is hidden. */}
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'up-next')}
        aria-labelledby={tabId(idBase, 'up-next')}
        // A box that scrolls has to be reachable from the keyboard.
        tabIndex={0}
        hidden={tab !== 'up-next'}
        className={tabPanelClassName}
      >
        <UpNext />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'lyrics')}
        aria-labelledby={tabId(idBase, 'lyrics')}
        hidden={tab !== 'lyrics'}
        className="min-h-0 flex-1"
      >
        {/* The lines scroll in a box of their own inside the panel, so the timing controls stay in
            view; the box is what takes focus. */}
        <LyricsPanel
          key={track.id}
          track={track}
          visible={tab === 'lyrics'}
          large={lyricsView}
          onToggleLarge={toggleLarge}
        />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'about')}
        aria-labelledby={tabId(idBase, 'about')}
        tabIndex={0}
        hidden={tab !== 'about'}
        className={tabPanelClassName}
      >
        <AboutPanel key={track.id} track={track} visible={tab === 'about'} />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'history')}
        aria-labelledby={tabId(idBase, 'history')}
        tabIndex={0}
        hidden={tab !== 'history'}
        className={tabPanelClassName}
      >
        <History visible={tab === 'history'} />
      </div>
    </Panel>
  )
}

// What the window leaves under the top bar and the page's own padding (see `--page-pad` below).
const nowPlayingScreenClassName =
  'h-[calc(100dvh_-_var(--topbar-height)_-_var(--safe-top)_-_var(--page-pad))]'

export function NowPlayingPage() {
  const player = usePlayer()
  const popout = useNowPlayingPopout()
  const track = player.libraryTrack
  const [help, setHelp] = useState(false)
  const openHelp = useCallback(() => setHelp(true), [])
  const closeHelp = useCallback(() => setHelp(false), [])
  // The lyrics view takes over the content area. It lives here because the page hides its two
  // columns under it. Not remembered, and gone with the track.
  const [lyricsView, setLyricsView] = useState(false)
  const hasTrack = Boolean(track)
  useEffect(() => {
    if (!hasTrack) setLyricsView(false)
  }, [hasTrack])
  // A phone has one layout, so the choice is kept but not applied there, and S is not offered.
  const large = popout.size === 'large' && !popout.phone
  usePageShortcuts({
    enabled: Boolean(track),
    stage: popout.dockedStage,
    onHelp: openHelp,
    onSize: popout.phone ? undefined : popout.toggleSize,
  })
  if (!track)
    return (
      <EmptyPanel tall>
        <Disc3 size={40} />
        {/* A catalog preview can never reach the stage: its audio has no CORS headers, so the
            visualizer cannot read it. Say so rather than claim nothing is playing. */}
        {player.track ? (
          <>
            <h1>A preview is playing.</h1>
            <p className="text-muted">
              Now Playing and its visuals play with tracks from your library.
            </p>
          </>
        ) : (
          <h1>Nothing playing yet.</h1>
        )}
        <Link data-ui="button" className={buttonClassName('primary', 'mx-auto')} to="/library">
          Open your library
        </Link>
      </EmptyPanel>
    )

  // Two columns that together fit the window under the top bar: the stage and its controls on
  // the left, one tabbed panel on the right that scrolls inside itself. `main` pads its bottom by
  // 130px to clear the footer player, which this page hides, so the columns take back all but
  // 24px of it. A phone stacks them and lets the page scroll.
  //
  // A large stage stacks them too, but keeps a window's height for the stage and its controls, so
  // the stage takes what is left above them, and the panel gets a window's height of its own to
  // scroll in. The page scrolls to reach it. Only classes differ from the small layout, so the
  // stage is not remounted and its visualizer keeps running through the switch.
  return (
    <div
      className={cx(
        '-mb-[106px] grid gap-x-[40px] gap-y-[24px] [--page-pad:60px] wide:[--page-pad:72px] max-phone:mb-0 max-phone:h-auto max-phone:grid-cols-1 max-phone:grid-rows-none',
        large
          ? 'grid-cols-1'
          : cx(
              nowPlayingScreenClassName,
              'grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]',
            ),
      )}
    >
      <NowPlayingWash art={artUrl(track)} />
      {/* Under the lyrics view the columns stay laid out, so the page is where it was on return,
          but `invisible` takes them out of sight, the tab order, the pointer and the accessibility
          tree. The wash is left showing through the view. */}
      <div
        className={cx(
          'flex min-w-0 flex-col gap-[16px]',
          large ? cx(nowPlayingScreenClassName, 'min-h-[520px]') : 'min-h-0',
          lyricsView && 'invisible',
        )}
      >
        <NowPlayingStage />
        <NowPlayingControls track={track} />
      </div>
      <NowPlayingTabs
        track={track}
        lyricsView={lyricsView}
        onLyricsView={setLyricsView}
        className={cx(
          large ? cx(nowPlayingScreenClassName, 'min-h-[420px]') : 'min-h-0',
          lyricsView && 'invisible',
        )}
      />
      <ShortcutsDialog open={help} onClose={closeHelp} />
    </div>
  )
}
