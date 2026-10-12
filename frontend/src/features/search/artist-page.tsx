import { useMemo } from 'react'

import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useRouterState } from '@tanstack/react-router'

import { albumSchema, api, artistSchema, artistTopSchema } from '../../api'
import type { MusicResult } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { ErrorBanner } from '../../ui'
import { ArtistDownloadButton } from '../downloads/artist-download'
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
        {topTracks.length > 0 && <CatalogTrackList items={topTracks} />}
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
