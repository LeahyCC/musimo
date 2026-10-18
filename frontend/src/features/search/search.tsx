import { useEffect, useMemo, useRef, useState } from 'react'

import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Music2 } from 'lucide-react'

import { albumSchema, api, searchPageSchema, yearsSchema } from '../../api'
import type { MusicResult } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import {
  Button,
  EmptyPanel,
  ErrorBanner,
  Field,
  FieldSelect,
  SelectChip,
  textLinkClassName,
} from '../../ui'
import { PodcastResults } from '../podcasts/podcasts'
import { HomeShelves } from './home-shelves'
import { addSearch, readSearches, writeSearches } from './recent-searches'
import {
  AlbumDestination,
  AlbumRows,
  CardGrid,
  CatalogTrackList,
  resultsHeadingClassName,
  resultsTitleClassName,
} from './results'
import { SearchField } from './search-field'
import { saveLastSearch, sorts, tabs, validateSearch } from './search-params'
import type { SearchState } from './search-params'
import { TopResult } from './top-result'

/** How long a query must stand before the home page remembers it. */
const RECENT_SETTLE_MS = 1200

const labels = {
  top: 'Top',
  track: 'Tracks',
  album: 'Albums',
  artist: 'Artists',
  podcast: 'Podcasts',
}

function normalizedText(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
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
  const room = useLayout() === 'room'
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
    return compact
      ? filtered.slice(0, kind === 'track' || (room && kind === 'album') ? 5 : 6)
      : filtered
  }, [raw, yearQuery.data, state, kind, compact, coverage, room])
  return (
    <section className="mb-[30px]" aria-label={labels[kind]}>
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
          <CatalogTrackList items={items} resetScroll={resetScroll} />
        ) : (
          <>
            {kind === 'album' && <AlbumDestination />}
            {room && compact && kind === 'album' ? (
              <AlbumRows items={items} />
            ) : (
              <CardGrid items={items} />
            )}
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
    </section>
  )
}

function SearchBody({ room }: { room: boolean }) {
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
      <div className="mb-[24px] flex items-center gap-[8px] max-phone:mb-[16px] max-phone:flex-wrap">
        <div
          className="flex min-w-0 flex-none items-center gap-[6px] overflow-x-auto [scrollbar-width:none] max-phone:w-full"
          role="group"
          aria-label="Search type"
        >
          {tabs.map((value) => (
            <button
              key={value}
              data-ui="tab"
              aria-pressed={tab === value}
              className={cx(
                'h-[32px] flex-none rounded-pill px-[14px] text-body font-medium whitespace-nowrap coarse:min-h-11 max-phone:px-[12px]',
                room
                  ? tab === value
                    ? 'border-0 bg-text text-canvas'
                    : 'border-0 bg-raised text-muted hover:text-text'
                  : tab === value
                    ? 'border border-good-line bg-active text-text'
                    : 'border border-line bg-transparent text-muted hover:text-text',
              )}
              onClick={() => change({ tab: value })}
            >
              {labels[value]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {music ? (
          <div className="flex flex-none items-center gap-[8px] max-phone:w-full">
            <Button aria-expanded={filters} onClick={() => setFilters(!filters)}>
              Filters
            </Button>
            <SelectChip
              label="Sort"
              value={state.sort ?? 'relevance'}
              defaultValue="relevance"
              options={sorts.map((value) => ({
                value,
                label: `${value[0]?.toUpperCase()}${value.slice(1)}`,
              }))}
              onChange={(sort) => change({ sort })}
              className="max-phone:ml-auto"
            />
          </div>
        ) : null}
        {!room && music && (
          <span className="flex-none text-small text-faint max-tablet:hidden">
            Checked against your library
          </span>
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
      ) : tab === 'top' ? (
        <TopTab
          state={state}
          room={room}
          topArtist={artistResults.data?.pages[0]?.items[0]}
          change={change}
        />
      ) : (
        kinds.length > 0 && (
          <div className="pt-[4px]">
            {kinds.map((kind) => (
              <ResultsSection
                key={kind}
                kind={kind}
                state={state}
                compact={false}
                change={change}
              />
            ))}
          </div>
        )
      )}
    </>
  )
}

/**
 * The Top tab. Classic sets the best-matching artist beside the first tracks and runs the albums
 * under both as covers; the Listening room opens with the artist as a banner, then tracks and
 * albums side by side, the albums as rows.
 */
function TopTab({
  state,
  room,
  topArtist,
  change,
}: {
  state: SearchState
  room: boolean
  topArtist: MusicResult | undefined
  change: (patch: Partial<SearchState>) => void
}) {
  const section = (kind: ResultKind) => (
    <ResultsSection kind={kind} state={state} compact change={change} />
  )
  if (room)
    return (
      <>
        {topArtist && <TopResult artist={topArtist} room />}
        <div className="flex flex-wrap gap-x-[24px]">
          <div className="min-w-0 flex-[3_1_560px]">{section('track')}</div>
          <div className="min-w-0 flex-[2_1_300px]">{section('album')}</div>
        </div>
        {section('artist')}
      </>
    )
  return (
    <>
      <div className="flex flex-wrap gap-x-[24px]">
        {topArtist && (
          <div className="mb-[30px] min-w-0 flex-[1_1_300px]">
            <TopResult artist={topArtist} room={false} />
          </div>
        )}
        {/* A track row's fixed columns take about 400px, so below 560px the titles shrink to a
            letter or two. Under that the tracks drop below the top result instead. */}
        <div className="min-w-0 flex-[2_1_560px]">{section('track')}</div>
      </div>
      {section('album')}
      {section('artist')}
    </>
  )
}

export function SearchPage() {
  const room = useLayout() === 'room'
  return (
    <>
      <SearchField room={room} />
      <SearchBody room={room} />
    </>
  )
}
