import { useEffect, useMemo, useRef, useState } from 'react'

import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Disc3, Headphones, Music2, Pause, Play, Search } from 'lucide-react'

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
import { DownloadTarget } from './download-target'
import { DownloadButton, failureMessage, useJobs } from './downloads'
import { InfiniteScroll } from './infinite-scroll'
import { durationText, usePlayer, usePreviewPlayback } from './player'

const tabs = ['top', 'track', 'album', 'artist'] as const
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
const labels = { top: 'Top', track: 'Tracks', album: 'Albums', artist: 'Artists' }

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
      className="text-link back-to-search"
      onClick={() => void navigate({ to: '/search', search: lastSearch })}
    >
      ← Back to results
    </button>
  )
}

export function Badge({ item, job }: { item: MusicResult; job?: DownloadJob }) {
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
    <span
      className={`ownership ${failed ? 'failed' : item.ownership === 'edition' ? 'partial' : item.ownership}`}
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
    </span>
  )
}

function Art({ item }: { item: MusicResult }) {
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
    <div className={`result-art ${item.kind === 'artist' ? 'artist-art' : ''}`}>
      {item.art ? <img src={item.art} alt="" loading="lazy" /> : <Disc3 />}
      {item.kind === 'track' && (
        <button
          className="art-play"
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
    <article className="music-card">
      <Art item={item} />
      {item.kind === 'artist' ? (
        <Link
          className="card-primary-link"
          to="/artists/$artistId"
          params={{ artistId: String(item.id) }}
        >
          <span>{item.title}</span>
        </Link>
      ) : (
        <Link
          className="card-primary-link"
          to="/albums/$albumId"
          params={{ albumId: String(item.kind === 'album' ? item.id : item.album_id) }}
        >
          <span>{item.title}</span>
        </Link>
      )}
      <small>
        {item.kind === 'artist' ? (
          `${item.popularity.toLocaleString()} ${item.popularity === 1 ? 'fan' : 'fans'}`
        ) : (
          <>
            {display.artist_id ? (
              <Link
                className="card-secondary-link"
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
        <button className="text-link coverage-retry" onClick={() => void detail.refetch()}>
          Retry coverage
        </button>
      ) : (
        <Badge item={display} />
      )}
      {item.kind === 'album' && (
        <meter
          min={0}
          max={display.track_count || 1}
          value={display.owned_count}
          aria-label={`${item.title} library coverage`}
        />
      )}
      {item.kind === 'album' && (
        <>
          <AlbumDownloadButton item={display} />
          <DownloadTarget />
        </>
      )}
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
      className={`track-row${selected ? ' selected-track' : ''}`}
      id={`track-${item.id}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={focusable ? 0 : -1}
    >
      <Art item={item} />
      <div className="track-title">
        <strong>
          <Link
            to="/albums/$albumId"
            params={{ albumId: String(item.album_id) }}
            search={{ track: item.id }}
          >
            {item.title}
          </Link>{' '}
          {item.explicit && (
            <span className="explicit" title="Explicit">
              E
            </span>
          )}
        </strong>
        <Link to="/artists/$artistId" params={{ artistId: String(item.artist_id) }}>
          {item.artist}
        </Link>
      </div>
      <Link
        className="track-album"
        to="/albums/$albumId"
        params={{ albumId: String(item.album_id) }}
      >
        {item.album}
      </Link>
      <span className="track-year">{item.year ?? '…'}</span>
      <span className="track-duration">{durationText(item.duration)}</span>
      <Badge item={item} job={job} />
      <button
        className="text-preview"
        onClick={() => player.play(item)}
        disabled={noPreview}
        title={noPreview ? 'No preview available' : undefined}
      >
        {playing ? 'Pause' : noPreview ? 'No preview' : item.preview ? 'Preview' : 'Find preview'}
      </button>
      <DownloadButton item={item} />
    </div>
  )
}

function CardGrid({ items }: { items: MusicResult[] }) {
  return (
    <div className="music-grid">
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
    if (job.hidden) continue
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
      <div className="track-list" onKeyDown={handleKeyDown}>
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
      className="track-list virtual-list"
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

function ResultsSection({
  kind,
  state,
  compact,
  change,
}: {
  kind: 'track' | 'album' | 'artist'
  state: SearchState
  compact: boolean
  change: (patch: Partial<SearchState>) => void
}) {
  const query = useInfiniteQuery({
    queryKey: ['search', state.q, kind],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(
        `search?${new URLSearchParams({ q: state.q ?? '', kind, index: String(pageParam) })}`,
        searchPageSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next_index ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })
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
    <section className="results-section" aria-label={labels[kind]}>
      <div className="section-heading">
        <h2>{labels[kind]}</h2>
        {compact && (
          <button className="text-link" onClick={() => change({ tab: kind })}>
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
        <div className="error" role="alert">
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}
      {query.isPending && (
        <div className="search-skeleton" role="status">
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
        <p className="muted small">
          Release years unavailable.{' '}
          <button onClick={() => void yearQuery.refetch()}>Retry years</button>
        </p>
      )}
      {items.length > 0 &&
        (kind === 'track' ? (
          <TrackList items={items} resetScroll={resetScroll} />
        ) : (
          <CardGrid items={items} />
        ))}
      {!query.isPending && !query.isError && !items.length && (
        <p className="empty-results">
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
        <div className="best-result">
          <Headphones size={27} />
          <div>
            <small>TOP TRACK</small>
            <strong>{items[0].title}</strong>
            <span>
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
    <button className="button primary" onClick={() => player.play(item)}>
      {active ? <Pause size={16} /> : <Play size={16} />} {active ? 'Pause' : 'Preview'}
    </button>
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
  useEffect(() => {
    if (state.q) saveLastSearch(state)
  }, [state])
  if (!state.q || state.q.trim().length < 2)
    return (
      <div className="discovery-home">
        <span className="eyebrow">THE NEXT ADDITION TO YOUR COLLECTION</span>
        <h1>
          Find it.
          <br />
          <em>Make room for it.</em>
        </h1>
        <p>
          Search tracks, albums and artists. Listen to a preview and see what’s already in your
          library.
        </p>
        <div className="suggestions">
          {['Daft Punk', 'Khruangbin', 'Nina Simone', 'Radiohead'].map((q) => (
            <button className="button" key={q} onClick={() => change({ q })}>
              <Search size={14} />
              {q}
            </button>
          ))}
        </div>
        <div className="discovery-note">
          <Music2 size={24} />
          <span>
            Deezer catalog · Library-aware search
            <small>Start typing above. Two characters is enough.</small>
          </span>
        </div>
      </div>
    )
  if (/^https?:\/\//i.test(state.q.trim()))
    return (
      <section className="empty-panel">
        <h1>Pasting links is not supported yet.</h1>
        <p>Search by artist, album or track name for now.</p>
        <button className="button" onClick={() => change({ q: '' })}>
          Clear link
        </button>
      </section>
    )
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">DISCOVER YOUR NEXT FAVOURITE</span>
          <h1>Results for “{state.q}”</h1>
        </div>
      </div>
      <div className="search-toolbar">
        <div className="result-tabs" aria-label="Search type">
          {tabs.map((value) => (
            <button
              key={value}
              aria-pressed={tab === value}
              className={tab === value ? 'selected' : ''}
              onClick={() => change({ tab: value })}
            >
              {labels[value]}
            </button>
          ))}
        </div>
        <button className="button" aria-expanded={filters} onClick={() => setFilters(!filters)}>
          Filters
        </button>
        <label className="sort-control">
          Sort{' '}
          <select
            value={state.sort ?? 'relevance'}
            onChange={(e) => change({ sort: sorts.find((value) => value === e.target.value) })}
          >
            {sorts.map((value) => (
              <option key={value} value={value}>
                {value[0]?.toUpperCase()}
                {value.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(filters ||
        state.explicit ||
        state.from !== undefined ||
        state.until !== undefined ||
        state.min !== undefined ||
        state.max !== undefined ||
        state.preview ||
        state.library) && (
        <div className="filter-chips">
          <label>
            Lyrics
            <select
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
            </select>
          </label>
          <label>
            Year from
            <input
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
          <label>
            Year to
            <input
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
          <label>
            Minutes from
            <input
              aria-label="Minimum minutes"
              type="number"
              min="0"
              value={state.min ?? ''}
              onChange={(e) => change({ min: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label>
            Minutes to
            <input
              aria-label="Maximum minutes"
              type="number"
              min="0"
              value={state.max ?? ''}
              onChange={(e) => change({ max: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label>
            Library
            <select
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
            </select>
          </label>
          <label className="check-filter">
            <input
              type="checkbox"
              checked={state.preview ?? false}
              onChange={(e) => change({ preview: e.target.checked || undefined })}
            />
            Has preview
          </label>
          <button
            className="text-link"
            onClick={() =>
              void navigate({ to: '/search', search: { q: state.q, tab, sort: state.sort } })
            }
          >
            Clear filters
          </button>
        </div>
      )}
      <p className="result-hint">
        Filters and sort apply to loaded results. Years fill in as album details arrive. Duration
        and preview filters apply to tracks.
      </p>
      {(tab === 'top' ? (['track', 'album', 'artist'] as const) : [tab]).map((kind) => (
        <ResultsSection
          key={kind}
          kind={kind}
          state={state}
          compact={tab === 'top'}
          change={change}
        />
      ))}
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
      <div className="error" role="alert">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </div>
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
      <div className="album-header">
        <Art item={album} />
        <div>
          <span className="eyebrow">
            {album.record_type.toUpperCase()} · {album.year ?? 'Year unknown'}
          </span>
          <h1>{album.title}</h1>
          <Link to="/artists/$artistId" params={{ artistId: String(album.artist_id) }}>
            {album.artist}
          </Link>
          <p>
            {label} · {album.track_count} tracks · {durationText(duration)} · ~
            {Math.round((duration * bitrate) / 8 / 1024)} MB estimated
          </p>
          <Badge item={album} />
        </div>
      </div>
      <div className="album-actions">
        <label>
          Quality{' '}
          <select value={chosenQuality} onChange={(e) => setQuality(e.target.value)}>
            <option value="original">Original</option>
            <option value="m4a">M4A</option>
            <option value="opus">Opus</option>
            <option value="mp3">MP3</option>
          </select>
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
        <small>Size assumes {bitrate} kbps; actual source varies.</small>
        {editionCount > 0 && (
          <small>
            {editionCount} track{editionCount === 1 ? ' has' : 's have'} another edition in your
            library
          </small>
        )}
        <DownloadTarget format={chosenQuality} />
      </div>
      {!complete && (
        <p className="error">The catalog returned an incomplete track list. Coverage is partial.</p>
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
      <div className="error">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </div>
    )
  if (!query.data) return <p role="status">Loading artist…</p>
  const artist = query.data.pages[0]?.artist
  const items = [
    ...new Map(
      query.data.pages.flatMap((page) => page.items).map((item) => [item.id, item]),
    ).values(),
  ]
  const topTracks = top.data?.tracks.slice(0, 5) ?? []
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
      <div className="artist-header">
        {artist?.art && <img src={artist.art} alt="" />}
        <div>
          <span className="eyebrow">ARTIST</span>
          <h1>{artist?.name}</h1>
          <p>{items.length} releases loaded</p>
          <ArtistDownloadButton
            key={artistId}
            artistId={Number(artistId)}
            name={artist?.name ?? 'Artist'}
          />
        </div>
      </div>
      <section className="results-section" aria-labelledby="popular-songs-title">
        <div className="section-heading">
          <h2 id="popular-songs-title">Popular songs</h2>
        </div>
        {top.isPending && <p role="status">Loading popular songs…</p>}
        {top.isError && (
          <p className="error" role="alert">
            {top.error.message} <button onClick={() => void top.refetch()}>Retry</button>
          </p>
        )}
        {topTracks.length > 0 && <TrackList items={topTracks} />}
        {top.isSuccess && !topTracks.length && <p className="muted">No popular songs found.</p>}
      </section>
      <section className="results-section" aria-labelledby="popular-albums-title">
        <div className="section-heading">
          <h2 id="popular-albums-title">Popular albums</h2>
        </div>
        {(top.isPending || popularAlbumQueries.some((result) => result.isPending)) && (
          <p role="status">Finding popular albums…</p>
        )}
        {popularAlbumQueries.some((result) => result.isError) && (
          <p className="error" role="alert">
            Some popular albums could not be checked.{' '}
            <button
              onClick={() =>
                void Promise.all(popularAlbumQueries.map((result) => result.refetch()))
              }
            >
              Retry
            </button>
          </p>
        )}
        {popularAlbums.length > 0 && <CardGrid items={popularAlbums} />}
        {top.isSuccess &&
          popularAlbumQueries.every((result) => !result.isPending) &&
          !popularAlbums.length && <p className="muted">No popular albums found.</p>}
      </section>
      <section className="results-section" aria-labelledby="discography-title">
        <div className="section-heading artist-release-heading">
          <div>
            <h2 id="discography-title">Discography</h2>
            <small>
              {releases.length} shown · {items.length} releases loaded
            </small>
          </div>
          <div className="artist-release-controls">
            <label>
              Show
              <select
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
            <label>
              Sort
              <select
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
          <CardGrid items={releases} />
        ) : (
          <p className="muted">No releases match this view.</p>
        )}
      </section>
      <p className="muted small">
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
