import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const song = librarySong('song-1', { title: 'First Light', duration: 30 })

// Times are milliseconds, as Navidrome sends them.
const SYNCED = {
  items: [
    {
      synced: true,
      line: [
        { start: 0, value: 'Morning finds the water' },
        { start: 8000, value: 'Light across the floor' },
        { start: 16000, value: 'Nobody at the door' },
        { start: 24000, value: 'Evening finds the shore' },
      ],
    },
  ],
}

/** Opens Now Playing on the Lyrics tab with a restored queue at `position` milliseconds. */
async function openLyrics(page: Page, lyrics: unknown, position = 0) {
  await page.addInitScript(() => {
    localStorage.setItem('musimo.now-playing-view', 'artwork')
    localStorage.setItem('musimo.now-playing-tab', 'lyrics')
  })
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position, entry: [song] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/song-1', (route) => route.fulfill({ json: lyrics }))
  await page.goto('/now-playing')
  await expect(page.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true')
}

const line = (page: Page, text: string) => page.getByRole('button', { name: text, exact: true })

test('the line for the restored position is current, and the nudge moves it', async ({ page }) => {
  // Nine seconds in: past the second line's start, short of the third.
  await openLyrics(page, SYNCED, 9000)
  await expect(line(page, 'Light across the floor')).toHaveAttribute('aria-current', 'true')
  await expect(line(page, 'Morning finds the water')).not.toHaveAttribute('aria-current', 'true')

  // Three presses later is a second and a half, which puts the second line's start past the
  // playhead, so the first line is current again.
  const later = page.getByRole('button', { name: /^Later/ })
  await later.click()
  await later.click()
  await later.click()
  await expect(page.getByRole('group', { name: 'Lyrics timing' })).toContainText('+1.5 s')
  await expect(line(page, 'Morning finds the water')).toHaveAttribute('aria-current', 'true')

  // The nudge belongs to this track and survives a reload.
  await page.reload()
  await expect(page.getByRole('group', { name: 'Lyrics timing' })).toContainText('+1.5 s')
  const saved = await page.evaluate(() => localStorage.getItem('musimo.lyrics-offset'))
  expect(JSON.parse(saved ?? '{}')).toEqual({ 'song-1': 1.5 })
})

test('clicking a line seeks the player to its start', async ({ page }) => {
  await openLyrics(page, SYNCED)
  await line(page, 'Nobody at the door').click()
  await expect(line(page, 'Nobody at the door')).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue(/^16(\.0)?$/)
})

/** The lyrics view that Large type and L open, and the box of lines inside it. */
const view = (page: Page) => page.locator('[data-lyrics-view]')
const viewLines = (page: Page) => view(page).getByRole('region', { name: 'Lyrics', exact: true })

test('L opens the lyrics view across the content, and Escape closes it and returns focus', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'A phone has no L key.')
  await page.setViewportSize({ width: 1440, height: 900 })
  await openLyrics(page, SYNCED)
  const large = page.getByRole('button', { name: 'Large type' })
  await expect(view(page)).toHaveCount(0)

  await page.keyboard.press('l')
  await expect(view(page)).toBeVisible()
  // The lines are a wide column, not the half window the tab has.
  const content = await page.locator('main').boundingBox()
  const column = await viewLines(page).boundingBox()
  expect(column?.width ?? 0).toBeGreaterThanOrEqual((content?.width ?? Infinity) * 0.6)
  // The tab's own lines are gone, so only one list follows the clock.
  await expect(page.getByRole('region', { name: 'Lyrics', exact: true })).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(view(page)).toHaveCount(0)
  await expect(large).toBeFocused()

  // L closes it too, and focus comes back the same way.
  await page.keyboard.press('l')
  await expect(view(page)).toBeVisible()
  await page.keyboard.press('l')
  await expect(view(page)).toHaveCount(0)
  await expect(large).toBeFocused()

  // The close button leaves as well.
  await large.click()
  await view(page).getByRole('button', { name: 'Close lyrics view' }).click()
  await expect(view(page)).toHaveCount(0)
  await expect(large).toBeFocused()

  // Typing in the search box keeps its own letters. Last, since the letter searches.
  await page.getByRole('textbox', { name: 'Search music or paste a link' }).focus()
  await page.keyboard.press('l')
  await expect(view(page)).toHaveCount(0)
})

test('clicking a line in the lyrics view seeks, and the nudge is in reach', async ({ page }) => {
  await openLyrics(page, SYNCED)
  await page.getByRole('button', { name: 'Large type' }).click()
  await expect(view(page)).toBeVisible()

  const target = viewLines(page).getByRole('button', { name: 'Nobody at the door', exact: true })
  await target.click()
  await expect(target).toHaveAttribute('aria-current', 'true')
  const slider = view(page).getByRole('slider', { name: 'Playback position' })
  await expect(slider).toHaveValue(/^16(\.0)?$/)

  const timing = view(page).getByRole('group', { name: 'Lyrics timing' })
  await timing.getByRole('button', { name: /^Later/ }).click()
  await expect(timing).toContainText('+0.5 s')
})

test('the strip in the lyrics view plays and pauses', async ({ page }) => {
  await openLyrics(page, SYNCED)
  await page.getByRole('button', { name: 'Large type' }).click()
  const strip = view(page)
  await expect(strip.getByText('First Light')).toBeVisible()

  await strip.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(strip.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await strip.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(strip.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
})

test('untimed lyrics get the same view without following', async ({ page }) => {
  await openLyrics(page, { items: [{ synced: false, line: [{ value: 'Just the words' }] }] })
  await page.getByRole('button', { name: 'Large type' }).click()
  await expect(view(page)).toBeVisible()
  await expect(view(page).getByText('Not timed')).toBeVisible()
  await expect(viewLines(page).getByText('Just the words')).toBeVisible()
  await expect(view(page).getByRole('group', { name: 'Lyrics timing' })).toHaveCount(0)
  await expect(view(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible()
})

test('untimed lyrics say so and have no timing control', async ({ page }) => {
  await openLyrics(page, { items: [{ synced: false, line: [{ value: 'Just the words' }] }] })
  await expect(page.getByText('Not timed')).toBeVisible()
  await expect(page.getByText('Just the words')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Lyrics timing' })).toHaveCount(0)
})

test('no lyrics offers another search', async ({ page }) => {
  await openLyrics(page, { items: [] })
  await expect(page.getByText('No lyrics found for this track.')).toBeVisible()
  // Registered later, so it answers first from here on.
  await page.route('**/api/player/lyrics/song-1', (route) => route.fulfill({ json: SYNCED }))
  await page.getByRole('button', { name: 'Search again' }).click()
  await expect(line(page, 'Morning finds the water')).toBeVisible()
})
