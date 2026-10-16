import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { settingsSchema } from '../src/api'
import { generatedPlayerAudio, librarySong, playerFixtures, requestBody } from './library-fixtures'

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
  await expect(page.getByText('Queue restored. Press play to continue.').first()).toBeVisible()
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
  await expect(page.getByText('Queue restored. Press play to continue.').first()).toBeVisible()
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

  await page.route('**/api/library/playlists', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    expect(requestBody(route).song_ids).toEqual([second.id])
    await route.fulfill({
      json: {
        id: 'pl-42',
        name: 'Music bot selection',
        songCount: 1,
        duration: second.duration,
        song: [second],
      },
    })
  })
  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Music bot selection')
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText('Saved as the playlist \u201cMusic bot selection\u201d.'),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: `../runtime/milestone1/music-bot-${info.project.name}.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Clear chat' }).click()
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toHaveCount(0)
  await page.reload()
  // A cleared chat stays cleared, and opens on the greeting.
  await expect(page.getByRole('heading', { name: /^Hi, I.m Octive\.$/ })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Proposed songs' })).toHaveCount(0)
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
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click()
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
  await page.route('**/api/music-bot/validate', (route) =>
    route.fulfill({ status: 409, json: { detail: 'A file is unavailable. Ask again.' } }),
  )
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
  await expect(page.getByText('No room on the shelf!')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace upcoming instead' })).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Play', exact: true }).click()
  await expect(
    page.getByText('The queue changed here but could not be saved.').first(),
  ).toBeVisible()
})

test('cancelling validation cannot apply a selection', async ({ page }) => {
  const saves = await fixtures(page)
  let release: (() => void) | undefined
  await page.route('**/api/music-bot/validate', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ json: { tracks: [first, second] } }).catch(() => undefined)
  })
  await page.goto('/music-bot')
  await ask(page)
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  release?.()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  expect(saves).toHaveLength(0)
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
