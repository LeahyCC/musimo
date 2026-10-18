import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { api, libraryPlaylistsSchema, playerCapabilitiesSchema } from '../../api'
import type { LibraryPlaylist } from '../../api'
import { defaultLibrarySort } from '../../features/library/library-params'

/* What the sidebar shows besides its links: the album count, the playlists group and the version.
   Each is read-only and optional, so a failed request leaves the row bare rather than the sidebar
   broken. */

/** The playlists group shows Liked plus the most recently updated, this many rows in all. */
export const SIDEBAR_PLAYLISTS = 3

const albumTotalSchema = z.object({ total: z.number().default(0) })
const healthVersionSchema = z.object({ version: z.string() })

/** The library endpoints answer only once the music folder is set up, as the library page checks. */
function useLibraryReady() {
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
  return capabilities.data?.available === true
}

/** How many albums the library holds, or undefined until the server says. */
export function useAlbumCount() {
  const ready = useLibraryReady()
  // Its own key: the library page keeps its list under `library-albums` as an infinite query.
  const albums = useQuery({
    queryKey: ['library-album-count'],
    queryFn: ({ signal }) =>
      api(
        `library/albums?q=&sort=${defaultLibrarySort('albums')}&offset=0&size=1`,
        albumTotalSchema,
        { signal },
      ),
    enabled: ready,
    retry: false,
  })
  return albums.data?.total
}

/**
 * Liked first, then the playlists changed most recently, `SIDEBAR_PLAYLISTS` in all. There is no
 * pinning: recency is the only thing that decides which playlists get a row.
 */
export function pickSidebarPlaylists(
  playlists: readonly LibraryPlaylist[],
  likedId: string,
  limit = SIDEBAR_PLAYLISTS,
) {
  const liked = playlists.find((playlist) => playlist.id === likedId)
  const rest = playlists
    .filter((playlist) => playlist.id !== likedId)
    .sort((a, b) => b.changed.localeCompare(a.changed))
  return (liked ? [liked, ...rest] : rest).slice(0, limit)
}

export function useSidebarPlaylists() {
  const ready = useLibraryReady()
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: ready,
    retry: false,
  })
  const data = playlists.data
  if (!data) return { likedId: '', rows: [] }
  return { likedId: data.liked_id, rows: pickSidebarPlaylists(data.items, data.liked_id) }
}

/** The running server's version, or undefined until it answers. */
export function useServerVersion() {
  const health = useQuery({
    queryKey: ['server-version'],
    queryFn: ({ signal }) => api('health', healthVersionSchema, { signal }),
    staleTime: Infinity,
    retry: false,
  })
  return health.data?.version
}
