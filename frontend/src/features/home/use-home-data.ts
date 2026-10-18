import { useQuery } from '@tanstack/react-query'

import {
  api,
  diagnosticsSchema,
  libraryAlbumsSchema,
  libraryArtistsSchema,
  libraryPlaylistsSchema,
  libraryTracksSchema,
  playerCapabilitiesSchema,
} from '../../api'

export const FRESH_COUNT = 8

/** Whether the player answers, which every library query below waits for. */
export function useCapabilities() {
  return useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
}

/** Same key and request as the Diagnostics page, so the two share one answer. */
export function useDiagnostics() {
  return useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    // A scan changes the counts while the first-run page is open.
    refetchInterval: (query) => (query.state.data?.library.status === 'scanning' ? 2000 : false),
  })
}

/** The newest albums, and the size of the whole album list, from one request. */
export function useFreshAlbums() {
  const capabilities = useCapabilities()
  return useQuery({
    queryKey: ['home-fresh-albums'],
    queryFn: ({ signal }) =>
      api(`library/albums?q=&sort=newest&offset=0&size=${FRESH_COUNT}`, libraryAlbumsSchema, {
        signal,
      }),
    enabled: capabilities.data?.available === true,
    retry: false,
  })
}

/** Artist and song totals for the Classic header. One row is fetched; only the total is read. */
export function useLibraryCounts() {
  const capabilities = useCapabilities()
  const enabled = capabilities.data?.available === true
  const artists = useQuery({
    queryKey: ['home-artist-count'],
    queryFn: ({ signal }) =>
      api('library/artists?q=&sort=name&offset=0&size=1', libraryArtistsSchema, { signal }),
    enabled,
    retry: false,
  })
  const tracks = useQuery({
    queryKey: ['home-track-count'],
    queryFn: ({ signal }) =>
      api('library/tracks?q=&sort=title&offset=0&size=1', libraryTracksSchema, { signal }),
    enabled,
    retry: false,
  })
  return { artists: artists.data?.total, tracks: tracks.data?.total }
}

export function usePlaylists() {
  const capabilities = useCapabilities()
  return useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: capabilities.data?.available === true,
    retry: false,
  })
}

export type LibraryState = 'loading' | 'empty' | 'filled'

/**
 * Whether Home shows the dashboard or the first-run page. When the player answers, an empty album
 * list is an empty library. When it does not, the scan's own file count is the only other signal
 * the app has.
 */
export function useLibraryState(): LibraryState {
  const capabilities = useCapabilities()
  const diagnostics = useDiagnostics()
  const fresh = useFreshAlbums()
  if (capabilities.isPending) return 'loading'
  if (capabilities.data?.available) {
    if (fresh.isPending) return 'loading'
    return fresh.data && fresh.data.total === 0 ? 'empty' : 'filled'
  }
  if (diagnostics.isPending) return 'loading'
  return diagnostics.data?.library.total_files === 0 ? 'empty' : 'filled'
}
