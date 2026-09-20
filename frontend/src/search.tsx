import { useEffect, useMemo, useRef, useState } from 'react'

import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Disc3, Headphones, Music2, Pause, Play } from 'lucide-react'

import { AlbumDownloadButton } from './album-download'
import {
  albumSchema,
  api,
  artistSchema,
  artistTopSchema,
  searchPageSchema,
  settingsSchema,
  yearsSchema,
} from './api'
import type { DownloadJob, MusicResult } from './api'
import { ArtistDownloadButton } from './artist-download'
import { cx } from './cx'
import { DownloadTarget } from './download-target'
import { DownloadButton, failureMessage, useJobs } from './downloads'
import { HomeShelves } from './home-shelves'
import { InfiniteScroll } from './infinite-scroll'
import { durationText, usePlayer, usePreviewPlayback } from './player'
import { PodcastResults } from './podcasts'
import { addSearch, readSearches, writeSearches } from './recent-searches'
import {
  Button,
  EmptyPanel,
  ErrorBanner,
  Field,
  FieldSelect,
  Ownership,
  textLinkClassName,
} from './ui'

/* A result section's heading row sits a little tighter than the shared one in `ui/`, and its
   title keeps a gap under it where a count or link wraps below. */
const resultsHeadingClassName = 'mb-[17px] flex items-center justify-between gap-[12px]'
const resultsTitleClassName = 'mb-[12px] text-base'

/** How long a query must stand before the home page remembers it. */
const RECENT_SETTLE_MS = 1200

const tabs = ['top', 'track', 'album', 'artist', 'podcast'] as const
type Tab = (typeof tabs)[number]
const sorts = ['relevance', 'title', 'artist', 'year', 'duration', 'popularity'] as const
type Sort = (typeof sorts)[number]
const artistReleaseTypes = ['albums-eps', 'album', 'ep', 'single', 'all'] as const
const artistSorts = ['newest', 'oldest', 'title', 'title-desc'] as const
export type SearchState = {
  q?: string
  tab?: Tab
  explicit?: 'all' | 'clean' | 'explicit'
  from?: number
  until?: number
  min?: number
  max?: number
  preview?: boolean
  library?: 'all' | 'missing' | 'owned'
  sort?: Sort
}
export type ArtistSearch = {
  type?: (typeof artistReleaseTypes)[number]
  sort?: (typeof artistSorts)[number]
}
export function validateSearch(search: Record<string, unknown>): SearchState {
  const number = (value: unknown) =>
    value !== '' && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : undefined
  return {
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : undefined,
    tab: tabs.find((tab) => tab === search.tab),
    sort: sorts.find((sort) => sort === search.sort),
    explicit:
      search.explicit === 'clean' || search.explicit === 'explicit' ? search.explicit : undefined,
    library:
      search.library === 'owned' || search.library === 'missing' ? search.library : undefined,
    preview: search.preview === true || search.preview === 'true' || undefined,
    from: number(search.from),
    until: number(search.until),
    min: number(search.min),
    max: number(search.max),
  }
}

export function validateArtistSearch(search: Record<string, unknown>): ArtistSearch {
  return {
    type: artistReleaseTypes.find((type) => type === search.type),
    sort: artistSorts.find((sort) => sort === search.sort),
  }
}
const labels = {
  top: 'Top',
  track: 'Tracks',
  album: 'Albums',
  artist: 'Artists',
  podcast: 'Podcasts',
}

function saveLastSearch(state: SearchState) {
  try {
    sessionStorage.setItem('musimo.last-search', JSON.stringify(state))
  } catch {
    // Silently fail if sessionStorage is not available
  }
}

function getLastSearch(): SearchState | null {
  try {
    const stored = sessionStorage.getItem('musimo.last-search')
    return stored ? validateSearch(JSON.parse(stored)) : null
  } catch {
    return null
  }
}

