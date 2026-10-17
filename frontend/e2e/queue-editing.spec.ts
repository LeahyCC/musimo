import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import {
  bodyText,
  generatedPlayerAudio,
  librarySong,
  playerFixtures,
  requestBody,
} from './library-fixtures'
import { botModelFixtures, proposalFixtures } from './proposal-fixtures'

const alpha = librarySong('song-a', { title: 'Alpha' })
const bravo = librarySong('song-b', { title: 'Bravo' })
const charlie = librarySong('song-c', { title: 'Charlie' })
const delta = librarySong('song-d', { title: 'Delta' })
const echo = librarySong('song-e', { title: 'Echo', albumId: 'album-2', album: 'Open Air' })

type Save = { ids: string[]; current: string }

/**
 * Restores this queue with its first song loaded, without starting playback, and records every
 * save the player sends back. It hands back the queue as it was last
 * saved, so a reload restores the edits made before it.
 */
async function restoreQueue(page: Page, queue: LibraryTrack[]) {
  const saves: Save[] = []
  const known = new Map(
    [...queue, alpha, bravo, charlie, delta, echo].map((song) => [song.id, song] as const),
  )
  let restored = { current: queue[0]?.id ?? '', entry: queue }
  // Pinned so the stage does not depend on the machine's graphics.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await generatedPlayerAudio(page)
  await page.route('**/api/player/queue', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ...restored, position: 0 } })
      return
    }

    const body = requestBody(route)
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter(
      (id): id is string => typeof id === 'string',
    )
    const current = bodyText(body, 'current') ?? ''
    saves.push({ ids, current })
    const entry = ids.flatMap((id) => known.get(id) ?? [])
    if (entry.length === ids.length) restored = { current, entry }
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  return saves
}

const lastSave = (saves: Save[]) => saves[saves.length - 1]

const album = {
  id: 'album-1',
  name: 'Clear Water',
  artist: 'Harbor Static',
  coverArt: 'cover-1',
  songCount: 2,
  song: [charlie, delta],
}

test('Up next reorders, removes and clears from the buttons and the keyboard, saving each change', async ({
  page,
}) => {
  const saves = await restoreQueue(page, [alpha, bravo, charlie, delta])
  await page.goto('/now-playing')
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })
  const titles = upNext.locator('[data-queue-index] strong')
  await expect(titles).toHaveText(['Bravo', 'Charlie', 'Delta'])

  await upNext.getByRole('button', { name: 'Move Delta up' }).click()
  await expect(titles).toHaveText(['Bravo', 'Delta', 'Charlie'])
  await expect
    .poll(() => lastSave(saves))
    .toEqual({
      ids: ['song-a', 'song-b', 'song-d', 'song-c'],
      current: 'song-a',
    })
  await expect(upNext.getByRole('status')).toHaveText('Moved Delta to position 2 of 3.')
  // The row moved under the keyboard, so focus stays with it.
  await expect(upNext.getByRole('button', { name: 'Move Delta up' })).toBeFocused()

  await upNext.getByRole('button', { name: 'Play Charlie' }).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(titles).toHaveText(['Bravo', 'Charlie', 'Delta'])
  await expect(upNext.getByRole('button', { name: 'Play Charlie' })).toBeFocused()

  await upNext.getByRole('button', { name: 'Remove Charlie from the queue' }).click()
  await expect(titles).toHaveText(['Bravo', 'Delta'])
  await expect.poll(() => lastSave(saves)?.ids).toEqual(['song-a', 'song-b', 'song-d'])
  await expect(upNext.getByRole('status')).toHaveText('Removed Charlie. 2 songs up next.')
  await expect(upNext.getByRole('button', { name: 'Remove Delta from the queue' })).toBeFocused()

  // Clearing keeps the song that is playing.
  await upNext.getByRole('button', { name: 'Clear queue' }).click()
  await expect(upNext.getByText('Nothing else is queued.')).toBeVisible()
  await expect.poll(() => lastSave(saves)).toEqual({ ids: ['song-a'], current: 'song-a' })
  await expect(upNext.getByRole('button', { name: 'Clear queue' })).toBeDisabled()
})

