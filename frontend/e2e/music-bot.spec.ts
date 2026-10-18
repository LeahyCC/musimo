import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { settingsSchema } from '../src/api'
import { generatedPlayerAudio, librarySong, playerFixtures, requestBody } from './library-fixtures'
import { mainNav } from './nav'
import { proposalFixtures } from './proposal-fixtures'
import type { ProposalMock } from './proposal-fixtures'

const first = librarySong('tr-0000000000000001', { title: 'First Light', year: 1992 })
const second = librarySong('tr-0000000000000002', {
  title: 'Orchard Song',
  artist: 'Orchard',
  year: 1996,
})
const playing = librarySong('tr-0000000000000003', { title: 'Playing Song' })
const plan = {
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
  favourites: true,
  history: 'any',
  exclude_played_days: 1,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 3600,
  limit: 100,
  similar_to_current: false,
  explanation: '',
}
const answer = {
  plan,
  tracks: [first, second],
  total_seconds: 428,
  shortfall_seconds: 3172,
  summary: '2 songs, 7.1 minutes. 52.9 minutes short; no exclusions were relaxed.',
  elapsed_ms: 123,
}

/** The proposal routes' stand-in for the test in progress. Set by fixtures(); one worker runs a file. */
let proposals: ProposalMock

test.afterEach(async ({ page }) => {
  // Reloads can leave snapshot handlers reading responses when the context closes.
  // Finish those handlers before teardown disposes their API responses.
  await page.unrouteAll({ behavior: 'wait' })
})

async function fixtures(page: Page, restore = true) {
  await playerFixtures(page)
  await generatedPlayerAudio(page)

  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch()
    const data = (await response.json()) as Record<string, unknown>
    const settings = typeof data.settings === 'object' && data.settings ? { ...data.settings } : {}
    await route.fulfill({
      json: {
        ...data,
        settings: {
          ...settings,
          ollama_model: { value: 'fixture', origin: 'database', locked: false },
          music_timezone: { value: 'Pacific/Honolulu', origin: 'database', locked: false },
        },
      },
    })
  })

  await page.route('**/api/settings', async (route) => {
    const response = await route.fetch()
    const data: unknown = await response.json()
    const settings = data && typeof data === 'object' ? { ...data } : {}
    await route.fulfill({
      json: {
        ...settings,
        ollama_model: { value: 'fixture', origin: 'database', locked: false },
        music_timezone: { value: 'Pacific/Honolulu', origin: 'database', locked: false },
      },
    })
  })

  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: ['fixture'], elapsed_ms: 2 } }),
  )
  await page.route('**/api/music-bot/chat', (route) => route.fulfill({ json: answer }))
  proposals = await proposalFixtures(page, [first, second])
  // Only the one-song Play from a song's menu still goes through this check.
  await page.route('**/api/music-bot/validate', (route) => {
    const body = requestBody(route)
    // The songs the plan was measured against travel with every selection check.
    expect(body).toHaveProperty('reference_id')
    expect(body).toHaveProperty('current_id')
    const ids = Array.isArray(body.ids) ? body.ids : []
    return route.fulfill({
      json: { tracks: [first, second].filter((song) => ids.includes(song.id)) },
    })
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

  return saves
}

/** The chat's text box, whatever the pet is called. */
const box = (page: Page) => page.getByRole('textbox', { name: /^Ask .+ for music$/ })

async function say(page: Page, text: string) {
  await box(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

async function ask(
  page: Page,
  text = 'Queue an hour of my favourite 90s music, excluding songs played today.',
) {
  await say(page, text)
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toBeVisible()
}

/** The live result card: the newest one, which has the actions. */
const card = (page: Page) => page.locator('[data-bot="card"]').last()
const undo = (page: Page) => card(page).getByRole('button', { name: 'Undo', exact: true })

test('Undo restores a 701-song shuffle and playback continues beyond its 500-song window', async ({
  page,
}) => {
  const saves = await fixtures(page)
  const songs = Array.from({ length: 701 }, (_, i) =>
    librarySong(`tr-${(i + 100).toString(16).padStart(16, '0')}`, { title: `Deck ${i}` }),
  )
  const window = songs.slice(0, 500)
  await page.addInitScript(
    (ids) =>
      localStorage.setItem(
        'musimo.shuffle-deck',
        JSON.stringify({
          seed: 'fixture-seed',
          cursor: 500,
          total: 701,
          queue: ids,
        }),
      ),
    window.map((song) => song.id),
  )

  await page.route('**/api/player/queue', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { current: songs[450]?.id, position: 0, entry: window } })
    saves.push(requestBody(route))
    return route.fulfill({ status: 204 })
  })
  const cursors: unknown[] = []
  await page.route('**/api/library/tracks/shuffle', (route) => {
    const body = requestBody(route)
    cursors.push(body.cursor)
    expect(body.seed).toBe('fixture-seed')
    return route.fulfill({
      json: {
        seed: 'fixture-seed',
        cursor: 700,
        total: 701,
        items: songs.slice(500, 700),
        missing: [],
      },
    })
  })
  await page.goto('/music-bot')
  await expect(page.getByRole('contentinfo')).toContainText(/Deck \d+/)
  await ask(page)
  await page.getByRole('button', { name: 'Replace upcoming' }).click()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('musimo.shuffle-deck')))
    .toBeNull()
  await undo(page).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('musimo.shuffle-deck') ?? '{}') as unknown,
      ),
    )
    .toEqual({
      seed: 'fixture-seed',
      cursor: 500,
      total: 701,
      queue: window.map((song) => song.id),
    })
  for (let i = 0; i < 51; i++)
    await page
      .locator('footer.live-player')
      .getByRole('button', { name: 'Next track', exact: true })
      .click()
  await expect(page.locator('footer.live-player')).toContainText('Deck 501')
  expect(cursors).toEqual([500])
  await expect.poll(() => saves.at(-1)?.current).toBe(songs[501]?.id)
  // Undone once, so nothing is left to undo.
  await expect(undo(page)).toHaveCount(0)
})

