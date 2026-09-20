import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { DEFAULT_THEME } from '../src/theme/themes'
import type { Theme } from '../src/theme/themes'
import { librarySong, playerFixtures } from './library-fixtures'
import { LIGHT_THEME, rgb, themeVars } from './theme-fixtures'

const queue = [
  librarySong('song-1', { title: 'First Light', duration: 30 }),
  librarySong('song-2', { title: 'Second Wind', duration: 30, coverArt: 'cover-2' }),
]

/** Two covers with a color of their own, so a track change has a different glow to fade to. */
const COVERS: Record<string, string> = { 'cover-1': '#c83c28', 'cover-2': '#2846c8' }

type Options = {
  /** A custom theme to open the page in, in place of the default one. */
  theme?: Theme
  /** The fill of each cover by id; a cover not listed keeps the fixture's flat green. */
  covers?: Record<string, string>
  /** Covers that do not load, so no color can be read from them. */
  unreadable?: boolean
}

/** Opens Now Playing on a restored queue, without starting playback. */
async function openNowPlaying(page: Page, { theme, covers, unreadable }: Options = {}) {
  // The view is pinned so the stage does not depend on the machine's WebGPU.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  if (theme) {
    await page.addInitScript(
      ([active, custom, vars]: readonly [string, string, string]) => {
        localStorage.setItem('musimo.theme', active)
        localStorage.setItem('musimo.custom-themes', custom)
        localStorage.setItem('musimo.theme-vars', vars)
      },
      [
        theme.id,
        JSON.stringify({ version: 1, themes: [theme] }),
        JSON.stringify(themeVars(theme)),
      ] as const,
    )
  }
  await playerFixtures(page)
  // Registered after the fixtures, so it is the one that answers.
  if (unreadable) {
    await page.route('**/api/player/art/**', (route) => route.fulfill({ status: 404 }))
  } else if (covers) {
    await page.route('**/api/player/art/**', (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
      const fill = covers[id] ?? '#283d31'

      return route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${fill}"/></svg>`,
      })
    })
  }
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

/** The layer of the glow, which is the element that carries its background. */
const glowLayer = '[data-now-playing-glow] > div'

for (const theme of [undefined, LIGHT_THEME]) {
  const name = theme ? 'the light fixture theme' : 'the default theme'

  test(`the glow sits behind the stage and stops short of the text, and axe passes, in ${name}`, async ({
    page,
  }) => {
    await openNowPlaying(page, { theme, covers: COVERS })
    const glow = page.locator('[data-now-playing-glow]')
    const layer = page.locator(glowLayer)

    // A hex value on the element, hidden from assistive tech, and out of the way of the pointer.
    await expect(glow).toHaveAttribute('data-now-playing-glow', /^#[0-9a-f]{6}$/)
    await expect(glow).toHaveAttribute('aria-hidden', 'true')
    await expect(glow).toHaveCSS('pointer-events', 'none')

    // Painted in the value it announces, which is not transparent and not the canvas itself.
    const hex = (await glow.getAttribute('data-now-playing-glow')) ?? ''
    await expect(layer).toHaveCount(1)
    await expect(layer).toHaveCSS('background-color', rgb(hex))
    await expect(layer).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(hex).not.toBe((theme ?? DEFAULT_THEME).colors['--color-canvas'])

    // Behind the stage: earlier in the document, and the same box, so the stage covers the fill and
    // only the shadow shows around it.
    const behind = await page.evaluate(() => {
      const stage = document.querySelector('.stage')
      const halo = document.querySelector('[data-now-playing-glow]')
      if (!stage || !halo) return false

      return Boolean(stage.compareDocumentPosition(halo) & Node.DOCUMENT_POSITION_PRECEDING)
    })
    expect(behind).toBe(true)
    const stageBox = await page.locator('.stage').boundingBox()
    const layerBox = await layer.boundingBox()
    if (!stageBox || !layerBox) throw new Error('Stage or glow has no layout box')
    expect(layerBox.x).toBeCloseTo(stageBox.x, 0)
    expect(layerBox.y).toBeCloseTo(stageBox.y, 0)
    expect(layerBox.width).toBeCloseTo(stageBox.width, 0)
    expect(layerBox.height).toBeCloseTo(stageBox.height, 0)

    // It fades out before the title under it and the panel beside it: how far the shadow reaches is
    // its blur plus its spread.
    const reach = await layer.evaluate((element) => {
      const lengths = getComputedStyle(element).boxShadow.match(/-?[\d.]+px/g) ?? []
      const [, , blur = 0, spread = 0] = lengths.map((length) => Number.parseFloat(length))

      return blur + spread
    })
    expect(reach).toBeGreaterThan(0)
    const title = await page.getByRole('heading', { name: 'First Light' }).boundingBox()
    const panel = await page.getByRole('tabpanel').boundingBox()
    if (!title || !panel) throw new Error('Title or panel has no layout box')
    expect(stageBox.y + stageBox.height + reach).toBeLessThanOrEqual(title.y)
    expect(stageBox.x + stageBox.width + reach).toBeLessThanOrEqual(panel.x)

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
}

test('no color to read means no glow and no wash', async ({ page }) => {
  await openNowPlaying(page, { unreadable: true })
  await expect(page.locator('[data-now-playing-wash]')).toHaveAttribute('data-now-playing-wash', '')
  await expect(page.locator('[data-now-playing-glow]')).toHaveAttribute('data-now-playing-glow', '')
  await expect(page.locator(glowLayer)).toHaveCount(0)
})

for (const reduced of [false, true]) {
  test(`a track change ${reduced ? 'cuts' : 'cross-fades'} the glow${reduced ? ' under reduced motion' : ''}`, async ({
    page,
  }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
    await openNowPlaying(page, { covers: COVERS })
    const glow = page.locator('[data-now-playing-glow]')
    await expect(glow).toHaveAttribute('data-now-playing-glow', /^#[0-9a-f]{6}$/)
    const before = (await glow.getAttribute('data-now-playing-glow')) ?? ''
    await page.evaluate(() => {
      const seen: Observed = window
      seen.sawLeaving = false
      new MutationObserver(() => {
        if (document.querySelector('[data-now-playing-glow] .leaving')) seen.sawLeaving = true
      }).observe(document.body, { childList: true, subtree: true })
    })

    await page.keyboard.press('Shift+ArrowRight')
    await expect(page.getByRole('heading', { name: 'Second Wind' })).toBeVisible()
    // The other cover's color arrives once it has been read.
    await expect(glow).not.toHaveAttribute('data-now-playing-glow', before)
    await expect(glow).toHaveAttribute('data-now-playing-glow', /^#[0-9a-f]{6}$/)
    const sawLeaving = () => page.evaluate(() => Boolean((window as Observed).sawLeaving))
    if (reduced) {
      await page.waitForTimeout(500)
      expect(await sawLeaving()).toBe(false)
    } else {
      await expect.poll(sawLeaving).toBe(true)
      // The old layer is taken away when its fade is done, leaving the new one alone.
      await expect(page.locator(`${glowLayer}.leaving`)).toHaveCount(0)
      await expect(page.locator(glowLayer)).toHaveCount(1)
    }
  })
}
