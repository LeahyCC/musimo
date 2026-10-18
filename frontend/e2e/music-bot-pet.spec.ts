import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import { BUILT_IN_THEMES } from '../src/theme/themes'
import type { Theme } from '../src/theme/themes'
import { generatedPlayerAudio, librarySong, playerFixtures, requestBody } from './library-fixtures'
import { proposalFixtures } from './proposal-fixtures'
import type { ProposalMock } from './proposal-fixtures'

/* The music bot's pet: where it perches, opening and closing its chat, every action on a result
   from the popover, its quick menu and settings, the phone sheet, the Windows 95 skin and reduced
   motion. The chat's own rules (scope, cancel, errors, undo edge cases) are in music-bot.spec.ts.
   Screenshots for review land in runtime/pet. */

const first = librarySong('tr-0000000000000001', { title: 'First Light', year: 1992 })
const second = librarySong('tr-0000000000000002', { title: 'Orchard Song', artist: 'Orchard' })
const playing = librarySong('tr-0000000000000003', {
  title: 'Teardrop',
  artist: 'Massive Attack',
  album: 'Mezzanine',
  track: 3,
})
const plan = {
  change_filters: [],
  allow_artists: [],
  add_count: 0,
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: [],
  genres: [],
  year_from: 1980,
  year_to: 1989,
  favourites: true,
  history: 'any',
  exclude_played_days: 1,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 3600,
  limit: 100,
  similar_to_current: false,
  explanation: 'Rewound a decade. Same rules, 80s this time.',
  suggestions: [],
}
const answer = {
  plan,
  tracks: [first, second],
  total_seconds: 428,
  shortfall_seconds: 3172,
  summary:
    '2 songs, 7.1 minutes. Based on saved library tags. Favourites are songs in your Liked playlist.',
  elapsed_ms: 123,
}

/** The proposal routes' stand-in for the test in progress. Set by fixtures(); one worker runs a file. */
let proposals: ProposalMock

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

type Options = { restore?: boolean; theme?: string; pet?: Record<string, unknown> }

async function fixtures(page: Page, { restore = true, theme, pet }: Options = {}) {
  await playerFixtures(page)
  await generatedPlayerAudio(page)
  const withModel = async (data: unknown) => ({
    ...(data && typeof data === 'object' ? data : {}),
    ollama_model: { value: 'fixture', origin: 'database', locked: false },
    music_timezone: { value: 'Pacific/Honolulu', origin: 'database', locked: false },
  })
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    await route.fulfill({ json: await withModel(await response.json()) })
  })

  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch()
    const data = (await response.json()) as Record<string, unknown>
    await route.fulfill({ json: { ...data, settings: await withModel(data.settings) } })
  })

  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: ['fixture', 'llama3.2:3b'], elapsed_ms: 2 } }),
  )
  await page.route('**/api/music-bot/chat', (route) => route.fulfill({ json: answer }))
  proposals = await proposalFixtures(page, [first, second])
  await page.route('**/api/music-bot/validate', (route) => {
    const ids = requestBody(route).ids
    const wanted = Array.isArray(ids) ? ids : []
    return route.fulfill({ json: { tracks: [first, second].filter((s) => wanted.includes(s.id)) } })
  })
  const saves: Record<string, unknown>[] = []
  await page.route('**/api/player/queue', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: { current: restore ? playing.id : '', position: 0, entry: restore ? [playing] : [] },
      })
    saves.push(requestBody(route))
    return route.fulfill({ status: 204 })
  })
  if (pet)
    await page.addInitScript(
      (settings) => localStorage.setItem('musimo.pet', settings),
      JSON.stringify({ version: 1, ...pet }),
    )
  // Picked the way a person picks it, so the theme store paints everything it paints for real.
  const found: Theme | undefined = BUILT_IN_THEMES.find((entry) => entry.id === theme)
  if (found) {
    await page.goto('/settings/user')
    await page.getByRole('radio', { name: found.name }).check()
    await expect(page.locator('html')).toHaveCSS('color-scheme', found.scheme)
  }
  return saves
}