function normalizedText(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

function BackToSearch() {
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

function Art({
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

export function MusicCard({ item }: { item: MusicResult }) {
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

export function TrackRow({
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
function AlbumDestination() {
  return <DownloadTarget lead="Downloads go to" className="mb-[12px] block" />
}

function CardGrid({ items }: { items: MusicResult[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-[20px] max-phone:grid-cols-2 max-phone:gap-[12px]">
      {items.map((item) => (
        <MusicCard key={item.id} item={item} />
      ))}
    </div>
  )
}

export function TrackList({
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

type ResultKind = 'track' | 'album' | 'artist'

/* The page and each of its sections read the same query, so the page can tell that every section
   came back empty and say so once. */
const searchResultsQuery = (q: string | undefined, kind: ResultKind) =>
  infiniteQueryOptions({
    queryKey: ['search', q, kind],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(
        `search?${new URLSearchParams({ q: q ?? '', kind, index: String(pageParam) })}`,
        searchPageSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next_index ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })

function ResultsSection({
  kind,
  state,
  compact,
  change,
}: {
  kind: ResultKind
  state: SearchState
  compact: boolean
  change: (patch: Partial<SearchState>) => void
}) {
  const query = useInfiniteQuery(searchResultsQuery(state.q, kind))
  const raw = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data])
  // Subscribe at the filter level too: verified coverage must change which albums are shown.
  const coverage = useQueries({
    queries: (kind === 'album' ? raw : []).map((item) => ({
      queryKey: ['album', item.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(`albums/${item.id}?background=true`, albumSchema, { signal }),
      enabled:
        !query.isPlaceholderData &&
        Boolean(
          state.library ||
          state.from !== undefined ||
          state.until !== undefined ||
          state.sort === 'year',
        ),
      staleTime: 60_000,
      retry: false,
    })),
  })
  const ids = useMemo(() => [...new Set(raw.map((item) => item.album_id).filter(Boolean))], [raw])
  const yearQuery = useQuery({
    queryKey: ['years', ids.join(',')],
    enabled: kind === 'track' && ids.length > 0 && !query.isPlaceholderData,
    queryFn: async ({ signal }) => {
      const result: Record<string, number | null> = {}
      // Hydration is independent of first paint and stays inside the server's bounded batch size.
      for (let start = 0; start < ids.length; start += 50)
        Object.assign(
          result,
          await api(`album-years?ids=${ids.slice(start, start + 50).join(',')}`, yearsSchema, {
            signal,
          }),
        )
      return result
    },
    staleTime: 86_400_000,
    retry: false,
  })
  // Track filter state separately from search query for deliberate scroll reset
  const filterSignature = useMemo(
    () =>
      JSON.stringify({
        explicit: state.explicit,
        from: state.from,
        until: state.until,
        library: state.library,
        min: state.min,
        max: state.max,
        preview: state.preview,
        sort: state.sort,
      }),
    [
      state.explicit,
      state.from,
      state.until,
      state.library,
      state.min,
      state.max,
      state.preview,
      state.sort,
    ],
  )
  const prevFilterRef = useRef(filterSignature)
  const resetCounterRef = useRef(0)
  if (prevFilterRef.current !== filterSignature) {
    prevFilterRef.current = filterSignature
    resetCounterRef.current += 1
  }
  const resetScroll = resetCounterRef.current
  const items = useMemo(() => {
    const unique = [...new Map(raw.map((item) => [item.id, item])).values()]
    const filtered = unique
      .map((item) =>
        kind === 'album'
          ? (coverage.find((result) => result.data?.album.id === item.id)?.data?.album ?? item)
          : item,
      )
      .map((item) => ({
        ...item,
        year: item.year ?? yearQuery.data?.[String(item.album_id)] ?? null,
      }))
      .filter((item) => {
        if (kind !== 'artist') {
          if (
            (state.explicit === 'clean' && item.explicit) ||
            (state.explicit === 'explicit' && !item.explicit)
          )
            return false
          if (state.from !== undefined && (item.year === null || item.year < state.from))
            return false
          if (state.until !== undefined && (item.year === null || item.year > state.until))
            return false
          if (
            (state.library === 'owned' && item.ownership === 'missing') ||
            (state.library === 'missing' && item.ownership === 'owned')
          )
            return false
        }

        if (kind === 'track') {
          if (
            (state.min !== undefined && item.duration < state.min * 60) ||
            (state.max !== undefined && item.duration > state.max * 60)
          )
            return false
          if (state.preview && !item.preview) return false
        }
        return true
      })
    const sort = state.sort
    if (sort && sort !== 'relevance') {
      const queryName = normalizedText(state.q ?? '')
      filtered.sort((a, b) => {
        if (kind === 'artist' && sort === 'popularity') {
          const exactMatch =
            Number(normalizedText(b.title) === queryName) -
            Number(normalizedText(a.title) === queryName)
          if (exactMatch) return exactMatch
        }
        return sort === 'title' || sort === 'artist'
          ? a[sort].localeCompare(b[sort])
          : (b[sort] ?? -1) - (a[sort] ?? -1)
      })
    }
    return compact ? filtered.slice(0, kind === 'track' ? 5 : 6) : filtered
  }, [raw, yearQuery.data, state, kind, compact, coverage])
  return (
    <section className="mb-[36px]" aria-label={labels[kind]}>
      {/* On its own tab the heading only repeats the chosen tab, and on a phone that row is a
          good part of what keeps the first result off the first screen. It stays for a screen
          reader; the Top tab keeps it, where it tells the sections apart. */}
      <div className={cx(resultsHeadingClassName, !compact && 'max-phone:sr-only')}>
        <h2 className={resultsTitleClassName}>{labels[kind]}</h2>
        {compact && items.length > 0 && (
          <button
            type="button"
            data-ui="text-link"
            className={textLinkClassName()}
            onClick={() => change({ tab: kind })}
          >
            View all
          </button>
        )}
        {!compact && (
          <small>
            {items.length} shown · {raw.length} loaded of {query.data?.pages[0]?.total ?? '…'}
          </small>
        )}
      </div>
      {query.isError && (
        <ErrorBanner role="alert">
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {query.isPending && (
        <div
          className="[&>i]:mt-[12px] [&>i]:block [&>i]:h-[58px] [&>i]:rounded-[7px] [&>i]:bg-[linear-gradient(100deg,var(--color-raised),var(--color-hover),var(--color-raised))]"
          role="status"
        >
          Searching {labels[kind].toLowerCase()}…<i />
          <i />
          <i />
        </div>
      )}
      {query.isFetching && !query.isPending && <small role="status">Updating results…</small>}
      {yearQuery.isFetching &&
        (state.from !== undefined || state.until !== undefined || state.sort === 'year') && (
          <small role="status">Checking release years…</small>
        )}
      {yearQuery.isError && (
        <p className="text-muted text-small">
          Release years unavailable.{' '}
          <button onClick={() => void yearQuery.refetch()}>Retry years</button>
        </p>
      )}
      {items.length > 0 &&
        (kind === 'track' ? (
          <TrackList items={items} resetScroll={resetScroll} />
        ) : (
          <>
            {kind === 'album' && <AlbumDestination />}
            <CardGrid items={items} />
          </>
        ))}
      {!query.isPending && !query.isError && !items.length && (
        <p className="py-[30px]">
          No {labels[kind].toLowerCase()} match{' '}
          {raw.length ? 'these filters in the loaded results.' : 'this search.'}
        </p>
      )}
      {!compact && query.hasNextPage && (
        <InfiniteScroll
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
      {compact && kind === 'track' && items[0] && (
        <div className="mt-[22px] flex items-center gap-[20px] rounded-lg border border-good-line bg-[linear-gradient(110deg,var(--color-good-bg),var(--color-raised))] p-[24px] max-phone:gap-[10px] max-phone:p-[18px]">
          <Headphones size={27} className="max-phone:hidden" />
          <div className="flex-1">
            <small className="block text-caption tracking-[1.5px] text-accent">TOP TRACK</small>
            <strong className="my-[7px] block text-subtitle">{items[0].title}</strong>
            <span className="block text-small text-muted">
              {items[0].artist} · {durationText(items[0].duration)}
            </span>
          </div>
          <PreviewButton item={items[0]} />
        </div>
      )}
    </section>
  )
}

function PreviewButton({ item }: { item: MusicResult }) {
  const player = usePlayer()
  const active = usePreviewPlayback(item.id).playing
  return (
    <Button variant="primary" onClick={() => player.play(item)}>
      {active ? <Pause size={16} /> : <Play size={16} />} {active ? 'Pause' : 'Preview'}
    </Button>
  )
}

export function SearchPage() {
  const location = useRouterState({ select: (state) => state.location })
  const state = validateSearch(Object.fromEntries(new URLSearchParams(location.searchStr)))
  const navigate = useNavigate()
  const change = (patch: Partial<SearchState>) => {
    void navigate({ to: '/search', search: { ...state, ...patch } })
  }
  const tab = state.tab ?? 'top'
  const [filters, setFilters] = useState(false)
  // Podcasts come from another directory, so the music filters and sort do not apply to them.
  const music = tab !== 'podcast'
  const filtersShown =
    music &&
    Boolean(
      filters ||
      state.explicit ||
      state.from !== undefined ||
      state.until !== undefined ||
      state.min !== undefined ||
      state.max !== undefined ||
      state.preview ||
      state.library,
    )
  useEffect(() => {
    if (state.q) saveLastSearch(state)
  }, [state])
  const searching =
    Boolean(state.q) && (state.q?.trim().length ?? 0) >= 2 && !/^https?:\/\//i.test(state.q ?? '')
  // A search is kept for the home page once it has stood for a moment, since the box searches as
  // a person types and every keystroke on the way would otherwise be remembered.
  useEffect(() => {
    const query = state.q
    if (!searching || !query) return
    const remember = () => writeSearches(addSearch(readSearches(), query))
    const timer = setTimeout(remember, RECENT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [searching, state.q])
  const kinds: ResultKind[] =
    tab === 'top' ? ['track', 'album', 'artist'] : tab === 'podcast' ? [] : [tab]
  // Called for all three kinds every render, since hooks cannot be conditional; the ones this tab
  // does not show stay disabled.
  const trackResults = useInfiniteQuery({
    ...searchResultsQuery(state.q, 'track'),
    enabled: searching && kinds.includes('track'),
  })
  const albumResults = useInfiniteQuery({
    ...searchResultsQuery(state.q, 'album'),
    enabled: searching && kinds.includes('album'),
  })
  const artistResults = useInfiniteQuery({
    ...searchResultsQuery(state.q, 'artist'),
    enabled: searching && kinds.includes('artist'),
  })
  const resultQueries = { track: trackResults, album: albumResults, artist: artistResults }
  // Every section answered and none had a single result: one message beats three empty sections.
  const nothingFound =
    kinds.length > 0 &&
    kinds.every((kind) => {
      const result = resultQueries[kind]
      return (
        result.isSuccess &&
        !result.isPlaceholderData &&
        result.data.pages.every((page) => page.items.length === 0)
      )
    })
  if (!state.q || state.q.trim().length < 2)
    return (
      <div className="max-w-[840px] pt-[54px] pb-[30px] max-phone:pt-[25px]">
        <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
          THE NEXT ADDITION TO YOUR COLLECTION
        </span>
        <h1 className="my-[26px] text-[clamp(42px,6vw,78px)] leading-[1.06] tracking-[-3px] max-phone:tracking-[-2px]">
          Find it.
          <br />
          <em className="text-accent not-italic">Make room for it.</em>
        </h1>
        <p className="max-w-[490px] text-section">
          Search tracks, albums, artists and podcasts. Listen to a preview and see what’s already in
          your library.
        </p>
        <HomeShelves onSearch={(q) => change({ q })} />
        <div className="flex gap-[16px] border-t border-line pt-[26px] text-accent">
          <Music2 size={24} />
          <span>
            Deezer catalog · Library-aware search
            <small className="mt-[7px] block text-muted">
              Start typing above. Two characters is enough.
            </small>
          </span>
        </div>
      </div>
    )
  if (/^https?:\/\//i.test(state.q.trim()))
    return (
      <EmptyPanel>
        <h1>Pasting links is not supported yet.</h1>
        <p>Search by artist, album or track name for now.</p>
        <Button onClick={() => change({ q: '' })}>Clear link</Button>
      </EmptyPanel>
    )
  return (
    <>
      <div className="mb-[25px] max-phone:mb-[10px]">
        <div>
          <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:hidden">
            DISCOVER YOUR NEXT FAVOURITE
          </span>
          <h1 className="max-phone:text-heading max-phone:[overflow-wrap:anywhere]">
            Results for “{state.q}”
          </h1>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-[16px] border-b border-line pb-[18px] max-phone:gap-[8px] max-phone:pb-[10px]">
        <div className="mr-auto flex flex-wrap gap-[6px] max-phone:w-full" aria-label="Search type">
          {tabs.map((value) => (
            <button
              key={value}
              data-ui="tab"
              aria-pressed={tab === value}
              className={cx(
                'rounded-pill border-0 px-[17px] py-[10px] whitespace-nowrap coarse:min-h-11 max-phone:flex-1 max-phone:p-[9px]',
                tab === value ? 'bg-accent text-accent-ink' : 'bg-transparent text-muted',
              )}
              onClick={() => change({ tab: value })}
            >
              {labels[value]}
            </button>
          ))}
        </div>
        {music && (
          <>
            <Button aria-expanded={filters} onClick={() => setFilters(!filters)}>
              Filters
            </Button>
            <label className="flex items-center gap-[10px] text-body text-muted max-phone:ml-auto">
              Sort{' '}
              <FieldSelect
                tone="sunken"
                fullWidth={false}
                value={state.sort ?? 'relevance'}
                onChange={(e) => change({ sort: sorts.find((value) => value === e.target.value) })}
              >
                {sorts.map((value) => (
                  <option key={value} value={value}>
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </option>
                ))}
              </FieldSelect>
            </label>
          </>
        )}
      </div>
      {filtersShown && (
        <div className="flex flex-wrap items-end gap-[12px] pt-[20px] pb-[8px]">
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Lyrics
            <FieldSelect
              tone="sunken"
              fullWidth={false}
              value={state.explicit ?? 'all'}
              onChange={(e) =>
                change({
                  explicit:
                    e.target.value === 'clean'
                      ? 'clean'
                      : e.target.value === 'explicit'
                        ? 'explicit'
                        : undefined,
                })
              }
            >
              <option value="all">All</option>
              <option value="clean">Clean</option>
              <option value="explicit">Explicit</option>
            </FieldSelect>
          </label>
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Year from
            <Field
              tone="sunken"
              fullWidth={false}
              className="w-[93px]"
              aria-label="Year from"
              type="number"
              min="0"
              max="9999"
              value={state.from ?? ''}
              onChange={(e) =>
                change({ from: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Year to
            <Field
              tone="sunken"
              fullWidth={false}
              className="w-[93px]"
              aria-label="Year to"
              type="number"
              min="0"
              max="9999"
              value={state.until ?? ''}
              onChange={(e) =>
                change({ until: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Minutes from
            <Field
              tone="sunken"
              fullWidth={false}
              className="w-[93px]"
              aria-label="Minimum minutes"
              type="number"
              min="0"
              value={state.min ?? ''}
              onChange={(e) => change({ min: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Minutes to
            <Field
              tone="sunken"
              fullWidth={false}
              className="w-[93px]"
              aria-label="Maximum minutes"
              type="number"
              min="0"
              value={state.max ?? ''}
              onChange={(e) => change({ max: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label className="flex flex-col gap-[5px] text-small text-muted">
            Library
            <FieldSelect
              tone="sunken"
              fullWidth={false}
              value={state.library ?? 'all'}
              onChange={(e) =>
                change({
                  library:
                    e.target.value === 'owned'
                      ? 'owned'
                      : e.target.value === 'missing'
                        ? 'missing'
                        : undefined,
                })
              }
            >
              <option value="all">All</option>
              <option value="missing">Missing tracks</option>
              <option value="owned">In library</option>
            </FieldSelect>
          </label>
          <label className="flex flex-row items-center gap-[5px] p-[10px] text-small text-muted coarse:min-h-11">
            <input
              type="checkbox"
              checked={state.preview ?? false}
              onChange={(e) => change({ preview: e.target.checked || undefined })}
            />
            Has preview
          </label>
          <button
            type="button"
            data-ui="text-link"
            className={textLinkClassName()}
            onClick={() =>
              void navigate({ to: '/search', search: { q: state.q, tab, sort: state.sort } })
            }
          >
            Clear filters
          </button>
          <p className="w-full text-small text-muted">
            Filters and sort apply to loaded results. Years fill in as album details arrive.
            Duration and preview filters apply to tracks.
          </p>
        </div>
      )}
      {!music && <PodcastResults q={state.q.trim()} />}
      {nothingFound ? (
        <p className="py-[30px]" role="status">
          No results for “{state.q}”. Check the spelling or try a shorter search.
        </p>
      ) : (
        kinds.length > 0 && (
          <div className="pt-[20px] max-phone:pt-[14px]">
            {kinds.map((kind) => (
              <ResultsSection
                key={kind}
                kind={kind}
                state={state}
                compact={tab === 'top'}
                change={change}
              />
            ))}
          </div>
        )
      )}
    </>
  )
}

export function AlbumPage() {
  const { albumId } = useParams({ from: '/albums/$albumId' })
  const focusTrack = useRouterState({
    select: (state) =>
      Number(new URLSearchParams(state.location.searchStr).get('track')) || undefined,
  })
  const query = useQuery({
    queryKey: ['album', Number(albumId)],
    queryFn: ({ signal }) => api(`albums/${albumId}`, albumSchema, { signal }),
    staleTime: 60_000,
  })
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const [quality, setQuality] = useState<string | undefined>(undefined)
  const chosenQuality = quality ?? settings.data?.output_format.value ?? 'original'
  if (query.isError)
    return (
      <ErrorBanner role="alert">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </ErrorBanner>
    )
  if (!query.data) return <p role="status">Loading album…</p>
  const { album, tracks, label, duration, complete } = query.data
  const editionCount = tracks.filter((track) => track.ownership === 'edition').length
  const missingCount = tracks.filter(
    (track) => track.ownership !== 'owned' && track.ownership !== 'edition',
  ).length
  const hasOwnedTracks = tracks.some(
    (track) => track.ownership === 'owned' || track.ownership === 'edition',
  )
  const bitrate = chosenQuality === 'mp3' ? 320 : 160
  return (
    <>
      <BackToSearch />
      <div className="mt-[24px] mb-[32px] flex items-center gap-[28px] max-phone:items-start max-phone:gap-[16px]">
        <Art item={album} className="w-[210px] max-phone:w-[95px]" />
        <div>
          <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
            {album.record_type.toUpperCase()} · {album.year ?? 'Year unknown'}
          </span>
          <h1 className="my-[12px] max-phone:text-[24px]">{album.title}</h1>
          <Link to="/artists/$artistId" params={{ artistId: String(album.artist_id) }}>
            {album.artist}
          </Link>
          <p className="my-[15px] text-body">
            {label} · {album.track_count} tracks · {durationText(duration)} · ~
            {Math.round((duration * bitrate) / 8 / 1024)} MB estimated
          </p>
          <Badge item={album} />
        </div>
      </div>
      <div className="album-actions mb-[25px] flex flex-wrap items-center gap-[15px]">
        <label className="text-small text-muted">
          Quality{' '}
          <FieldSelect
            tone="sunken"
            fullWidth={false}
            value={chosenQuality}
            onChange={(e) => setQuality(e.target.value)}
          >
            <option value="original">Original</option>
            <option value="m4a">M4A</option>
            <option value="opus">Opus</option>
            <option value="mp3">MP3</option>
          </FieldSelect>
        </label>
        <AlbumDownloadButton
          key={`${album.id}-${hasOwnedTracks ? 'missing' : 'all'}`}
          item={album}
          missingOnly={hasOwnedTracks}
          format={chosenQuality}
          target={settings.data?.destination.value}
          label={
            hasOwnedTracks && missingCount > 0
              ? `Download missing (${missingCount})`
              : 'Download album'
          }
        />
        <small className="w-full text-muted">
          Size assumes {bitrate} kbps; actual source varies.
        </small>
        {editionCount > 0 && (
          <small className="w-full text-muted">
            {editionCount} track{editionCount === 1 ? ' has' : 's have'} another edition in your
            library
          </small>
        )}
        <DownloadTarget format={chosenQuality} />
      </div>
      {!complete && (
        <ErrorBanner>
          The catalog returned an incomplete track list. Coverage is partial.
        </ErrorBanner>
      )}
      <TrackList items={tracks} focusTrack={focusTrack} />
    </>
  )
}

export function ArtistPage() {
  const { artistId } = useParams({ from: '/artists/$artistId' })
  const location = useRouterState({ select: (state) => state.location })
  const state = validateArtistSearch(Object.fromEntries(new URLSearchParams(location.searchStr)))
  const navigate = useNavigate()
  const query = useInfiniteQuery({
    queryKey: ['artist', artistId],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(`artists/${artistId}?index=${pageParam}`, artistSchema, { signal }),
    getNextPageParam: (page) => page.next_index ?? undefined,
    staleTime: 86_400_000,
  })
  const top = useQuery({
    queryKey: ['artist-top', artistId],
    queryFn: ({ signal }) => api(`artists/${artistId}/top`, artistTopSchema, { signal }),
    staleTime: 3_600_000,
    retry: false,
  })
  const popularAlbumIds = useMemo(
    () => [...new Set((top.data?.tracks ?? []).map((track) => track.album_id).filter(Boolean))],
    [top.data],
  )
  const popularAlbumQueries = useQueries({
    queries: popularAlbumIds.map((albumId) => ({
      queryKey: ['album', albumId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(`albums/${albumId}?background=true`, albumSchema, { signal }),
      staleTime: 60_000,
      retry: false,
    })),
  })
  if (query.isError)
    return (
      <ErrorBanner>
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </ErrorBanner>
    )
  if (!query.data) return <p role="status">Loading artist…</p>
  const artist = query.data.pages[0]?.artist
  const items = [
    ...new Map(
      query.data.pages.flatMap((page) => page.items).map((item) => [item.id, item]),
    ).values(),
  ]
  // Deezer's top tracks leave the year out. The albums behind them are loaded anyway for the
  // popular albums row, so their years fill the column instead of leaving it waiting.
  const albumYears = new Map(
    popularAlbumQueries.flatMap((result) =>
      result.data ? [[result.data.album.id, result.data.album.year] as const] : [],
    ),
  )
  const topTracks = (top.data?.tracks.slice(0, 5) ?? []).map((track) => ({
    ...track,
    year: track.year ?? albumYears.get(track.album_id) ?? null,
  }))
  const popularAlbums = popularAlbumQueries
    .map((result) => result.data?.album)
    .filter(
      (album): album is MusicResult =>
        album?.record_type === 'album' && album.artist_id === Number(artistId),
    )
    .slice(0, 6)
  const releaseType = state.type ?? 'albums-eps'
  const releaseSort = state.sort ?? 'newest'
  const releases = items
    .filter(
      (item) =>
        releaseType === 'all' ||
        item.record_type === releaseType ||
        (releaseType === 'albums-eps' && ['album', 'ep'].includes(item.record_type)),
    )
    .sort((a, b) =>
      releaseSort === 'title' || releaseSort === 'title-desc'
        ? a.title.localeCompare(b.title) * (releaseSort === 'title-desc' ? -1 : 1)
        : releaseSort === 'oldest'
          ? (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER)
          : (b.year ?? -1) - (a.year ?? -1),
    )
  const change = (patch: ArtistSearch) => {
    void navigate({
      to: '/artists/$artistId',
      params: { artistId },
      search: { ...state, ...patch },
    })
  }
  return (
    <>
      <BackToSearch />
      <div className="mt-[25px] mb-[40px] flex items-center gap-[25px]">
        {artist?.art && (
          <img src={artist.art} alt="" className="w-[150px] rounded-pill max-phone:w-[95px]" />
        )}
        <div>
          <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
            ARTIST
          </span>
          <h1 className="my-[12px]">{artist?.name}</h1>
          <p>{items.length} releases loaded</p>
          <ArtistDownloadButton
            key={artistId}
            artistId={Number(artistId)}
            name={artist?.name ?? 'Artist'}
          />
        </div>
      </div>
      <section className="mb-[36px]" aria-labelledby="popular-songs-title">
        <div className={resultsHeadingClassName}>
          <h2 id="popular-songs-title" className={resultsTitleClassName}>
            Popular songs
          </h2>
        </div>
        {top.isPending && <p role="status">Loading popular songs…</p>}
        {top.isError && (
          <ErrorBanner role="alert">
            {top.error.message} <button onClick={() => void top.refetch()}>Retry</button>
          </ErrorBanner>
        )}
        {topTracks.length > 0 && <TrackList items={topTracks} />}
        {top.isSuccess && !topTracks.length && (
          <p className="text-muted">No popular songs found.</p>
        )}
      </section>
      <section className="mb-[36px]" aria-labelledby="popular-albums-title">
        <div className={resultsHeadingClassName}>
          <h2 id="popular-albums-title" className={resultsTitleClassName}>
            Popular albums
          </h2>
        </div>
        {(top.isPending || popularAlbumQueries.some((result) => result.isPending)) && (
          <p role="status">Finding popular albums…</p>
        )}
        {popularAlbumQueries.some((result) => result.isError) && (
          <ErrorBanner role="alert">
            Some popular albums could not be checked.{' '}
            <button
              onClick={() =>
                void Promise.all(popularAlbumQueries.map((result) => result.refetch()))
              }
            >
              Retry
            </button>
          </ErrorBanner>
        )}
        {popularAlbums.length > 0 && (
          <>
            <AlbumDestination />
            <CardGrid items={popularAlbums} />
          </>
        )}
        {top.isSuccess &&
          popularAlbumQueries.every((result) => !result.isPending) &&
          !popularAlbums.length && <p className="text-muted">No popular albums found.</p>}
      </section>
      <section className="mb-[36px]" aria-labelledby="discography-title">
        <div className="mb-[17px] flex items-end justify-between gap-[12px] max-phone:flex-col max-phone:items-start">
          <div className="grid gap-[5px]">
            <h2 id="discography-title" className={resultsTitleClassName}>
              Discography
            </h2>
            <small>
              {releases.length} shown · {items.length} releases loaded
            </small>
          </div>
          <div className="flex flex-wrap gap-[10px] max-phone:w-full">
            <label className="grid gap-[5px] text-caption text-muted uppercase tracking-[0.08em] max-phone:w-full">
              Show
              <select
                className="min-w-[145px] rounded-[7px] border border-line-strong bg-sunken px-[10px] py-[8px] pr-[30px] text-small tracking-normal text-text normal-case max-phone:w-full"
                value={releaseType}
                onChange={(event) => change({ type: event.target.value as ArtistSearch['type'] })}
              >
                <option value="albums-eps">Albums and EPs</option>
                <option value="album">Albums</option>
                <option value="ep">EPs</option>
                <option value="single">Singles</option>
                <option value="all">All releases</option>
              </select>
            </label>
            <label className="grid gap-[5px] text-caption text-muted uppercase tracking-[0.08em] max-phone:w-full">
              Sort
              <select
                className="min-w-[145px] rounded-[7px] border border-line-strong bg-sunken px-[10px] py-[8px] pr-[30px] text-small tracking-normal text-text normal-case max-phone:w-full"
                value={releaseSort}
                onChange={(event) => change({ sort: event.target.value as ArtistSearch['sort'] })}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="title">Title A to Z</option>
                <option value="title-desc">Title Z to A</option>
              </select>
            </label>
          </div>
        </div>
        {releases.length > 0 ? (
          <>
            {/* The popular albums grid above already said it, when it has cards. */}
            {popularAlbums.length === 0 && <AlbumDestination />}
            <CardGrid items={releases} />
          </>
        ) : (
          <p className="text-muted">No releases match this view.</p>
        )}
      </section>
      <p className="text-small text-muted">
        Popular songs come from Deezer. Popular albums are the albums behind those songs. Review
        alternative editions before downloading an artist.
      </p>
      {query.hasNextPage && (
        <InfiniteScroll
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
    </>
  )
}
