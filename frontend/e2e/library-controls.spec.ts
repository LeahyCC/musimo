import type { Page } from '@playwright/test'

import {
  closeLibraryFilters,
  libraryShow,
  librarySong,
  librarySort,
  openLibraryFilters,
  openLibraryView,
  playerFixtures,
  toggleLibraryFacet,
} from './library-fixtures'
import { expect, test } from './test'

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
  await librarySort(page, 'tracks').selectOption('duration')
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
  await toggleLibraryFacet(page, isMobile, 'Genre')
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
  await toggleLibraryFacet(page, isMobile, 'Genre', 1)
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
  await page.goto('/library/albums')
  await expect(page).toHaveURL(/\/library\/albums$/)
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
  for (const name of ['Play all', 'Shuffle', 'Queue', 'More actions for Clear Water'])
    await expect(header.getByRole('button', { name })).toBeVisible()

  // The browse heading and the view switcher give way to the header; a slim row carries the way
  // back, so the album starts right under it.
  await expect(page.getByRole('heading', { name: 'Albums', exact: true })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Library views' })).toHaveCount(0)
  const back = page.getByRole('button', { name: 'Back to albums' })
  await expect(back).toBeVisible()
  const backBox = await back.boundingBox()
  const headerBox = await header.boundingBox()
  if (!backBox || !headerBox) throw new Error('Missing header measurements')
  expect(headerBox.y - (backBox.y + backBox.height)).toBeLessThan(60)
})

test('a failed load reports under the heading it belongs to', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({ status: 500, json: { detail: 'The library index is unavailable.' } }),
  )
  await page.goto('/library/albums')

  const heading = page.getByRole('heading', { name: 'Albums', exact: true })
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
  await toggleLibraryFacet(page, isMobile, 'Genre')
  await page.getByLabel('Rock').check()
  await toggleLibraryFacet(page, isMobile, 'Genre', 1)
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
  await librarySort(page, 'tracks').selectOption('album')
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
  await expect(page).toHaveURL(/sort=oldest/)
  await expect.poll(names).toEqual(['Stone Lines', 'Clear Water'])

  await expect(page.getByRole('img', { name: /Clear Water leads with 30 plays/ })).toBeVisible()
  // The most played songs lead the page, most played first, and link on to the whole list.
  await expect(page.getByRole('heading', { name: 'Top songs' })).toBeVisible()
  await expect(page.locator('.library-top-songs .library-track-play strong').first()).toHaveText(
    'Cinder',
  )
  await expect(page.getByRole('button', { name: 'All 3 songs' })).toBeVisible()
  await page.getByRole('button', { name: 'All songs' }).click()
  await expect(page.getByLabel('Sort songs')).toBeVisible()
  // All songs keeps the same header rather than shrinking to a bare count.
  await expect(header.getByRole('heading', { level: 1, name: 'Harbor Static' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Albums' })).toBeVisible()
  await page.getByLabel('Sort songs').selectOption('plays')
  await expect(page).toHaveURL(/sort=plays/)
  await expect(page.locator('.library-track-play strong').first()).toHaveText('Cinder')
  await header.getByRole('button', { name: 'Albums' }).click()
  await expect(page).toHaveURL(/sort=oldest/)
  await expect.poll(names).toEqual(['Stone Lines', 'Clear Water'])
})

test('returning to the artists list restores the place it was left', async ({ page }) => {
  await libraryFixtures(page)
  const artists = Array.from({ length: 48 }, (_, index) => ({
    id: `artist-${index + 1}`,
    name: `Artist ${index + 1}`,
    albumCount: 1,
  }))
  await page.route(
    (url) => url.pathname === '/api/library/artists',
    (route) =>
      route.fulfill({
        json: { items: artists, next_offset: null, total: artists.length, genres: [], years: [] },
      }),
  )

  await page.route('**/api/library/artists/artist-36', (route) =>
    route.fulfill({ json: { id: 'artist-36', name: 'Artist 36', album: [] } }),
  )

  await page.route('**/api/library/artists/artist-36/tracks', (route) =>
    route.fulfill({ json: { items: [] } }),
  )
  await page.goto('/library/artists')

  const card = page.getByRole('button', { name: 'Open Artist 36' })
  await card.scrollIntoViewIfNeeded()
  // The list scrolls on the window in Classic and on `#main` in the Listening room.
  const place = () =>
    page.evaluate(() => Math.max(window.scrollY, document.querySelector('#main')?.scrollTop ?? 0))
  await expect.poll(place).toBeGreaterThan(200)
  const leftAt = await place()

  // The page's own Back link opens the list afresh, and the browser's Back returns to the
  // earlier visit; both should land where the list was left.
  for (const goBack of [
    async () => page.getByRole('button', { name: 'Back to artists' }).click(),
    async () => page.goBack(),
  ]) {
    await card.click()
    await expect(page.getByRole('heading', { name: 'Artist 36' })).toBeVisible()
    await goBack()
    await expect(card).toBeInViewport()
    await expect(card).toBeFocused()
    await expect.poll(place).toBeGreaterThan(leftAt - 200)
  }
})

test('the A-Z rail jumps to a letter further down the artists list', async ({ page }) => {
  await libraryFixtures(page)
  const artists = [
    ['a', 'Alpha'],
    ['m', 'Mango'],
    ['z', 'Zebra'],
  ].flatMap(([prefix, word]) =>
    Array.from({ length: 10 }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      name: `${word} ${index + 1}`,
      albumCount: 1,
    })),
  )
  // Pages of ten, whatever size the page asks for, so the Z artists start out genuinely
  // unloaded and the jump has to fetch its way to them.
  await page.route(
    (url) => url.pathname === '/api/library/artists',
    (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0)
      const end = offset + 10
      route.fulfill({
        json: {
          items: artists.slice(offset, end),
          next_offset: end < artists.length ? end : null,
          total: artists.length,
          genres: [],
          years: [],
          letters:
            offset === 0
              ? [
                  { letter: 'A', offset: 0 },
                  { letter: 'M', offset: 10 },
                  { letter: 'Z', offset: 20 },
                ]
              : [],
        },
      })
    },
  )
  await page.goto('/library/artists')

  await page.getByRole('button', { name: 'Jump to artists starting with Z' }).click()
  const card = page.getByRole('button', { name: 'Open Zebra 1' })
  await expect(card).toBeInViewport()
  await expect(card).toBeFocused()
})