const pet = (page: Page) => page.locator('[data-pet="perch"] [data-pet="button"]')
const chat = (page: Page) => page.getByRole('dialog', { name: /^Chat with / })
const box = (page: Page) => page.getByRole('textbox', { name: /^Ask .+ for music$/ })
const card = (page: Page) => page.locator('[data-bot="card"]').last()

/** Sends a request and waits for its answer: one more reply from the bot than before. */
async function ask(page: Page, text = 'make it 80s instead') {
  const replies = chat(page).locator('[data-bot="bot"]')
  const before = await replies.count()
  await box(page).fill(text)
  await box(page).press('Enter')
  await expect(replies).toHaveCount(before + 1)
  await expect(card(page)).toBeVisible()
}

/** Nothing of the pet's box may cover the bar it stands on. */
async function clearOf(button: Locator, bar: Locator, gap = 0) {
  const pet = await button.boundingBox()
  const footer = await bar.boundingBox()
  expect(pet && footer).toBeTruthy()
  if (pet && footer) expect(pet.y + pet.height).toBeLessThanOrEqual(footer.y + 1 - gap)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `../runtime/pet/${name}.png` })
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop layout.')

  test('perches clear of the controls, opens a labelled chat and gives focus back', async ({
    page,
  }) => {
    await fixtures(page)
    await page.goto('/search')
    const button = pet(page)
    await expect(button).toHaveAccessibleName('Octive, music bot. Open chat')
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    await clearOf(button, page.locator('footer.live-player'))

    await button.click()
    await expect(chat(page)).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(box(page)).toBeFocused()
    await expect(chat(page).getByRole('heading', { name: /^Hi, I.m Octive\.$/ })).toBeVisible()
    await expect(chat(page).getByRole('log')).toHaveAttribute('aria-live', 'polite')
    expect(
      (await new AxeBuilder({ page }).include('[data-bot="popover"]').analyze()).violations,
    ).toEqual([])
    await shot(page, 'desktop-dark-first')

    await page.keyboard.press('Escape')
    await expect(chat(page)).toHaveCount(0)
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(chat(page)).toBeVisible()
    await chat(page).getByRole('button', { name: 'Close chat' }).click()
    await expect(chat(page)).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('every action on a result, Undo and its refusal, from the popover', async ({ page }) => {
    const saves = await fixtures(page)
    await page.goto('/search')
    await pet(page).click()
    await ask(page)
    await expect(card(page)).toContainText('PREVIEW, NOT APPLIED')
    await expect(card(page).getByRole('list', { name: 'Active filters' })).toContainText(
      '1980–1989',
    )
    await shot(page, 'desktop-dark-result')

    await card(page).getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => saves.at(-1)?.ids).toEqual([first.id, second.id])
    await expect(card(page)).toContainText('IN YOUR QUEUE')
    await shot(page, 'desktop-dark-played')
    await card(page).getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id])

    await ask(page, 'again')
    await card(page).getByRole('button', { name: 'Play next', exact: true }).click()
    await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
    await card(page).getByRole('button', { name: 'Undo', exact: true }).click()

    await ask(page, 'again')
    await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
    await card(page).getByRole('button', { name: 'Undo', exact: true }).click()

    await ask(page, 'again')
    await card(page).getByRole('button', { name: 'Replace upcoming' }).click()
    await expect.poll(() => saves.at(-1)?.current).toBe(playing.id)
    // The next song is a different load, so Undo refuses. Pause would not.
    await page
      .locator('footer.live-player')
      .getByRole('button', { name: 'Next track', exact: true })
      .click()
    await expect(card(page).getByRole('alert')).toContainText('Can’t undo.')
    await expect(card(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
    await shot(page, 'desktop-dark-refused')

    await ask(page, 'save these')
    await card(page).getByRole('button', { name: 'Save as playlist' }).click()
    await card(page).getByLabel('Playlist name').fill('80s favourites')
    await card(page).getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(() => proposals.saved)
      .toEqual([{ name: '80s favourites', ids: [first.id, second.id] }])
  })

  test('a reply that lands with the chat closed wakes the pet, with a dot and a bubble', async ({
    page,
  }) => {
    await fixtures(page)
    let release: (() => void) | undefined
    await page.route('**/api/music-bot/chat', async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.fulfill({ json: answer }).catch(() => undefined)
    })
    await page.goto('/search')
    await pet(page).click()
    await box(page).fill('an hour of my favourite 80s music')
    await box(page).press('Enter')
    await expect(pet(page).locator('[data-pet-state]')).toHaveAttribute(
      'data-pet-state',
      'thinking',
    )
    await page.keyboard.press('Escape')
    await expect.poll(() => Boolean(release)).toBe(true)
    release?.()
    await expect(pet(page)).toHaveAccessibleName('Octive, music bot. New reply. Open chat')
    await expect(pet(page).locator('[data-pet="dot"]')).toBeVisible()
    await expect(page.locator('[data-pet="bubble"]')).toHaveText('2 songs ready when you are.')
    await shot(page, 'desktop-dark-reply-waiting')
    await pet(page).click()
    await expect(pet(page).locator('[data-pet="dot"]')).toHaveCount(0)
  })

  test('a reply read on the full page is not left waiting on the pet', async ({ page }) => {
    await fixtures(page)
    await page.goto('/music-bot')
    await box(page).fill('make it 80s instead')
    await box(page).press('Enter')
    await expect(card(page).getByRole('list', { name: 'Proposed songs' })).toBeVisible()
    await page.waitForTimeout(300)
    await expect(pet(page).locator('[data-pet="dot"]')).toHaveCount(0)
    await expect(pet(page)).toHaveAccessibleName('Octive, music bot. Open chat')
    await expect(page.locator('[data-pet="bubble"]')).toHaveCount(0)
  })

  test('removing a song keeps the summary true to the list', async ({ page }) => {
    await fixtures(page)
    await page.goto('/search')
    await pet(page).click()
    await ask(page)
    await card(page).getByRole('button', { name: 'More actions for Orchard Song' }).click()
    await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
    await expect(
      card(page).getByRole('list', { name: 'Proposed songs' }).getByRole('listitem'),
    ).toHaveCount(1)
    await expect(card(page)).toContainText('1 song, 3.6 minutes.')
    await expect(card(page).getByRole('note')).toContainText('56 min short.')
  })

  test('Back on a freshly opened chat page stays in Musimo', async ({ page }) => {
    await fixtures(page)
    await page.goto('/music-bot')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(/\/search$/)
  })

  test('questions get quick replies, and a picked scope goes with the request', async ({
    page,
  }) => {
    await fixtures(page)
    const bodies: Record<string, unknown>[] = []
    await page.route('**/api/music-bot/chat', async (route) => {
      bodies.push(requestBody(route))
      await route.fulfill({
        json:
          bodies.length === 1
            ? {
                ...answer,
                tracks: [],
                total_seconds: 0,
                plan: {
                  ...plan,
                  action: 'clarify',
                  suggestions: ['Just my favourites', 'Ones I haven’t played'],
                },
                summary: 'The whole decade? Or shall I narrow it down?',
              }
            : answer,
      })
    })
    await page.goto('/search')
    await pet(page).click()
    await box(page).fill('Play something from the 90s')
    await box(page).press('Enter')
    const replies = chat(page).getByRole('group', { name: 'Quick replies' })
    await expect(replies.getByRole('button')).toHaveCount(2)
    await expect(pet(page).locator('[data-pet-state]')).toHaveAttribute(
      'data-pet-state',
      'confused',
    )
    await shot(page, 'desktop-dark-clarify')
    await replies.getByRole('button', { name: 'Just my favourites' }).click()
    await expect(card(page)).toBeVisible()
    expect(bodies[1]?.prompt).toBe('Just my favourites')
    expect(bodies[1]?.scope).toBeUndefined()

    await chat(page).getByRole('radio', { name: 'This selection' }).click()
    await ask(page, 'only the ones by Orchard')
    expect(bodies[2]?.scope).toBe('proposal')
    // A pick is for one request; the radio then shows what the answer used.
    await expect(chat(page).getByRole('radio', { name: 'Whole library' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  test('the quick menu changes the pet, and settings survive a reload', async ({ page }) => {
    await fixtures(page)
    await page.goto('/search')
    await pet(page).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Octive' })
    await expect(menu).toBeVisible()
    await shot(page, 'desktop-dark-menu')
    await menu
      .getByRole('group', { name: 'Size' })
      .getByRole('menuitemradio', { name: 'Large' })
      .click()

    await menu
      .getByRole('group', { name: 'Sit on' })
      .getByRole('menuitemradio', { name: 'Right' })
      .click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(pet(page)).toBeFocused()

    // With the chat open behind it, one Escape closes the menu and leaves the chat.
    await pet(page).click()
    await expect(chat(page)).toBeVisible()
    await pet(page).click({ button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(chat(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(chat(page)).toHaveCount(0)
    const size = await pet(page).locator('[data-pet-state]').boundingBox()
    expect(size?.width).toBe(56)
    // Right means the right of the footer, clear of the volume, not over the sidebar.
    const spot = await pet(page).boundingBox()
    const bar = await page.locator('footer.live-player').boundingBox()
    expect(spot && bar && spot.x + spot.width).toBeGreaterThan(
      (bar?.x ?? 0) + (bar?.width ?? 0) - 120,
    )
    expect(spot?.x ?? 0).toBeGreaterThan(bar?.x ?? 0)

    await page.goto('/settings/user#music-bot-pet')
    const section = page.locator('#music-bot-pet')
    await section.getByRole('radio', { name: 'Robot' }).click()
    await section.getByLabel('Name').fill('Pip')
    await section.getByRole('radio', { name: 'Violet' }).click()
    await section.getByRole('radio', { name: 'Chatty' }).click()
    await section.getByLabel('Animation').selectOption('off')
    await shot(page, 'desktop-dark-settings')
    await page.reload()
    await expect(pet(page)).toHaveAccessibleName('Pip, music bot. Open chat')
    await expect(page.locator('#music-bot-pet').getByRole('radio', { name: 'Robot' })).toBeChecked()
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('musimo.pet') ?? '{}') as unknown),
    ).toMatchObject({
      version: 1,
      kind: 'robot',
      name: 'Pip',
      colour: 'violet',
      size: 'large',
      position: 'right',
      chattiness: 'chatty',
      motion: 'off',
    })
    // Off holds every pose still.
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('[data-pet="perch"] *')].some(
        (element) => getComputedStyle(element).animationName !== 'none',
      ),
    )
    expect(moving).toBe(false)
  })

  test('a hidden pet hands its face and reply dot to the sidebar', async ({ page }) => {
    await fixtures(page, { pet: { hidden: true } })
    await page.goto('/search')
    await expect(page.locator('[data-pet="perch"]')).toHaveCount(0)
    const row = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /Music bot/ })
    await expect(row.locator('[data-pet="face"]')).toBeVisible()
    await shot(page, 'desktop-dark-hidden')
    await row.click()
    await expect(page.getByRole('heading', { name: 'Music bot', level: 1 })).toBeVisible()
    await expect(box(page)).toBeVisible()
  })

  test('Now Playing seats the pet beside the title, outlined over the cover wash', async ({
    page,
  }) => {
    await fixtures(page)
    for (const [name, colour] of [
      ['bright', '#f2d36b'],
      ['dark', '#141a33'],
    ] as const) {
      await page.route('**/api/player/art/**', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${colour}"/></svg>`,
        }),
      )
      await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
      await page.goto('/now-playing')
      const spot = page.getByRole('main').locator('[data-pet="button"]')
      await expect(spot).toBeVisible()
      await expect(page.locator('[data-pet="perch"]')).toHaveCount(0)
      await page.waitForTimeout(600)
      await shot(page, `now-playing-${name}-cover`)
      await spot.click()
      await expect(chat(page)).toBeVisible()
      await page.keyboard.press('Escape')
    }
  })

  for (const theme of ['musimo-light', 'win95-light', 'win95-dark', 'slate-dark']) {
    test(`${theme}: pet and chat take the theme`, async ({ page }) => {
      await fixtures(page, { theme })
      await page.goto('/search')
      const win95 = theme.startsWith('win95')
      if (win95) await expect(page.locator('html')).toHaveAttribute('data-skin', 'win95')
      else await expect(page.locator('html')).not.toHaveAttribute('data-skin', /.+/)
      await pet(page).click()
      await ask(page)
      if (win95) {
        // Pixel art: one layer of box-shadow pixels, sized on the 16 by 16 grid.
        const drawn = await pet(page).locator('[data-pet-state]').boundingBox()
        expect((drawn?.width ?? 0) % 16).toBe(0)
        await expect(chat(page).getByRole('table', { name: 'Proposed songs' })).toBeVisible()
        const bar = await chat(page)
          .locator('[data-bot="title-bar"]')
          .evaluate((element) => getComputedStyle(element).backgroundColor)
        const highlight = await page.evaluate(() => {
          const probe = document.createElement('i')
          probe.style.background = 'var(--highlight)'
          document.body.append(probe)
          const colour = getComputedStyle(probe).backgroundColor
          probe.remove()
          return colour
        })
        expect(bar).toBe(highlight)
      } else {
        await expect(card(page).getByRole('list', { name: 'Proposed songs' })).toBeVisible()
      }
      expect(
        (await new AxeBuilder({ page }).include('[data-bot="popover"]').analyze()).violations,
      ).toEqual([])
      await shot(page, `desktop-${theme}-result`)
    })
  }

  test('reduced motion holds the pet still', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await fixtures(page)
    await page.goto('/search')
    await expect(pet(page)).toBeVisible()
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('[data-pet="perch"] *')].some(
        (element) => getComputedStyle(element).animationName !== 'none',
      ),
    )
    expect(moving).toBe(false)
    await page.goto('/settings/user#music-bot-pet')
    await expect(page.getByLabel('Animation')).toContainText('Follow this device (reduced)')
  })
})

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone layout.')

  test('perches off the seek strip, opens a sheet, and waits in the top bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await fixtures(page)
    await page.goto('/search')
    const button = pet(page)
    await expect(button).toBeVisible()
    const size = await button.boundingBox()
    expect(size?.width).toBeGreaterThanOrEqual(44)
    expect(size?.height).toBeGreaterThanOrEqual(44)
    // The mini player's seek strip reaches 6px above its top edge, so the pet stops above that.
    await clearOf(button, page.locator('footer.live-player'), 6)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot(page, 'phone-dark-mini')

    await button.click()
    const sheet = page.locator('dialog[data-bot="sheet"]')
    await expect(sheet).toBeVisible()
    await expect(box(page)).toBeFocused()
    await ask(page)
    const action = await card(page).getByRole('button', { name: 'Play', exact: true }).boundingBox()
    expect(action?.height).toBeGreaterThanOrEqual(44)
    await shot(page, 'phone-dark-sheet')
    await sheet.getByRole('button', { name: 'Close chat' }).first().click()
    await expect(sheet).toBeHidden()
    await expect(button).toBeFocused()
  })

  test('with nothing playing the pet tucks into the top bar link', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await fixtures(page, { restore: false })
    await page.goto('/search')
    await expect(page.locator('[data-pet="perch"]')).toHaveCount(0)
    const link = page.getByRole('banner').getByRole('link', { name: /Music bot/ })
    await expect(link.locator('[data-pet="face"]')).toBeVisible()
    await shot(page, 'phone-dark-idle')
    await link.click()
    await expect(box(page)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot(page, 'phone-dark-page')
  })

  for (const theme of ['musimo-light', 'win95-light']) {
    test(`${theme}: phone sheet takes the theme`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await fixtures(page, { theme })
      await page.goto('/search')
      await pet(page).click()
      await ask(page)
      await shot(page, `phone-${theme}-sheet`)
    })
  }
})
