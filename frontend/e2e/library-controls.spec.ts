import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import {
  closeLibraryFilters,
  librarySong,
  openLibraryFilters,
  playerFixtures,
} from './library-fixtures'

const library = [
  librarySong('s1', { title: 'Beacon', genre: 'Jazz', year: 1999, playCount: 12 }),
  librarySong('s2', { title: 'Anchor', genre: 'Rock', year: 2011, playCount: 4 }),
  librarySong('s3', { title: 'Cinder', genre: 'Jazz', year: 2011, playCount: 30 }),
]

type Recorded = { tracks: URL[]; selection: URL[] }

async function libraryFixtures(page: Page): Promise<Recorded> {
  const recorded: Recorded = { tracks: [], selection: [] }
  await playerFixtures(page)
  await page.route(
    (url) => url.pathname === '/api/library/tracks',
    (route) => {
      const url = new URL(route.request().url())
      recorded.tracks.push(url)
      const genres = url.searchParams.getAll('genre')
      const items = genres.length
        ? library.filter((item) => genres.includes(item.genre ?? ''))
        : library
      route.fulfill({
        json: {
          items,
          next_offset: null,
          total: items.length,
          genres: ['Jazz', 'Rock'],
          years: [2011, 1999],
        },
      })
    },
  )

  await page.route(
    (url) => url.pathname === '/api/library/tracks/selection',
    (route) => {
      const url = new URL(route.request().url())
      recorded.selection.push(url)
      const shuffled = url.searchParams.get('shuffle') === 'true'
      route.fulfill({
        json: { items: shuffled ? [...library].reverse() : library, total: library.length },
      })
    },
  )

  return recorded
}

test('the tracks view sends its search, filter, sort and shuffle to the server', async ({
  page,
  isMobile,
}) => {
  const recorded = await libraryFixtures(page)
  await page.goto('/library/tracks')

  await expect(page.getByText('3 of 3 loaded')).toBeVisible()
  // One note covers both buttons; it used to be printed under each of them.
  await expect(page.getByText('Covers every matching song, not just the loaded ones.')).toHaveCount(
    1,
  )
  await openLibraryFilters(page, isMobile)
  await page.getByLabel('Sort tracks').selectOption('duration')
  await closeLibraryFilters(page, isMobile)
  await page.getByLabel('Search tracks').fill('cinder')
  await expect
    .poll(() => {
      const latest = recorded.tracks.at(-1)?.searchParams
      return [latest?.get('q'), latest?.get('sort')]
    })
    .toEqual(['cinder', 'duration'])

  await page.getByLabel('Search tracks').fill('')
  await openLibraryFilters(page, isMobile)
  await page.getByText('All genres', { exact: true }).click()
  // Filter choices come from the whole library, not only the rows on screen.
  await expect(page.getByLabel('Rock')).toBeVisible()
  // The open menu stays inside the viewport at phone widths instead of forcing a sideways scroll.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0)
  await page.getByLabel('Jazz').check()
  await expect.poll(() => recorded.tracks.at(-1)?.searchParams.getAll('genre')).toEqual(['Jazz'])
  // On a phone the button says how many filters are on once the sheet is closed.
  if (isMobile) {
    await closeLibraryFilters(page, isMobile)
    await expect(page.getByRole('button', { name: 'Filter (1)', exact: true })).toBeVisible()
    await openLibraryFilters(page, isMobile)
  }
  // Close the panel first: at narrow widths it sits over the rest of the toolbar.
  await page.getByText('Genres (1)', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await closeLibraryFilters(page, isMobile)

  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('Beacon')
  expect(recorded.selection.at(-1)?.searchParams.get('shuffle')).toBe('false')

  // The footer player has its own Shuffle toggle, so scope to the list's controls.
  const actions = page.locator('.library-list-actions')
  await actions.getByRole('button', { name: 'Shuffle' }).click()
  await expect.poll(() => recorded.selection.at(-1)?.searchParams.get('shuffle')).toBe('true')
})

test('loading states name what is on the way and hold the counts back', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', () => new Promise(() => undefined))
  await page.goto('/library')
  // The home view loads albums, so that is what it says while waiting.
  await expect(page.getByText('Loading albums…')).toBeVisible()

  await page.route('**/api/library/albums/album-1', () => new Promise(() => undefined))
  await page.goto('/library/albums/album-1')
  await expect(page.getByText('Loading songs…')).toBeVisible()
  // No "0 songs" while the album is still on its way.
  await expect(page.locator('.library-detail .library-count')).toHaveCount(0)
})