test('a tracks sort stays in the address and comes back with the tab', async ({
  page,
  isMobile,
}) => {
  await libraryFixtures(page)
  await page.route(
    (url) => url.pathname === '/api/library/artists',
    (route) =>
      route.fulfill({
        json: { items: [], next_offset: null, total: 0, genres: [], years: [] },
      }),
  )
  await page.goto('/library/tracks')
  await openLibraryFilters(page, isMobile)
  await librarySort(page, 'tracks').selectOption('duration')
  await closeLibraryFilters(page, isMobile)
  await expect(page).toHaveURL(/\/library\/tracks\?sort=duration/)

  await openLibraryView(page, isMobile, 'Artists')
  await expect(page).toHaveURL(/\/library\/artists$/)
  await openLibraryView(page, isMobile, 'Tracks')
  await expect(page).toHaveURL(/\/library\/tracks\?sort=duration/)
  await openLibraryFilters(page, isMobile)
  await expect(librarySort(page, 'tracks')).toHaveValue('duration')
})

test('an album sort stays after opening the album and going back', async ({ page, isMobile }) => {
  await playerFixtures(page)
  await page.route(
    (url) => url.pathname === '/api/library/albums',
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'album-1',
              name: 'Clear Water',
              artist: 'Harbor Static',
              year: 2018,
              songCount: 2,
            },
          ],
          next_offset: null,
          total: 1,
          genres: ['Ambient'],
          years: [2018],
        },
      }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/albums/album-1',
    (route) =>
      route.fulfill({
        json: {
          id: 'album-1',
          name: 'Clear Water',
          artist: 'Harbor Static',
          year: 2018,
          song: [librarySong('s1', { title: 'First Light' })],
        },
      }),
  )
  await page.goto('/library/albums')
  await openLibraryFilters(page, isMobile)
  await librarySort(page, 'albums').selectOption('title')
  await closeLibraryFilters(page, isMobile)
  await expect(page).toHaveURL(/sort=title/)

  await page.getByRole('button', { name: 'Open Clear Water' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Clear Water' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/library\/albums\?sort=title/)

  await page.getByRole('button', { name: 'Open Clear Water' }).click()
  await page.getByRole('button', { name: 'Back to albums' }).click()
  await expect(page).toHaveURL(/\/library\/albums\?sort=title/)
  await openLibraryFilters(page, isMobile)
  await expect(librarySort(page, 'albums')).toHaveValue('title')
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
  await librarySort(page, 'artists').selectOption('recent')
  await libraryShow(page, 'Show artists').selectOption('unplayed')
  await expect(page.getByText('1 of 1 loaded')).toBeVisible()
  await toggleLibraryFacet(page, isMobile, 'Genre')
  // The genre choices are the whole library's, sent back with the first page.
  await page.getByLabel('Jazz').check()
  await expect
    .poll(() => {
      const latest = requests.at(-1)?.searchParams
      return [latest?.get('sort'), latest?.get('show'), latest?.getAll('genre')]
    })
    .toEqual(['recent', 'unplayed', ['Jazz']])
  await toggleLibraryFacet(page, isMobile, 'Genre', 1)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(libraryShow(page, 'Show artists')).toHaveValue('')
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

test('the phone switches library views from a row of chips with aria-pressed state', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'A wide Classic screen switches view from the sidebar, not from the page')
  await libraryFixtures(page)
  await page.goto('/library/albums')

  const views = page.getByRole('navigation', { name: 'Library views' })
  // Home is the dashboard at `/` now, not a library view.
  await expect(views.getByRole('button', { name: 'Home', exact: true })).toHaveCount(0)
  const albumsTab = views.getByRole('button', { name: 'Albums', exact: true })
  const artistsTab = views.getByRole('button', { name: 'Artists', exact: true })
  const tracksTab = views.getByRole('button', { name: 'Tracks', exact: true })
  const playlistsTab = views.getByRole('button', { name: 'Playlists', exact: true })

  await expect(albumsTab).toHaveAttribute('aria-pressed', 'true')
  await expect(artistsTab).toHaveAttribute('aria-pressed', 'false')
  await expect(tracksTab).toHaveAttribute('aria-pressed', 'false')
  await expect(playlistsTab).toHaveAttribute('aria-pressed', 'false')

  await artistsTab.click()
  await expect(albumsTab).toHaveAttribute('aria-pressed', 'false')
  await expect(artistsTab).toHaveAttribute('aria-pressed', 'true')
})

