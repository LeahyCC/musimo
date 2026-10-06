import { lazy, Suspense } from 'react'

import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  useParams,
  useSearch,
} from '@tanstack/react-router'

import { DiagnosticsPage } from '../features/diagnostics/diagnostics'
import { DownloadsPage } from '../features/downloads/downloads'
import { PopoutProvider } from '../features/now-playing/now-playing-popout'
import { PlayerProvider } from '../features/player/player'
import { PodcastPage } from '../features/podcasts/podcasts'
import { AlbumPage } from '../features/search/album-page'
import { ArtistPage } from '../features/search/artist-page'
import { SearchPage } from '../features/search/search'
import { validateArtistSearch, validateSearch } from '../features/search/search-params'
import { SettingsPage } from '../features/settings/server-settings'
import { UserSettingsPage } from '../features/settings/user-settings'
import { EmptyPanel } from '../ui'
import { Shell } from './shell'

const LibraryPage = lazy(() =>
  import('../features/library/library').then((module) => ({ default: module.LibraryPage })),
)
const NowPlayingPage = lazy(() =>
  import('../features/now-playing/now-playing-page').then((module) => ({
    default: module.NowPlayingPage,
  })),
)

const rootRoute = createRootRoute({
  component: () => (
    <PlayerProvider>
      <PopoutProvider>
        <Shell />
      </PopoutProvider>
    </PlayerProvider>
  ),
  notFoundComponent: () => (
    <EmptyPanel>
      <h1>Page not found</h1>
      <Link to="/search">Back to Musimo</Link>
    </EmptyPanel>
  ),
})
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SearchPage,
})
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch,
  component: SearchPage,
})
const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/albums/$albumId',
  validateSearch: (search: Record<string, unknown>): { track?: number } => ({
    track:
      Number.isSafeInteger(Number(search.track)) && Number(search.track) > 0
        ? Number(search.track)
        : undefined,
  }),
  component: AlbumPage,
})
const artistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artists/$artistId',
  validateSearch: validateArtistSearch,
  component: ArtistPage,
})
const podcastRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/podcasts/$podcastId',
  component: PodcastPage,
})
const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/downloads',
  component: DownloadsPage,
})

function LibraryScreen({
  view,
  albumId,
  artistId,
  playlistId,
  parentArtistId,
  artistSection,
  highlightTrackId,
}: {
  view?: 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'
  albumId?: string
  artistId?: string
  playlistId?: string
  parentArtistId?: string
  artistSection?: 'albums' | 'songs'
  highlightTrackId?: string
}) {
  return (
    <Suspense fallback={<p role="status">Opening your library…</p>}>
      <LibraryPage
        view={view}
        albumId={albumId}
        artistId={artistId}
        playlistId={playlistId}
        parentArtistId={parentArtistId}
        artistSection={artistSection}
        highlightTrackId={highlightTrackId}
      />
    </Suspense>
  )
}

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: () => <LibraryScreen />,
})
const libraryAlbumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/albums',
  component: () => <LibraryScreen view="albums" />,
})
const libraryAlbumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/albums/$albumId',
  // The song to mark as playing, put there by Now Playing's About tab. The router reads a value of
  // only digits as a number, so it is turned back into the id's text.
  validateSearch: (search: Record<string, unknown>): { track?: string } => {
    const { track } = search
    const named = (typeof track === 'string' || typeof track === 'number') && track !== ''
    return { track: named ? String(track).slice(0, 200) : undefined }
  },
  component: function LibraryAlbumRoute() {
    const { albumId } = useParams({ from: '/library/albums/$albumId' })
    const { track } = useSearch({ from: '/library/albums/$albumId' })
    return <LibraryScreen view="albums" albumId={albumId} highlightTrackId={track} />
  },
})
const libraryArtistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists',
  component: () => <LibraryScreen view="artists" />,
})
const libraryArtistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId',
  component: function LibraryArtistRoute() {
    const { artistId } = useParams({ from: '/library/artists/$artistId' })
    return <LibraryScreen view="artists" artistId={artistId} />
  },
})
const libraryArtistSongsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId/songs',
  component: function LibraryArtistSongsRoute() {
    const { artistId } = useParams({ from: '/library/artists/$artistId/songs' })
    return <LibraryScreen view="artists" artistId={artistId} artistSection="songs" />
  },
})
const libraryArtistAlbumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId/albums/$albumId',
  component: function LibraryArtistAlbumRoute() {
    const { albumId, artistId } = useParams({
      from: '/library/artists/$artistId/albums/$albumId',
    })
    return <LibraryScreen view="artists" albumId={albumId} parentArtistId={artistId} />
  },
})
const libraryTracksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/tracks',
  component: () => <LibraryScreen view="tracks" />,
})
const libraryPlaylistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/playlists',
  component: () => <LibraryScreen view="playlists" />,
})
const libraryPlaylistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/playlists/$playlistId',
  component: function LibraryPlaylistRoute() {
    const { playlistId } = useParams({ from: '/library/playlists/$playlistId' })
    return <LibraryScreen view="playlists" playlistId={playlistId} />
  },
})
const nowPlayingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/now-playing',
  component: () => (
    <Suspense fallback={<p role="status">Opening the player…</p>}>
      <NowPlayingPage />
    </Suspense>
  ),
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})
const userSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/user',
  component: UserSettingsPage,
})
const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: DiagnosticsPage,
})
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    searchRoute,
    albumRoute,
    artistRoute,
    podcastRoute,
    libraryRoute,
    libraryAlbumsRoute,
    libraryAlbumRoute,
    libraryArtistsRoute,
    libraryArtistRoute,
    libraryArtistSongsRoute,
    libraryArtistAlbumRoute,
    libraryTracksRoute,
    libraryPlaylistsRoute,
    libraryPlaylistRoute,
    nowPlayingRoute,
    downloadsRoute,
    settingsRoute,
    userSettingsRoute,
    diagnosticsRoute,
  ]),
  defaultPreload: 'intent',
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
