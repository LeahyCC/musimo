import type { Locator, Page } from '@playwright/test'

import { generatedPlayerAudio, librarySong, playerFixtures } from './library-fixtures'
import { botModelFixtures, proposalFixtures } from './proposal-fixtures'
import { expect, test } from './test'

/* The music bot's chat on a phone, in both layouts: the /music-bot page and the pet's sheet. It
   should read like a messaging app: the conversation takes the screen, the text box sits at the
   foot (on the on-screen keyboard while it is up), and nothing stands on it. Phone width only;
   the desktop chat is covered by the other music-bot specs. */
test.skip(({ isMobile }) => !isMobile, 'Phone layout only.')

const playing = librarySong('tr-0000000000000003', { title: 'Playing Song' })
const songs = Array.from({ length: 20 }, (_, i) =>
  librarySong(`tr-${(i + 0x100).toString(16).padStart(16, '0')}`, {
    title: `A rather long song title number ${i}`,
    artist: `Artist ${i % 5}`,
    duration: 200 + i,
  }),
)
const answer = {
  plan: {
    change_filters: [],
    allow_artists: [],
    add_count: 0,
    action: 'search',
    scope: 'library',
    artists: [],
    exclude_artists: [],
    genres: [],
    year_from: 1990,
    year_to: 1999,
    favourites: false,
    history: 'any',
    exclude_played_days: 0,
    min_seconds: 0,
    max_seconds: null,
    target_seconds: 3600,
    limit: 100,
    similar_to_current: false,
    explanation: '',
  },
  tracks: songs,
  total_seconds: 4190,
  shortfall_seconds: 0,
  summary: '20 songs, 69.8 minutes.',
  elapsed_ms: 12,
}

async function fixtures(page: Page, layout: 'classic' | 'room') {
  await page.addInitScript((value) => localStorage.setItem('musimo.layout', value), layout)
  // A stand-in for the visual viewport, so a test can raise and lower an on-screen keyboard the
  // way iOS Safari does: the layout viewport stays put and only the visible part shrinks.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: innerWidth,
      height: innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    })
    Object.defineProperty(window, 'visualViewport', { get: () => viewport })
    Object.defineProperty(window, 'fakeKeyboard', {
      value: (height: number) => {
        viewport.height = innerHeight - height
        viewport.dispatchEvent(new Event('resize'))
      },
    })
  })
  await playerFixtures(page)
  await generatedPlayerAudio(page)
  await botModelFixtures(page)
  await page.route('**/api/music-bot/chat', (route) => route.fulfill({ json: answer }))
  await proposalFixtures(page, songs)
  await page.route('**/api/player/queue', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { current: playing.id, position: 0, entry: [playing] } })
      : route.fulfill({ status: 204 }),
  )
}

const box = (page: Page) => page.getByRole('textbox', { name: /^Ask .+ for music$/ })
const card = (page: Page) => page.locator('[data-bot="card"]').last()
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const bars = (page: Page) => page.locator('[data-keyboard-hide]:visible')

async function rect(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('Not on screen')
  return found
}

async function ask(page: Page) {
  await box(page).fill('Twenty songs')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect(card(page).getByRole('list', { name: 'Proposed songs' })).toBeVisible()
}

/** The top of whatever is fixed along the screen's foot: the mini player, or the tab bar. The
 *  Listening room's fade behind them is only a picture, so it is left out. */
async function barsTop(page: Page) {
  return page.evaluate(() => {
    const tops = [...document.querySelectorAll('[data-keyboard-hide]:not([aria-hidden])')]
      .map((element) => element.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.top > innerHeight / 2)
      .map((r) => r.top)
    return Math.min(innerHeight, ...tops)
  })
}

const atEnd = (element: Locator) =>
  element.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 2)

async function keyboard(page: Page, height: number) {
  await page.evaluate((h) => {
    const raise = Reflect.get(window, 'fakeKeyboard')
    if (typeof raise === 'function') raise(h)
  }, height)
}

