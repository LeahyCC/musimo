import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

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
}) => {
  const recorded = await libraryFixtures(page)
  await page.goto('/library/tracks')

  await expect(page.getByText('3 of 3 loaded')).toBeVisible()
  // One note covers both buttons; it used to be printed under each of them.
  await expect(page.getByText('Covers every matching song, not just the loaded ones.')).toHaveCount(
    1,
  )
  await page.getByLabel('Sort tracks').selectOption('duration')
  await page.getByLabel('Search tracks').fill('cinder')
  await expect
    .poll(() => {
      const latest = recorded.tracks.at(-1)?.searchParams
      return [latest?.get('q'), latest?.get('sort')]
    })
    .toEqual(['cinder', 'duration'])

  await page.getByLabel('Search tracks').fill('')
  await page.getByText('All genres', { exact: true }).click()
  // Filter choices come from the whole library, not only the rows on screen.
  await expect(page.getByLabel('Rock')).toBeVisible()
  await page.getByLabel('Jazz').check()
  await expect.poll(() => recorded.tracks.at(-1)?.searchParams.getAll('genre')).toEqual(['Jazz'])
  // Close the panel first: at narrow widths it sits over the rest of the toolbar.
  await page.getByText('Genres (1)', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()

  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('Beacon')
  expect(recorded.selection.at(-1)?.searchParams.get('shuffle')).toBe('false')

  // The footer player has its own Shuffle toggle, so scope to the list's controls.
  const actions = page.locator('.library-list-actions')
  await actions.getByRole('button', { name: 'Shuffle' }).click()
  await expect.poll(() => recorded.selection.at(-1)?.searchParams.get('shuffle')).toBe('true')
})

test('a filtered selection is its own queue, not the one already playing', async ({ page }) => {
  await libraryFixtures(page)
  await page.goto('/library/tracks')

  const actions = page.locator('.library-list-actions')
  await actions.getByRole('button', { name: 'Play all' }).click()
  await expect(actions.getByRole('button', { name: 'Pause' })).toBeVisible()

  // A different filter is a different selection, so the control cannot claim to be playing it.
  await page.getByText('All genres', { exact: true }).click()
  await page.getByLabel('Rock').check()
  await page.getByText('Genres (1)', { exact: true }).click()
  await expect(actions.getByRole('button', { name: 'Play all' })).toBeVisible()
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
    route.fulfill({ json: { id: 'artist-1', name: 'Harbor Static', album: albums } }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: library } }),
  )
  await page.goto('/library/artists/artist-1')

  await expect(page.getByRole('button', { name: 'Open Clear Water' })).toBeVisible()
  await expect(page.locator('.library-card-copy').first()).toContainText('2011')
  const names = () => page.locator('.library-card-copy strong').allInnerTexts()
  expect(await names()).toEqual(['Clear Water', 'Stone Lines'])
  await page.getByLabel('Sort albums').selectOption('oldest')
  await expect.poll(names).toEqual(['Stone Lines', 'Clear Water'])

  await expect(page.getByRole('img', { name: /Clear Water leads with 30 plays/ })).toBeVisible()
  await page.getByRole('button', { name: 'All songs' }).click()
  await expect(page.getByLabel('Sort songs')).toBeVisible()
  await page.getByLabel('Sort songs').selectOption('plays')
  await expect(page.locator('.library-track-play strong').first()).toHaveText('Cinder')
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
