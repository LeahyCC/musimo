import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Disc3,
  Heart,
  Library,
  ListMusic,
  Pencil,
  Plus,
  Search,
  Shuffle,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react'

import {
  api,
  emptySchema,
  libraryAlbumDetailSchema,
  libraryAlbumsSchema,
  libraryArtistDetailSchema,
  libraryArtistsSchema,
  libraryArtistTracksSchema,
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  librarySelectionSchema,
  libraryTrackSearchSchema,
  libraryTracksSchema,
  playerCapabilitiesSchema,
} from '../../api'
import type { LibraryAlbum, LibraryArtist, LibraryPlaylist, LibraryTrack } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { ReviewDialog } from '../../components/review-sheet'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { usePhone } from '../../lib/use-phone'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  Field,
  FieldSelect,
  InlineError,
  sectionCaptionClassName,
  sectionHeadingClassName,
  textLinkClassName,
} from '../../ui'
import { remember, songCount, stored, usePlayer, usePlaylistSongs } from '../player/player'
import { queueActions } from '../player/queue-actions'
import { albumCountLabel, type AlbumGroup, groupAlbumEditions, yearSpan } from './album-editions'
import { CollectionCover, CollectionHeader } from './collection-header'
import {
  AlbumItem,
  ArtistItem,
  browseGridClass,
  browseListClass,
  collectionArtClass,
  CollectionPlayButton,
  collectionRowClass,
  cover,
  FilterMenu,
  LayoutToggle,
  PlaylistRow,
  type ViewMode,
} from './collection-items'
import { artistPageLocation, useArtistSort, useLibraryBrowse } from './library-browse'
import { artistAlbumSorts, artistSongSorts, librarySortValues } from './library-params'
import { LibraryHeading, LibraryToolbar, SearchField, type TabCounts } from './library-toolbar'
import { PopularityChart } from './popularity-chart'
import { TrackList } from './track-list'

export type LibraryTab = 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'
type Tab = LibraryTab

type ArtistSection = 'albums' | 'songs'
type Collection = 'album' | 'artist' | 'playlist'

type LibraryPageProps = {
  view?: Tab
  albumId?: string
  artistId?: string
  playlistId?: string
  parentArtistId?: string
  artistSection?: ArtistSection
  /** A song of the open album to mark, from the About tab's "Open album" link. */
  highlightTrackId?: string
}

// Labels for librarySortValues. The value list lives in one place, so a sort the address
// accepts is one the menu can show.
const sortLabels = {
  home: {
    newest: 'Recently added',
    title: 'Album A to Z',
    artist: 'Artist A to Z',
    year: 'Newest release',
  },
  albums: {
    newest: 'Recently added',
    title: 'Album A to Z',
    artist: 'Artist A to Z',
    year: 'Newest release',
  },
  artists: {
    name: 'Artist A to Z',
    albums: 'Most albums',
    recent: 'Recently added',
  },
  tracks: {
    title: 'Track A to Z',
    artist: 'Artist A to Z',
    album: 'Album A to Z',
    year: 'Newest release',
    duration: 'Longest first',
    newest: 'Recently added',
  },
  playlists: {
    name: 'Playlist A to Z',
    tracks: 'Most tracks',
    duration: 'Longest first',
    changed: 'Recently updated',
  },
} as const satisfies {
  [K in Tab]: Record<(typeof librarySortValues)[K][number], string>
}
const artistAlbumLabels = {
  year: 'Newest release',
  oldest: 'Oldest release',
  title: 'Album A to Z',
  plays: 'Most played',
} as const satisfies Record<(typeof artistAlbumSorts)[number], string>
const artistSongLabels = {
  album: 'Album order',
  title: 'Track A to Z',
  plays: 'Most played',
  duration: 'Longest first',
  year: 'Newest release',
} as const satisfies Record<(typeof artistSongSorts)[number], string>

const viewSorts = {
  home: librarySortValues.home.map((value) => ({ value, label: sortLabels.home[value] })),
  albums: librarySortValues.albums.map((value) => ({ value, label: sortLabels.albums[value] })),
  artists: librarySortValues.artists.map((value) => ({ value, label: sortLabels.artists[value] })),
  tracks: librarySortValues.tracks.map((value) => ({ value, label: sortLabels.tracks[value] })),
  playlists: librarySortValues.playlists.map((value) => ({
    value,
    label: sortLabels.playlists[value],
  })),
}

/** A whole collection's length for a page header: "42 min", or "1 hr 4 min" from an hour up. */
const totalLength = (seconds: number) => {
  if (seconds <= 0) return ''
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

const sumDuration = (songs: LibraryTrack[]) => songs.reduce((sum, song) => sum + song.duration, 0)

const textCompare = (left = '', right = '') =>
  left.localeCompare(right, undefined, { numeric: true })

type AlbumEditions = AlbumGroup<LibraryAlbum>

/** A group of editions sorts as one album: its newest or oldest year, and all its plays. */
function sortArtistAlbums(groups: AlbumEditions[], sort: string) {
  const years = (group: AlbumEditions) => group.editions.map((item) => item.album.year)
  const newest = (group: AlbumEditions) => Math.max(-1, ...years(group).map((year) => year ?? -1))
  const oldest = (group: AlbumEditions) =>
    Math.min(Number.MAX_SAFE_INTEGER, ...years(group).map((y) => y ?? Number.MAX_SAFE_INTEGER))
  const plays = (group: AlbumEditions) =>
    group.editions.reduce((sum, item) => sum + item.album.playCount, 0)
  // Both date orders push an undated album to the end rather than pretending it is oldest.
  return [...groups].sort((a, b) => {
    if (sort === 'title') return textCompare(a.name, b.name)
    if (sort === 'plays') return plays(b) - plays(a) || textCompare(a.name, b.name)
    if (sort === 'oldest') return oldest(a) - oldest(b)
    return newest(b) - newest(a) || textCompare(a.name, b.name)
  })
}

function sortArtistSongs(songs: LibraryTrack[], sort: string) {
  return [...songs].sort((a, b) => {
    if (sort === 'title') return textCompare(a.title, b.title)
    if (sort === 'plays') return b.playCount - a.playCount || textCompare(a.title, b.title)
    if (sort === 'duration') return b.duration - a.duration || textCompare(a.title, b.title)
    if (sort === 'year') return (b.year ?? -1) - (a.year ?? -1) || textCompare(a.title, b.title)
    return textCompare(a.album, b.album) || (a.track ?? 0) - (b.track ?? 0)
  })
}

async function collectionTracks(kind: Collection, id: string) {
  if (kind === 'album')
    return (await api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema)).song
  if (kind === 'playlist')
    return (await api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema))
      .entry
  return (await api(`library/artists/${encodeURIComponent(id)}/tracks`, libraryArtistTracksSchema))
    .items
}

