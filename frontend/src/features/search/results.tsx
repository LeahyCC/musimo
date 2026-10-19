import { useEffect, useRef, useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  CircleDashed,
  Clock,
  Copy,
  Disc3,
  Pause,
  Play,
} from 'lucide-react'

import { albumSchema, api } from '../../api'
import type { DownloadJob, MusicResult } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { Ownership, textLinkClassName } from '../../ui'
import { AlbumDownloadButton } from '../downloads/album-download'
import { DownloadButton } from '../downloads/download-button'
import { DownloadTarget } from '../downloads/download-target'
import { failureMessage, useJobs } from '../downloads/jobs'
import { resolvedDeezerId } from '../downloads/spotify-download'
import { catalogAction, isDeezerTrack, toQueueTrack } from '../player/account-play'
import { durationText, usePlayer, usePreviewPlayback } from '../player/player'
import { queueActions } from '../player/queue-actions'
import { ownedFraction, ownedShare } from './coverage'
import { resultKey } from './result-key'
import { getLastSearch } from './search-params'
import type { SearchState } from './search-params'

/* A result section's heading row sits a little tighter than the shared one in `ui/`, and its
   title keeps a gap under it where a count or link wraps below. */
export const resultsHeadingClassName = 'mb-[17px] flex items-center justify-between gap-[12px]'
export const resultsTitleClassName = 'mb-[12px] text-base'

const backClassName =
  'inline-flex h-[32px] items-center gap-[6px] rounded-[8px] bg-transparent py-0 pr-[10px] pl-[6px] -ml-[6px] mb-[16px] text-body text-muted hover:bg-raised hover:text-text coarse:min-h-11'

/** The way back to the last search, or to `fallback` for a visit that did not come from one. */
export function BackToSearch({ fallback }: { fallback?: SearchState }) {
  const navigate = useNavigate()
  const lastSearch = getLastSearch()
  const target = lastSearch?.q ? lastSearch : fallback
  if (!target) return null
  return (
    <button
      type="button"
      data-ui="back-link"
      className={backClassName}
      onClick={() => void navigate({ to: '/search', search: target })}
    >
      <ChevronLeft size={16} aria-hidden="true" />
      Back to results
    </button>
  )
}

type BadgeState = {
  variant: 'owned' | 'partial' | 'failed' | 'missing'
  label: string
  icon: typeof Check | null
}

/** What a row or card says about its place in the library, and the icon that goes with it. */
function badgeState(item: MusicResult, job?: DownloadJob): BadgeState {
  const failed =
    item.ownership !== 'owned' && item.ownership !== 'edition' && job?.stage === 'failed'
  if (failed) return { variant: 'failed', label: 'Download failed', icon: AlertCircle }
  if (item.kind === 'album')
    return {
      variant: item.ownership === 'edition' ? 'partial' : item.ownership,
      label:
        item.track_count > 0
          ? `${item.owned_count} of ${item.track_count}${item.coverage_verified ? '' : ' estimated'}`
          : 'Checking coverage…',
      icon: item.ownership === 'owned' || item.ownership === 'edition' ? Check : null,
    }
  if (item.ownership === 'owned') return { variant: 'owned', label: 'In library', icon: Check }
  if (item.ownership === 'edition') {
    const label = item.matched_album
      ? `Another edition in library (${item.matched_album})`
      : 'Another edition in library'
    return { variant: 'partial', label, icon: Copy }
  }
  // The file was downloaded but the library index has no match for it now, so it is not green.
  if (job?.stage === 'done') return { variant: 'missing', label: 'Downloaded earlier', icon: null }
  if (job?.stage === 'retry_wait')
    return { variant: 'missing', label: 'Retry scheduled', icon: Clock }
  if (job) {
    const label = job.stage.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
    return { variant: 'missing', label, icon: Clock }
  }
  return { variant: 'missing', label: 'Not in library', icon: CircleDashed }
}

const dotClassNames = {
  owned: 'bg-accent',
  partial: 'bg-partial',
  failed: 'bg-danger',
  missing: 'bg-faint',
}
const roomTextClassNames = {
  owned: 'text-accent',
  partial: 'text-partial',
  failed: 'text-danger',
  missing: 'text-muted',
}

