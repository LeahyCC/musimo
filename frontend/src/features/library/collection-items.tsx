import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

import {
  ChevronDown,
  Disc3,
  Grid2X2,
  Heart,
  LayoutGrid,
  List,
  ListMusic,
  Pause,
  Play,
  Plus,
  Rows3,
  Shuffle,
  Trash2,
} from 'lucide-react'

import type { LibraryAlbum, LibraryArtist, LibraryPlaylist } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { Button, IconButton } from '../../ui'
import { durationText, songCount, useCollectionPlayback } from '../player/player'
import { queueActions } from '../player/queue-actions'

/** How a browse view lays its items out. Not the app's layout (Classic or Listening room). */
export type ViewMode = 'grid' | 'list'

export const cover = (coverArt?: string) =>
  coverArt ? `/api/player/art/${encodeURIComponent(coverArt)}` : ''

const albumMeta = (album: LibraryAlbum, years = album.year ? String(album.year) : '') =>
  [album.artist, years, songCount(album.songCount)].filter(Boolean).join(' · ')

// The editions sheet's rows: an art square, a name and a meta line on a sunken pill.
export const collectionRowClass =
  'group grid min-w-0 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-[12px] rounded-[8px] border border-line bg-sunken px-[10px] py-[7px] hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)] max-phone:grid-cols-[42px_minmax(0,1fr)_auto] max-phone:gap-[9px]'
export const collectionArtClass =
  'grid h-[48px] w-[48px] place-items-center overflow-hidden rounded-md bg-raised text-faint max-phone:h-[42px] max-phone:w-[42px]'
const collectionOpenClass =
  'grid min-w-0 gap-[4px] border-0 bg-none px-0 py-[8px] text-left text-inherit'
const collectionActionsClass = 'flex items-center gap-[4px] max-phone:gap-0'

/**
 * A row in a browse list. Classic joins the rows in one bordered block with a rule between them.
 * The Listening room sets them apart as soft rounded rows that light up under the pointer.
 */
const browseRowClass = (room: boolean) =>
  cx(
    'group grid min-w-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-[12px] px-[12px] py-[6px] max-phone:gap-[9px] max-phone:pr-[4px]',
    room
      ? 'rounded-[10px] hover:bg-raised focus-within:bg-raised'
      : 'border-t border-line first:border-t-0 hover:bg-sunken focus-within:bg-sunken',
  )
const browseArtClass = (round = false) =>
  cx(
    'grid h-[44px] w-[44px] place-items-center overflow-hidden bg-raised text-faint',
    round ? 'rounded-pill' : 'rounded-md',
  )

/** The box a browse list sits in. */
export function browseListClass(room: boolean) {
  return room ? 'grid gap-[2px]' : 'overflow-hidden rounded-[12px] border border-line'
}

/** Album and artist tiles, or playlist cards, flowing as many to a row as fit. */
export function browseGridClass(kind: 'album' | 'artist' | 'playlist', room: boolean) {
  if (kind === 'playlist')
    return room
      ? 'library-list grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[12px]'
      : 'library-list grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-[18px] gap-y-[24px] max-phone:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]'
  const columns = {
    album: room
      ? 'library-grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'
      : 'library-grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))]',
    artist: room
      ? 'library-artist-grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))]'
      : 'library-artist-grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))]',
  }[kind]
  return cx('grid', columns, room ? 'gap-x-[14px] gap-y-[22px]' : 'gap-x-[18px] gap-y-[24px]')
}

export function LayoutToggle({
  layout,
  onChange,
}: {
  layout: ViewMode
  onChange: (layout: ViewMode) => void
}) {
  const room = useLayout() === 'room'
  const button = cx(
    'aria-pressed:bg-active aria-pressed:text-text',
    room ? 'h-[32px] w-[32px] rounded-[8px]' : 'h-[30px] w-[30px] rounded-md',
  )
  return (
    <div
      className={cx(
        'flex bg-sunken p-[2px]',
        room ? 'rounded-[10px]' : 'rounded-[8px] border border-line',
      )}
      role="group"
      aria-label="Library layout"
    >
      <IconButton
        aria-label="Grid view"
        aria-pressed={layout === 'grid'}
        onClick={() => onChange('grid')}
        className={button}
      >
        {room ? <LayoutGrid size={15} /> : <Grid2X2 size={15} />}
      </IconButton>
      <IconButton
        aria-label="List view"
        aria-pressed={layout === 'list'}
        onClick={() => onChange('list')}
        className={button}
      >
        {room ? <Rows3 size={15} /> : <List size={15} />}
      </IconButton>
    </div>
  )
}