test('a row can be dragged to a new place in Up next', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, 'Checked on desktop Chromium.')
  const saves = await restoreQueue(page, [alpha, bravo, charlie, delta])
  await page.goto('/now-playing')
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })
  const titles = upNext.locator('[data-queue-index] strong')
  await expect(titles).toHaveText(['Bravo', 'Charlie', 'Delta'])

  const grip = await upNext.locator('[data-queue-index="1"] span[aria-hidden="true"]').boundingBox()
  const last = await upNext.locator('[data-queue-index="3"]').boundingBox()
  if (!grip || !last) throw new Error('Missing row boxes')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  // Below the middle of the last row is the gap after it.
  await page.mouse.move(grip.x + grip.width / 2, last.y + last.height - 2, { steps: 8 })
  await page.mouse.up()

  await expect(titles).toHaveText(['Charlie', 'Delta', 'Bravo'])
  await expect.poll(() => lastSave(saves)?.ids).toEqual(['song-a', 'song-c', 'song-d', 'song-b'])
})

test('Up next saves the whole queue as a playlist', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie])
  let created: Record<string, unknown> = {}
  await page.route('**/api/library/playlists', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { items: [], liked_id: '' } })
      return
    }

    created = requestBody(route)
    await route.fulfill({
      json: { id: 'playlist-1', name: 'Road trip', entry: [alpha, bravo, charlie] },
    })
  })
  await page.goto('/now-playing')
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })

  await upNext.getByRole('button', { name: 'Save as playlist' }).click()
  await upNext.getByLabel('Playlist name').fill('Road trip')
  await upNext.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(upNext.getByRole('status')).toHaveText('Saved 3 songs as playlist Road trip.')
  expect(created).toEqual({ name: 'Road trip', song_ids: ['song-a', 'song-b', 'song-c'] })
})

test('a song row and its album queue songs after the playing one, or at the end', async ({
  page,
}) => {
  const saves = await restoreQueue(page, [alpha, bravo])
  await page.route('**/api/library/albums/album-1', (route) => route.fulfill({ json: album }))
  await page.goto('/library/albums/album-1')
  await expect(page.locator('.live-player')).toContainText('Alpha')

  await page.getByRole('button', { name: 'More actions for Charlie' }).click()
  await page.getByRole('menuitem', { name: 'Play next' }).click()
  await expect
    .poll(() => lastSave(saves))
    .toEqual({
      ids: ['song-a', 'song-c', 'song-b'],
      current: 'song-a',
    })
  await expect(page.locator('.live-player')).toContainText('Playing Charlie next.')

  // Play next again lands behind the first, so the two play in the order they were chosen.
  await page.getByRole('button', { name: 'More actions for Delta' }).click()
  await page.getByRole('menuitem', { name: 'Play next' }).click()
  await expect.poll(() => lastSave(saves)?.ids).toEqual(['song-a', 'song-c', 'song-d', 'song-b'])

  await page.getByRole('button', { name: 'More actions for Clear Water' }).click()
  await page.getByRole('menuitem', { name: 'Add to queue' }).click()
  await expect
    .poll(() => lastSave(saves)?.ids)
    .toEqual(['song-a', 'song-c', 'song-d', 'song-b', 'song-c', 'song-d'])
})

test('removing a row keeps where the queue came from, and the album still shows Pause', async ({
  page,
}) => {
  await restoreQueue(page, [])
  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({ json: { ...album, songCount: 3, song: [charlie, delta, echo] } }),
  )
  await page.goto('/library/albums/album-1')
  const detail = page.locator('.library-detail')
  const pause = detail.getByRole('button', { name: 'Pause', exact: true })
  await detail.getByRole('button', { name: 'Play all' }).click()
  await expect(pause).toBeVisible()
  await page.getByRole('link', { name: 'Open Now Playing' }).click()
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })
  await expect(upNext.getByText(/^Playing from album Clear Water$/)).toBeVisible()

  await upNext.getByRole('button', { name: 'Remove Delta from the queue' }).click()
  await expect(upNext.locator('[data-queue-index] strong')).toHaveText(['Echo'])
  await expect(upNext.getByText(/^Playing from album Clear Water, edited$/)).toBeVisible()

  // The song playing is still the album's own, so the album's button carries on offering Pause.
  await page.goBack()
  await expect(page).toHaveURL(/\/library\/albums\/album-1$/)
  await expect(pause).toBeVisible()
  await expect(pause).toHaveAttribute('data-active', 'true')

  // Clearing leaves one song and no collection, so it counts as the listener's own queue.
  await page.goForward()
  await upNext.getByRole('button', { name: 'Clear queue' }).click()
  await expect(upNext.getByText(/^Playing from your queue$/)).toBeVisible()
  await page.goBack()
  await expect(detail.getByRole('button', { name: 'Play all' })).toBeVisible()
})

