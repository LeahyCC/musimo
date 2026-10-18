import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, Check } from 'lucide-react'

import { api, artistSchema } from '../../api'
import type { MusicResult } from '../../api'
import { cx } from '../../lib/cx'
import { Button, CoverageBar } from '../../ui'
import { ArtistDownloadButton } from '../downloads/artist-download'
import { useJobs } from '../downloads/jobs'
import { releaseCoverage } from './coverage'

/**
 * The artist the search matched best, with how much of their catalog the library holds. The counts
 * come from the releases the artist page loads (the same query, so opening the page costs nothing
 * more) and are estimates until each album has been checked; "other edition" is only known per
 * track, so it is left out here.
 */
export function TopResult({ artist, room }: { artist: MusicResult; room: boolean }) {
  const releases = useInfiniteQuery({
    queryKey: ['artist', String(artist.id)],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(`artists/${artist.id}?index=${pageParam}`, artistSchema, { signal }),
    getNextPageParam: (page) => page.next_index ?? undefined,
    staleTime: 86_400_000,
    retry: false,
  })
  const jobs = useJobs((data) => data.jobs).data
  const items = releases.data?.pages.flatMap((page) => page.items) ?? []
  const counts = releaseCoverage(items, jobs ?? [])
  const ownedSongs = counts?.owned ?? 0
  // The button opens the albums-only sheet, so its count leaves singles and EPs out too.
  const albums = releaseCoverage(
    items.filter((release) => release.record_type === 'album'),
    jobs ?? [],
  )
  const missing = albums?.missing
  // Only the first page of releases is loaded, so "nothing missing" holds only when that is all.
  const nothingMissing = missing === 0 && !releases.hasNextPage
  const name = (
    <Link
      to="/artists/$artistId"
      params={{ artistId: String(artist.id) }}
      className={cx(
        'card-primary-link block font-semibold tracking-[-0.6px] text-text hover:text-text',
        room ? 'mt-[4px] text-[24px]' : 'mt-[16px] text-[24px]',
      )}
    >
      {artist.title}
    </Link>
  )
  const portrait = artist.art ? (
    <img
      src={artist.art}
      alt=""
      className={cx('shrink-0 rounded-pill object-cover', room ? 'size-[72px]' : 'size-[96px]')}
    />
  ) : (
    <div className={cx('shrink-0 rounded-pill bg-active', room ? 'size-[72px]' : 'size-[96px]')} />
  )

  if (room)
    return (
      <section
        aria-label="Top result"
        data-ui="top-result"
        className="relative isolate mb-[24px] flex flex-wrap items-center gap-x-[24px] gap-y-[18px] rounded-[18px] bg-raised px-[20px] py-[18px]"
      >
        {portrait}
        <div className="min-w-0 flex-[1_1_220px]">
          <div className="font-mono text-tiny tracking-[0.6px] text-faint">ARTIST · TOP RESULT</div>
          {name}
          {counts ? (
            <CoverageBar {...counts} className="mt-[12px]" />
          ) : (
            (releases.isPending || releases.isError) && (
              <p className="mt-[12px] text-small text-faint" role="status">
                {releases.isError ? 'Library counts are unavailable.' : 'Checking your library…'}
              </p>
            )
          )}
        </div>
        <ArtistDownloadButton
          artistId={artist.id}
          name={artist.title}
          trigger={(open) => (
            <Button
              variant="primary"
              className="relative z-raised"
              disabled={nothingMissing}
              onClick={() => open(false)}
            >
              <ArrowDownToLine size={16} />
              {nothingMissing
                ? 'Nothing missing'
                : missing
                  ? `Get the ${missing} missing`
                  : 'Get missing albums'}
            </Button>
          )}
        />
      </section>
    )

  return (
    <section aria-labelledby="top-result-title" data-ui="top-result">
      <h2 id="top-result-title" className="mb-[14px] text-base">
        Top result
      </h2>
      <div className="relative isolate rounded-[14px] border border-line bg-raised p-[20px] hover:border-good-line">
        {portrait}
        {name}
        <div className="mt-[6px] flex flex-wrap items-center gap-[8px] text-small text-muted">
          Artist
          {items.length > 0 &&
            ` · ${items.length} releases${releases.hasNextPage ? ' so far' : ''}`}
          {counts && ownedSongs > 0 && (
            <span className="inline-flex items-center gap-[4px] rounded-[4px] bg-owned-bg px-[7px] py-[3px] text-tiny text-accent">
              <Check size={11} aria-hidden="true" />
              {ownedSongs} {ownedSongs === 1 ? 'song' : 'songs'} in library
            </span>
          )}
        </div>
        <div className="mt-[18px] flex flex-wrap gap-[8px]">
          <ArtistDownloadButton
            artistId={artist.id}
            name={artist.title}
            trigger={(open) => (
              <Button className="relative z-raised" onClick={() => open(false)}>
                <ArrowDownToLine size={15} />
                Get missing albums
              </Button>
            )}
          />
        </div>
      </div>
    </section>
  )
}
