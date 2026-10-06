import { useEffect, useRef, useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Disc3, Pause, Play } from 'lucide-react'

import { albumSchema, api } from '../../api'
import type { DownloadJob, MusicResult } from '../../api'
import { cx } from '../../lib/cx'
import { Ownership, textLinkClassName } from '../../ui'
import { AlbumDownloadButton } from '../downloads/album-download'
import { DownloadButton } from '../downloads/download-button'
import { DownloadTarget } from '../downloads/download-target'
import { failureMessage, useJobs } from '../downloads/jobs'
import { durationText, usePlayer, usePreviewPlayback } from '../player/player'
import { getLastSearch } from './search-params'

/* A result section's heading row sits a little tighter than the shared one in `ui/`, and its
   title keeps a gap under it where a count or link wraps below. */
export const resultsHeadingClassName = 'mb-[17px] flex items-center justify-between gap-[12px]'
export const resultsTitleClassName = 'mb-[12px] text-base'

export function BackToSearch() {
  const navigate = useNavigate()
  const lastSearch = getLastSearch()
  if (!lastSearch?.q) return null
  return (
    <button
      type="button"
      data-ui="text-link"
      className={textLinkClassName()}
      onClick={() => void navigate({ to: '/search', search: lastSearch })}
    >
      ← Back to results
    </button>
  )
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
  if (item.kind === 'artist') return null
  const failed =
    item.ownership !== 'owned' && item.ownership !== 'edition' && job?.stage === 'failed'
  const jobLabel =
    job?.stage === 'failed'
      ? 'Download failed'
      : job?.stage === 'retry_wait'
        ? 'Retry scheduled'
        : job?.stage === 'done'
          ? 'Downloaded earlier'
          : job?.stage.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
  const editionLabel = item.matched_album
    ? `Another edition in library (${item.matched_album})`
    : 'Another edition in library'
  return (
    <Ownership
      variant={failed ? 'failed' : item.ownership === 'edition' ? 'partial' : item.ownership}
      className={className}
      title={
        failed
          ? job.error_hint || failureMessage(job)
          : item.ownership === 'edition'
            ? `${editionLabel}\n${item.matched_paths.join('\n')}`
            : item.matched_paths.join('\n') ||
              (item.kind === 'album' && !item.coverage_verified
                ? 'Coverage is still being checked against the library index.'
                : 'No matching file in the current library index')
      }
    >
      {(item.ownership === 'owned' || item.ownership === 'edition') && <Check size={12} />}
      {item.kind === 'album'
        ? item.track_count > 0
          ? `${item.owned_count} of ${item.track_count}${item.coverage_verified ? '' : ' estimated'}`
          : 'Checking coverage…'
        : item.ownership === 'owned'
          ? 'In library'
          : item.ownership === 'edition'
            ? editionLabel
            : (jobLabel ?? 'Missing')}
    </Ownership>
  )
}

export function Art({
  item,
  size = 'card',
  className,
}: {
  item: MusicResult
  size?: 'card' | 'row'
  className?: string
}) {
  const player = usePlayer()
  const active = usePreviewPlayback(item.id).playing
  const previewState = player.previewState(item.id)
  const noPreview = previewState === 'none'
  const label = active
    ? `Pause ${item.title}`
    : noPreview
      ? `No preview ${item.title}`
      : item.preview
        ? `Preview ${item.title}`
        : `Find preview ${item.title}`
  return (
    <div
      className={cx(
        'group relative isolate flex shrink-0 items-center justify-center overflow-hidden bg-active',
        item.kind === 'artist' ? 'rounded-pill' : 'rounded-[7px]',
        size === 'row' ? 'h-[46px] w-[46px]' : 'aspect-square',
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
          onClick={() => player.play(item)}
          disabled={noPreview}
        >
          {active ? <Pause size={19} /> : <Play size={19} />}
        </button>
      )}
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
        <meter
          className="h-[4px] w-full"
          min={0}
          max={display.track_count || 1}
          value={display.owned_count}
          aria-label={`${item.title} library coverage`}
        />
      )}
      {item.kind === 'album' && <AlbumDownloadButton item={display} overlay />}
    </article>
  )
}