test('a hung queue save times out, coalesces later edits and persists Undo before the late save', async ({
  page,
}) => {
  await fixtures(page)
  const saves: Record<string, unknown>[] = []
  let committed: unknown = []
  let high = 0
  let lateFinished = false
  let release: (() => void) | undefined
  const commit = (body: Record<string, unknown>) => {
    const sequence = Number(body.sequence)
    if (sequence > high) {
      committed = body.ids
      high = sequence
    }
  }
  await page.route('**/api/player/queue', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { current: playing.id, position: 0, entry: [playing] } })
    const body = requestBody(route)
    saves.push(body)
    if (saves.length === 1) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      commit(body)
      lateFinished = true
      await route.fulfill({ status: 204 }).catch(() => undefined)
      return
    }
    commit(body)
    await route.fulfill({ status: 204 })
  })
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  await undo(page).click()
  await page.getByRole('button', { name: 'Replace upcoming' }).click()
  await undo(page).click()
  await expect(
    page.getByText('The queue changed here but could not be saved.').first(),
  ).toBeVisible({ timeout: 12000 })
  await expect.poll(() => committed).toEqual([playing.id])
  expect(saves).toHaveLength(2)
  release?.()
  await expect.poll(() => lateFinished).toBe(true)
  await expect.poll(() => high).toBe(Number(saves[1]?.sequence))
  expect(committed).toEqual([playing.id])
})