test('after a reload with shuffle on, a song queued to play next still plays next', async ({
  page,
}) => {
  // Chance would take the last song in the queue, so only the saved choice can put Echo first.
  await page.addInitScript(() => {
    Math.random = () => 0.99
    localStorage.setItem('musimo.player-shuffle', 'true')
  })
  const saves = await restoreQueue(page, [alpha, bravo, charlie, delta])
  await page.route('**/api/library/albums/album-2', (route) =>
    route.fulfill({
      json: {
        id: 'album-2',
        name: 'Open Air',
        artist: 'Harbor Static',
        coverArt: 'cover-2',
        songCount: 1,
        song: [echo],
      },
    }),
  )
  await page.goto('/library/albums/album-2')
  await expect(page.locator('.live-player')).toContainText('Alpha')

  await page.getByRole('button', { name: 'More actions for Echo' }).click()
  await page.getByRole('menuitem', { name: 'Play next' }).click()
  await expect
    .poll(() => lastSave(saves)?.ids)
    .toEqual(['song-a', 'song-e', 'song-b', 'song-c', 'song-d'])

  // The saved queue gives the ids back and nothing else, so what was chosen has to come from the browser.
  await page.reload()
  await expect(page.locator('.live-player')).toContainText('Alpha')
  await page.getByRole('button', { name: 'Next track' }).click()
  await expect(page.locator('.live-player')).toContainText('Echo')
})

test('adding past the 500 songs the queue keeps is refused with a message', async ({ page }) => {
  const full = Array.from({ length: 500 }, (_, index) =>
    librarySong(`filler-${index}`, { title: `Filler ${index}` }),
  )
  const saves = await restoreQueue(page, full)
  await page.route('**/api/library/albums/album-1', (route) => route.fulfill({ json: album }))
  await page.goto('/library/albums/album-1')
  await expect(page.locator('.live-player')).toContainText('Filler 0')
  const before = saves.length

  await page.getByRole('button', { name: 'More actions for Clear Water' }).click()
  await page.getByRole('menuitem', { name: 'Add to queue' }).click()
  await expect(page.locator('.live-player')).toContainText('The queue is full')
  await expect(page.locator('.live-player')).toContainText('Nothing was added')
  expect(saves).toHaveLength(before)
})

test('songs confirmed from a bot preview join Up next in the approved order and stay editable', async ({
  page,
}) => {
  const saves = await restoreQueue(page, [alpha])
  await botModelFixtures(page)
  const proposals = await proposalFixtures(page, [bravo, charlie, delta])
  const plan = {
    change_filters: [],
    allow_artists: [],
    add_count: 0,
    action: 'search',
    scope: 'library',
    artists: [],
    exclude_artists: [],
    genres: [],
    year_from: null,
    year_to: null,
    favourites: false,
    history: 'any',
    exclude_played_days: 0,
    min_seconds: 0,
    max_seconds: null,
    target_seconds: 0,
    limit: 100,
    similar_to_current: false,
    explanation: '',
  }
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: {
        plan,
        tracks: [bravo, charlie, delta],
        total_seconds: 642,
        shortfall_seconds: 0,
        summary: '3 songs, 10.7 minutes. Based on saved library tags.',
        elapsed_ms: 5,
      },
    }),
  )
  await page.goto('/music-bot')
  await page.getByRole('textbox', { name: /^Ask .+ for music$/ }).fill('three easy songs')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toBeVisible()
  // A preview changes nothing: the queue is still the one song that was restored.
  expect(saves).toHaveLength(0)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => lastSave(saves)?.ids).toEqual(['song-a', 'song-b', 'song-c', 'song-d'])
  expect(proposals.handed).toEqual([['song-b', 'song-c', 'song-d']])

  await page.getByRole('link', { name: 'Open Now Playing' }).first().click()
  const upNext = page.getByRole('tabpanel', { name: 'Up next' })
  const titles = upNext.locator('[data-queue-index] strong')
  await expect(titles).toHaveText(['Bravo', 'Charlie', 'Delta'])
  await upNext.getByRole('button', { name: 'Move Delta up' }).click()
  await expect(titles).toHaveText(['Bravo', 'Delta', 'Charlie'])
  await expect.poll(() => lastSave(saves)?.ids).toEqual(['song-a', 'song-b', 'song-d', 'song-c'])
  // The edit is the person's own: the confirmed preview did not queue anything again.
  expect(proposals.commits).toHaveLength(1)
})