function TrackRow({
  item,
  selected = false,
  job,
  focusable = false,
}: {
  item: MusicResult
  selected?: boolean
  job?: DownloadJob
  focusable?: boolean
}) {
  const player = usePlayer()
  const playing = usePreviewPlayback(item.id).playing
  const previewState = player.previewState(item.id)
  const noPreview = previewState === 'none'
  return (
    <div
      className={cx(
        'track-row flex h-[76px] items-center gap-[14px] border-b border-line p-[8px] text-small',
        'hover:bg-hover focus:outline-2 focus:outline-accent focus:[outline-offset:-2px] coarse:[&_button]:min-h-11',
        'max-phone:grid max-phone:grid-cols-[44px_minmax(0,1fr)_auto] max-phone:grid-rows-[1fr_auto] max-phone:gap-[2px_8px] max-phone:p-[6px_0]',
        selected && 'bg-accent/9 outline outline-1 outline-accent [outline-offset:-1px]',
      )}
      id={`track-${item.id}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={focusable ? 0 : -1}
    >
      <Art item={item} size="row" className="max-phone:col-start-1 max-phone:row-span-2" />
      <div className="min-w-0 flex-1 max-phone:col-start-2 max-phone:row-start-1">
        <strong className="flex items-center gap-[6px] text-lead font-medium">
          <Link
            className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
            to="/albums/$albumId"
            params={{ albumId: String(item.album_id) }}
            search={{ track: item.id }}
          >
            {item.title}
          </Link>{' '}
          {item.explicit && (
            <span
              className="explicit shrink-0 rounded-[2px] bg-faint px-[4px] py-px text-micro text-accent-ink"
              title="Explicit"
            >
              E
            </span>
          )}
        </strong>
        <Link
          className="mt-[5px] block overflow-hidden text-ellipsis whitespace-nowrap text-body text-muted"
          to="/artists/$artistId"
          params={{ artistId: String(item.artist_id) }}
        >
          {item.artist}
        </Link>
      </div>
      <Link
        className="w-[19%] overflow-hidden text-ellipsis whitespace-nowrap text-muted max-tablet:hidden"
        to="/albums/$albumId"
        params={{ albumId: String(item.album_id) }}
      >
        {item.album}
      </Link>
      <span className="w-[32px] text-muted max-phone:hidden">{item.year ?? '…'}</span>
      <span className="w-[32px] text-muted max-phone:hidden">{durationText(item.duration)}</span>
      <Badge
        item={item}
        job={job}
        className="max-phone:col-start-2 max-phone:row-start-2 max-phone:justify-self-start max-phone:px-[6px] max-phone:py-[4px] max-phone:text-caption"
      />
      <button
        className="w-[65px] border-0 bg-transparent text-tiny text-accent max-phone:hidden coarse:min-h-11 coarse:min-w-11 coarse:px-[6px] coarse:py-[12px]"
        onClick={() => player.play(item)}
        disabled={noPreview}
        title={noPreview ? 'No preview available' : undefined}
      >
        {playing ? 'Pause' : noPreview ? 'No preview' : item.preview ? 'Preview' : 'Find preview'}
      </button>
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

export function CatalogTrackList({
  items,
  focusTrack,
  resetScroll,
}: {
  items: MusicResult[]
  focusTrack?: number
  resetScroll?: number
}) {
  const parent = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const queue = useJobs()
  const jobs = new Map<number, DownloadJob>()
  for (const job of queue.data?.jobs ?? []) {
    // Podcast episodes are numbered by another directory, so only music jobs belong here.
    if (job.hidden || job.catalog !== 'deezer') continue
    const current = jobs.get(job.track_id)
    if (!current || current.updated_at < job.updated_at) jobs.set(job.track_id, job)
  }
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 76,
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
      document.getElementById(`track-${items[newIndex]?.id}`)?.focus({ preventScroll: true })
    })
  }
  if (items.length <= 12)
    return (
      <div onKeyDown={handleKeyDown}>
        {items.map((item, index) => (
          <TrackRow
            key={item.id}
            item={item}
            selected={item.id === focusTrack}
            job={jobs.get(item.id)}
            focusable={index === focusedIndex}
          />
        ))}
      </div>
    )
  return (
    <div
      ref={parent}
      className="virtual-list min-h-[280px] overflow-auto overscroll-contain contain-strict"
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
              key={item.id}
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
                item={item}
                selected={item.id === focusTrack}
                job={jobs.get(item.id)}
                focusable={row.index === focusedIndex}
              />
            </div>
          ) : null
        })}
      </div>
    </div>
  )
}