export function Badge({
  item,
  job,
  className,
}: {
  item: MusicResult
  job?: DownloadJob
  className?: string
}) {
  const layout = useLayout()
  if (item.kind === 'artist') return null
  const state = badgeState(item, job)
  const failed = state.variant === 'failed'
  const editionLabel = item.matched_album
    ? `Another edition in library (${item.matched_album})`
    : 'Another edition in library'
  const title = failed
    ? job?.error_hint || (job ? failureMessage(job) : '')
    : item.ownership === 'edition'
      ? `${editionLabel}\n${item.matched_paths.join('\n')}`
      : item.matched_paths.join('\n') ||
        (item.kind === 'album' && !item.coverage_verified
          ? 'Coverage is still being checked against the library index.'
          : 'No matching file in the current library index')
  const Icon = state.icon
  // The Listening room names the state with a dot and plain words, with no chip behind it.
  if (layout === 'room')
    return (
      <span
        data-ui="ownership"
        data-variant={state.variant}
        title={title}
        className={cx(
          'inline-flex w-fit items-center gap-[6px] whitespace-nowrap text-small',
          roomTextClassNames[state.variant],
          className,
        )}
      >
        <i
          aria-hidden="true"
          className={cx('size-[7px] rounded-pill', dotClassNames[state.variant])}
        />
        {state.label}
      </span>
    )
  return (
    <Ownership variant={state.variant} className={className} title={title}>
      {Icon && <Icon size={12} />}
      {state.label}
    </Ownership>
  )
}

function useRowAction(item: MusicResult) {
  const player = usePlayer()
  const playingPreview = usePreviewPlayback(item.id, item.spotify_id).playing
  const playingAccount = Boolean(
    player.playing &&
    player.libraryTrack?.origin === 'deezer' &&
    player.libraryTrack.deezerId === item.id,
  )
  const action = catalogAction({
    item,
    playingPreview,
    playingAccount,
    fetching: player.fetchingId === item.id,
    previewState: player.previewState(item.id, item.spotify_id),
    listen: player.listen,
  })
  const press = () => {
    if (action.press === 'cancel') player.cancelFetch()
    else if (action.press === 'play') player.playCatalog(item)
    else if (action.press === 'preview') player.play(item)
  }
  return { action, press, playing: playingPreview || playingAccount }
}

export function Art({
  item,
  size = 'card',
  className,
  rounded = 'rounded-[7px]',
}: {
  item: MusicResult
  size?: 'card' | 'row'
  className?: string
  /** The corner radius class, for a hero cover that wants more than a card's. */
  rounded?: string
}) {
  const { action, press, playing } = useRowAction(item)
  const label = `${action.label} ${item.title}`
  return (
    <div
      className={cx(
        'group relative isolate flex shrink-0 items-center justify-center overflow-hidden bg-active',
        item.kind === 'artist' ? 'rounded-pill' : rounded,
        size === 'row' ? 'h-[40px] w-[40px]' : 'aspect-square',
        className,
      )}
    >
      {item.art ? (
        <img src={item.art} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <Disc3 />
      )}
      {item.kind === 'track' && (
        <button
          className={cx(
            'absolute inset-0 z-raised grid place-items-center border-0 text-on-media opacity-0 transition-opacity',
            'bg-scrim/47',
            'group-hover:opacity-100 group-focus-within:opacity-100',
            'no-hover:bg-scrim/20 no-hover:opacity-100',
            'max-phone:bg-scrim/20 max-phone:opacity-100',
          )}
          aria-label={label}
          title={action.title}
          onClick={press}
          disabled={action.disabled}
        >
          {playing ? <Pause size={19} /> : <Play size={19} />}
        </button>
      )}
    </div>
  )
}

/** The thin bar under an album: how much of it the library holds. Full is accent, some is partial. */
export function OwnershipBar({
  item,
  label,
  className,
}: {
  item: Pick<MusicResult, 'owned_count' | 'track_count'>
  label: string
  className?: string
}) {
  const share = ownedShare(item)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={item.track_count || 1}
      aria-valuenow={item.owned_count}
      aria-valuetext={ownedFraction(item) || 'Checking coverage'}
      className={cx('h-[3px] w-full overflow-hidden rounded-[3px] bg-line-strong', className)}
    >
      <div
        className={cx('h-full rounded-[3px]', share === 1 ? 'bg-accent' : 'bg-partial')}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  )
}

