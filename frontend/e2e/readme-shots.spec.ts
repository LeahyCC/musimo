import type { Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'
import { searchFixtures } from './search-fixtures'
import { showcaseDiagnostics, showcaseFixtures, showcaseQueue } from './showcase-fixtures'
import { e2eListenerId, test } from './test'

/* The README's screenshots, from the invented library in `showcase-fixtures.ts`. Not part of a
   normal run: `MUSIMO_SHOTS=1 npx playwright test readme-shots --project=chromium` writes them
   into docs/assets. Diagnostics is the isolated stack's own answer with its music folder made
   writable, so it reads as a working install would. The visualizer GIF is recorded by hand and is not made here. */

test.skip(!process.env.MUSIMO_SHOTS, 'Set MUSIMO_SHOTS=1 to rewrite the README screenshots.')

const ASSETS = fileURLToPath(new URL('../../docs/assets/', import.meta.url))
const PHONES = fileURLToPath(new URL('../test-results/readme-phones/', import.meta.url))

async function open(page: Page, layout: 'classic' | 'room', path: string, queue = false) {
  await playerFixtures(page)
  if (queue) await showcaseQueue(page)
  else await emptyQueue(page)
  await searchFixtures(page)
  await showcaseFixtures(page, e2eListenerId())
  await showcaseDiagnostics(page)
  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: [], elapsed_ms: 1 } }),
  )

  await page.addInitScript((value) => {
    localStorage.setItem('musimo.layout', value)
    localStorage.setItem('musimo.now-playing-view', 'artwork')
  }, layout)
  await page.goto(path)
  // Live updates hold a connection open, so the page never goes network-idle. Wait for the
  // covers instead, then a moment for the cover colors and the pet to settle.
  // Only the covers on screen: a lazy image in a hidden tab never loads.
  await page.waitForFunction(() =>
    Array.from(document.images)
      .filter((image) => {
        const box = image.getBoundingClientRect()
        return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight
      })
      .every((image) => image.complete && image.naturalWidth > 0),
  )
  await page.waitForTimeout(1200)
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 })

  const shots: [string, 'classic' | 'room', string, boolean?][] = [
    ['now-playing', 'classic', '/now-playing'],
    ['listening-room', 'room', '/'],
    ['search', 'classic', '/search?q=Mira'],
    ['library', 'classic', '/library/albums'],
    ['downloads', 'room', '/downloads', true],
    ['diagnostics', 'classic', '/diagnostics'],
  ]
  for (const [name, layout, path, queue] of shots) {
    test(name, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium')
      await open(page, layout, path, queue)
      await page.screenshot({ path: `${ASSETS}${name}.png` })
    })
  }
})

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  const shots: [string, 'classic' | 'room', string][] = [
    ['classic-home', 'classic', '/'],
    ['room-library', 'room', '/library/albums'],
    ['room-now-playing', 'room', '/now-playing'],
    ['classic-layout', 'classic', '/settings/user'],
  ]
  for (const [name, layout, path] of shots) {
    test(name, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium')
      await open(page, layout, path)
      if (name === 'classic-layout')
        await page.getByRole('heading', { name: 'Layout' }).evaluate((heading) => {
          heading.closest('section')?.scrollIntoView({ block: 'center' })
        })
      mkdirSync(PHONES, { recursive: true })
      await page.screenshot({ path: `${PHONES}${name}.png` })
    })
  }

  // The four phones side by side in one picture, so the README shows them as a row.
  test('row', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium')
    const page = await browser.newPage({ viewport: { width: 1720, height: 900 } })
    const frames = shots
      .map(([name]) => {
        const data = readFileSync(`${PHONES}${name}.png`).toString('base64')
        return `<img src="data:image/png;base64,${data}">`
      })
      .join('')
    await page.setContent(
      `<body style="margin:0;background:#0a0d0c"><div id="row" style="display:flex;gap:36px;padding:28px 36px;width:max-content">${frames}</div><style>img{width:390px;height:844px;border-radius:44px;outline:8px solid #1b2420}</style></body>`,
    )
    await page.locator('#row').screenshot({ path: `${ASSETS}phones.png` })
    await page.close()
  })
})
