import { useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Disc3, Search } from 'lucide-react'

import { api, libraryAlbumsSchema, playerCapabilitiesSchema } from './api'
import { readSearches, writeSearches } from './recent-searches'
import { Button, textLinkClassName } from './ui'

// What a new install shows before it has any searches of its own.
const STARTERS = ['Daft Punk', 'Khruangbin', 'Nina Simone', 'Radiohead']
const FRESH_COUNT = 6

function RecentSearches({ onSearch }: { onSearch: (q: string) => void }) {
  const [recent, setRecent] = useState(readSearches)
  if (!recent.length)
    return (
      <div className="flex flex-wrap gap-[10px]">
        {STARTERS.map((q) => (
          <Button key={q} onClick={() => onSearch(q)}>
            <Search size={14} />
            {q}
          </Button>
        ))}
      </div>
    )
  return (
    <section aria-labelledby="recent-searches-heading">
      <div className="mb-[12px] flex items-center justify-between gap-[12px]">
        <h2 id="recent-searches-heading" className="text-strong">
          Recent searches
        </h2>
        <button
          type="button"
          data-ui="text-link"
          className={textLinkClassName('text-small')}
          onClick={() => {
            writeSearches([])
            setRecent([])
          }}
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap gap-[10px]">
        {recent.map((q) => (
          <Button key={q} onClick={() => onSearch(q)}>
            <Search size={14} />
            {q}
          </Button>
        ))}
      </div>
    </section>
  )
}

/** The newest albums in the library, only once the library is set up and answering. */
function FreshInLibrary() {
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
  const fresh = useQuery({
    queryKey: ['home-fresh-albums'],
    queryFn: ({ signal }) =>
      api(`library/albums?q=&sort=newest&offset=0&size=${FRESH_COUNT}`, libraryAlbumsSchema, {
        signal,
      }),
    enabled: capabilities.data?.available === true,
    retry: false,
  })
  const albums = fresh.data?.items ?? []
  if (!albums.length) return null
  return (
    <section aria-labelledby="fresh-heading" className="mt-[40px]">
      <h2 id="fresh-heading" className="mb-[14px] text-strong">
        Fresh in your library
      </h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-[16px] p-0 max-phone:grid-cols-3 max-phone:gap-[12px]">
        {albums.map((album) => (
          <li key={album.id} className="min-w-0">
            <Link
              to="/library/albums/$albumId"
              params={{ albumId: album.id }}
              className="block text-text hover:text-accent"
            >
              {album.coverArt ? (
                <img
                  className="aspect-square w-full rounded-[8px] bg-raised object-cover"
                  src={`/api/player/art/${encodeURIComponent(album.coverArt)}`}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="grid aspect-square w-full place-items-center rounded-[8px] bg-raised text-muted">
                  <Disc3 size={28} />
                </span>
              )}
              <strong className="mt-[8px] block truncate text-small">{album.name}</strong>
              <span className="block truncate text-caption text-muted">{album.artist}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What the home page offers under its hero: a way back to earlier searches, and new arrivals. */
export function HomeShelves({ onSearch }: { onSearch: (q: string) => void }) {
  return (
    <div className="mt-[32px] mb-[60px] max-phone:mb-[35px]">
      <RecentSearches onSearch={onSearch} />
      <FreshInLibrary />
    </div>
  )
}
