import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { bodyNumber, bodyText, librarySong, playerFixtures, requestBody } from './library-fixtures'

const first = librarySong('s1', { title: 'Beacon', duration: 180 })
const second = librarySong('s2', { title: 'Anchor', duration: 180 })

/** Playlist contents the fixture mutates, so add and remove have to actually take effect. */
function playlistState() {
  return new Map<string, { id: string; name: string; entry: LibraryTrack[] }>([
    ['liked', { id: 'liked', name: 'Liked', entry: [] }],
    ['road', { id: 'road', name: 'Road trip', entry: [second] }],
  ])
}

async function playlistFixtures(page: Page) {
  const state = playlistState()
  await playerFixtures(page)
  const summary = (id: string) => {
    const playlist = state.get(id)
    return {
      id,
      name: playlist?.name ?? '',
      songCount: playlist?.entry.length ?? 0,
      duration: (playlist?.entry.length ?? 0) * 180,
      public: id === 'road',
      owner: 'listener',
      changed: '2026-09-01T00:00:00Z',
    }
  }
  await page.route(
    (url) => url.pathname === '/api/library/playlists',
    (route) =>
      route.fulfill({
        // Liked comes back last so the browser has to be the thing that promotes it.
        json: { items: [summary('road'), summary('liked')], liked_id: 'liked' },
      }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/playlists/liked',
    (route) => route.fulfill({ json: { ...summary('liked'), entry: state.get('liked')?.entry } }),
  )

  await page.route(/\/api\/library\/playlists\/(liked|road)$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const playlist = state.get(id)
    if (route.request().method() === 'DELETE') {
      state.delete(id)
      return route.fulfill({ status: 204 })
    }

    if (route.request().method() === 'PATCH' && playlist) {
      playlist.name = bodyText(requestBody(route), 'name') ?? playlist.name
    }
    return route.fulfill({ json: { ...summary(id), entry: playlist?.entry } })
  })

  await page.route(/\/api\/library\/playlists\/(liked|road)\/songs$/, (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const id = parts[parts.length - 2] ?? ''
    const playlist = state.get(id)
    const change = requestBody(route)
    const added = bodyText(change, 'song_id_to_add')
    const removed = bodyNumber(change, 'song_index_to_remove')
    if (playlist && added) playlist.entry = [...playlist.entry, first]
    if (playlist && removed !== undefined)
      playlist.entry = playlist.entry.filter((_, index) => index !== removed)
    return route.fulfill({ json: { ...summary(id), entry: playlist?.entry } })
  })

  await page.route(
    (url) => url.pathname === '/api/library/tracks/search',
    (route) => route.fulfill({ json: { items: [first, second] } }),
  )

  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: { id: 'album-1', name: 'Clear Water', artist: 'Harbor Static', song: [first] },
    }),
  )

  return state
}

test('the liked playlist leads the list and cannot be deleted from it', async ({ page }) => {
  await playlistFixtures(page)
  await page.goto('/library/playlists')

  const rows = page.locator('.library-list-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Liked')
  await expect(rows.first().getByRole('button', { name: 'Delete playlist Liked' })).toHaveCount(0)
  await expect(rows.nth(1).getByRole('button', { name: 'Delete playlist Road trip' })).toHaveCount(
    1,
  )

  // The delete control stays out of the way until the row is hovered or focused. Touch
  // layouts have nothing to hover, so it stays visible there.
  const trash = rows.nth(1).getByRole('button', { name: 'Delete playlist Road trip' })
  const idle = await page.evaluate(() => (matchMedia('(hover: none)').matches ? '1' : '0'))
  expect(await trash.evaluate((element) => getComputedStyle(element).opacity)).toBe(idle)
  await rows.nth(1).hover()
  await expect.poll(() => trash.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

  await page.getByLabel('Filter playlists').selectOption('private')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Liked')
})

test('a playlist page counts, plays, shuffles and renames its songs', async ({ page }) => {
  await playlistFixtures(page)
  await page.goto('/library/playlists/road')

  await expect(page.getByRole('heading', { name: 'Road trip' })).toBeVisible()
  await expect(page.locator('.library-detail .library-count').first()).toHaveText('1 song · 3:00')
  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('Anchor')

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Playlist name').fill('Long drive')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByLabel('Playlist name')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Long drive' })).toBeVisible()

  // Adding a song already in the playlist is not offered; the same control removes it.
  await page.getByLabel('Search songs to add').fill('anchor')
  const results = page.locator('.playlist-add-list')
  await expect(results.getByRole('button', { name: 'Remove Anchor from Long drive' })).toBeVisible()
  await results.getByRole('button', { name: 'Add Beacon to Long drive' }).click()
  await expect(page.locator('.library-detail .library-count').first()).toHaveText('2 songs · 6:00')
  await expect(results.getByRole('button', { name: 'Remove Beacon from Long drive' })).toBeVisible()
})

test('the playlist picker centres, toggles membership and removes other songs', async ({
  page,
}) => {
  await playlistFixtures(page)
  await page.goto('/library/albums/album-1')
  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('Beacon')

  await page.getByRole('button', { name: 'Add Beacon to a playlist' }).click()
  const sheet = page.getByRole('dialog', { name: 'Add track to playlist' })
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('Missing dialog or viewport measurements')
  // Centred means the gaps above and below match, and the same left and right.
  expect(Math.abs(box.y - (viewport.height - box.y - box.height))).toBeLessThan(2)
  expect(Math.abs(box.x - (viewport.width - box.x - box.width))).toBeLessThan(2)

  const row = sheet.locator('.playlist-picker-row').filter({ hasText: 'Road trip' })
  await expect(row).toContainText('1 song')
  await row.getByRole('button', { name: 'Add Beacon to Road trip' }).click()
  await expect(row.getByRole('button', { name: 'Remove Beacon from Road trip' })).toBeVisible()
  await expect(row).toContainText('2 songs')

  await row.getByRole('button', { name: 'Show songs in Road trip' }).click()
  const songs = row.locator('.playlist-picker-songs')
  await expect(songs).toContainText('Anchor')
  // A fixed height keeps a long playlist inside the sheet.
  expect(await songs.evaluate((element) => getComputedStyle(element).maxHeight)).toBe('190px')
  await songs.getByRole('button', { name: 'Remove Anchor from Road trip' }).click()
  await expect(songs).not.toContainText('Anchor')

  await sheet.getByRole('button', { name: 'Close playlist picker' }).click()
  await expect(sheet).toBeHidden()

  // The playlist page reads the same cache, so the change is already there.
  await page.goto('/library/playlists/road')
  await expect(page.locator('.library-detail .library-count').first()).toHaveText('1 song · 3:00')
  await expect(page.locator('.library-tracks')).toContainText('Beacon')
})

test('a playlist remove stays locked until the change lands', async ({ page }) => {
  const state = await playlistFixtures(page)
  state.get('road')?.entry.push(first)
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    /\/api\/library\/playlists\/road\/songs$/,
    async (route) => {
      await held
      await route.fallback()
    },
    { times: 1 },
  )

  await page.goto('/library/playlists/road')
  const rows = page.locator('.library-track-row')
  await expect(rows).toHaveCount(2)
  await rows
    .first()
    .getByRole('button', { name: /^Remove/ })
    .click()

  // Both removals are positional, so the second must not be sent against the old list.
  const remaining = rows.nth(1).getByRole('button', { name: /^Remove/ })
  await expect(remaining).toBeDisabled()
  release()
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByRole('button', { name: /^Remove/ })).toBeEnabled()
})