test('preview, follow-up, queue, Undo, playlist and desktop/phone layout', async ({
  page,
  isMobile,
}, info) => {
  const saves = await fixtures(page)
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/music-bot')
  await expect(page.getByRole('contentinfo')).toContainText('Playing Song')
  await ask(page)
  await expect(
    page.getByRole('list', { name: 'Proposed songs' }).getByRole('listitem'),
  ).toHaveCount(2)
  await expect(page.getByText(/52.9 minutes short/).first()).toBeVisible()
  await expect(card(page).getByRole('note')).toContainText('53 min short.')
  await expect(card(page)).toContainText('PREVIEW, NOT APPLIED')
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
  await expect(card(page)).toContainText('IN YOUR QUEUE')
  await undo(page).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id])
  await expect(card(page)).toContainText('PREVIEW, NOT APPLIED')
  await card(page).getByRole('button', { name: 'More actions for First Light' }).click()
  await page.getByRole('menuitem', { name: 'Use as reference' }).click()
  await expect(page.getByText('First Light \u00b7 Harbor Static')).toBeVisible()
  await page.route('**/api/music-bot/chat', async (route) => {
    expect(requestBody(route).reference_id).toBe(first.id)
    // What was shown is the server's memory, so the browser sends neither the songs nor a
    // generation seed, and every request draws a fresh one.
    expect(requestBody(route)).not.toHaveProperty('shown_ids')
    expect(requestBody(route)).not.toHaveProperty('generation_seed')
    // The plan goes back as the server sent it, with its (empty) suggestions and the song
    // characteristic fields the browser fills in when an older build's reply leaves them out.
    expect(requestBody(route).previous).toEqual({
      ...plan,
      suggestions: [],
      tempo: '',
      tempo_min: null,
      tempo_max: null,
      energy: '',
      energy_compared: '',
      tempo_compared: '',
      sound: '',
    })

    await route.fulfill({
      json: {
        ...answer,
        tracks: [second],
        plan: { ...plan, exclude_artists: ['Harbor Static'], scope: 'proposal' },
      },
    })
  })
  await ask(page, 'remove that artist')
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toHaveCount(1)
  await expect(
    page.getByRole('list', { name: 'Proposed songs' }).getByRole('listitem'),
  ).toHaveCount(1)
  await expect(page.getByText('Replaced')).toBeVisible()

  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Music bot selection')
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText('Saved as the playlist \u201cMusic bot selection\u201d.'),
  ).toBeVisible()
  await expect(card(page).getByRole('status')).toContainText('Music bot selection')
  // The playlist holds the revision the card showed: the refined list, saved once.
  expect(proposals.saved).toEqual([{ name: 'Music bot selection', ids: [second.id] }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: `../runtime/milestone1/music-bot-${info.project.name}.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Clear chat' }).click()
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toHaveCount(0)
  // Clear chat empties the conversation only. The shown songs are the server's, and the tab no
  // longer keeps a copy that could disagree.
  expect(proposals.memory().songs).toEqual([first.id, second.id])
  expect(proposals.forgets).toBe(0)
  expect(await page.evaluate(() => sessionStorage.getItem('musimo.music-bot.shown'))).toBeNull()
  await page.reload()
  // A cleared chat stays cleared, and opens on the greeting.
  await expect(page.getByRole('heading', { name: /^Hi, I.m Octive\.$/ })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toHaveCount(0)
})

test('shown songs are remembered across a reload, Clear chat keeps them, and Forget clears them', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await page.evaluate(() => sessionStorage.setItem('musimo.music-bot.shown', '[["stale"]]'))
  await ask(page)
  // The browser says a stored revision was shown. It sends no song ids and keeps no copy.
  await expect.poll(() => proposals.presented).toHaveLength(1)
  expect(proposals.presented[0]).toMatch(/^pr-[0-9a-f]{16}:1$/)
  expect(proposals.memory().songs).toEqual([first.id, second.id])
  expect(await page.evaluate(() => sessionStorage.getItem('musimo.music-bot.shown'))).toBeNull()

  await page.reload()
  await page.getByRole('button', { name: 'Chat settings' }).click()
  const status = page.locator('[data-bot="memory-status"]')
  await expect(status).toHaveText('I am remembering 2 songs from 1 answer.')
  const forget = page.getByRole('button', { name: 'Forget shown songs' })
  await expect(forget).toBeEnabled()
  await expect(page.getByText(/This applies to every device\./)).toBeVisible()
  await expect(page.getByText(/play history, likes and playlists stay/i)).toBeVisible()

  // Clear chat leaves the memory alone.
  await page.getByRole('button', { name: 'Clear chat' }).click()
  await expect(status).toHaveText('I am remembering 2 songs from 1 answer.')
  expect(proposals.forgets).toBe(0)

  await forget.click()
  await expect(status).toHaveText('I am not remembering any songs.')
  await expect(forget).toBeDisabled()
  expect(proposals.forgets).toBe(1)
  expect(proposals.memory().songs).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: 'Chat settings' }).click()
  await expect(page.locator('[data-bot="memory-status"]')).toHaveText(
    'I am not remembering any songs.',
  )
})

test('a result still on its way when another device forgets is not remembered', async ({
  page,
}) => {
  await fixtures(page)
  let release: (() => void) | undefined
  proposals.holdPresent = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.goto('/music-bot')
  await ask(page)
  // The card is up and its report is in flight. Another device presses Forget now.
  await expect.poll(() => proposals.presented).toHaveLength(1)
  proposals.forgetElsewhere()
  const answered = page.waitForResponse((response) => response.url().endsWith('/memory/shown'))
  release?.()
  // Not an error: the report is answered, and the result simply is not recorded.
  expect(await (await answered).json()).toMatchObject({ recorded: false, reason: 'forgotten' })
  expect(proposals.memory().songs).toEqual([])
  expect(proposals.memory().results).toBe(0)

  // An answer made after the forget is remembered as usual.
  proposals.holdPresent = undefined
  await ask(page)
  await expect.poll(() => proposals.presented).toHaveLength(2)
  await expect.poll(() => proposals.memory().songs).toEqual([first.id, second.id])
})

test('a refinement and a cancelled answer are not reported as shown', async ({ page }) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await expect.poll(() => proposals.presented).toHaveLength(1)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: { ...answer, tracks: [second], plan: { ...plan, scope: 'proposal' } },
    }),
  )
  await ask(page, 'remove that artist')
  // A refinement narrows what was shown, so the browser does not send it as a new result.
  expect(proposals.presented).toHaveLength(1)
  expect(proposals.memory().results).toBe(1)

  let release: (() => void) | undefined
  await page.route('**/api/music-bot/chat', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ json: answer }).catch(() => undefined)
  })
  await say(page, 'something else')
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  release?.()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  expect(proposals.presented).toHaveLength(1)
  expect(proposals.memory().results).toBe(1)
})

test('cancellation and navigation suppress late playback commands', async ({ page }) => {
  const saves = await fixtures(page)
  let release: (() => void) | undefined
  await page.route('**/api/music-bot/chat', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })

    await route
      .fulfill({ json: { ...answer, plan: { ...plan, action: 'skip' } } })
      .catch(() => undefined)
  })
  await page.goto('/music-bot')
  await say(page, 'skip')
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  release?.()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  expect(saves).toHaveLength(0)
  await say(page, 'skip')
  // Search is in the sidebar and in a phone's bar; Settings is not in the bar.
  await mainNav(page).getByRole('link', { name: 'Search', exact: true }).click()
  release?.()
  expect(saves).toHaveLength(0)
})

test('unavailable Ollama, invalid output and missing tracks leave queue alone', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ status: 503, json: { detail: 'Cannot reach Ollama.' } }),
  )
  await page.goto('/music-bot')
  await expect(page.getByRole('heading', { name: /reach the model server/ })).toBeVisible()
  await expect(box(page)).toBeDisabled()
  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: ['fixture'], elapsed_ms: 2 } }),
  )
  await page.getByRole('button', { name: 'Retry connection' }).click()
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      status: 502,
      json: { detail: 'The model returned an invalid plan. Nothing changed.' },
    }),
  )
  await say(page, 'rock')
  await expect(page.getByRole('alert')).toContainText('didn\u2019t make sense')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.route('**/api/music-bot/chat', (route) => route.fulfill({ json: answer }))
  await ask(page)
  proposals.fault = () => 'stale'
  await page.getByRole('button', { name: 'Play next', exact: true }).click()
  await expect(page.getByRole('alert').last()).toContainText('unavailable')
  expect(saves).toHaveLength(0)
})

test('autoplay refusal is honest and Undo restores an empty queue', async ({ page }) => {
  const saves = await fixtures(page, false)
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException('Blocked', 'NotAllowedError'))
  })
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('main').getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByText('Press play when you are ready.').first()).toBeVisible()
  // Loaded, not claimed as playing: the browser refused to start it.
  await expect(card(page).getByRole('status')).toContainText('These 2 songs replaced your queue.')
  await expect(card(page).getByRole('status')).toContainText('Loaded, not playing yet.')
  await expect(card(page).getByRole('status')).not.toContainText('Playing now')
  await undo(page).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([])
})

test('pause leaves a proposal and Undo alone', async ({ page }) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await page
    .locator('footer.live-player')
    .getByRole('button', { name: 'Play', exact: true })
    .click()
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect(undo(page)).toBeEnabled()
  await page
    .locator('footer.live-player')
    .getByRole('button', { name: 'Pause', exact: true })
    .click()
  await expect(undo(page)).toBeEnabled()
  await page
    .locator('footer.live-player')
    .getByRole('button', { name: 'Next track', exact: true })
    .click()
  await expect(undo(page)).toBeDisabled()
})

test('Play next and Replace upcoming preserve the playing song, and Undo respects manual edits', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Play next', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
  expect(saves.at(-1)?.current).toBe(playing.id)
  // An applied card offers Undo; asking again brings a fresh preview with its actions.
  await ask(page, 'the same again')
  await page.getByRole('button', { name: 'Replace upcoming' }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
  await page.getByRole('link', { name: 'Open Now Playing' }).first().click()
  await page.getByRole('button', { name: /Remove First Light/ }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, second.id])
  // The sidebar row on a desktop, the top bar link on a phone.
  await page.locator('a[href="/music-bot"]:visible').first().click()
  await expect(undo(page)).toBeDisabled()
  await expect(card(page).getByRole('alert')).toContainText('Can\u2019t undo.')
  await expect(card(page).getByRole('link', { name: 'View queue' })).toBeVisible()
})

test('a full queue refuses additions and a failed save is reported', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? {
            json: {
              current: playing.id,
              position: 0,
              entry: Array.from({ length: 500 }, () => playing),
            },
          }
        : { status: 500, json: { detail: 'Save failed' } },
    ),
  )
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('500')
  // The server has the confirmation, and the message says the queue was not changed.
  await expect(page.getByRole('alert')).toContainText(
    'The server recorded this confirmation, but your queue was not changed.',
  )
  await expect(page.getByText('No room on the shelf!')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace upcoming instead' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Play', exact: true }).click()
  await expect(
    page.getByText('The queue changed here but could not be saved.').first(),
  ).toBeVisible()
})

test('connection settings and model selection persist through reload', async ({
  page,
  request,
}) => {
  const old = settingsSchema.parse(await (await request.get('/api/settings')).json())
  await playerFixtures(page)
  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: ['fixture'], elapsed_ms: 2 } }),
  )
  try {
    await page.goto('/settings#music-bot')
    await page.getByLabel('Ollama server address').fill('http://127.0.0.1:11435')
    await page.getByLabel('Music time zone').fill('Pacific/Honolulu')
    await expect(page.getByRole('button', { name: 'Test Ollama connection' })).toBeDisabled()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Saved. You can safely refresh.')).toBeVisible()
    await page.getByRole('button', { name: 'Test Ollama connection' }).click()
    await expect(page.getByText('Connected. 1 installed models (2 ms).')).toBeVisible()
    await page.getByRole('link', { name: 'Open music bot' }).click()
    await page.getByLabel('Installed Ollama model').selectOption('fixture')
    await page.getByRole('button', { name: 'Use this model' }).click()
    await expect
      .poll(
        async () =>
          settingsSchema.parse(await (await request.get('/api/settings')).json()).ollama_model
            .value,
      )
      .toBe('fixture')
    await page.reload()
    await page.getByRole('button', { name: 'Chat settings' }).click()
    await expect(page.getByRole('radio', { name: 'fixture' })).toBeChecked()
    await expect(page.getByText(/Played today uses Pacific\/Honolulu/)).toBeVisible()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText('Connected. 1 installed model (2 ms).')).toBeVisible()
  } finally {
    await request.patch('/api/settings', {
      data: {
        ollama_url: old.ollama_url.value,
        ollama_model: old.ollama_model.value,
        music_timezone: old.music_timezone.value,
      },
    })
  }
})

const DONE: Record<string, string> = { pause: 'Paused', resume: 'Playing', skip: 'Skipped' }

test('direct pause, resume and skip act through the browser player', async ({ page }) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await page
    .locator('footer.live-player')
    .getByRole('button', { name: 'Play', exact: true })
    .click()
  const audio = page.locator('audio.library-audio[data-role="active"]')
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false)
  for (const action of ['pause', 'resume', 'skip']) {
    await page.route('**/api/music-bot/chat', (route) =>
      route.fulfill({ json: { ...answer, plan: { ...plan, action } } }),
    )
    await say(page, action)
    await expect(
      page
        .getByRole('log')
        .getByText(DONE[action] ?? '')
        .last(),
    ).toBeVisible()
    if (action !== 'skip')
      await expect
        .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
        .toBe(action === 'pause')
    else await expect.poll(() => saves.at(-1)?.current).toBe(first.id)
  }
})

const wide = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    librarySong(`tr-${(index + 0x100).toString(16).padStart(16, '0')}`, {
      title: `Long ${index}`,
      artist: `Artist ${index % 5}`,
      genre: index % 2 ? 'Rock' : 'Pop',
      year: 1990 + (index % 10),
      duration: 200 + index,
    }),
  )

test('a long proposal opens on a sample of itself, with the whole list one press away', async ({
  page,
}, info) => {
  await fixtures(page)
  const songs = wide(20)
  proposals = await proposalFixtures(page, songs)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({ json: { ...answer, tracks: songs, shortfall_seconds: 0 } }),
  )
  await page.goto('/music-bot')
  await ask(page)
  const list = card(page).getByRole('list', { name: 'Proposed songs' })
  // About six songs spread across the list, not its first few.
  await expect(list.locator('strong')).toHaveText([0, 3, 6, 9, 12, 15].map((n) => `Long ${n}`))
  const facts = card(page).getByLabel('About this preview')
  await expect(facts).toContainText('5 artists')
  await expect(facts).toContainText('Pop (10), Rock (10)')
  await expect(facts).toContainText('1990–1999')
  // No tempo or energy is claimed while no recipe measured any.
  await expect(facts).not.toContainText(/BPM|tempo/i)
  const all = card(page).getByRole('button', { name: /^(See all 20 songs|Show the sample)$/ })
  await expect(all).toHaveText('See all 20 songs')
  await card(page).evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: `../runtime/bot-preview/sample-${info.project.name}.png` })
  await all.focus()
  await page.keyboard.press('Enter')
  await expect(list.getByRole('listitem')).toHaveCount(20)
  await expect(all).toHaveAttribute('aria-expanded', 'true')
  await expect(all).toHaveText('Show the sample')
  await page.keyboard.press('Enter')
  await expect(list.getByRole('listitem')).toHaveCount(6)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a short proposal is shown whole, with nothing to unfold', async ({ page }) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await expect(
    card(page).getByRole('list', { name: 'Proposed songs' }).getByRole('listitem'),
  ).toHaveCount(2)
  await expect(card(page).getByRole('button', { name: /^See all/ })).toHaveCount(0)
})

test('Save and Add to queue confirm the shown revision and never search again', async ({
  page,
}) => {
  const saves = await fixtures(page)
  let chats = 0
  await page.route('**/api/music-bot/chat', (route) => {
    chats += 1
    return route.fulfill({ json: answer })
  })
  await page.goto('/music-bot')
  await ask(page)
  expect(proposals.creates).toHaveLength(1)
  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Road trip')
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(() => proposals.saved)
    .toEqual([{ name: 'Road trip', ids: [first.id, second.id] }])
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
  // The chat ran once, the search once. Both confirmations name the revision, not a search.
  expect(chats).toBe(1)
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(0)
  const [playlist, queue] = proposals.commits
  expect(playlist).toMatchObject({
    contract_version: 5,
    revision: 1,
    target: { kind: 'playlist', name: 'Road trip' },
    repeat: false,
  })
  expect(queue).toMatchObject({ revision: 1, target: { kind: 'queue' }, repeat: false })
  expect(queue?.proposal_id).toBe(playlist?.proposal_id)
  // One operation id for each press, made by the browser.
  expect(playlist?.operation_id).toMatch(/^op-[0-9a-f]{32}$/)
  expect(queue?.operation_id).toMatch(/^op-[0-9a-f]{32}$/)
  expect(queue?.operation_id).not.toBe(playlist?.operation_id)
  expect(proposals.handed).toEqual([[first.id, second.id]])
})

test('a refinement is the next revision of the same proposal, and the card says which', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await expect(card(page)).not.toContainText('REVISION')
  await ask(page, 'something else')
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(1)
  expect(proposals.refines[0]?.body.revision).toBe(1)
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => proposals.commits[0]?.revision).toBe(2)
})

test('a stale proposal says what changed, swaps nothing, and refreshes only when asked', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  proposals.fault = () => 'stale'
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview is out of date.')
  await expect(problem).toContainText('First Light: the file is unavailable')
  await expect(problem).toContainText('no song was swapped')
  // Nothing moved, and the confirmations wait for the refresh.
  expect(saves).toHaveLength(0)
  await expect(card(page).getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0)
  const items = card(page).getByRole('list', { name: 'Proposed songs' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  proposals.fault = undefined
  proposals.pick = () => [second]
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  // The same request again: the same filters and the seed the first run drew.
  await expect(problem).toHaveCount(0)
  expect(proposals.refines).toHaveLength(1)
  expect(proposals.refines[0]?.body).toMatchObject({ revision: 1, intent: { seed: 7 } })
  await expect(
    page.getByText('Refreshed the preview: 1 song left. Check it before you confirm.'),
  ).toBeVisible()
  await expect(items).toHaveCount(1)
  await expect(card(page)).toContainText('REVISION 2')
  expect(saves).toHaveLength(0)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, second.id])
  expect(proposals.commits.at(-1)?.revision).toBe(2)
})

test('a double click on Add to queue sends one confirmation and adds the songs once', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  let release: (() => void) | undefined
  proposals.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByRole('button', { name: 'Add to queue', exact: true }).dblclick()
  await expect.poll(() => proposals.commits.length).toBe(1)
  release?.()
  await expect(card(page)).toContainText('IN YOUR QUEUE')
  expect(proposals.commits).toHaveLength(1)
  expect(proposals.handed).toHaveLength(1)
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
})

test('a double submit of Save as playlist saves one playlist', async ({ page }) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  let release: (() => void) | undefined
  proposals.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Once')
  await card(page).getByRole('button', { name: 'Save', exact: true }).dblclick()
  await expect.poll(() => proposals.commits.length).toBe(1)
  release?.()
  await expect(page.getByText('Saved as the playlist “Once”.')).toBeVisible()
  expect(proposals.commits).toHaveLength(1)
  expect(proposals.saved).toEqual([{ name: 'Once', ids: [first.id, second.id] }])
})

test('a confirmation whose answer was lost is asked again with the same id and lands once', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  // The server records it, then the reply never arrives.
  proposals.fault = (_, count) => (count === 1 ? 'drop-after' : undefined)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect(card(page)).toContainText('IN YOUR QUEUE')
  expect(proposals.commits).toHaveLength(2)
  expect(proposals.commits[1]?.operation_id).toBe(proposals.commits[0]?.operation_id)
  expect(proposals.handed).toHaveLength(1)
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
})

test('while the outcome is unknown no new attempt is offered, and checking again reconciles it', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  proposals.fault = (_, count) => (count <= 2 ? 'drop-before' : undefined)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('I can’t tell if that went through.')
  await expect(problem).toContainText('Nothing has been added to your queue yet.')
  await expect(card(page).getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0)
  await expect(card(page).getByRole('button', { name: 'Save as playlist' })).toHaveCount(0)
  expect(saves).toHaveLength(0)
  await problem.getByRole('button', { name: 'Check again' }).click()
  await expect(card(page)).toContainText('IN YOUR QUEUE')
  expect(new Set(proposals.commits.map((commit) => commit.operation_id)).size).toBe(1)
  expect(proposals.commits).toHaveLength(3)
  expect(proposals.handed).toHaveLength(1)
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
})

test('a second Add to queue after Undo is sent as a repeat under a new id', async ({ page }) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await undo(page).click()
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => proposals.commits.length).toBe(2)
  expect(proposals.commits[1]).toMatchObject({ repeat: true })
  expect(proposals.commits[1]?.operation_id).not.toBe(proposals.commits[0]?.operation_id)
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
})

test('Save as playlist on a restored card makes a preview first and saves on a second press', async ({
  page,
}) => {
  await fixtures(page)
  await page.addInitScript(
    ([reply, log]) => {
      sessionStorage.setItem('musimo.music-bot.proposal', reply ?? '')
      sessionStorage.setItem('musimo.music-bot.log', log ?? '')
    },
    [
      JSON.stringify(answer),
      JSON.stringify({
        entries: [
          {
            id: 1,
            kind: 'reply',
            text: 'Here it is.',
            mood: 'talking',
            suggestions: [],
            card: '2 songs',
          },
        ],
        cardId: 1,
      }),
    ],
  )
  await page.goto('/music-bot')
  await expect(card(page)).toBeVisible()
  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Restored')
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('I made a preview of this list first.')).toBeVisible()
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.creates[0]).toMatchObject({
    scope: 'proposal',
    context: { proposal_ids: [first.id, second.id] },
  })
  expect(proposals.commits).toHaveLength(0)
  expect(proposals.saved).toHaveLength(0)
  await expect(card(page).getByLabel('About this preview')).toBeVisible()
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(() => proposals.saved)
    .toEqual([{ name: 'Restored', ids: [first.id, second.id] }])
})

test('taking a song off the card is the next revision, and that is what is confirmed', async ({
  page,
}) => {
  const saves = await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await card(page).getByRole('button', { name: 'More actions for First Light' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(
    card(page).getByRole('list', { name: 'Proposed songs' }).getByRole('listitem'),
  ).toHaveCount(1)
  // A remove edit of the open proposal, not a new proposal.
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.edits).toHaveLength(1)
  expect(proposals.edits[0]).toMatchObject({
    revision: 1,
    edit: { kind: 'remove', ids: [first.id] },
  })
  await expect(card(page)).toContainText('REVISION 2')
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, second.id])
  expect(proposals.handed).toEqual([[second.id]])
  expect(proposals.commits[0]).toMatchObject({ revision: 2 })
})

test('a song the library no longer has is named, left off the list, and refreshed before confirming', async ({
  page,
}) => {
  const saves = await fixtures(page)
  proposals.ghosts = ['tr-00000000000000ff']
  await page.goto('/music-bot')
  await ask(page)
  const items = card(page).getByRole('list', { name: 'Proposed songs' }).getByRole('listitem')
  // The two songs that exist are drawn. The one that does not is not, and nothing crashes.
  await expect(items).toHaveCount(2)
  const missing = card(page).locator('[data-bot="missing"]')
  await expect(missing).toContainText('1 song in this preview is no longer in your library.')
  await expect(card(page).getByLabel('About this preview')).toContainText(
    '1 song no longer in the library',
  )
  // Confirming would only be refused as stale, so it waits for the refresh.
  await expect(card(page).getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0)
  expect(proposals.commits).toHaveLength(0)
  proposals.ghosts = []
  await missing.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(missing).toHaveCount(0)
  await expect(card(page)).toContainText('REVISION 2')
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
})

test('a preview whose songs have all left the library says so instead of showing an empty card', async ({
  page,
}) => {
  await fixtures(page)
  proposals.pick = () => []
  proposals.ghosts = ['tr-00000000000000fe', 'tr-00000000000000ff']
  await page.goto('/music-bot')
  await say(page, 'anything')
  await expect(card(page).locator('[data-bot="missing"]')).toContainText(
    '2 songs in this preview are no longer in your library.',
  )
  await expect(card(page)).not.toContainText('None of your library matches')
  await expect(card(page).getByRole('list', { name: 'Proposed songs' })).toHaveCount(0)
  await expect(card(page).getByRole('button', { name: 'Refresh preview' })).toBeVisible()
})

test('the approved total stays the card’s total, and the length the songs add up to now is labelled', async ({
  page,
}) => {
  await fixtures(page)
  // The revision was approved at 7 min 8 s. The songs now add up to a minute less.
  proposals.drift = 60
  await page.goto('/music-bot')
  await ask(page)
  await expect(card(page)).toContainText('Total 7 min')
  await expect(card(page).getByLabel('About this preview')).toContainText(
    'Length now 6 min, approved at 7 min',
  )
})

test('every request names a contract version the server takes, for create, refine and commit', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  await ask(page, 'something else')
  await expect(card(page)).toContainText('REVISION 2')
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => proposals.commits.length).toBe(1)
  expect(proposals.creates[0]?.contract_version).toBe(5)
  expect(proposals.refines[0]?.body.intent).toMatchObject({ contract_version: 5 })
  expect(proposals.commits[0]?.contract_version).toBe(5)
})

test('a recorded queue confirmation the card cannot match says so, leaves the queue alone and offers a refresh', async ({
  page,
}) => {
  const saves = await fixtures(page)
  // The server's receipt names a song this card does not hold.
  proposals.receiptExtra = ['tr-00000000000000ff']
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('Your queue was not changed.')
  await expect(problem).toContainText('The server recorded this confirmation')
  expect(proposals.commits).toHaveLength(1)
  expect(saves).toHaveLength(0)
  await expect(card(page)).not.toContainText('IN YOUR QUEUE')
  // No second confirmation is offered until the card is refreshed.
  await expect(card(page).getByRole('button', { name: 'Add to queue', exact: true })).toHaveCount(0)
  proposals.receiptExtra = []
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => saves.at(-1)?.ids).toEqual([playing.id, first.id, second.id])
  expect(proposals.commits.at(-1)?.revision).toBe(2)
})

test('Remove from this list and Refresh preview wait while a chat request runs, and the chat is not left locked', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/music-bot/chat', async (route) => {
    await gate
    await route.fulfill({ json: answer }).catch(() => undefined)
  })
  await say(page, 'something else')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await card(page).getByRole('button', { name: 'More actions for First Light' }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove from this list' })).toBeDisabled()
  await page.keyboard.press('Escape')
  // Nothing was stored by the press that could not happen.
  expect(proposals.creates).toHaveLength(1)
  release?.()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(box(page)).toBeEnabled()
  // And the chat takes the next request.
  await ask(page, 'one more')
  await expect(card(page)).toContainText('REVISION 3')
})

test('a stale or unsettled preview cannot have a song taken off it, and Refresh waits for a running request', async ({
  page,
}) => {
  await fixtures(page)
  await page.goto('/music-bot')
  await ask(page)
  proposals.fault = () => 'stale'
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview is out of date.')
  await card(page).getByRole('button', { name: 'More actions for First Light' }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove from this list' })).toBeDisabled()
  await page.keyboard.press('Escape')
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/music-bot/chat', async (route) => {
    await gate
    await route.fulfill({ json: answer }).catch(() => undefined)
  })
  await say(page, 'something else')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(problem.getByRole('button', { name: 'Refresh preview' })).toBeDisabled()
  release?.()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})
