import { lazy, Suspense } from 'react'

import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  redirect,
  useParams,
  useRouterState,
  useSearch,
} from '@tanstack/react-router'

import { SongAnalysisPage } from '../features/analysis/song-analysis'
import { DiagnosticsPage } from '../features/diagnostics/diagnostics'
import { DownloadsPage } from '../features/downloads/downloads'
import { HomePage } from '../features/home/home'
import {
  lastLibraryView,
  libraryPaths,
  validateArtistAlbumSearch,
  validateArtistSongSearch,
  validateLibrarySearch,
} from '../features/library/library-params'
import { MusicBotProvider } from '../features/music-bot/bot-chat'
import { MusicBotPage } from '../features/music-bot/music-bot'
import { PetHostProvider } from '../features/music-bot/pet-host'
import { PopoutProvider } from '../features/now-playing/now-playing-popout'
import { PlayerProvider } from '../features/player/player'
import { PodcastPage } from '../features/podcasts/podcasts'
import { AlbumPage } from '../features/search/album-page'
import { ArtistPage } from '../features/search/artist-page'
import { SearchPage } from '../features/search/search'
import { validateArtistSearch, validateSearch } from '../features/search/search-params'
import { SettingsPage } from '../features/settings/server-settings'
import { UserSettingsPage } from '../features/settings/user-settings'
import { EmptyPanel, ToastProvider } from '../ui'
import { Shell } from './shell'

const LibraryPage = lazy(() =>
  import('../features/library/library').then((module) => ({ default: module.LibraryPage })),
)
const NowPlayingPage = lazy(() =>
  import('../features/now-playing/now-playing-page').then((module) => ({
    default: module.NowPlayingPage,
  })),
)

function Root() {
  const page = useRouterState({ select: (state) => state.location.pathname })
  return (
    // Toasts sit outermost so the player and the music bot can raise one, not just the shell.
    <ToastProvider page={page}>
      <PlayerProvider>
        <MusicBotProvider>
          <PopoutProvider>
            <PetHostProvider>
              <Shell />
            </PetHostProvider>
          </PopoutProvider>
        </MusicBotProvider>
      </PlayerProvider>
    </ToastProvider>
  )
}

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <EmptyPanel>
      <h1>Page not found</h1>
      <Link to="/">Back to Musimo</Link>
    </EmptyPanel>
  ),
})
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
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

// Library has no page of its own. It opens the view it was last on in this visit, or Artists, the
// first tab; that view then brings back its own filters. The Library tabs, the palette and an
// old link or bookmark all come in this way, and a link's own filters are kept.
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  beforeLoad: ({ search }) => {
    const view = lastLibraryView()
    throw redirect({
      to: libraryPaths[view],
      search: validateLibrarySearch(view, search),
      replace: true,
    })
  },
})
const libraryAlbumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/albums',
  validateSearch: (search: Record<string, unknown>) => validateLibrarySearch('albums', search),
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
  validateSearch: (search: Record<string, unknown>) => validateLibrarySearch('artists', search),
  component: () => <LibraryScreen view="artists" />,
})
const libraryArtistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId',
  validateSearch: validateArtistAlbumSearch,
  component: function LibraryArtistRoute() {
    const { artistId } = useParams({ from: '/library/artists/$artistId' })
    return <LibraryScreen view="artists" artistId={artistId} />
  },
})
const libraryArtistSongsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId/songs',
  validateSearch: validateArtistSongSearch,
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
  validateSearch: (search: Record<string, unknown>) => validateLibrarySearch('tracks', search),
  component: () => <LibraryScreen view="tracks" />,
})
const libraryPlaylistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/playlists',
  validateSearch: (search: Record<string, unknown>) => validateLibrarySearch('playlists', search),
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
// Song analysis: measure tempo and energy, listen, and switch it on for Octive. Linked from Server
// settings under Music bot.
const libraryAnalysisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/analysis',
  component: SongAnalysisPage,
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
const musicBotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/music-bot',
  // Home's Octive chips pass what to ask as ?prompt=.
  validateSearch: (search: Record<string, unknown>): { prompt?: string } =>
    typeof search.prompt === 'string' && search.prompt.trim() ? { prompt: search.prompt } : {},
  component: MusicBotPage,
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
    libraryAnalysisRoute,
    nowPlayingRoute,
    downloadsRoute,
    settingsRoute,
    musicBotRoute,
    userSettingsRoute,
    diagnosticsRoute,
  ]),
  defaultPreload: 'intent',
  // Come back to where a list was left, not its top. On the library lists the key is the
  // address rather than the history entry, so the library's own Back link — which opens
  // the list afresh — restores the same place the browser's Back button does. Everywhere
  // else the history entry is the key, so opening a detail page a second time starts at
  // its top and each search address does not grow its own saved position. `#main` is the
  // Listening room's scrolling pane; the window is Classic's and a phone's. Both are
  // named as scroll-to-top selectors so a page with no remembered place starts at its top.
  scrollRestoration: true,
  getScrollRestorationKey: (location) =>
    /^\/library\/(albums|artists|tracks|playlists)$/.test(location.pathname)
      ? location.href
      : (location.state?.__TSR_key ?? location.href),
  scrollToTopSelectors: ['window', '#main'],
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
