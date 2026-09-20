import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const alpha = librarySong('song-a', { title: 'Alpha', duration: 30 })
const bravo = librarySong('song-b', { title: 'Bravo', duration: 30 })

/** Now Playing with two songs restored, the clock under the test's control, and Alpha playing. */
async function playOnNowPlaying(page: Page) {
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-a', position: 0, entry: [alpha, bravo] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/now-playing')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
}

/** Opens the sleep timer menu and picks one of its choices. */
async function choose(page: Page, name: string) {
  await page.getByRole('button', { name: 'Sleep timer', exact: true }).click()
  await page.getByRole('menuitemradio', { name }).click()
}

test('a timed sleep counts down, can be cancelled, and pauses when it runs out', async ({
  page,
}) => {
  await playOnNowPlaying(page)
  const timer = page.getByRole('button', { name: 'Sleep timer', exact: true })
  const left = page.getByRole('timer', { name: 'Sleep time left' })

  await expect(timer).toHaveAttribute('aria-haspopup', 'menu')
  await choose(page, '15 minutes')
  await expect(left).toHaveText(/^1[45]:\d\d$/)

  // The running choice is the checked one.
  await timer.click()
  await expect(page.getByRole('menuitemradio', { name: '15 minutes' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('Escape')

  // Cancelling takes the countdown away and leaves the music alone.
  await page.getByRole('button', { name: 'Cancel sleep timer' }).click()
  await expect(left).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await timer.click()
  await expect(page.getByRole('menuitemradio', { name: 'Off' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('Escape')

  // Run one out: the clock is the test's, so fifteen minutes pass at once.
  await choose(page, '15 minutes')
  await page.clock.fastForward('15:05')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(left).toHaveCount(0)
})

test('the menu opens from the keyboard, moves with the arrows and returns focus on Escape', async ({
  page,
}) => {
  await playOnNowPlaying(page)
  const timer = page.getByRole('button', { name: 'Sleep timer', exact: true })

  await timer.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: 'Sleep timer' })).toBeVisible()
  await expect(page.getByRole('menuitemradio', { name: 'Off' })).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'End of track' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(timer).toBeFocused()

  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(timer).toBeFocused()
  await expect(page.getByRole('timer', { name: 'Sleep time left' })).toBeVisible()
})

test('end of album or queue is not offered with shuffle on', async ({ page }) => {
  await playOnNowPlaying(page)
  const timer = page.getByRole('button', { name: 'Sleep timer', exact: true })
  const item = page.getByRole('menuitemradio', { name: /End of album or queue/ })

  await timer.click()
  await expect(item).toBeEnabled()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click()
  await timer.click()
  await expect(item).toBeDisabled()
  await expect(item).toContainText('Not with shuffle or repeat')
})

test('the control row stays on one line at 1280 by 720 with a timer running', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'A laptop width is checked from a desktop browser, without 44px touch sizes.')
  await page.setViewportSize({ width: 1280, height: 720 })
  await playOnNowPlaying(page)
  await choose(page, '15 minutes')
  await expect(page.getByRole('timer', { name: 'Sleep time left' })).toBeVisible()

  // Every control in the row shares one line when their tops and bottoms overlap the shuffle's.
  const names = ['Shuffle', 'Sleep timer', 'Cancel sleep timer', 'Mute', 'Close player']
  const boxes = await Promise.all(
    names.map((name) => page.getByRole('button', { name, exact: true }).first().boundingBox()),
  )
  const [first, ...rest] = boxes
  if (!first) throw new Error('Missing the shuffle button')
  for (const box of rest) {
    if (!box) throw new Error('Missing a control in the row')
    expect(Math.abs(box.y + box.height / 2 - (first.y + first.height / 2))).toBeLessThan(
      first.height / 2,
    )
  }
  // Exact, because the hidden footer player has a "Library volume" of its own.
  await expect(page.getByRole('slider', { name: 'Volume', exact: true })).toBeVisible()
})
