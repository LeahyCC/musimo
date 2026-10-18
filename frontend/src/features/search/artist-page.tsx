import { useMemo } from 'react'

import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { ArrowDownToLine, ListMusic } from 'lucide-react'

import { albumSchema, api, artistSchema, artistTopSchema } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { Button, ErrorBanner, SelectChip } from '../../ui'
import { ArtistDownloadButton } from '../downloads/artist-download'
import { DownloadTarget } from '../downloads/download-target'
import { useJobs } from '../downloads/jobs'
import { CatalogHero, HeroDestination } from './catalog-hero'
import { releaseCoverage } from './coverage'
import {
  AlbumDestination,
  BackToSearch,
  CardGrid,
  CatalogTrackList,
  resultsHeadingClassName,
  resultsTitleClassName,
} from './results'
import { validateArtistSearch } from './search-params'
import type { ArtistSearch } from './search-params'

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
  const jobs = useJobs((data) => data.jobs).data
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
  const releaseType = state.type ?? 'all'
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
  const albums = releases.filter((item) => item.record_type === 'album')
  const singlesAndEps = releases.filter((item) => item.record_type !== 'album')
  const loadedAlbums = items.filter((item) => item.record_type === 'album').length
  return (
    <div className="[container-type:inline-size]">
      <BackToSearch />
      <CatalogHero
        cover={
          artist?.art ? (
            <img
              src={artist.art}
              alt=""
              className="aspect-square w-full rounded-pill object-cover shadow-[0_24px_50px_-24px_color-mix(in_oklab,var(--color-shadow)_80%,transparent)]"
            />
          ) : (
            <div className="aspect-square w-full rounded-pill bg-active" />
          )
        }
        eyebrow="Artist"
        source="Deezer"
        title={artist?.name ?? ''}
        meta={`${loadedAlbums} albums · ${items.length - loadedAlbums} singles & EPs${query.hasNextPage ? ' so far' : ''}`}
        coverage={items.length ? releaseCoverage(items, jobs ?? []) : undefined}
        actions={
          <ArtistDownloadButton
            key={artistId}
            artistId={Number(artistId)}
            name={artist?.name ?? 'Artist'}
            trigger={(open) => (
              <>
                <Button
                  variant="primary"
                  aria-label="Download all albums"
                  onClick={() => open(false)}
                >
                  <ArrowDownToLine size={16} />
                  Download all albums…
                </Button>
                <Button aria-label="Download all music" onClick={() => open(true)}>
                  <ListMusic size={15} />
                  Download all music…
                </Button>
                <HeroDestination>
                  <DownloadTarget />
                </HeroDestination>
              </>
            )}
          />
        }
      />
      <section className="mb-[30px]" aria-labelledby="popular-songs-title">
        <div className={resultsHeadingClassName}>
          <h2 id="popular-songs-title" className={resultsTitleClassName}>
            Popular
          </h2>
        </div>
        {top.isPending && <p role="status">Loading popular songs…</p>}
        {top.isError && (
          <ErrorBanner role="alert">
            {top.error.message} <button onClick={() => void top.refetch()}>Retry</button>
          </ErrorBanner>
        )}
        {topTracks.length > 0 && <CatalogTrackList items={topTracks} />}
        {top.isSuccess && !topTracks.length && (
          <p className="text-muted">No popular songs found.</p>
        )}
      </section>
      <div
        className="mb-[16px] flex flex-wrap items-center gap-[8px]"
        role="group"
        aria-label="Release filters"
      >
        <SelectChip
          label="Show"
          value={releaseType}
          defaultValue="all"
          options={[
            { value: 'all', label: 'All releases' },
            { value: 'albums-eps', label: 'Albums and EPs' },
            { value: 'album', label: 'Albums' },
            { value: 'ep', label: 'EPs' },
            { value: 'single', label: 'Singles' },
          ]}
          onChange={(type) => change({ type })}
        />
        <SelectChip
          label="Sort"
          value={releaseSort}
          defaultValue="newest"
          options={[
            { value: 'newest', label: 'Newest' },
            { value: 'oldest', label: 'Oldest' },
            { value: 'title', label: 'Title A to Z' },
            { value: 'title-desc', label: 'Title Z to A' },
          ]}
          onChange={(sort) => change({ sort })}
        />
        <small className="text-faint">
          {releases.length} shown · {items.length} releases loaded
        </small>
      </div>
      {(
        [
          ['albums-title', 'Albums', albums],
          ['singles-title', 'Singles & EPs', singlesAndEps],
        ] as const
      ).map(([id, title, group], index) =>
        group.length > 0 ? (
          <section key={id} className="mb-[30px]" aria-labelledby={id}>
            <div className="mb-[14px] flex items-baseline gap-[10px]">
              <h2 id={id} className="text-base">
                {title}
              </h2>
              <span className="font-mono text-tiny text-faint">{group.length}</span>
            </div>
            {/* One line about where downloads go, above the first grid that has cards. */}
            {(index === 0 || albums.length === 0) && <AlbumDestination />}
            <CardGrid items={group} />
          </section>
        ) : null,
      )}
      {releases.length === 0 && <p className="text-muted">No releases match this view.</p>}
      <p className="text-small text-faint">
        Popular songs come from Deezer. Counts are estimated from each release's track list and your
        library's tags, so "other edition" shows only on an album's own page. Review alternative
        editions before downloading an artist.
      </p>
      {query.hasNextPage && (
        <InfiniteScroll
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
    </div>
  )
}