test('an album page opens with its cover, year, artist link and meta line', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: {
        id: 'album-1',
        name: 'Clear Water',
        artist: 'Harbor Static',
        artistId: 'artist-1',
        coverArt: 'cover-1',
        year: 2018,
        genre: 'Ambient',
        songCount: 2,
        duration: 428,
        playCount: 0,
        song: [
          librarySong('s1', { title: 'First Light', track: 1 }),
          librarySong('s2', { title: 'Second Track', track: 2 }),
        ],
      },
    }),
  )
  await page.goto('/library/albums/album-1')

  const header = page.locator('.collection-header')
  await expect(header.getByRole('heading', { level: 1, name: 'Clear Water' })).toBeVisible()
  await expect(header).toContainText('ALBUM · 2018')
  await expect(header.locator('.collection-cover img')).toHaveAttribute(
    'src',
    '/api/player/art/cover-1',
  )

  await expect(header.getByRole('link', { name: 'Harbor Static' })).toHaveAttribute(
    'href',
    '/library/artists/artist-1',
  )
  await expect(header.locator('.library-count')).toHaveText('2 songs · 7 min · Ambient')
  for (const name of ['Play all', 'Shuffle', 'More actions for Clear Water'])
    await expect(header.getByRole('button', { name })).toBeVisible()

  // The page heading and its eyebrow give way to the header; the tabs stay as a slim row with the
  // way back, so the album starts right under them.
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0)
  await expect(page.getByText('YOUR MUSIC, READY TO PLAY')).toHaveCount(0)
  const tabs = page.getByRole('navigation', { name: 'Library views' })
  await expect(tabs).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to albums' })).toBeVisible()
  const tabsBox = await tabs.boundingBox()
  const headerBox = await header.boundingBox()
  if (!tabsBox || !headerBox) throw new Error('Missing header measurements')
  expect(headerBox.y - (tabsBox.y + tabsBox.height)).toBeLessThan(60)
})

test('a failed load reports under the heading it belongs to', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({ status: 500, json: { detail: 'The library index is unavailable.' } }),
  )
  await page.goto('/library')

  const heading = page.getByRole('heading', { name: 'Fresh in your library' })
  const error = page.getByRole('alert')
  await expect(heading).toBeVisible()
  await expect(error).toContainText('The library index is unavailable.')

  const errorHandle = await error.elementHandle()
  const headingComesFirst = await heading.evaluate(
    (headingNode, errorNode) =>
      errorNode instanceof Node
        ? Boolean(headingNode.compareDocumentPosition(errorNode) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    errorHandle,
  )
  expect(headingComesFirst).toBe(true)
})

test('a filtered selection is its own queue, not the one already playing', async ({
  page,
  isMobile,
}) => {
  await libraryFixtures(page)
  await page.goto('/library/tracks')

  const actions = page.locator('.library-list-actions')
  await actions.getByRole('button', { name: 'Play all' }).click()
  await expect(actions.getByRole('button', { name: 'Pause' })).toBeVisible()

  // A different filter is a different selection, so the control cannot claim to be playing it.
  await openLibraryFilters(page, isMobile)
  await page.getByText('All genres', { exact: true }).click()
  await page.getByLabel('Rock').check()
  await page.getByText('Genres (1)', { exact: true }).click()
  await closeLibraryFilters(page, isMobile)
  await expect(actions.getByRole('button', { name: 'Play all' })).toBeVisible()
})

