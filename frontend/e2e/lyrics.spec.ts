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

test('L toggles large type, and not while typing in the search box', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A phone has no L key.')
  await openLyrics(page, SYNCED)
  const large = page.getByRole('button', { name: 'Large type' })
  await expect(large).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('l')
  await expect(large).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('textbox', { name: 'Search music or paste a link' }).focus()
  await page.keyboard.press('l')
  await expect(large).toHaveAttribute('aria-pressed', 'true')
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