/** Closes a popover on a press outside it or on Escape. */
function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close()
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        close()
        event.preventDefault()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [close, open, root])
}

const optionListClass =
  'grid max-h-[260px] overflow-auto overscroll-contain border-line bg-sunken p-[8px]'

function OptionList({
  options,
  selected,
  onToggle,
}: {
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  return options.map((option) => (
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
  ))
}

/** The phone sheet's multi-select: a closed summary that opens its options in the flow of the sheet. */
export function FilterMenu({
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
  useDismiss(open, () => setOpen(false), root)

  return (
    <details
      ref={root}
      className="relative w-full min-w-[125px] rounded-[8px] border border-line bg-sunken text-muted"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-[11px] pr-[30px] pl-[12px] text-text coarse:flex coarse:min-h-11 coarse:items-center">
        {selected.length ? `${label} (${selected.length})` : `All ${label.toLowerCase()}`}
      </summary>
      <div className={cx(optionListClass, 'border-t')}>
        <OptionList options={options} selected={selected} onToggle={onToggle} />
      </div>
    </details>
  )
}

/**
 * A toolbar control that picks several values at once, which a native select cannot do. Classic
 * draws it as the same 36px "Genre Latin, Funk" chip as its selects. The Listening room draws the
 * dashed "+ Genre" pill, and the values already picked sit beside it as removable chips.
 */
export function FacetChip({
  label,
  options,
  selected,
  onToggle,
  room,
}: {
  /** "Genre" or "Year": the chip's word, and the name of its button. */
  label: string
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
  room: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false), root)
  const active = selected.length > 0

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        data-ui={room ? 'add-chip' : 'select-chip'}
        data-active={(!room && active) || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          room
            ? 'inline-flex h-[32px] items-center gap-[6px] rounded-pill border border-dashed border-line-strong bg-transparent px-[11px] text-small whitespace-nowrap text-muted hover:text-text coarse:min-h-11'
            : cx(
                'inline-flex h-[36px] max-w-[260px] items-center gap-[6px] rounded-[8px] border pr-[10px] pl-[12px] text-body whitespace-nowrap text-text coarse:min-h-11',
                active ? 'border-good-line bg-active' : 'border-line bg-sunken',
              )
        }
      >
        {room ? (
          <>
            <Plus aria-hidden="true" size={13} />
            {label}
          </>
        ) : (
          <>
            <span className="text-muted">{label}</span>
            <span className="truncate">{active ? selected.join(', ') : 'Any'}</span>
            <ChevronDown aria-hidden="true" size={14} className="flex-none" />
          </>
        )}
      </button>
      {open && (
        <div
          className={cx(
            optionListClass,
            'absolute top-[calc(100%+5px)] left-0 z-overlay min-w-[190px] rounded-[8px] border shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]',
          )}
        >
          <OptionList options={options} selected={selected} onToggle={onToggle} />
        </div>
      )}
    </div>
  )
}