test('tracks A to Z has no number column, and a long album name stops at two lines', async ({
  page,
  isMobile,
}) => {
  await libraryFixtures(page)
  const album = 'A Very Long Album Title '.repeat(8).trim()
  await page.route(
    (url) => url.pathname === '/api/library/tracks',
    (route) =>
      route.fulfill({
        json: {
          items: [
            librarySong('s1', { title: 'Anchor', track: 9, album }),
            librarySong('s2', { title: 'Beacon', track: 4 }),
          ],
          next_offset: null,
          total: 2,
          genres: [],
          years: [],
        },
      }),
  )
  await page.goto('/library/tracks')

  const rows = page.locator('.library-track-row')
  await expect(rows).toHaveCount(2)
  // The first cell is the title, not a song's number on some other album.
  await expect(rows.first().locator('.library-track-play > span:first-child')).toContainText(
    'Anchor',
  )

  // The album column is hidden on a phone, so there is nothing to clamp there.
  if (!isMobile) {
    // The artist's small text is the first in the row and the album's is the second.
    const name = rows.first().locator('.library-track-play small').nth(1)
    await expect(name).toHaveText(album)
    expect(await name.evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe('2')
    // Clamped to two lines, so the row is no taller than two lines of it plus the row's padding.
    const heights = await name.evaluate((node) => ({
      text: node.getBoundingClientRect().height,
      full: node.scrollHeight,
    }))
    expect(heights.full).toBeGreaterThan(heights.text)
  }

  // Album order is the one sort where a song's number on its album still reads right.
  await openLibraryFilters(page, isMobile)
  await page.getByLabel('Sort tracks').selectOption('album')
  await closeLibraryFilters(page, isMobile)
  await expect(rows.first().locator('.library-track-play > span:first-child')).toHaveText('9')
})

test('pausing a collection resumes it instead of starting over', async ({ page }) => {
  const recorded = await libraryFixtures(page)
  await page.goto('/library/tracks')

  const actions = page.locator('.library-list-actions')
  await actions.getByRole('button', { name: 'Play all' }).click()
  await expect(actions.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  const fetched = recorded.selection.length

  await actions.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(actions.getByRole('button', { name: 'Play all' })).toBeVisible()
  await actions.getByRole('button', { name: 'Play all' }).click()

  // Resume, not restart. Restarting would refetch the selection and queue it from the top,
  // losing the listener's place, and a shuffled selection would come back in a new order.
  // The request count is the check: whether headless audio actually resumes is the browser's
  // business, and not every engine does it without a real user gesture.
  expect(recorded.selection.length).toBe(fetched)
})

test('an artist page dates, sorts and charts its albums', async ({ page }) => {
  await libraryFixtures(page)
  const albums = [
    {
      id: 'album-1',
      name: 'Clear Water',
      artist: 'Harbor Static',
      songCount: 2,
      year: 2011,
      playCount: 30,
    },
    {
      id: 'album-2',
      name: 'Stone Lines',
      artist: 'Harbor Static',
      songCount: 3,
      year: 1999,
      playCount: 4,
    },
  ]
  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({
      json: { id: 'artist-1', name: 'Harbor Static', coverArt: 'artist-cover-1', album: albums },
    }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: library } }),
  )
  await page.goto('/library/artists/artist-1')

  // The header carries a round photo, the name and both counts, and no page heading above it.
  const header = page.locator('.collection-header')
  await expect(header.getByRole('heading', { level: 1, name: 'Harbor Static' })).toBeVisible()
  await expect(header).toContainText('ARTIST')
  await expect(header.locator('.collection-cover img')).toHaveAttribute(
    'src',
    '/api/player/art/artist-cover-1',
  )
  await expect(header.locator('.library-count')).toHaveText('2 albums · 3 songs')
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Back to artists' })).toBeVisible()

  await expect(page.getByRole('button', { name: 'Open Clear Water' })).toBeVisible()
  await expect(page.locator('.library-card-copy').first()).toContainText('2011')
  const names = () => page.locator('.library-card-copy strong').allInnerTexts()
  expect(await names()).toEqual(['Clear Water', 'Stone Lines'])
  await page.getByLabel('Sort albums').selectOption('oldest')
  await expect.poll(names).toEqual(['Stone Lines', 'Clear Water'])

  await expect(page.getByRole('img', { name: /Clear Water leads with 30 plays/ })).toBeVisible()
  await page.getByRole('button', { name: 'All songs' }).click()
  await expect(page.getByLabel('Sort songs')).toBeVisible()
  // All songs keeps the same header rather than shrinking to a bare count.
  await expect(header.getByRole('heading', { level: 1, name: 'Harbor Static' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Albums' })).toBeVisible()
  await page.getByLabel('Sort songs').selectOption('plays')
  await expect(page.locator('.library-track-play strong').first()).toHaveText('Cinder')
})

test('an artist page folds the editions of one album into a single card', async ({ page }) => {
  await libraryFixtures(page)
  const album = (id: string, name: string, year: number, songs: number, playCount: number) => ({
    id,
    name,
    artist: 'Harbor Static',
    coverArt: 'cover-1',
    songCount: songs,
    year,
    playCount,
  })
  // Two editions of Circles, and two titles that only look alike and must stay apart.
  const albums = [
    album('circles-1', 'Circles', 2019, 12, 5),
    album('circles-2', 'Circles (Deluxe Edition)', 2020, 20, 9),
    album('blue-1', 'Blue', 2015, 8, 1),
    album('blue-2', 'Blue Moon', 2016, 9, 2),
  ]
  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({ json: { id: 'artist-1', name: 'Harbor Static', album: albums } }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: library } }),
  )
  await page.goto('/library/artists/artist-1')

  // Four releases, three albums: the header says both.
  const header = page.locator('.collection-header')
  await expect(header.locator('.library-count')).toHaveText('3 albums, 4 editions · 3 songs')
  const names = () => page.locator('.library-card-copy strong').allInnerTexts()
  // A group sorts as one album, by its newest edition.
  expect(await names()).toEqual(['Circles', 'Blue Moon', 'Blue'])
  await page.getByLabel('Sort albums').selectOption('oldest')
  await expect.poll(names).toEqual(['Blue', 'Blue Moon', 'Circles'])
  await page.getByLabel('Sort albums').selectOption('plays')
  await expect.poll(names).toEqual(['Circles', 'Blue Moon', 'Blue'])

  // Only the grouped card carries the chip; "Blue" and "Blue Moon" are ordinary cards.
  await expect(page.locator('.edition-chip')).toHaveText(['2 editions'])
  await expect(page.getByRole('button', { name: 'Open Blue', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Blue Moon', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Open Circles, 2 editions' }).click()
  const editions = page.getByRole('dialog', { name: 'Circles' })
  await expect(editions).toBeVisible()
  const rows = editions.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  // Oldest first, each with what tells it apart: the edition words, the year and the song count.
  await expect(rows.nth(0)).toContainText('Standard edition')
  await expect(rows.nth(0)).toContainText('2019 · 12 songs')
  await expect(rows.nth(1)).toContainText('Deluxe Edition')
  await expect(rows.nth(1)).toContainText('2020 · 20 songs')

  await editions.getByRole('button', { name: /Deluxe Edition/ }).click()
  await expect(page).toHaveURL(/\/library\/artists\/artist-1\/albums\/circles-2$/)
})