const albumPage = {
  items: [
    {
      id: 'album-1',
      name: 'Clear Water',
      artist: 'Harbor Static',
      coverArt: 'cover-1',
      year: 2011,
    },
    {
      id: 'album-2',
      name: 'Stone Lines',
      artist: 'Harbor Static',
      coverArt: 'cover-1',
      year: 1999,
    },
  ],
  next_offset: null,
  total: 2,
  genres: ['Ambient', 'Jazz'],
  years: [2011, 1999],
}

async function browseFixtures(page: Page) {
  await libraryFixtures(page)
  await page.route(
    (url) => url.pathname === '/api/library/albums',
    (route) => route.fulfill({ json: albumPage }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/artists',
    (route) =>
      route.fulfill({
        json: { items: [], next_offset: null, total: 7, genres: [], years: [] },
      }),
  )

  await page.route('**/api/library/playlists', (route) =>
    route.fulfill({ json: { items: [], liked_id: '' } }),
  )
}

test('Classic names the view with its count and lays its toolbar out in 36px chips', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'A phone keeps these controls in the Filter sheet')
  await browseFixtures(page)
  await page.goto('/library/albums')

  await expect(page.getByRole('heading', { name: 'Albums', exact: true })).toBeVisible()
  await expect(page.getByText('2 albums', { exact: true })).toBeVisible()
  // The view switcher is a phone's chip row. A wide screen has the sidebar.
  await expect(page.getByRole('navigation', { name: 'Library views' })).toBeHidden()

  const chips = page.locator('[data-ui="select-chip"]')
  await expect(chips).toHaveCount(3)
  for (const chip of await chips.all()) expect((await chip.boundingBox())?.height).toBe(36)
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('the Listening room shows one Library page with counted tabs and removable filter chips', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'A phone keeps its filters in the Filter sheet')
  await page.addInitScript(() => localStorage.setItem('musimo.layout', 'room'))
  await browseFixtures(page)
  await page.goto('/library/albums?genre=%5B%22Jazz%22%5D')

  const views = page.getByRole('navigation', { name: 'Library views' })
  const artists = views.getByRole('button', { name: /^Artists/ })
  await expect(artists).toContainText('7')
  await expect(views.getByRole('button', { name: /^Albums/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // A filter that is on is a chip that removes itself, and the address follows.
  await page.getByRole('button', { name: 'Remove filter Genre: Jazz' }).click()
  await expect(page).toHaveURL(/\/library\/albums$/)
  await expect(page.getByRole('button', { name: /Remove filter/ })).toHaveCount(0)

  // One that is off is a dashed chip that opens its choices.
  await page.getByRole('button', { name: 'Year' }).click()
  await page.getByLabel('1999').click()
  await expect(page.getByRole('button', { name: 'Remove filter Year: 1999' })).toBeVisible()
})