/** Play turns into Pause while this exact collection owns the queue. */
export function CollectionPlayButton({
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
        'library-card-play absolute right-[8px] bottom-[8px] grid h-[36px] w-[36px] place-items-center rounded-pill border-0 bg-accent text-accent-ink shadow-[0_6px_16px_color-mix(in_oklab,var(--color-shadow)_40%,transparent)] transition-[opacity,transform] duration-[140ms] ease-in-out',
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

const editionChipClassName =
  'rounded-pill bg-canvas/93 px-[8px] py-[3px] text-micro whitespace-nowrap text-strong'

const artImage = (coverArt: string | undefined, fallback: ReactNode) =>
  coverArt ? (
    <img
      src={cover(coverArt)}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
    />
  ) : (
    fallback
  )

export function AlbumItem({
  album,
  editions = 1,
  years,
  layout,
  loading,
  onOpen,
  onPlay,
  onShuffle,
  onQueue,
}: {
  album: LibraryAlbum
  /** How many editions this card stands for; from two up it wears an "n editions" chip. */
  editions?: number
  /** The years to print, where a group of editions spans more than the album's own. */
  years?: string
  layout: ViewMode
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
  /** Queues the whole album: right after the playing track, or at the end. */
  onQueue: (upNext: boolean) => void
}) {
  const room = useLayout() === 'room'
  const openLabel = editions > 1 ? `Open ${album.name}, ${editions} editions` : `Open ${album.name}`
  const year = years ?? (album.year ? String(album.year) : '')
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
      <div className={browseRowClass(room)} data-browse-anchor={album.id}>
        <span className={browseArtClass()}>{artImage(album.coverArt, <Disc3 />)}</span>
        <button
          className={collectionOpenClass}
          aria-label={editions > 1 ? openLabel : undefined}
          onClick={onOpen}
        >
          <strong className="truncate text-body font-semibold">{album.name}</strong>
          <small className="truncate text-muted">
            {albumMeta(album, years)}
            {editions > 1 ? ` · ${editions} editions` : ''}
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
    <article className="library-card group min-w-0" data-browse-anchor={album.id}>
      <div className="relative">
        {/* Over the artwork, so it takes the page's wash to stay readable, and shows on hover or
            focus like the play button beside it. */}
        <div className="absolute top-[6px] right-[6px] z-raised rounded-pill bg-canvas/93 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100">
          {menu}
        </div>
        <button
          className={cx(
            'relative grid aspect-square w-full place-items-center overflow-hidden border border-line bg-raised p-0 text-faint transition-[filter,transform] duration-[140ms]',
            room
              ? 'rounded-[12px] group-hover:-translate-y-[2px]'
              : 'rounded-[10px] group-hover:brightness-110',
          )}
          aria-label={openLabel}
          onClick={onOpen}
        >
          {artImage(album.coverArt, <Disc3 />)}
          {room && year && (
            <span className="absolute top-[8px] left-[8px] rounded-[5px] bg-sidebar/75 px-[6px] py-[2px] font-mono text-caption text-text">
              {year}
            </span>
          )}
          {editions > 1 && (
            <span
              className={cx(editionChipClassName, 'edition-chip absolute bottom-[6px] left-[6px]')}
            >
              {editions} editions
            </span>
          )}
        </button>
        <CollectionPlayButton
          source={`album:${album.id}`}
          name={album.name}
          variant="card-play"
          size={15}
          disabled={loading}
          onPlay={onPlay}
        />
      </div>
      <button
        className="library-card-copy block w-full border-0 bg-none p-0 text-left text-inherit"
        onClick={onOpen}
      >
        <strong className="mt-[9px] block truncate text-body font-semibold">{album.name}</strong>
        <small className="mt-[2px] block truncate text-muted">
          {album.artist}
          {!room && year && ` · ${year}`}
        </small>
      </button>
    </article>
  )
}

export function ArtistItem({
  artist,
  layout,
  loading,
  onOpen,
  onPlay,
  onShuffle,
}: {
  artist: LibraryArtist
  layout: ViewMode
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
}) {
  const room = useLayout() === 'room'
  const albums = `${artist.albumCount ?? 0} ${artist.albumCount === 1 ? 'album' : 'albums'}`
  const art = artImage(artist.coverArt, <Disc3 />)

  // The grid mirrors the album card (big art, copy below, play on hover) so the two views
  // browse the same way. The art stays round so an artist never reads as an album.
  if (layout === 'grid')
    return (
      <article className="library-artist-card group min-w-0" data-browse-anchor={artist.id}>
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
            size={15}
            disabled={loading}
            onPlay={onPlay}
          />
        </div>
        <button
          className="block w-full border-0 bg-none p-0 text-center text-inherit"
          onClick={onOpen}
        >
          <strong className="mt-[10px] block truncate text-body font-semibold">
            {artist.name}
          </strong>
          <small
            className={cx('mt-[2px] block truncate text-muted', room && 'font-mono text-faint')}
          >
            {albums}
          </small>
        </button>
      </article>
    )

  return (
    <article
      className={cx('library-artist-card', browseRowClass(room))}
      data-browse-anchor={artist.id}
    >
      <span className={browseArtClass(true)}>{art}</span>
      <button className={collectionOpenClass} onClick={onOpen}>
        <strong className="truncate text-body font-semibold">{artist.name}</strong>
        <small className="truncate text-muted">{albums}</small>
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

const likedCoverClass =
  'absolute inset-0 grid place-items-center text-accent-ink bg-[linear-gradient(160deg,var(--color-accent),color-mix(in_oklab,var(--color-accent),var(--color-good-line)))]'

export function PlaylistRow({
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
  layout: ViewMode
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
  const room = useLayout() === 'room'
  // The server serves one cover per playlist, so a tile shows that cover and not a four-up mosaic.
  const art = (heart: number) => (
    <>
      {artImage(playlist.coverArt, <ListMusic size={heart} />)}
      {liked && (
        <span className={likedCoverClass}>
          <Heart size={heart} fill="currentColor" />
        </span>
      )}
    </>
  )
  const meta = [
    songCount(playlist.songCount ?? 0),
    playlist.duration ? durationText(playlist.duration) : '',
    playlist.public ? 'public' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const rowMenu = (
    <RowMenu
      label={`More actions for ${playlist.name}`}
      disabled={loading}
      actions={queueActions(
        () => onQueue(true),
        () => onQueue(false),
      )}
    />
  )
  const shuffle = (
    <IconButton
      size="box"
      aria-label={`Shuffle ${playlist.name}`}
      onClick={onShuffle}
      disabled={loading}
    >
      <Shuffle size={17} />
    </IconButton>
  )
  const remove = (className?: string) => (
    <IconButton
      size="box"
      className={className}
      aria-label={`Delete playlist ${playlist.name}`}
      onClick={onDelete}
      disabled={deleting}
    >
      <Trash2 size={16} />
    </IconButton>
  )
  const actions = (
    <div className={collectionActionsClass}>
      <CollectionPlayButton
        source={`playlist:${playlist.id}`}
        name={playlist.name}
        variant="icon"
        size={17}
        disabled={loading}
        onPlay={onPlay}
      />
      {/* The sideways card is narrow, so only Play shows until the card is hovered or focused. */}
      <span
        className={cx(
          'flex items-center',
          layout === 'grid' &&
            room &&
            'hidden group-hover:flex group-focus-within:flex no-hover:flex',
        )}
      >
        {shuffle}
        {rowMenu}
      </span>
      {!liked && (
        <span
          className={cx(
            layout === 'grid' &&
              room &&
              'hidden group-hover:block group-focus-within:block no-hover:block',
          )}
        >
          {remove(
            'opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100',
          )}
        </span>
      )}
    </div>
  )

  if (layout === 'list')
    return (
      <div
        className={cx('library-list-row', browseRowClass(room))}
        data-browse-anchor={playlist.id}
      >
        <span className={cx(browseArtClass(), 'relative')}>{art(18)}</span>
        <button className={cx('library-list-open', collectionOpenClass)} onClick={onOpen}>
          <strong className="truncate text-body font-semibold">{playlist.name}</strong>
          <small className="truncate text-muted">{meta}</small>
        </button>
        {actions}
      </div>
    )

  // The Listening room's card runs sideways: a small cover, the name, and the controls to the right.
  if (room)
    return (
      <div
        className="library-list-row group flex min-w-0 items-center gap-[12px] rounded-[16px] bg-raised p-[10px] hover:bg-hover focus-within:bg-hover"
        data-browse-anchor={playlist.id}
      >
        <span className="relative grid h-[64px] w-[64px] flex-none place-items-center overflow-hidden rounded-[10px] bg-sunken text-faint">
          {art(24)}
        </span>
        <button
          className="library-list-open grid min-w-0 flex-1 gap-[4px] border-0 bg-none p-0 text-left text-inherit"
          onClick={onOpen}
        >
          <strong className="truncate text-body font-semibold">{playlist.name}</strong>
          <small className="truncate font-mono text-faint">{meta}</small>
        </button>
        {actions}
      </div>
    )

  // Classic's card: a square cover with its controls on it, the name and meta underneath.
  return (
    <article className="library-list-row group min-w-0" data-browse-anchor={playlist.id}>
      <div className="relative">
        <button
          className="library-list-open relative grid aspect-square w-full place-items-center overflow-hidden rounded-[10px] border border-line bg-raised p-0 text-faint"
          aria-label={`Open ${playlist.name}`}
          onClick={onOpen}
        >
          {art(44)}
        </button>
        <div className="absolute top-[6px] right-[6px] z-raised flex rounded-pill bg-canvas/93 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100">
          {shuffle}
          {rowMenu}
          {!liked && remove()}
        </div>
        <CollectionPlayButton
          source={`playlist:${playlist.id}`}
          name={playlist.name}
          variant="card-play"
          size={15}
          disabled={loading}
          onPlay={onPlay}
        />
      </div>
      <button
        className="mt-[9px] block w-full border-0 bg-none p-0 text-left text-inherit"
        onClick={onOpen}
      >
        <strong className="block truncate text-body font-semibold">{playlist.name}</strong>
        <small className="mt-[2px] block truncate text-muted">{meta}</small>
      </button>
    </article>
  )
}