test('the artists view sends its filters to the server and keeps favourites', async ({
  page,
  isMobile,
}) => {
  await libraryFixtures(page)
  const artists = [
    { id: 'artist-1', name: 'Harbor Static', albumCount: 2 },
    { id: 'artist-2', name: 'Low Tide', albumCount: 1 },
  ]
  const requests: URL[] = []
  await page.route(
    (url) => url.pathname === '/api/library/artists',
    (route) => {
      const url = new URL(route.request().url())
      requests.push(url)
      const items = url.searchParams.get('show') ? artists.slice(0, 1) : artists
      route.fulfill({
        json: {
          items,
          next_offset: null,
          total: items.length,
          genres: ['Jazz', 'Rock'],
          years: [2011, 1999],
        },
      })
    },
  )
  let starred = false
  const favourites: string[] = []
  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({
      json: {
        id: 'artist-1',
        name: 'Harbor Static',
        album: [],
        ...(starred ? { starred: '2026-09-17T00:00:00Z' } : {}),
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: [] } }),
  )

  await page.route('**/api/library/artists/artist-1/favourite', (route) => {
    favourites.push(route.request().method())
    starred = route.request().method() === 'PUT'
    return route.fulfill({ status: 204 })
  })
  await page.goto('/library/artists')

  await expect(page.getByText('2 of 2 loaded')).toBeVisible()
  await openLibraryFilters(page, isMobile)
  await page.getByLabel('Sort artists').selectOption('recent')
  await page.getByLabel('Show artists').selectOption('unplayed')
  await expect(page.getByText('1 of 1 loaded')).toBeVisible()
  await page.getByText('All genres', { exact: true }).click()
  // The genre choices are the whole library's, sent back with the first page.
  await page.getByLabel('Jazz').check()
  await expect
    .poll(() => {
      const latest = requests.at(-1)?.searchParams
      return [latest?.get('sort'), latest?.get('show'), latest?.getAll('genre')]
    })
    .toEqual(['recent', 'unplayed', ['Jazz']])
  await page.getByText('Genres (1)', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByLabel('Show artists')).toHaveValue('')
  await closeLibraryFilters(page, isMobile)
  // The unfiltered list was fetched before, so clearing may reuse it rather than ask again.
  await expect(page.getByText('2 of 2 loaded')).toBeVisible()

  await page.goto('/library/artists/artist-1')
  await page.getByRole('button', { name: 'Add to favourites' }).click()
  const favourite = page.getByRole('button', { name: 'Favourite', exact: true })
  await expect(favourite).toHaveAttribute('aria-pressed', 'true')
  await favourite.click()
  await expect(page.getByRole('button', { name: 'Add to favourites' })).toBeVisible()
  expect(favourites).toEqual(['PUT', 'DELETE'])
})

test('library view tabs have aria-pressed state', async ({ page }) => {
  await libraryFixtures(page)
  await page.goto('/library')

  const homeTab = page.getByRole('button', { name: 'Home', exact: true })
  const albumsTab = page.getByRole('button', { name: 'Albums', exact: true })
  const artistsTab = page.getByRole('button', { name: 'Artists', exact: true })
  const tracksTab = page.getByRole('button', { name: 'Tracks', exact: true })
  const playlistsTab = page.getByRole('button', { name: 'Playlists', exact: true })

  await expect(homeTab).toHaveAttribute('aria-pressed', 'true')
  await expect(albumsTab).toHaveAttribute('aria-pressed', 'false')
  await expect(artistsTab).toHaveAttribute('aria-pressed', 'false')
  await expect(tracksTab).toHaveAttribute('aria-pressed', 'false')
  await expect(playlistsTab).toHaveAttribute('aria-pressed', 'false')

  await albumsTab.click()
  await expect(homeTab).toHaveAttribute('aria-pressed', 'false')
  await expect(albumsTab).toHaveAttribute('aria-pressed', 'true')
})