function MusicCard({ item }: { item: MusicResult }) {
  const detail = useQuery({
    queryKey: ['album', item.id],
    queryFn: ({ signal }) => api(`albums/${item.id}?background=true`, albumSchema, { signal }),
    enabled: item.kind === 'album',
    staleTime: 60_000,
    retry: false,
  })
  const display = item.kind === 'album' ? (detail.data?.album ?? item) : item
  return (
    <article className="group relative isolate flex min-w-0 flex-col gap-[9px] rounded-lg border border-transparent bg-raised p-[12px] hover:border-line hover:bg-hover focus-within:border-line focus-within:bg-hover">
      <Art item={item} />
      {item.kind === 'artist' ? (
        <Link
          className="card-primary-link block text-lead font-semibold"
          to="/artists/$artistId"
          params={{ artistId: String(item.id) }}
        >
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
            {item.title}
          </span>
        </Link>
      ) : (
        <Link
          className="card-primary-link block text-lead font-semibold"
          to="/albums/$albumId"
          params={{ albumId: String(item.kind === 'album' ? item.id : item.album_id) }}
        >
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
            {item.title}
          </span>
        </Link>
      )}
      <small className="text-body text-muted">
        {item.kind === 'artist' ? (
          `${item.popularity.toLocaleString()} ${item.popularity === 1 ? 'fan' : 'fans'}`
        ) : (
          <>
            {display.artist_id ? (
              <Link
                className="relative z-raised"
                to="/artists/$artistId"
                params={{ artistId: String(display.artist_id) }}
              >
                {display.artist}
              </Link>
            ) : (
              display.artist
            )}
            {display.year ? ` · ${display.year}` : ''}
          </>
        )}
      </small>
      {item.kind === 'album' && detail.isError ? (
        <button
          type="button"
          data-ui="text-link"
          className={textLinkClassName('relative z-raised self-start text-tiny')}
          onClick={() => void detail.refetch()}
        >
          Retry coverage
        </button>
      ) : (
        <Badge item={display} />
      )}
      {item.kind === 'album' && (
        <OwnershipBar item={display} label={`${item.title} library coverage`} />
      )}
      {item.kind === 'album' && <AlbumDownloadButton item={display} overlay />}
    </article>
  )
}