export function LibraryPage({
  view = 'home',
  albumId = '',
  artistId = '',
  playlistId = '',
  parentArtistId = '',
  artistSection = 'albums',
  highlightTrackId = '',
}: LibraryPageProps = {}) {
  const player = usePlayer()
  const client = useQueryClient()
  const navigate = useNavigate()
  const tab = view
  const shell = useLayout()
  const room = shell === 'room'
  const phone = usePhone()
  const filterSheet = useRef<HTMLDialogElement>(null)
  const filterSheetTitle = useId()
  const editionsSheet = useRef<HTMLDialogElement>(null)
  const editionsSheetTitle = useId()
  const [openGroupKey, setOpenGroupKey] = useState('')
  const [layout, setLayout] = useState<ViewMode>(() =>
    stored('musimo.library-layout', 'grid') === 'list' ? 'list' : 'grid',
  )
  const showBrowser = !albumId && !artistId && !playlistId
  const artistSongsMode = artistSection === 'songs'
  const browse = useLibraryBrowse(tab, showBrowser)
  const artistOrdering = useArtistSort(
    artistId && !albumId ? (artistSongsMode ? 'songs' : 'albums') : null,
    artistId,
  )
  const { deferredQuery } = browse
  const sort = browse.sort
  const selectedGenres = browse.genres
  const selectedYears = browse.years
  const visibility = browse.visibility
  const artistShow = browse.show
  const [newName, setNewName] = useState('')
  const [showPlaylistForm, setShowPlaylistForm] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [playlistTrackQuery, setPlaylistTrackQuery] = useState('')
  const deferredPlaylistQuery = useDeferredValue(playlistTrackQuery.trim())
  const capabilities = useQuery({
    queryKey: ['player-capabilities'],
    queryFn: ({ signal }) => api('player/capabilities', playerCapabilitiesSchema, { signal }),
    retry: false,
  })
  const ready = capabilities.data?.available === true
  // Albums, artists and tracks are all filtered and sorted by the server, so a filter covers
  // the whole library rather than the pages this browser has scrolled through.
  const albumSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    return params.toString()
  }, [deferredQuery, selectedGenres, selectedYears, sort])
  const albums = useInfiniteQuery({
    queryKey: ['library-albums', albumSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/albums?${albumSearch}&offset=${pageParam}&size=60`, libraryAlbumsSchema, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: ready && (tab === 'home' || tab === 'albums'),
  })
  const artistSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    if (artistShow) params.set('show', artistShow)
    return params.toString()
  }, [artistShow, deferredQuery, selectedGenres, selectedYears, sort])
  const artists = useInfiniteQuery({
    queryKey: ['library-artists', artistSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/artists?${artistSearch}&offset=${pageParam}&size=100`, libraryArtistsSchema, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: ready && tab === 'artists',
  })
  // Search, filter, sort, totals and shuffle are the server's job so they cover the whole
  // library rather than the pages this browser happens to have scrolled through.
  const trackSearch = useMemo(() => {
    const params = new URLSearchParams({ q: deferredQuery, sort })
    for (const genre of selectedGenres) params.append('genre', genre)
    for (const year of selectedYears) params.append('year', year)
    return params.toString()
  }, [deferredQuery, selectedGenres, selectedYears, sort])
  const tracks = useInfiniteQuery({
    queryKey: ['library-tracks', trackSearch],
    queryFn: ({ pageParam, signal }) =>
      api(`library/tracks?${trackSearch}&offset=${pageParam}&size=100`, libraryTracksSchema, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next_offset ?? undefined,
    enabled: ready && tab === 'tracks',
    // Without this a filter change empties the filter menus and disables Play all until the
    // new page lands, which on a large library is seconds.
    placeholderData: keepPreviousData,
  })
  // The Listening room's view strip shows every view's size, so it asks each list for its total
  // (one row is enough, the total rides on the page).
  const viewCounts = useQuery({
    queryKey: ['library-view-counts'],
    queryFn: async ({ signal }): Promise<TabCounts> => {
      const [albumPage, artistPage, trackPage, playlistPage] = await Promise.all([
        api('library/albums?size=1', libraryAlbumsSchema, { signal }),
        api('library/artists?size=1', libraryArtistsSchema, { signal }),
        api('library/tracks?size=1', libraryTracksSchema, { signal }),
        api('library/playlists', libraryPlaylistsSchema, { signal }),
      ])
      return {
        albums: albumPage.total,
        artists: artistPage.total,
        tracks: trackPage.total,
        playlists: playlistPage.items.length,
      }
    },
    enabled: ready && shell === 'room' && showBrowser,
  })
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: ready && (tab === 'playlists' || Boolean(playlistId)),
  })
  const albumDetail = useQuery({
    queryKey: ['library-album', albumId],
    queryFn: ({ signal }) =>
      api(`library/albums/${encodeURIComponent(albumId)}`, libraryAlbumDetailSchema, { signal }),
    enabled: ready && Boolean(albumId),
  })
  const artistDetail = useQuery({
    queryKey: ['library-artist', artistId],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(artistId)}`, libraryArtistDetailSchema, { signal }),
    enabled: ready && Boolean(artistId),
  })
  const artistTracks = useQuery({
    queryKey: ['library-artist-tracks', artistId],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(artistId)}/tracks`, libraryArtistTracksSchema, {
        signal,
      }),
    enabled: ready && Boolean(artistId),
  })
  // The player writes to this same key, so adding a song there shows here without a reload.
  const playlistDetail = useQuery({
    queryKey: ['library-playlist', playlistId],
    queryFn: ({ signal }) =>
      api(`library/playlists/${encodeURIComponent(playlistId)}`, libraryPlaylistDetailSchema, {
        signal,
      }),
    enabled: ready && Boolean(playlistId),
  })
  // One upstream page is all this box needs, and the value is deferred so a keystroke does
  // not start a request of its own.
  const playlistTracks = useQuery({
    queryKey: ['library-track-search', deferredPlaylistQuery],
    queryFn: ({ signal }) =>
      api(
        `library/tracks/search?q=${encodeURIComponent(deferredPlaylistQuery)}&size=20`,
        libraryTrackSearchSchema,
        { signal },
      ),
    enabled: ready && Boolean(playlistId) && Boolean(deferredPlaylistQuery),
  })
  const createPlaylist = useMutation({
    mutationFn: (name: string) =>
      api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: (playlist) => {
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      void client.invalidateQueries({ queryKey: ['library-view-counts'] })
      setShowPlaylistForm(false)
      setNewName('')
      void navigate({
        to: '/library/playlists/$playlistId',
        params: { playlistId: playlist.id },
      })
    },
  })
  const renamePlaylist = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`library/playlists/${encodeURIComponent(id)}`, libraryPlaylistDetailSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    onSuccess: (playlist) => {
      client.setQueryData(['library-playlist', playlist.id], playlist)
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      // Liked is read under its own key by the footer player, so a rename has to reach it.
      void client.invalidateQueries({ queryKey: ['library-playlist-liked'] })
      setRenaming(false)
    },
  })
  const playlistSongs = usePlaylistSongs()
  const deletePlaylist = useMutation({
    mutationFn: (id: string) =>
      api(`library/playlists/${encodeURIComponent(id)}`, emptySchema, { method: 'DELETE' }),
    onSuccess: () => {
      browse.open('playlists')
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      void client.invalidateQueries({ queryKey: ['library-view-counts'] })
    },
  })
  const favouriteArtist = useMutation({
    mutationFn: ({ id, favourite }: { id: string; favourite: boolean }) =>
      api(`library/artists/${encodeURIComponent(id)}/favourite`, emptySchema, {
        method: favourite ? 'PUT' : 'DELETE',
      }),
    onSuccess: (_, { id }) => {
      void client.invalidateQueries({ queryKey: ['library-artist', id] })
      void client.invalidateQueries({ queryKey: ['library-artists'] })
    },
  })
  const playCollection = useMutation({
    mutationFn: ({ kind, id }: { kind: Collection; id: string; shuffled: boolean }) =>
      collectionTracks(kind, id),
    onSuccess: (items, { kind, id, shuffled }) => {
      const source = `${kind}:${id}`
      if (shuffled) player.shuffleLibrary(items, source)
      else player.playLibrary(items, 0, source)
    },
  })
  // An album or playlist card has not loaded its songs, so queueing one reads them first.
  const queueCollection = useMutation({
    mutationFn: ({ kind, id }: { kind: 'album' | 'playlist'; id: string; upNext: boolean }) =>
      collectionTracks(kind, id),
    onSuccess: (items, { upNext }) => {
      if (upNext) player.playNext(items)
      else player.addToQueue(items)
    },
  })
  // The filters are part of the identity: a Jazz selection and a Rock selection are two
  // different queues, and one Pause button must not stand for both.
  const trackSource = `tracks:${trackSearch}`
  const playTracks = useMutation({
    mutationFn: ({ shuffled }: { shuffled: boolean }) =>
      api(`library/tracks/selection?${trackSearch}&shuffle=${shuffled}`, librarySelectionSchema),
    onSuccess: (selection, { shuffled }) => {
      if (shuffled)
        player.playDeck(
          selection.items,
          selection.seed,
          selection.total,
          selection.cursor,
          trackSource,
        )
      else player.playLibrary(selection.items, 0, trackSource)
    },
  })

  const albumItems = useMemo(
    () => albums.data?.pages.flatMap((page) => page.items) ?? [],
    [albums.data],
  )
  const albumTotal = albums.data?.pages[0]?.total ?? 0
  const artistItems = useMemo(
    () => artists.data?.pages.flatMap((page) => page.items) ?? [],
    [artists.data],
  )
  const artistTotal = artists.data?.pages[0]?.total ?? 0
  const trackItems = useMemo(
    () => tracks.data?.pages.flatMap((page) => page.items) ?? [],
    [tracks.data],
  )
  const trackTotal = tracks.data?.pages[0]?.total ?? 0
  const likedId = playlists.data?.liked_id ?? ''
  const playlistItems = useMemo(() => {
    const needle = deferredQuery.toLocaleLowerCase()
    const items = (playlists.data?.items ?? []).filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(needle) &&
        (visibility === 'all' ||
          (visibility === 'public' ? item.public : !item.public) ||
          item.id === likedId),
    )
    const ordered = [...items].sort((a, b) => {
      if (sort === 'tracks') return (b.songCount ?? 0) - (a.songCount ?? 0)
      if (sort === 'duration') return (b.duration ?? 0) - (a.duration ?? 0)
      if (sort === 'changed') return textCompare(b.changed, a.changed)
      return textCompare(a.name, b.name)
    })
    // Liked is the one playlist Musimo maintains, so it stays at the top of every view.
    return ordered.sort((a, b) => Number(b.id === likedId) - Number(a.id === likedId))
  }, [deferredQuery, likedId, playlists.data, sort, visibility])
  // Editions of one album show as a single card, so these are groups, not raw albums.
  const artistAlbums = useMemo(
    () => sortArtistAlbums(groupAlbumEditions(artistDetail.data?.album ?? []), artistOrdering.sort),
    [artistDetail.data, artistOrdering.sort],
  )
  const openEditions = artistAlbums.find(
    (group) => group.key === openGroupKey && group.editions.length > 1,
  )
  useEffect(() => {
    const sheet = editionsSheet.current
    if (openEditions && sheet && !sheet.open) sheet.showModal()
  }, [openEditions])
  const artistSongs = useMemo(
    () => sortArtistSongs(artistTracks.data?.items ?? [], artistOrdering.sort),
    [artistTracks.data, artistOrdering.sort],
  )

  // Each tab's first page carries the whole library's filter choices.
  const facets =
    tab === 'tracks'
      ? tracks.data?.pages[0]
      : tab === 'artists'
        ? artists.data?.pages[0]
        : albums.data?.pages[0]
  const genres = facets?.genres ?? []
  const years = (facets?.years ?? []).map(String)
  const currentItems =
    tab === 'artists'
      ? artistItems
      : tab === 'tracks'
        ? trackItems
        : tab === 'playlists'
          ? playlistItems
          : albumItems
  const activeQuery =
    tab === 'artists'
      ? artists
      : tab === 'tracks'
        ? tracks
        : tab === 'playlists'
          ? playlists
          : albums
  const hasMore =
    tab === 'artists'
      ? artists.hasNextPage
      : tab === 'tracks'
        ? tracks.hasNextPage
        : tab === 'playlists'
          ? false
          : albums.hasNextPage
  const loadingMore =
    tab === 'artists'
      ? artists.isFetchingNextPage
      : tab === 'tracks'
        ? tracks.isFetchingNextPage
        : tab === 'playlists'
          ? false
          : albums.isFetchingNextPage
  const facetsShown = tab === 'home' || tab === 'albums' || tab === 'artists' || tab === 'tracks'
  // The phone's Filter button wears this number, so a filter chosen in the sheet is not invisible
  // once the sheet closes.
  const activeFilters =
    selectedGenres.length +
    selectedYears.length +
    (artistShow ? 1 : 0) +
    (visibility !== 'all' ? 1 : 0)
  const loadedText =
    tab === 'tracks'
      ? `${trackItems.length} of ${trackTotal} loaded`
      : tab === 'artists'
        ? `${artistItems.length} of ${artistTotal} loaded`
        : tab === 'playlists'
          ? `${currentItems.length} loaded`
          : `${albumItems.length} of ${albumTotal} loaded`
  const albumParent = parentArtistId
    ? { id: parentArtistId, name: albumDetail.data?.artist || 'artist' }
    : null
  const playlist = playlistDetail.data
  const album = albumId ? albumDetail.data : undefined
  const playlistLiked = Boolean(playlist) && playlist?.id === likedId
  const detailTracks = playlist?.entry ?? albumDetail.data?.song ?? []
  // Four different covers make a mosaic; fewer show the first, and a playlist with no covered
  // song falls back to that song's own cover.
  const playlistCovers = [
    ...new Set((playlist?.entry ?? []).flatMap((song) => (song.coverArt ? [song.coverArt] : []))),
  ]
    .slice(0, 4)
    .map(cover)
  if (!playlistCovers.length && playlist?.coverArt) playlistCovers.push(cover(playlist.coverArt))
  const detailTitle = playlist?.name ?? albumDetail.data?.name ?? ''
  const detailSource = playlist ? `playlist:${playlist.id}` : `album:${albumId}`
  const detailError = playlistId ? playlistDetail.error : albumId ? albumDetail.error : null
  const busy =
    playCollection.isPending ||
    queueCollection.isPending ||
    playTracks.isPending ||
    albumDetail.isLoading ||
    artistDetail.isLoading ||
    playlistDetail.isLoading

  useEffect(() => remember('musimo.library-layout', layout), [layout])

  useEffect(() => {
    setRenaming(false)
    setPlaylistTrackQuery('')
  }, [playlistId])

  function changeTab(next: Tab) {
    if (next === tab && showBrowser) return
    setShowPlaylistForm(false)
    browse.open(next)
  }

  function loadMore() {
    if (tab === 'artists') void artists.fetchNextPage()
    else if (tab === 'tracks') void tracks.fetchNextPage()
    else if (tab !== 'playlists') void albums.fetchNextPage()
  }

  function confirmDelete(target: LibraryPlaylist | { id: string; name: string }) {
    if (window.confirm(`Delete playlist “${target.name}”?`)) deletePlaylist.mutate(target.id)
  }

  // Renders under the heading it belongs to (e.g. "Fresh in your library") rather than above
  // the whole browser, so a failed load never reads as if the page itself is broken.
  const libraryLoadError = showBrowser && activeQuery.isError && (
    <InlineError role="alert">
      <span>{activeQuery.error.message}</span>
      <Button onClick={() => void activeQuery.refetch()}>Retry</Button>
    </InlineError>
  )

  if (capabilities.isLoading) return <p role="status">Connecting to your library…</p>
  if (!capabilities.data?.available)
    return (
      <EmptyPanel tall>
        <Library size={36} />
        <h1>Your music library lives here.</h1>
        <p>{capabilities.data?.detail ?? 'The music folder is not ready.'}</p>
        <Link
          data-ui="button"
          className={buttonClassName('primary', 'mx-auto')}
          to="/settings"
          hash="library"
        >
          Choose a music folder
        </Link>
      </EmptyPanel>
    )

  // A detail page starts with its own header, so it gets a slim row that carries the way back.
  const backLabel = albumParent?.name ?? (playlistId ? 'playlists' : albumId ? 'albums' : 'artists')
  const browsing = tab === 'home' ? 'albums' : tab
  // Classic prints the count of what the active view matches. The Listening room prints every
  // view's whole-library count in its strip, which `viewCounts` fetches.
  const activeTotal =
    browsing === 'artists'
      ? artistTotal
      : browsing === 'tracks'
        ? trackTotal
        : browsing === 'playlists'
          ? playlistItems.length
          : albumTotal
  const activeLoaded = !activeQuery.isLoading && !activeQuery.isError
  const tabCounts: TabCounts =
    shell === 'room' ? (viewCounts.data ?? {}) : activeLoaded ? { [browsing]: activeTotal } : {}
  const headingActions =
    tab === 'tracks' ? (
      <>
        <CollectionPlayButton
          source={trackSource}
          text="Play all"
          variant="primary"
          size={15}
          disabled={busy || !trackTotal}
          onPlay={() => playTracks.mutate({ shuffled: false })}
        />
        <Button
          onClick={() => playTracks.mutate({ shuffled: true })}
          disabled={busy || !trackTotal}
        >
          <Shuffle size={15} /> Shuffle
        </Button>
      </>
    ) : tab === 'playlists' && shell === 'classic' && !phone ? (
      <Button variant="primary" onClick={() => setShowPlaylistForm(true)}>
        <Plus size={16} /> New playlist
      </Button>
    ) : undefined

  // What the sort, filter and view controls are, in one column. A phone keeps them here rather than
  // in a toolbar, so the first album is on the first screen.
  const filterSheetBody = (
    <div className="grid gap-[14px]">
      <label className="grid gap-[6px] text-small text-muted">
        Sort by
        <FieldSelect
          tone="sunken"
          aria-label={`Sort ${tab}`}
          value={sort}
          onChange={(event) => browse.setSort(event.target.value)}
        >
          {viewSorts[tab].map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </FieldSelect>
      </label>
      {tab === 'playlists' && (
        <label className="grid gap-[6px] text-small text-muted">
          Show
          <FieldSelect
            tone="sunken"
            aria-label="Filter playlists"
            value={visibility}
            onChange={(event) => browse.setVisibility(event.target.value)}
          >
            <option value="all">All playlists</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </FieldSelect>
        </label>
      )}
      {tab === 'artists' && (
        <label className="grid gap-[6px] text-small text-muted">
          Show
          <FieldSelect
            tone="sunken"
            aria-label="Show artists"
            value={artistShow}
            onChange={(event) => browse.setShow(event.target.value)}
          >
            <option value="">All artists</option>
            <option value="favourites">Favourites</option>
            <option value="played">Played</option>
            <option value="unplayed">Never played</option>
          </FieldSelect>
        </label>
      )}
      {facetsShown && (
        <>
          <FilterMenu
            label="Genres"
            options={genres}
            selected={selectedGenres}
            onToggle={(value) => browse.toggleGenre(value)}
          />
          <FilterMenu
            label="Years"
            options={years}
            selected={selectedYears}
            onToggle={(value) => browse.toggleYear(value)}
          />
        </>
      )}
      {tab !== 'tracks' && (
        <div className="flex items-center justify-between gap-[12px] text-small text-muted">
          View
          <LayoutToggle layout={layout} onChange={setLayout} />
        </div>
      )}
      {activeFilters > 0 && (
        <button
          type="button"
          data-ui="text-link"
          className={textLinkClassName('self-start')}
          onClick={browse.clearFilters}
        >
          Clear filters
        </button>
      )}
    </div>
  )

  return (
    <>
      {showBrowser && (
        <LibraryHeading
          shell={shell}
          tab={browsing}
          counts={tabCounts}
          onOpen={changeTab}
          actions={headingActions}
        />
      )}
      {!showBrowser && (
        <div className="mb-[18px] flex flex-wrap items-center justify-between gap-x-[16px] border-b border-line max-phone:mb-[14px]">
          <button
            type="button"
            data-ui="text-link"
            className={textLinkClassName()}
            onClick={() => {
              if (albumParent) void navigate(artistPageLocation('albums', albumParent.id))
              else changeTab(playlistId ? 'playlists' : albumId ? 'albums' : 'artists')
            }}
          >
            ← Back to {backLabel}
          </button>
        </div>
      )}
      {showBrowser && phone && (
        <>
          <div className="mb-[14px] flex items-center gap-[10px]">
            <SearchField
              browse={browse}
              noun={browsing}
              room={shell === 'room'}
              className="min-w-0 flex-1"
            />
            <Button
              className="flex-none"
              aria-haspopup="dialog"
              onClick={() => filterSheet.current?.showModal()}
            >
              <SlidersHorizontal size={16} />
              {activeFilters > 0 ? `Filter (${activeFilters})` : 'Filter'}
            </Button>
          </div>
          {tab === 'playlists' && (
            <Button
              variant="primary"
              className="mb-[14px] w-full"
              onClick={() => setShowPlaylistForm(true)}
            >
              <Plus size={16} /> New playlist
            </Button>
          )}
          <ReviewDialog
            dialogRef={filterSheet}
            titleId={filterSheetTitle}
            eyebrow="LIBRARY"
            title={`Filter ${browsing}`}
            closeLabel="Close filters"
            onClose={() => undefined}
            footer={
              <Button
                variant="primary"
                className="w-full"
                onClick={() => filterSheet.current?.close()}
              >
                Done
              </Button>
            }
          >
            {filterSheetBody}
          </ReviewDialog>
        </>
      )}
      {showBrowser && !phone && (
        <LibraryToolbar
          shell={shell}
          tab={browsing}
          browse={browse}
          sorts={viewSorts[browsing]}
          genres={genres}
          years={years}
          facetsShown={facetsShown}
          view={layout}
          onView={setLayout}
          loadedText={loadedText}
        />
      )}
      {showBrowser && tab === 'playlists' && showPlaylistForm && (
        <form
          className="flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-raised p-[14px] mb-[20px]"
          onSubmit={(event) => {
            event.preventDefault()
            const name = newName.trim()
            if (name) createPlaylist.mutate(name)
          }}
        >
          <label className="grid min-w-[min(320px,100%)] gap-[6px] text-small text-muted">
            Playlist name
            <Field
              autoFocus
              value={newName}
              maxLength={200}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={createPlaylist.isPending}>
            {createPlaylist.isPending ? 'Creating…' : 'Create'}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setShowPlaylistForm(false)
              setNewName('')
            }}
          >
            Cancel
          </Button>
          {createPlaylist.isError && (
            <ErrorBanner className="w-full m-0">{createPlaylist.error.message}</ErrorBanner>
          )}
        </form>
      )}
      {showBrowser && activeQuery.isLoading && (
        <p role="status">Loading {tab === 'home' ? 'albums' : tab}…</p>
      )}
      {(albumId || playlistId) && (
        <section className="library-detail grid gap-[16px]">
          {(album || playlist) && (
            <CollectionHeader
              cover={
                <CollectionCover
                  urls={playlist ? playlistCovers : album?.coverArt ? [cover(album.coverArt)] : []}
                  fallback={playlist ? <ListMusic /> : <Disc3 />}
                />
              }
              eyebrow={playlist ? 'PLAYLIST' : ['ALBUM', album?.year].filter(Boolean).join(' · ')}
              title={detailTitle}
              titleIcon={playlistLiked ? <Heart size={22} fill="currentColor" /> : undefined}
              byline={
                playlist ? (
                  playlist.owner ? (
                    <span className="text-body">By {playlist.owner}</span>
                  ) : undefined
                ) : album?.artistId ? (
                  <Link
                    className="inline-flex w-fit items-center text-body text-accent hover:underline coarse:min-h-11"
                    to="/library/artists/$artistId"
                    params={{ artistId: album.artistId }}
                  >
                    {album.artist}
                  </Link>
                ) : (
                  <span className="text-body">{album?.artist}</span>
                )
              }
              meta={(playlist
                ? [
                    songCount(detailTracks.length),
                    totalLength(playlist.duration || sumDuration(detailTracks)),
                    playlist.public ? 'Public' : 'Private',
                  ]
                : [
                    songCount(detailTracks.length),
                    totalLength(album?.duration || sumDuration(detailTracks)),
                    album?.genre,
                  ]
              )
                .filter(Boolean)
                .join(' · ')}
            >
              <CollectionPlayButton
                source={detailSource}
                text="Play all"
                variant="primary"
                size={15}
                disabled={!detailTracks.length}
                onPlay={() => player.playLibrary(detailTracks, 0, detailSource)}
              />
              <Button
                onClick={() => player.shuffleLibrary(detailTracks, detailSource)}
                disabled={!detailTracks.length}
              >
                <Shuffle size={15} /> Shuffle
              </Button>
              <RowMenu
                label={`More actions for ${detailTitle}`}
                disabled={!detailTracks.length}
                actions={queueActions(
                  () => player.playNext(detailTracks),
                  () => player.addToQueue(detailTracks),
                )}
              />
              {playlist && (
                <Button
                  onClick={() => {
                    setRenameValue(playlist.name)
                    setRenaming(!renaming)
                  }}
                  aria-expanded={renaming}
                >
                  <Pencil size={15} /> Rename
                </Button>
              )}
              {playlist && !playlistLiked && (
                <Button
                  variant="danger"
                  onClick={() => confirmDelete(playlist)}
                  disabled={deletePlaylist.isPending}
                >
                  <Trash2 size={15} /> Delete
                </Button>
              )}
            </CollectionHeader>
          )}
          {playlist && renaming && (
            <form
              className="flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-raised p-[14px] mb-[20px]"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renameValue.trim()
                if (name && name !== playlist.name) renamePlaylist.mutate({ id: playlist.id, name })
                else setRenaming(false)
              }}
            >
              <label className="grid min-w-[min(320px,100%)] gap-[6px] text-small text-muted">
                Playlist name
                <Field
                  autoFocus
                  value={renameValue}
                  maxLength={200}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </label>
              <Button type="submit" variant="primary" disabled={renamePlaylist.isPending}>
                {renamePlaylist.isPending ? 'Saving…' : 'Save name'}
              </Button>
              <Button type="button" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              {renamePlaylist.isError && (
                <ErrorBanner className="w-full m-0">{renamePlaylist.error.message}</ErrorBanner>
              )}
            </form>
          )}
          {deletePlaylist.isError && (
            <ErrorBanner role="alert">{deletePlaylist.error.message}</ErrorBanner>
          )}
          {(albumDetail.isLoading || playlistDetail.isLoading) && (
            <p role="status">Loading songs…</p>
          )}
          {detailError && (
            <InlineError role="alert">
              <span>{detailError.message}</span>
              <Button
                onClick={() => void (playlistId ? playlistDetail.refetch() : albumDetail.refetch())}
              >
                Retry
              </Button>
            </InlineError>
          )}
          <TrackList
            tracks={detailTracks}
            source={detailSource}
            // A playlist is in the order its owner chose, so its rows count places in it. An album's
            // rows keep the numbers the album gave them.
            numbering={playlist ? 'position' : 'track'}
            highlightId={albumId ? highlightTrackId : ''}
            removing={Boolean(playlist) && playlistSongs.busy(playlist?.id ?? '')}
            onRemove={
              playlist
                ? (index) => playlistSongs.mutation.mutate({ playlistId: playlist.id, index })
                : undefined
            }
          />
          {playlist && (
            <section className="border-t border-line pt-[12px]">
              <div className={sectionHeadingClassName}>
                <h2 className="text-strong">Add songs</h2>
                <span className={sectionCaptionClassName}>Search your library</span>
              </div>
              <label className="flex w-[min(420px,100%)] items-center rounded-[8px] border border-line bg-sunken px-[12px] text-muted">
                <Search size={17} />
                <input
                  className="w-full border-0 bg-transparent p-[11px] text-inherit outline-0"
                  aria-label="Search songs to add"
                  value={playlistTrackQuery}
                  onChange={(event) => setPlaylistTrackQuery(event.target.value)}
                  placeholder="Search songs to add"
                />
              </label>
              {playlistTracks.isLoading && <p role="status">Searching songs…</p>}
              {playlistTracks.isError && <ErrorBanner>{playlistTracks.error.message}</ErrorBanner>}
              <div className="playlist-add-list grid gap-[6px] mt-[12px]">
                {playlistTracks.data?.items.map((track) => {
                  const index = playlist.entry.findIndex((item) => item.id === track.id)
                  const member = index >= 0
                  return (
                    <div
                      key={track.id}
                      className="flex items-center justify-between gap-[12px] rounded-md border border-line bg-raised px-[12px] py-[9px]"
                    >
                      <span className="grid min-w-0 gap-[3px]">
                        <strong>{track.title}</strong>
                        <small className="truncate text-muted">
                          {track.artist} · {track.album}
                        </small>
                      </span>
                      <Button
                        variant={member ? 'default' : 'primary'}
                        aria-label={`${member ? 'Remove' : 'Add'} ${track.title} ${member ? 'from' : 'to'} ${playlist.name}`}
                        onClick={() =>
                          playlistSongs.mutation.mutate(
                            member
                              ? { playlistId: playlist.id, index }
                              : { playlistId: playlist.id, songId: track.id },
                          )
                        }
                        disabled={playlistSongs.busy(playlist.id)}
                      >
                        {member ? (
                          <>
                            <X size={15} /> Remove
                          </>
                        ) : (
                          <>
                            <Plus size={15} /> Add
                          </>
                        )}
                      </Button>
                    </div>
                  )
                })}
              </div>
              {playlistSongs.mutation.isError && (
                <ErrorBanner>{playlistSongs.mutation.error.message}</ErrorBanner>
              )}
            </section>
          )}
        </section>
      )}
      {artistId && artistDetail.isError && (
        <InlineError role="alert">
          <span>{artistDetail.error.message}</span>
          <Button onClick={() => void artistDetail.refetch()}>Retry</Button>
        </InlineError>
      )}
      {artistId && artistDetail.data && (
        <section className="library-detail grid gap-[16px]">
          <CollectionHeader
            className="library-artist-heading"
            cover={
              <CollectionCover
                round
                urls={artistDetail.data.coverArt ? [cover(artistDetail.data.coverArt)] : []}
                fallback={<Disc3 />}
              />
            }
            eyebrow="ARTIST"
            title={artistDetail.data.name}
            // The songs are read apart from the albums, so their count waits until they arrive.
            meta={[
              albumCountLabel(artistAlbums.length, artistDetail.data.album.length),
              artistTracks.data ? songCount(artistSongs.length) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <CollectionPlayButton
              source={`artist:${artistId}`}
              text="Play all"
              variant="primary"
              size={15}
              disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
              onPlay={() =>
                artistSongsMode
                  ? player.playLibrary(artistSongs, 0, `artist:${artistId}`)
                  : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: false })
              }
            />
            <Button
              onClick={() =>
                artistSongsMode
                  ? player.shuffleLibrary(artistSongs, `artist:${artistId}`)
                  : playCollection.mutate({ kind: 'artist', id: artistId, shuffled: true })
              }
              disabled={busy || (artistSongsMode ? !artistSongs.length : !artistAlbums.length)}
            >
              <Shuffle size={15} /> Shuffle
            </Button>
            <Button
              aria-pressed={Boolean(artistDetail.data.starred)}
              disabled={favouriteArtist.isPending}
              onClick={() =>
                favouriteArtist.mutate({
                  id: artistId,
                  favourite: !artistDetail.data?.starred,
                })
              }
            >
              <Star size={15} fill={artistDetail.data.starred ? 'currentColor' : 'none'} />{' '}
              {artistDetail.data.starred ? 'Favourite' : 'Add to favourites'}
            </Button>
            <Button
              onClick={() =>
                void navigate(artistPageLocation(artistSongsMode ? 'albums' : 'songs', artistId))
              }
              disabled={!artistSongsMode && (artistTracks.isLoading || !artistSongs.length)}
            >
              <ListMusic size={15} /> {artistSongsMode ? 'Albums' : 'All songs'}
            </Button>
          </CollectionHeader>
          <div className="flex flex-wrap items-center gap-[10px] mt-[4px] mb-[12px]">
            <label className="flex min-h-[42px] items-center gap-[7px] rounded-[8px] border border-line bg-sunken px-[10px] text-muted">
              <SlidersHorizontal size={16} />
              <select
                className="max-w-[180px] border-0 bg-sunken py-[9px] pr-[22px] pl-[2px] text-text coarse:min-h-11 coarse:text-base"
                aria-label={artistSongsMode ? 'Sort songs' : 'Sort albums'}
                value={artistOrdering.sort}
                onChange={(event) => artistOrdering.setSort(event.target.value)}
              >
                {artistSongsMode
                  ? artistSongSorts.map((value) => (
                      <option value={value} key={value}>
                        {artistSongLabels[value]}
                      </option>
                    ))
                  : artistAlbumSorts.map((value) => (
                      <option value={value} key={value}>
                        {artistAlbumLabels[value]}
                      </option>
                    ))}
              </select>
            </label>
            {!artistSongsMode && <LayoutToggle layout={layout} onChange={setLayout} />}
          </div>
          {artistSongsMode && artistTracks.isError && (
            <ErrorBanner role="alert">{artistTracks.error.message}</ErrorBanner>
          )}
          {artistSongsMode && artistTracks.isLoading && <p role="status">Loading songs…</p>}
          {artistSongsMode ? (
            <TrackList tracks={artistSongs} source={`artist:${artistId}`} />
          ) : (
            <>
              <div
                className={
                  layout === 'grid'
                    ? 'library-grid grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-x-[16px] gap-y-[22px]'
                    : 'grid grid-cols-1 gap-[6px]'
                }
              >
                {artistAlbums.map((group) => {
                  // A group plays and queues its lead edition; the others are one click away.
                  const album = { ...group.lead, name: group.name }
                  const editions = group.editions.length
                  return (
                    <AlbumItem
                      album={album}
                      editions={editions}
                      years={yearSpan(group.editions.map((item) => item.album.year))}
                      key={group.key}
                      layout={layout}
                      loading={busy}
                      onOpen={() =>
                        editions > 1
                          ? setOpenGroupKey(group.key)
                          : void navigate({
                              to: '/library/artists/$artistId/albums/$albumId',
                              params: { artistId, albumId: album.id },
                            })
                      }
                      onPlay={() =>
                        playCollection.mutate({ kind: 'album', id: album.id, shuffled: false })
                      }
                      onShuffle={() =>
                        playCollection.mutate({ kind: 'album', id: album.id, shuffled: true })
                      }
                      onQueue={(upNext) =>
                        queueCollection.mutate({ kind: 'album', id: album.id, upNext })
                      }
                    />
                  )
                })}
              </div>
              <ReviewDialog
                dialogRef={editionsSheet}
                titleId={editionsSheetTitle}
                eyebrow={`${openEditions?.editions.length ?? 0} EDITIONS`}
                title={openEditions?.name ?? ''}
                closeLabel="Close editions"
                onClose={() => setOpenGroupKey('')}
                footer={
                  <Button className="w-full" onClick={() => editionsSheet.current?.close()}>
                    Close
                  </Button>
                }
              >
                <ul className="m-0 grid list-none gap-[6px] p-0">
                  {[...(openEditions?.editions ?? [])]
                    .sort(
                      (a, b) =>
                        (a.album.year ?? Number.MAX_SAFE_INTEGER) -
                          (b.album.year ?? Number.MAX_SAFE_INTEGER) ||
                        textCompare(a.edition, b.edition),
                    )
                    .map(({ album, edition }) => (
                      <li key={album.id}>
                        <button
                          className={cx(collectionRowClass, 'w-full text-left')}
                          onClick={() => {
                            setOpenGroupKey('')
                            editionsSheet.current?.close()
                            void navigate({
                              to: '/library/artists/$artistId/albums/$albumId',
                              params: { artistId, albumId: album.id },
                            })
                          }}
                        >
                          <span className={collectionArtClass}>
                            {album.coverArt ? (
                              <img
                                src={cover(album.coverArt)}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Disc3 />
                            )}
                          </span>
                          <span className="grid min-w-0 gap-[4px]">
                            <strong className="[overflow-wrap:anywhere]">
                              {edition || 'Standard edition'}
                            </strong>
                            <small className="text-muted">
                              {[album.year ? String(album.year) : '', songCount(album.songCount)]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </ReviewDialog>
              <section className="grid gap-[10px] mt-[26px]">
                <div className={sectionHeadingClassName}>
                  <h2 className="text-strong">Popularity</h2>
                  <span className={sectionCaptionClassName}>Play counts by release year</span>
                </div>
                <PopularityChart albums={artistDetail.data.album} />
              </section>
            </>
          )}
        </section>
      )}
      {(tab === 'home' || tab === 'albums') && showBrowser && (
        <section aria-label={deferredQuery ? 'Album results' : 'Albums'}>
          {libraryLoadError}
          <div
            className={layout === 'grid' ? browseGridClass('album', room) : browseListClass(room)}
          >
            {albumItems.map((album) => (
              <AlbumItem
                album={album}
                key={album.id}
                layout={layout}
                loading={busy}
                onOpen={() =>
                  void navigate({
                    to: '/library/albums/$albumId',
                    params: { albumId: album.id },
                  })
                }
                onPlay={() =>
                  playCollection.mutate({ kind: 'album', id: album.id, shuffled: false })
                }
                onShuffle={() =>
                  playCollection.mutate({ kind: 'album', id: album.id, shuffled: true })
                }
                onQueue={(upNext) =>
                  queueCollection.mutate({ kind: 'album', id: album.id, upNext })
                }
              />
            ))}
          </div>
        </section>
      )}
      {tab === 'artists' && showBrowser && (
        <div>
          {libraryLoadError}
          <div
            className={layout === 'grid' ? browseGridClass('artist', room) : browseListClass(room)}
          >
            {artistItems.map((artist: LibraryArtist) => (
              <ArtistItem
                artist={artist}
                key={artist.id}
                layout={layout}
                loading={busy}
                onOpen={() =>
                  void navigate({
                    to: '/library/artists/$artistId',
                    params: { artistId: artist.id },
                  })
                }
                onPlay={() =>
                  playCollection.mutate({ kind: 'artist', id: artist.id, shuffled: false })
                }
                onShuffle={() =>
                  playCollection.mutate({ kind: 'artist', id: artist.id, shuffled: true })
                }
              />
            ))}
          </div>
        </div>
      )}
      {tab === 'tracks' && showBrowser && (
        <section className="library-detail grid gap-[12px]">
          {libraryLoadError}
          {/* Play all and Shuffle sit in the heading. This note covers both when the whole
              selection fits; past 500 songs, Play all is capped by the saved queue and Shuffle
              keeps going, so each gets its own. */}
          {trackTotal > 500 ? (
            <div className="grid gap-[2px] text-small text-muted">
              <small>Plays the first 500 of {trackTotal.toLocaleString()} matching songs.</small>
              <small>
                Shuffles all {trackTotal.toLocaleString()} matching songs. Each plays once before
                any repeat.
              </small>
            </div>
          ) : (
            <small className="block text-small text-muted">
              Covers every matching song, not just the loaded ones.
            </small>
          )}
          {playTracks.isError && <ErrorBanner role="alert">{playTracks.error.message}</ErrorBanner>}
          {/* A song's number on its own album means nothing beside songs from other albums, so it
              is shown only when the list is in album order. */}
          <TrackList
            table
            tracks={trackItems}
            source={trackSource}
            numbering={sort === 'album' ? 'track' : 'none'}
          />
        </section>
      )}
      {tab === 'playlists' && showBrowser && (
        <div>
          {libraryLoadError}
          <div
            className={
              layout === 'grid' ? browseGridClass('playlist', room) : browseListClass(room)
            }
          >
            {room && !phone && (
              <button
                type="button"
                className={cx(
                  'flex items-center justify-center gap-[8px] border border-dashed border-line-strong bg-transparent font-medium text-muted hover:text-text coarse:min-h-11',
                  layout === 'grid' ? 'min-h-[84px] rounded-[16px]' : 'min-h-[56px] rounded-[10px]',
                )}
                onClick={() => setShowPlaylistForm(true)}
              >
                <Plus size={16} /> New playlist
              </button>
            )}
            {playlistItems.map((item: LibraryPlaylist) => (
              <PlaylistRow
                key={item.id}
                playlist={item}
                layout={layout}
                liked={item.id === likedId}
                loading={busy}
                deleting={deletePlaylist.isPending}
                onOpen={() =>
                  void navigate({
                    to: '/library/playlists/$playlistId',
                    params: { playlistId: item.id },
                  })
                }
                onPlay={() =>
                  playCollection.mutate({ kind: 'playlist', id: item.id, shuffled: false })
                }
                onShuffle={() =>
                  playCollection.mutate({ kind: 'playlist', id: item.id, shuffled: true })
                }
                onQueue={(upNext) =>
                  queueCollection.mutate({ kind: 'playlist', id: item.id, upNext })
                }
                onDelete={() => confirmDelete(item)}
              />
            ))}
          </div>
        </div>
      )}
      {playCollection.isError && (
        <ErrorBanner role="alert">{playCollection.error.message}</ErrorBanner>
      )}
      {queueCollection.isError && (
        <ErrorBanner role="alert">{queueCollection.error.message}</ErrorBanner>
      )}
      {showBrowser &&
        !activeQuery.isLoading &&
        !activeQuery.isError &&
        currentItems.length === 0 && (
          <p className="px-[16px] py-[64px] text-center text-muted">
            No {tab === 'home' ? 'albums' : tab} found.
          </p>
        )}
      {showBrowser && hasMore && (
        <InfiniteScroll hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
      )}
      {/* On a phone the count is not in the toolbar, so it reads under the list. */}
      {showBrowser && phone && (
        <p className="library-count mt-[14px] text-center text-small text-muted">{loadedText}</p>
      )}
    </>
  )
}