for (const layout of ['classic', 'room'] as const)
  test.describe(layout === 'room' ? 'Listening room' : 'Classic', () => {
    for (const [width, height] of [
      [320, 568],
      [390, 844],
    ] as const)
      test(`at ${width}x${height} the page gives the conversation the screen and keeps the box clear`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height })
        await fixtures(page, layout)
        await page.goto('/music-bot')
        await expect(page.getByText('Playing Song').first()).toBeVisible()

        // One header row: Settings and Clear chat beside the name, not on a row of their own.
        const title = await rect(page.locator('[data-bot="title"]'))
        for (const name of ['Chat settings', 'Clear chat']) {
          const tool = await rect(page.getByRole('button', { name, exact: true }))
          expect(Math.abs(tool.y + tool.height / 2 - (title.y + title.height / 2))).toBeLessThan(14)
        }
        // The model is picked in Chat settings, so it takes no row here.
        await expect(page.getByRole('button', { name: /^Model/ })).toHaveCount(0)
        // The three places to look fit the width and are 44px tall.
        for (const scope of await page.getByRole('radio').all()) {
          const r = await rect(scope)
          expect(r.height).toBeGreaterThanOrEqual(44)
          expect(r.x + r.width).toBeLessThanOrEqual(width)
        }
        // No second pet perched on the player, standing on the box.
        await expect(page.locator('[data-pet="perch"]')).toHaveCount(0)

        await ask(page)
        // No starter chips or footnote under a conversation on a phone.
        await expect(page.getByRole('group', { name: 'Prompts' })).toHaveCount(0)
        await expect(page.getByText('Enter to send')).toHaveCount(0)
        // The result is a message in the conversation, not a Draft under it.
        await expect(page.locator('[data-bot="draft"]')).toHaveCount(0)
        await expect(card(page)).toHaveAttribute('data-variant', 'inline')

        const field = await rect(page.locator('[data-bot="composer"]'))
        expect(field.y + field.height).toBeLessThanOrEqual((await barsTop(page)) + 1)
        // Send is the thing under a finger on it, not the player or the tab bar.
        const send = await rect(page.getByRole('button', { name: 'Send', exact: true }))
        expect(
          await page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
            { x: send.x + send.width / 2, y: send.y + send.height / 2 },
          ),
        ).toBe('Send')
        // The conversation has most of what is left: at least a third of a 568px screen.
        const room = await rect(log(page))
        expect(room.height).toBeGreaterThanOrEqual(height * (height < 600 ? 0.3 : 0.5))

        // A song title gets the row (it had about 100px at 390 and 25px at 320, the length and the
        // reply's indent beside it), and the card's actions are reached without going sideways.
        const song = card(page)
          .getByRole('list', { name: 'Proposed songs' })
          .getByRole('listitem')
          .first()
          .locator('strong')
        expect((await rect(song)).width).toBeGreaterThanOrEqual(width < 360 ? 90 : 160)
        const play = card(page).getByRole('button', { name: /^Play( now)?$/ })
        await play.scrollIntoViewIfNeeded()
        const action = await rect(play)
        expect(action.x).toBeGreaterThanOrEqual(0)
        expect(action.x + action.width).toBeLessThanOrEqual(width)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      })

    test('the on-screen keyboard lifts the box, takes the bars away and keeps the newest message in view', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await fixtures(page, layout)
      await page.goto('/music-bot')
      await ask(page)
      await expect.poll(() => atEnd(log(page))).toBe(true)

      await box(page).tap()
      await keyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', '')
      await expect(bars(page)).toHaveCount(0)
      const field = await rect(page.locator('[data-bot="composer"]'))
      expect(field.y + field.height).toBeLessThanOrEqual(844 - 336 + 1)
      expect(field.y).toBeGreaterThan(844 - 336 - 120)
      await expect.poll(() => atEnd(log(page))).toBe(true)
      expect((await rect(log(page))).height).toBeGreaterThan(200)

      await keyboard(page, 0)
      await expect(page.locator('html')).not.toHaveAttribute('data-keyboard', '')
      await expect(page.getByText('Playing Song').first()).toBeVisible()
      // The player measures itself again once it is back, so the page settles a frame later.
      await expect
        .poll(async () => {
          const after = await rect(page.locator('[data-bot="composer"]'))
          return after.y + after.height - (await barsTop(page))
        })
        .toBeLessThanOrEqual(1)
    })

    test('the pet’s sheet keeps its box above the keyboard and its songs readable', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await fixtures(page, layout)
      await page.goto('/library')
      await expect(page.getByText('Playing Song').first()).toBeVisible()
      await page
        .getByRole('button', { name: /music bot\. .*Open chat/ })
        .first()
        .tap()
      const sheet = page.locator('[data-bot="sheet"]')
      await expect(sheet).toBeVisible()
      await ask(page)
      const song = card(page)
        .getByRole('list', { name: 'Proposed songs' })
        .getByRole('listitem')
        .first()
        .locator('strong')
      expect((await rect(song)).width).toBeGreaterThanOrEqual(160)
      await expect(sheet.getByText('Enter to send')).toHaveCount(0)

      await box(page).tap()
      await keyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-keyboard', '')
      const frame = await rect(sheet)
      expect(frame.y + frame.height).toBeLessThanOrEqual(844 - 336 + 1)
      const field = await rect(sheet.locator('[data-bot="composer"]'))
      expect(field.y + field.height).toBeLessThanOrEqual(844 - 336 + 1)
      await expect.poll(() => atEnd(sheet.getByRole('log', { name: 'Conversation' }))).toBe(true)

      // Putting the sheet away lets the bars back.
      await keyboard(page, 0)
      await sheet.getByRole('button', { name: 'Close chat' }).last().tap()
      await expect(page.locator('html')).not.toHaveAttribute('data-keyboard', '')
      await expect(page.getByText('Playing Song').first()).toBeVisible()
    })
  })