function TrackRow({
  item,
  tracks,
  index = 0,
  selected = false,
  job,
  focusable = false,
  first = false,
  onAlbum = false,
}: {
  item: MusicResult
  tracks?: MusicResult[]
  index?: number
  selected?: boolean
  job?: DownloadJob
  focusable?: boolean
  /** The first row of a boxed list has no rule above it. */
  first?: boolean
  /** On an album's own page the album and year are already the heading, so the row drops them. */
  onAlbum?: boolean
}) {
  const room = useLayout() === 'room'
  const player = usePlayer()
  const { action, press } = useRowAction(item)
  const queued = isDeezerTrack(item) && player.listen?.ready === true && tracks !== undefined
  return (
    <div
      className={cx(
        'track-row flex h-[60px] items-center gap-[14px] p-[8px] text-small',
        room
          ? 'rounded-[10px] hover:bg-raised'
          : cx('px-[12px] hover:bg-sunken', !first && 'border-t border-line'),
        'focus:outline-2 focus:outline-accent focus:[outline-offset:-2px] coarse:[&_button]:min-h-11',
        'max-phone:grid max-phone:h-[78px] max-phone:grid-cols-[40px_minmax(0,1fr)_auto] max-phone:grid-rows-[1fr_auto] max-phone:gap-[2px_8px] max-phone:px-[8px] max-phone:py-[6px]',
        selected && 'bg-accent/9 outline outline-1 outline-accent [outline-offset:-1px]',
      )}
      id={`track-${resultKey(item)}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={focusable ? 0 : -1}
    >
      {onAlbum && (
        <span className="w-[22px] text-right font-mono text-tiny text-faint max-phone:hidden">
          {item.position}
        </span>
      )}
      <Art item={item} size="row" className="max-phone:col-start-1 max-phone:row-span-2" />
      <div className="min-w-0 flex-1 max-phone:col-start-2 max-phone:row-start-1">
        <strong className="flex items-center gap-[6px] text-lead font-medium">
          {item.spotify_id ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {item.title}
            </span>
          ) : (
            <Link
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              to="/albums/$albumId"
              params={{ albumId: String(item.album_id) }}
              search={{ track: item.id }}
            >
              {item.title}
            </Link>
          )}{' '}
          {item.explicit && (
            <span
              className="explicit shrink-0 rounded-[2px] bg-faint px-[4px] py-px text-micro text-accent-ink"
              title="Explicit"
            >
              E
            </span>
          )}
        </strong>
        {item.spotify_id ? (
          <span className="mt-[5px] block overflow-hidden text-ellipsis whitespace-nowrap text-body text-muted">
            {item.artist}
          </span>
        ) : (
          <Link
            className="mt-[5px] block overflow-hidden text-ellipsis whitespace-nowrap text-body text-muted"
            to="/artists/$artistId"
            params={{ artistId: String(item.artist_id) }}
          >
            {item.artist}
          </Link>
        )}
      </div>
      {!onAlbum &&
        (item.spotify_id ? (
          <span className="w-[19%] overflow-hidden text-ellipsis whitespace-nowrap text-muted max-tablet:hidden @max-2xl:hidden">
            {item.album}
          </span>
        ) : (
          <Link
            className="w-[19%] overflow-hidden text-ellipsis whitespace-nowrap text-muted max-tablet:hidden @max-2xl:hidden"
            to="/albums/$albumId"
            params={{ albumId: String(item.album_id) }}
          >
            {item.album}
          </Link>
        ))}
      {!onAlbum && (
        <span className="w-[32px] text-muted max-phone:hidden @max-xl:hidden">
          {item.year ?? '…'}
        </span>
      )}
      <span
        className={cx(
          'w-[40px] text-right max-phone:hidden',
          room ? 'font-mono text-tiny text-faint' : 'text-muted',
        )}
      >
        {durationText(item.duration)}
      </span>
      <Badge
        item={item}
        job={job}
        className="max-phone:col-start-2 max-phone:row-start-2 max-phone:justify-self-start max-phone:px-[6px] max-phone:py-[4px] max-phone:text-caption"
      />
      <button
        className="w-[92px] border-0 bg-transparent text-tiny text-accent max-phone:hidden coarse:min-h-11 coarse:min-w-11 coarse:px-[6px] coarse:py-[12px]"
        onClick={press}
        disabled={action.disabled}
        title={action.title}
      >
        {action.label}
      </button>
      {queued && (
        <RowMenu
          className="max-phone:hidden"
          label={`More actions for ${item.title}`}
          actions={[
            ...queueActions(
              () => player.playNext([toQueueTrack(item)]),
              () => player.addToQueue([toQueueTrack(item)]),
            ),
            {
              label: 'Play from here',
              onSelect: () =>
                player.playCatalogFrom(
                  tracks ?? [],
                  index,
                  onAlbum ? `album:${item.album_id}` : '',
                ),
            },
          ]}
        />
      )}
      <DownloadButton
        item={item}
        className="max-phone:col-start-3 max-phone:row-span-2 max-phone:row-start-1 max-phone:gap-[2px]"
      />
    </div>
  )
}

/** Where an album card's download goes, said once above the cards instead of on every one. */
export function AlbumDestination() {
  return <DownloadTarget lead="Downloads go to" className="mb-[12px] block" />
}

export function CardGrid({ items }: { items: MusicResult[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-[20px] max-phone:grid-cols-2 max-phone:gap-[12px]">
      {items.map((item) => (
        <MusicCard key={item.id} item={item} />
      ))}
    </div>
  )
}

/**
 * An album as one list row, the Listening room's Top tab: art, name, the year and count, a thin
 * bar, and the download. The whole row opens the album; the download keeps its own target.
 */
export function AlbumRows({ items }: { items: MusicResult[] }) {
  return (
    <div className="grid gap-[8px]">
      {items.map((item) => (
        <AlbumRow key={item.id} item={item} />
      ))}
    </div>
  )
}

function AlbumRow({ item }: { item: MusicResult }) {
  const detail = useQuery({
    queryKey: ['album', item.id],
    queryFn: ({ signal }) => api(`albums/${item.id}?background=true`, albumSchema, { signal }),
    staleTime: 60_000,
    retry: false,
  })
  const display = detail.data?.album ?? item
  return (
    <article className="group relative isolate grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-[12px] rounded-[12px] bg-raised p-[8px] hover:bg-hover focus-within:bg-hover">
      <Art item={item} rounded="rounded-[8px]" className="size-[52px]" />
      <div className="min-w-0">
        <Link
          className="card-primary-link block overflow-hidden text-ellipsis whitespace-nowrap font-semibold"
          to="/albums/$albumId"
          params={{ albumId: String(item.id) }}
        >
          {item.title}
        </Link>
        <span className="mt-[3px] block font-mono text-tiny text-faint">
          {[
            display.year,
            display.track_count > 0
              ? `${display.track_count} ${display.track_count === 1 ? 'track' : 'tracks'}`
              : '',
            ownedFraction(display),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <OwnershipBar
          item={display}
          label={`${item.title} library coverage`}
          className="mt-[7px]"
        />
      </div>
      <AlbumDownloadButton item={display} />
    </article>
  )
}

export function CatalogTrackList({
  items,
  focusTrack,
  resetScroll,
  onAlbum,
}: {
  items: MusicResult[]
  focusTrack?: number
  resetScroll?: number
  onAlbum?: boolean
}) {
  const parent = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const queue = useJobs()
  const jobs = new Map<number, DownloadJob>()
  for (const job of queue.data?.jobs ?? []) {
    // Podcast episodes are numbered by another directory, so only music jobs belong here.
    if (job.hidden || job.catalog !== 'deezer' || job.track_id <= 0) continue
    const current = jobs.get(job.track_id)
    if (!current || current.updated_at < job.updated_at) jobs.set(job.track_id, job)
  }
  const room = useLayout() === 'room'
  // The row measures its own list, not the window, to decide which columns fit.
  const boxed = cx('@container', !room && 'overflow-hidden rounded-[12px] border border-line')
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 60,
    overscan: 6,
  })
  useEffect(() => {
    if (resetScroll !== undefined && parent.current) {
      parent.current.scrollTop = 0
    }
  }, [resetScroll])

  useEffect(() => {
    const index = items.findIndex((item) => item.id === focusTrack)
    if (index < 0) return
    if (items.length > 12) {
      virtual.scrollToIndex(index, { align: 'center' })
      requestAnimationFrame(() => {
        document.getElementById(`track-${focusTrack}`)?.focus({ preventScroll: true })
      })
    } else {
      const element = document.getElementById(`track-${focusTrack}`)
      element?.scrollIntoView({ block: 'center' })
      element?.focus({ preventScroll: true })
    }
  }, [focusTrack, items, virtual])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!items.length) return
    let newIndex = focusedIndex
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      newIndex = Math.min(focusedIndex + 1, items.length - 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      newIndex = Math.max(focusedIndex - 1, 0)
    } else if (event.key === 'Home') {
      event.preventDefault()
      newIndex = 0
    } else if (event.key === 'End') {
      event.preventDefault()
      newIndex = items.length - 1
    } else {
      return
    }
    setFocusedIndex(newIndex)
    if (items.length > 12) {
      virtual.scrollToIndex(newIndex, { align: 'center' })
    }
    requestAnimationFrame(() => {
      const row = items[newIndex]
      if (row) document.getElementById(`track-${resultKey(row)}`)?.focus({ preventScroll: true })
    })
  }
  if (items.length <= 12)
    return (
      <div className={boxed} onKeyDown={handleKeyDown}>
        {items.map((item, index) => (
          <TrackRow
            key={resultKey(item)}
            first={index === 0}
            onAlbum={onAlbum}
            item={item}
            tracks={items}
            index={index}
            selected={item.id === focusTrack && !item.spotify_id}
            job={resolvedDeezerId(item) > 0 ? jobs.get(resolvedDeezerId(item)) : undefined}
            focusable={index === focusedIndex}
          />
        ))}
      </div>
    )
  return (
    <div
      ref={parent}
      className={cx(
        'virtual-list @container min-h-[280px] overflow-auto overscroll-contain contain-strict',
        room ? '' : 'rounded-[12px] border border-line',
      )}
      role="region"
      aria-label="Tracks"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((row) => {
          const item = items[row.index]
          return item ? (
            <div
              key={resultKey(item)}
              ref={virtual.measureElement}
              data-index={row.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start}px)`,
              }}
            >
              <TrackRow
                first={row.index === 0}
                onAlbum={onAlbum}
                item={item}
                tracks={items}
                index={row.index}
                selected={item.id === focusTrack && !item.spotify_id}
                job={resolvedDeezerId(item) > 0 ? jobs.get(resolvedDeezerId(item)) : undefined}
                focusable={row.index === focusedIndex}
              />
            </div>
          ) : null
        })}
      </div>
    </div>
  )
}
