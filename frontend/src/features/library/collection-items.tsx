import { useEffect, useRef, useState } from 'react'

import { Disc3, Grid2X2, Heart, List, ListMusic, Pause, Play, Shuffle, Trash2 } from 'lucide-react'

import type { LibraryAlbum, LibraryArtist, LibraryPlaylist } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { Button, IconButton } from '../../ui'
import { durationText, songCount, useCollectionPlayback } from '../player/player'
import { queueActions } from '../player/queue-actions'

export type Layout = 'grid' | 'list'

export const cover = (coverArt?: string) =>
  coverArt ? `/api/player/art/${encodeURIComponent(coverArt)}` : ''

const albumMeta = (album: LibraryAlbum, years = album.year ? String(album.year) : '') =>
  [album.artist, years, songCount(album.songCount)].filter(Boolean).join(' · ')

// Shared between the album, artist and playlist list rows: an album/artist/playlist art
// square, a name, a meta line and a trailing action cluster on a sunken pill.
export const collectionRowClass =
  'group grid min-w-0 grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-[12px] rounded-[8px] border border-line bg-sunken px-[10px] py-[7px] hover:border-[color:var(--line-hover)] focus-within:border-[color:var(--line-hover)] max-phone:grid-cols-[42px_minmax(0,1fr)_auto] max-phone:gap-[9px]'
export const collectionArtClass =
  'grid h-[48px] w-[48px] place-items-center overflow-hidden rounded-md bg-raised text-faint max-phone:h-[42px] max-phone:w-[42px]'
const collectionOpenClass =
  'grid min-w-0 gap-[4px] border-0 bg-none px-0 py-[8px] text-left text-inherit'
const collectionActionsClass = 'flex items-center gap-[4px] max-phone:gap-0'

export function LayoutToggle({
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

export function FilterMenu({
  label,
  options,
  selected,
  onToggle,
  inline = false,
}: {
  label: string
  options: string[]
  selected: string[]
  onToggle: (value: string) => void
  /** Opens in the flow of the page instead of floating over it, for use inside the phone sheet. */
  inline?: boolean
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
      className={cx(
        'relative min-w-[125px] rounded-[8px] border border-line bg-sunken text-muted max-phone:flex-1',
        inline && 'w-full',
      )}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-[11px] pr-[30px] pl-[12px] text-text coarse:flex coarse:min-h-11 coarse:items-center">
        {selected.length ? `${label} (${selected.length})` : `All ${label.toLowerCase()}`}
      </summary>
      <div
        className={cx(
          'grid max-h-[260px] overflow-auto overscroll-contain border-line bg-sunken p-[8px]',
          inline
            ? 'border-t'
            : 'absolute top-[calc(100%+5px)] left-0 z-overlay min-w-[190px] rounded-[8px] border shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)] max-phone:w-full max-phone:min-w-0',
        )}
      >
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

const editionChipClassName =
  'rounded-pill bg-canvas/93 px-[8px] py-[3px] text-micro whitespace-nowrap text-strong'

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
  layout: Layout
  loading: boolean
  onOpen: () => void
  onPlay: () => void
  onShuffle: () => void
  /** Queues the whole album: right after the playing track, or at the end. */
  onQueue: (upNext: boolean) => void
}) {
  const openLabel = editions > 1 ? `Open ${album.name}, ${editions} editions` : `Open ${album.name}`
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
        <button
          className={collectionOpenClass}
          aria-label={editions > 1 ? openLabel : undefined}
          onClick={onOpen}
        >
          <strong className="truncate">{album.name}</strong>
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
    <article className="library-card group min-w-0">
      <div className="relative">
        {/* Over the artwork, so it takes the page's wash to stay readable, and shows on hover or
            focus like the play button beside it. */}
        <div className="absolute top-[6px] right-[6px] z-raised rounded-pill bg-canvas/93 opacity-0 transition-opacity duration-[140ms] group-hover:opacity-100 group-focus-within:opacity-100 no-hover:opacity-100">
          {menu}
        </div>
        <button
          className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-[10px] border border-line bg-raised p-0 text-faint"
          aria-label={openLabel}
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
          {(years ?? (album.year ? String(album.year) : '')) && ` · ${years ?? String(album.year)}`}
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
