import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { librarySong, playerFixtures } from './library-fixtures'

const queue = [
  librarySong('song-1', { title: 'First Light', duration: 30 }),
  librarySong('song-2', { title: 'Second Wind', duration: 30, coverArt: 'cover-2' }),
]

/** Opens Now Playing on a restored queue, without starting playback. */
async function openNowPlaying(page: Page) {
  // The view is pinned so the stage does not depend on the machine's WebGPU.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: 'song-1', position: 0, entry: queue } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/now-playing')
  await expect(page.locator('.stage')).toBeVisible()
}

test.beforeEach(({ browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, 'Checked on desktop Chromium.')
})

test('the page has a wash from the cover, and it is only a value on a custom property', async ({
  page,
}) => {
  await openNowPlaying(page)

  // The fixture cover is one flat green, so the wash is that green mixed into the canvas.
  const wash = page.locator('[data-now-playing-wash]')
  await expect(wash).toHaveAttribute('data-now-playing-wash', /^#[0-9a-f]{6}$/)
  await expect(wash).toHaveAttribute('aria-hidden', 'true')
  await expect(wash).toHaveCSS('pointer-events', 'none')
})

test('the page keys work with nothing focused, and leave sliders and the tab list alone', async ({
  page,
}) => {
  await openNowPlaying(page)
  const volume = page.getByRole('slider', { name: 'Volume' })
  const level = async () => Number(await volume.inputValue())
  await expect.poll(level).toBeCloseTo(0.7, 2)

  await page.keyboard.press('ArrowDown')
  await expect.poll(level).toBeCloseTo(0.65, 2)
  await page.keyboard.press('ArrowUp')
  await expect.poll(level).toBeCloseTo(0.7, 2)

  await page.keyboard.press('m')
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible()
  await page.keyboard.press('m')
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible()

  await page.keyboard.press('l')
  await expect(page.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('q')
  await expect(page.getByRole('tab', { name: 'Up next' })).toHaveAttribute('aria-selected', 'true')

  // A focused slider keeps the arrow key: it moves one step of its own, not the page's five.
  await volume.focus()
  await page.keyboard.press('ArrowUp')
  await expect.poll(level).toBeCloseTo(0.71, 2)

  // A focused tab keeps the arrows for moving between tabs, and the volume does not move.
  await page.getByRole('tab', { name: 'Up next' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Lyrics' })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(level).toBeCloseTo(0.71, 2)
})

test('a question mark opens the cheat sheet and Escape closes it, but not from a text field', async ({
  page,
}) => {
  await openNowPlaying(page)
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })

  await page.keyboard.press('?')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Back or forward 5 seconds')).toBeVisible()
  await expect(sheet.getByText('Visualizer debug overlay')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  await page.getByRole('textbox', { name: 'Search music or paste a link' }).focus()
  await page.keyboard.press('?')
  await expect(sheet).toBeHidden()
})

test('right-clicking the artwork opens the menu, and Go to album goes there', async ({ page }) => {
  await openNowPlaying(page)
  const stage = page.locator('.stage')
  const box = await stage.boundingBox()
  if (!box) throw new Error('Stage has no layout box')

  await stage.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
  const menu = page.getByRole('menu', { name: 'Now Playing artwork' })
  await expect(menu).toBeVisible()
  for (const name of ['Go to album', 'Go to artist', 'Add to playlist', 'Full screen']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible()
  }

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await stage.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })
  await menu.getByRole('menuitem', { name: 'Go to album' }).click()
  await expect(page).toHaveURL(/\/library\/albums\/album-1/)
})

type Observed = Window & { sawLeaving?: boolean }

test('a track change cross-fades the artwork, and cuts under reduced motion', async ({ page }) => {
  await openNowPlaying(page)
  // Only a layer that is fading out carries `leaving`, and it is gone again within a third of a
  // second, so it is watched for rather than polled for.
  const watch = () =>
    page.evaluate(() => {
      const seen: Observed = window
      seen.sawLeaving = false
      new MutationObserver(() => {
        if (document.querySelector('.stage .leaving')) seen.sawLeaving = true
      }).observe(document.body, { childList: true, subtree: true })
    })
  const sawLeaving = () => page.evaluate(() => Boolean((window as Observed).sawLeaving))

  await watch()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByRole('heading', { name: 'Second Wind' })).toBeVisible()
  await expect.poll(sawLeaving).toBe(true)
  await expect(page.locator('.stage .leaving')).toHaveCount(0)
})

test('under reduced motion a track change draws no fading layer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openNowPlaying(page)
  await page.evaluate(() => {
    const seen: Observed = window
    seen.sawLeaving = false
    new MutationObserver(() => {
      if (document.querySelector('.leaving')) seen.sawLeaving = true
    }).observe(document.body, { childList: true, subtree: true })
  })

  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByRole('heading', { name: 'Second Wind' })).toBeVisible()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => Boolean((window as Observed).sawLeaving))).toBe(false)
})
