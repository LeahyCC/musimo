import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import type { DownloadJob } from '../src/api'
import { playerFixtures } from './library-fixtures'
import { emptyQueue, writableDestination } from './queue-fixtures'

const LINK = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'
const PLAYLIST = 'https://www.youtube.com/playlist?list=PL1'
const ART = 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg'

interface Entry {
  id: string
  title: string
  artist: string
  album: string
  date: string
  duration: number
  art: string
  owned: boolean
}
interface Preview {
  token: string
  site: string
  source: string
  kind: string
  single: boolean
  profile: boolean
  title: string
  truncated: boolean
  partial?: boolean
  quality_note?: string
  expires_in: number
  entries: Entry[]
}
interface Answer {
  status?: number
  body: unknown
}

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  id,
  title: `Song ${id}`,
  artist: 'Band',
  album: '',
  date: '2024-05-01',
  duration: 200,
  art: ART,
  owned: false,
  ...over,
})
const preview = (over: Partial<Preview> = {}): Preview => ({
  token: 'preview-token-0123456789',
  site: 'YouTube',
  source: 'youtube',
  kind: 'music',
  single: true,
  profile: false,
  title: '',
  truncated: false,
  expires_in: 600,
  entries: [entry('aaaaaaaaaaa')],
  ...over,
})
const playlist = (over: Partial<Preview> = {}): Preview =>
  preview({
    single: false,
    title: 'Road trip',
    entries: [
      entry('aaaaaaaaaaa'),
      entry('bbbbbbbbbbb', { owned: true }),
      entry('ccccccccccc', { duration: 3725 }),
    ],
    ...over,
  })
const refusal = (detail: string): Answer => ({ status: 422, body: { detail } })

const linkJob = (id: string, over: Partial<DownloadJob> = {}): DownloadJob => ({
  id,
  batch_id: '',
  batch_label: '',
  album_id: 0,
  catalog: 'link',
  source: 'youtube',
  track_id: 5,
  format: 'original',
  target: '/music',
  stage: 'queued',
  desired: 'run',
  meta: { id: 5, title: 'Song aaaaaaaaaaa', artist: 'Band', album: '', art: '', duration: 200 },
  candidates: [],
  selected: '',
  check_match: false,
  attempts: 0,
  retry_at: 0,
  progress: 0,
  downloaded: 0,
  total: 0,
  speed: 0,
  eta: null,
  error_code: '',
  error: '',
  retryable: false,
  error_hint: '',
  error_fix: '',
  tool_tail: '',
  tool_version: '',
  warnings: [],
  notes: [],
  final_path: '',
  codec: '',
  actual_bitrate: 0,
  created_at: 1,
  updated_at: 1,
  hidden: false,
  ...over,
})

interface Requests {
  resolved: string[]
  queued: unknown[]
  searched: string[]
}

/**
 * An empty queue, no catalog, and `answer` in place of the link API. Nothing here reaches a
 * real site: the link API is answered from the fixture and every other host is refused.
 */
async function linkFixtures(
  page: Page,
  answer: (url: string) => Answer | Promise<Answer> = () => ({ body: preview() }),
): Promise<Requests> {
  const seen: Requests = { resolved: [], queued: [], searched: [] }
  await playerFixtures(page)
  await emptyQueue(page)
  await writableDestination(page)
  await page.route('https://i.ytimg.com/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#283d31"/></svg>',
    }),
  )

  await page.route('**/api/search?*', (route) => {
    seen.searched.push(new URL(route.request().url()).searchParams.get('q') ?? '')
    return route.fulfill({ json: { items: [], total: 0, next_index: null, cached: false } })
  })

  await page.route('**/api/links/resolve', async (route) => {
    const { url } = route.request().postDataJSON() as { url: string }
    seen.resolved.push(url)
    const reply = await answer(url)
    // A cancelled request has nobody left to answer.
    await route.fulfill({ status: reply.status ?? 200, json: reply.body }).catch(() => undefined)
  })

  await page.route('**/api/links', async (route) => {
    const body = route.request().postDataJSON() as { entry_ids: string[] }
    seen.queued.push(body)
    const jobs = body.entry_ids.map((id, index) =>
      linkJob(`job-${id}`, {
        track_id: index + 5,
        meta: {
          id: index + 5,
          title: `Song ${id}`,
          artist: 'Band',
          album: '',
          art: '',
          duration: 200,
        },
      }),
    )
    await route.fulfill({ json: { id: '', jobs, skipped_done: 0 } })
  })

  // Record what the page aborts, since the browser reports a routed request as unfinished either way.
  await page.addInitScript(() => {
    const aborted: string[] = []
    Reflect.set(window, '__aborted', aborted)
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      init?.signal?.addEventListener('abort', () => aborted.push(url))
      return original(input, init)
    }
  })

  return seen
}

/** The link lookups the page has abandoned. */
const aborted = (page: Page) =>
  page.evaluate(() => {
    const list: unknown = Reflect.get(window, '__aborted')
    return Array.isArray(list)
      ? list.map(String).filter((url) => url.includes('/api/links/resolve'))
      : []
  })

const searchBox = (page: Page) => page.getByLabel('Search music or paste a link')
const sheet = (page: Page) => page.getByRole('dialog')

async function paste(page: Page, text: string) {
  const box = searchBox(page)
  await box.focus()
  // The event a real paste sends. Firefox empties the data of a page-made event, so the
  // clipboard the handler reads is supplied on the event itself.
  await box.evaluate((input, value) => {
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } })
    input.dispatchEvent(event)
  }, text)
}

/** Escape closes the sheet a moment later, so wait for it before the next link goes in. */
async function dismiss(page: Page) {
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
}

async function submit(page: Page, text: string) {
  await searchBox(page).fill(text)
  await page.keyboard.press('Enter')
}

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('Element has no box')
  return rect
}

test.describe('pasted links', () => {
  test('one recording is reviewed, queued and shown on its job card with its site', async ({
    page,
    isMobile,
  }) => {
    const seen = await linkFixtures(page)
    await page.goto('/')
    await paste(page, `  ${LINK}  `)

    await expect(sheet(page).getByRole('heading', { name: 'Review download' })).toBeVisible()
    // A link is never searched for, and the box keeps what was pasted.
    await expect(searchBox(page)).toHaveValue(LINK)
    await expect(sheet(page).getByText('YouTube', { exact: true })).toBeVisible()
    await expect(sheet(page).getByText('Song aaaaaaaaaaa')).toBeVisible()
    await expect(sheet(page).getByText('Band', { exact: true })).toBeVisible()
    await expect(sheet(page).getByText('3:20 · 2024-05-01')).toBeVisible()
    await expect(sheet(page).locator('img')).toBeVisible()
    await expect(sheet(page).getByText(/^to \S+ · /)).toBeVisible()
    await expect(sheet(page).getByRole('combobox', { name: 'Format' })).toBeVisible()
    await expect(sheet(page).getByRole('combobox', { name: 'Download to' })).toBeVisible()
    expect(seen.resolved).toEqual([LINK])

    await sheet(page).getByRole('button', { name: 'Download' }).click()
    await expect(
      sheet(page)
        .getByRole('status')
        .filter({ hasText: /queued from YouTube/ }),
    ).toHaveText(/1 song queued from YouTube\./)

    expect(seen.queued).toEqual([
      {
        token: 'preview-token-0123456789',
        entry_ids: ['aaaaaaaaaaa'],
        format: expect.stringMatching(/^(original|m4a|opus|mp3)$/) as unknown,
        target: expect.stringMatching(/\S/) as unknown,
      },
    ])
    expect(seen.searched).toEqual([])

    // Closing the sheet shows what the queue now holds.
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    if (isMobile) {
      await expect(page.getByRole('link', { name: /Downloads.*1.*active/ })).toBeVisible()
    } else {
      await expect(
        page.getByRole('button', { name: 'Open queue, 1 active downloads' }),
      ).toBeVisible()
    }

    // A reload would drop the fixture queue, so go there the way a person does.
    await page.getByRole('link', { name: /^Downloads/ }).click()
    const card = page.locator('#main').getByRole('article').filter({ hasText: 'Song aaaaaaaaaaa' })
    await expect(card.getByText('from YouTube')).toBeVisible()
    // Nothing is searched for a link job, so the card never claims a matching stage.
    const stages = card.getByLabel('Current stage: queued')
    await expect(stages.getByText('queued', { exact: true })).toBeVisible()
    await expect(stages.getByText('downloading', { exact: true })).toBeVisible()
    await expect(stages.getByText('matching', { exact: true })).toHaveCount(0)
  })

  test('submitting a link with Enter opens the same sheet and never searches', async ({ page }) => {
    const seen = await linkFixtures(page)
    await page.goto('/')
    await submit(page, LINK)
    // Focus lands on the heading once the dialog is open. WebKit ignores an Escape sent before that.
    await expect(sheet(page).getByRole('heading', { name: 'Review download' })).toBeFocused()
    // Escape closes it and puts the person back in the search box.
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    await expect(searchBox(page)).toBeFocused()
    // Typing a link, however slowly, waits for a paste or Enter instead of searching for pieces.
    await searchBox(page).fill('https://www.youtube.com/wat')
    await page.waitForTimeout(500)
    expect(seen.searched).toEqual([])
    expect(seen.resolved).toEqual([LINK])
    // Ordinary text still searches.
    await searchBox(page).fill('harbor')
    await expect.poll(() => seen.searched).toContain('harbor')
    expect(seen.resolved).toEqual([LINK])
  })

  test('a half-typed address gets a plain message instead of a search', async ({ page }) => {
    const seen = await linkFixtures(page)
    await page.goto('/')
    await submit(page, 'https://')
    await expect(sheet(page).getByRole('alert')).toHaveText(/not a whole link/)
    expect(seen.resolved).toEqual([])
    expect(seen.searched).toEqual([])
  })

  test('a playlist starts with the songs you do not own ticked, and queues only the ticked ones', async ({
    page,
  }) => {
    const seen = await linkFixtures(page, () => ({ body: playlist() }))
    await page.goto('/')
    await paste(page, PLAYLIST)

    await expect(sheet(page).getByRole('heading', { name: 'Road trip' })).toBeVisible()
    const rows = sheet(page).getByRole('checkbox')
    await expect(rows).toHaveCount(3)
    await expect(sheet(page).getByRole('checkbox', { name: /Song aaaaaaaaaaa/ })).toBeChecked()
    await expect(sheet(page).getByRole('checkbox', { name: /Song bbbbbbbbbbb/ })).not.toBeChecked()
    await expect(sheet(page).getByRole('checkbox', { name: /Song ccccccccccc/ })).toBeChecked()
    // The owned song carries the badge inside its own row, and the long one reads h:mm:ss.
    await expect(
      sheet(page).getByRole('checkbox', { name: /Song bbbbbbbbbbb.*In library/ }),
    ).toBeVisible()
    await expect(sheet(page).getByText('In library', { exact: true })).toHaveCount(1)
    await expect(sheet(page).getByText('Band · 1:02:05 · 2024-05-01')).toBeVisible()
    await expect(sheet(page).getByText('2 of 3 songs selected')).toBeVisible()
    await expect(sheet(page).getByText(/1 song already in library/)).toBeVisible()

    await sheet(page).getByRole('button', { name: 'Select none' }).click()
    await expect(sheet(page).getByText('0 of 3 songs selected')).toBeVisible()
    await expect(sheet(page).getByRole('button', { name: 'Download 0 songs' })).toBeDisabled()
    await sheet(page).getByRole('button', { name: 'Select all' }).click()
    await expect(sheet(page).getByText('3 of 3 songs selected')).toBeVisible()
    await sheet(page)
      .getByRole('checkbox', { name: /Song aaaaaaaaaaa/ })
      .uncheck()
    await expect(sheet(page).getByText('2 of 3 songs selected')).toBeVisible()

    await sheet(page).getByRole('button', { name: 'Download 2 songs' }).click()
    await expect(
      sheet(page)
        .getByRole('status')
        .filter({ hasText: /queued from/ }),
    ).toHaveText(/2 songs queued from YouTube\./)
    expect(seen.queued).toMatchObject([{ entry_ids: ['bbbbbbbbbbb', 'ccccccccccc'] }])
  })

  test('a profile link starts with nothing ticked', async ({ page }) => {
    await linkFixtures(page, () => ({
      body: playlist({ profile: true, title: 'Band', truncated: true }),
    }))
    await page.goto('/')
    await paste(page, 'https://www.youtube.com/@band')
    await expect(sheet(page).getByRole('heading', { name: 'Band' })).toBeVisible()
    await expect(sheet(page).getByRole('checkbox', { checked: true })).toHaveCount(0)
    await expect(sheet(page).getByText('0 of 3 songs selected')).toBeVisible()
    await expect(sheet(page).getByText(/whole profile/)).toBeVisible()
    await expect(sheet(page).getByText(/Only the first 500 are listed/)).toBeVisible()
    await expect(sheet(page).getByRole('button', { name: 'Download 0 songs' })).toBeDisabled()
    await sheet(page)
      .getByRole('checkbox', { name: /Song bbbbbbbbbbb/ })
      .check()
    await expect(sheet(page).getByRole('button', { name: 'Download 1 song' })).toBeEnabled()
  })

  test('a site says what quality to expect, and a profile says when only part of it was read', async ({
    page,
  }) => {
    const note = 'Bandcamp streams are 128 kbps MP3. Buying the album there gets you lossless.'
    await linkFixtures(page, (url) =>
      url.endsWith('/music')
        ? {
            body: playlist({
              site: 'Bandcamp',
              source: 'bandcamp',
              profile: true,
              title: 'Discography of band',
              partial: true,
              quality_note: note,
            }),
          }
        : {
            body: preview({ site: 'Bandcamp', source: 'bandcamp', quality_note: note }),
          },
    )
    await page.goto('/')
    await paste(page, 'https://band.bandcamp.com/track/a')
    await expect(sheet(page).getByText(note)).toBeVisible()
    await dismiss(page)

    await paste(page, 'https://band.bandcamp.com/music')
    await expect(sheet(page).getByText(note)).toBeVisible()
    await expect(sheet(page).getByText(/Some of this page could not be read in time/)).toBeVisible()
    await expect(sheet(page).getByRole('checkbox', { checked: true })).toHaveCount(0)
  })

  test('a site with no note and a full page shows neither', async ({ page }) => {
    await linkFixtures(page, () => ({ body: playlist() }))
    await page.goto('/')
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByText('2 of 3 songs selected')).toBeVisible()
    await expect(sheet(page).getByText(/could not be read in time/)).toHaveCount(0)
    await expect(sheet(page).getByText(/kbps/)).toHaveCount(0)
  })

  test('a read-only destination keeps Download off and says why', async ({ page }) => {
    await linkFixtures(page)
    const settings = (await (await page.request.get('/api/settings')).json()) as {
      destination: { value: string }
    }
    const destination = settings.destination.value
    let writable = false
    await page.route('**/api/diagnostics', async (route) => {
      const live = await route.fetch()
      const body = (await live.json()) as { disks: object[] }
      await route.fulfill({
        json: {
          ...body,
          disks: [
            { path: '', free_bytes: null, total_bytes: null, exists: false, writable: false },
            { path: destination, free_bytes: 1000, total_bytes: 2000, exists: true, writable },
          ],
        },
      })
    })
    await page.goto('/')
    await paste(page, LINK)
    const download = sheet(page).getByRole('button', { name: 'Download', exact: true })
    await expect(sheet(page).getByRole('alert')).toContainText('missing or read-only')
    await expect(download).toBeDisabled()

    // Once the folder can be written to, the same sheet lets the download through.
    writable = true
    await dismiss(page)
    await page.reload()
    await paste(page, LINK)
    await expect(sheet(page).getByRole('heading', { name: 'Review download' })).toBeVisible()
    await expect(sheet(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
    await expect(sheet(page).getByText(/missing or read-only/)).toHaveCount(0)
  })

  test('a recording already in the library says so and can still be downloaded', async ({
    page,
  }) => {
    await linkFixtures(page, () => ({
      body: preview({ entries: [entry('aaaaaaaaaaa', { owned: true })] }),
    }))
    await page.goto('/')
    await paste(page, LINK)
    await expect(sheet(page).getByText('In library', { exact: true })).toBeVisible()
    await expect(sheet(page).getByRole('button', { name: 'Download' })).toBeEnabled()
  })

  const refusals: [string, string, string][] = [
    [
      'an unsupported site',
      'https://example.com/song',
      "Musimo can't download from example.com. It works with: YouTube.",
    ],
    ['a Spotify link', 'https://open.spotify.com/track/1', 'Catalog imports are not built yet.'],
    [
      'a live stream',
      'https://www.youtube.com/watch?v=liveliveliv',
      "Live streams never finish, so they can't be saved.",
    ],
    [
      'nothing to download',
      'https://www.youtube.com/playlist?list=EMPTY',
      'There is nothing to download at this link.',
    ],
  ]
  for (const [name, url, detail] of refusals) {
    test(`${name} is refused in the sheet with the server's own words`, async ({ page }) => {
      const seen = await linkFixtures(page, () => refusal(detail))
      await page.goto('/')
      await paste(page, url)
      const alert = sheet(page).getByRole('alert')
      await expect(alert).toHaveText(detail)
      await expect(
        sheet(page).getByRole('heading', { name: 'This link can’t be used' }),
      ).toBeVisible()
      // Nothing to tick, nothing to queue.
      await expect(sheet(page).getByRole('checkbox')).toHaveCount(0)
      await expect(sheet(page).getByRole('button', { name: /^Download/ })).toHaveCount(0)
      await sheet(page).getByRole('button', { name: 'Close', exact: true }).click()
      await expect(sheet(page)).toHaveCount(0)
      expect(seen.queued).toEqual([])
      expect(seen.searched).toEqual([])
    })
  }

  test('a network failure is a plain message too', async ({ page }) => {
    await linkFixtures(page, () => ({
      status: 504,
      body: { detail: 'YouTube took too long to answer. Try again.' },
    }))
    await page.goto('/')
    await paste(page, LINK)
    await expect(sheet(page).getByRole('alert')).toHaveText(
      'YouTube took too long to answer. Try again.',
    )
  })

  test('the real server refuses an unlisted site and a Spotify link', async ({ page }) => {
    await playerFixtures(page)
    await emptyQueue(page)
    await page.goto('/')
    await paste(page, 'https://example.com/song')
    await expect(sheet(page).getByRole('alert')).toHaveText(
      "Musimo can't download from example.com. It works with: YouTube, Internet Archive, Bandcamp, SoundCloud, Audiomack, Audius, Jamendo.",
    )
    await dismiss(page)
    await paste(page, 'https://open.spotify.com/album/1')
    await expect(sheet(page).getByRole('alert')).toHaveText('Catalog imports are not built yet.')
  })

  test('cancelling while the link is being read stops the request and closes the sheet', async ({
    page,
  }) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = await linkFixtures(page, async () => {
      await held
      return { body: preview() }
    })
    await page.goto('/')
    await paste(page, LINK)

    const cancel = sheet(page).getByRole('button', { name: 'Cancel' })
    await expect(sheet(page).getByRole('heading', { name: 'Checking link' })).toBeVisible()
    await expect(sheet(page).getByRole('status')).toContainText(
      'Checking the link with www.youtube.com',
    )
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(sheet(page)).toHaveCount(0)
    await expect(searchBox(page)).toBeFocused()
    await expect
      .poll(() => aborted(page))
      .toContainEqual(expect.stringContaining('/api/links/resolve'))
    // Even if the site answers later, nothing comes back to the screen.
    release()
    await page.waitForTimeout(300)
    await expect(sheet(page)).toHaveCount(0)
    expect(seen.queued).toEqual([])
  })

  test('Escape while reading is a cancel, and a second link replaces the first request', async ({
    page,
  }) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = await linkFixtures(page, async (url) => {
      if (url === LINK) await held
      return { body: playlist({ title: 'Second link' }) }
    })
    await page.goto('/')
    await paste(page, LINK)
    await expect(sheet(page).getByRole('heading', { name: 'Checking link' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    await expect.poll(() => aborted(page)).toHaveLength(1)

    await paste(page, LINK)
    await expect(sheet(page).getByRole('heading', { name: 'Checking link' })).toBeVisible()
    // Pasting again while the first is still out: the first is abandoned, only the second shows.
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('heading', { name: 'Second link' })).toBeVisible()
    await expect.poll(() => aborted(page)).toHaveLength(2)
    release()
    await page.waitForTimeout(300)
    await expect(sheet(page).getByRole('heading', { name: 'Second link' })).toBeVisible()
    expect(seen.resolved).toEqual([LINK, LINK, PLAYLIST])
  })

  test('a link pasted the instant the last sheet closed still opens its own sheet', async ({
    page,
  }) => {
    await linkFixtures(page, (url) => ({ body: url === LINK ? preview() : playlist() }))
    await page.goto('/')
    await paste(page, LINK)
    await expect(sheet(page).getByRole('heading', { name: 'Review download' })).toBeVisible()
    // No wait in between: the close event of the first sheet must not take the second down.
    await page.keyboard.press('Escape')
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('heading', { name: 'Road trip' })).toBeVisible()
    await page.waitForTimeout(300)
    await expect(sheet(page).getByRole('checkbox')).toHaveCount(3)
  })

  test('the open sheet has no accessibility violations', async ({ page }) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await linkFixtures(page, async (url) => {
      if (url === 'https://www.youtube.com/watch?v=held') await held
      if (url === 'https://example.com/x')
        return refusal("Musimo can't download from example.com. It works with: YouTube.")
      return { body: url === LINK ? preview() : playlist() }
    })
    await page.goto('/')

    await paste(page, 'https://www.youtube.com/watch?v=held')
    await expect(sheet(page).getByRole('status')).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await dismiss(page)
    release()

    await paste(page, 'https://example.com/x')
    await expect(sheet(page).getByRole('alert')).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await dismiss(page)

    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('checkbox')).toHaveCount(3)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await dismiss(page)

    await paste(page, LINK)
    await expect(sheet(page).getByRole('heading', { name: 'Review download' })).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })

  test('the sheet is a centred dialog on a desktop and a bottom sheet at phone width', async ({
    page,
  }) => {
    await linkFixtures(page, () => ({ body: playlist() }))
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('checkbox')).toHaveCount(3)
    const desktop = await box(sheet(page))
    expect(desktop.width).toBeLessThanOrEqual(700)
    expect(desktop.x + desktop.width / 2).toBeCloseTo(640, -1)
    expect(desktop.y).toBeGreaterThan(0)
    await dismiss(page)

    await page.setViewportSize({ width: 390, height: 780 })
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('checkbox')).toHaveCount(3)
    const phone = await box(sheet(page))
    expect(phone.x).toBe(0)
    expect(phone.width).toBe(390)
    expect(phone.y + phone.height).toBeCloseTo(780, 0)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0)
    // The button that queues is inside the sheet's own view, not scrolled out of reach.
    await expect(sheet(page).getByRole('button', { name: 'Download 2 songs' })).toBeInViewport()
  })

  test('on a phone every control in the sheet is a full touch target and text is not zoomed', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'Touch sizes apply to the phone project only.')
    await linkFixtures(page, () => ({ body: playlist() }))
    await page.goto('/')
    await paste(page, PLAYLIST)
    await expect(sheet(page).getByRole('checkbox')).toHaveCount(3)
    const small = await sheet(page).evaluate((dialog) => {
      const out: string[] = []
      for (const el of dialog.querySelectorAll<HTMLElement>(
        "[data-ui='icon-button'], [data-ui='button'], [data-ui='text-link'], select, label",
      )) {
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        if (rect.height < 44)
          out.push(
            `${el.tagName} ${el.textContent?.slice(0, 20) ?? ''} ${Math.round(rect.height)}px`,
          )
        if (el.tagName === 'SELECT' && parseFloat(getComputedStyle(el).fontSize) < 16)
          out.push(`select font ${getComputedStyle(el).fontSize}`)
      }
      return out
    })
    expect(small).toEqual([])
  })

  test('the sheet is reachable and operable by keyboard alone', async ({ page }) => {
    const seen = await linkFixtures(page, () => ({ body: playlist() }))
    await page.goto('/')
    await submit(page, PLAYLIST)
    await expect(sheet(page).getByRole('heading', { name: 'Road trip' })).toBeFocused()
    // Tab order: close, format, destination, select all, select none, then the songs.
    await page.keyboard.press('Tab')
    await expect(sheet(page).getByRole('button', { name: 'Close link review' })).toBeFocused()
    await sheet(page).getByRole('button', { name: 'Select none' }).focus()
    await page.keyboard.press('Enter')
    await expect(sheet(page).getByText('0 of 3 songs selected')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(sheet(page).getByRole('checkbox', { name: /Song aaaaaaaaaaa/ })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(sheet(page).getByText('1 of 3 songs selected')).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Download 1 song' }).focus()
    await page.keyboard.press('Enter')
    await expect(
      sheet(page)
        .getByRole('status')
        .filter({ hasText: /queued from/ }),
    ).toBeVisible()
    expect(seen.queued).toMatchObject([{ entry_ids: ['aaaaaaaaaaa'] }])
  })
})

test.describe('site names', () => {
  test('a job card names its site the way the server does', async ({ page }) => {
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable in this fixture' } }),
    )

    await page.route('**/api/jobs*', (route) =>
      route.fulfill({
        json: {
          jobs: [
            linkJob('a', { source: 'bandcamp', source_label: 'Bandcamp', track_id: 1 }),
            linkJob('b', { source: 'archive', source_label: 'Internet Archive', track_id: 2 }),
            // A payload from a server before labels: the name is built from the source.
            linkJob('c', { source: 'newsite', track_id: 3 }),
          ].map((job, index) => ({
            ...job,
            meta: { ...job.meta, title: `Track ${index}` },
          })),
          controls: { paused: false, source_paused: false },
          summary: { active: 3, failed: 0, failure_reasons: [] },
        },
      }),
    )
    await page.goto('/downloads')
    const card = (title: string) =>
      page.locator('#main').getByRole('article').filter({ hasText: title })
    await expect(card('Track 0').getByText('from Bandcamp')).toBeVisible()
    await expect(card('Track 1').getByText('from Internet Archive')).toBeVisible()
    await expect(card('Track 2').getByText('from Newsite')).toBeVisible()
  })

  test('diagnostics lists every paused site, not only YouTube', async ({ page }) => {
    const diagnostics = (queue: object) => ({
      health: { status: 'ok', version: '1.0.0', uptime_seconds: 100, phase: 1 },
      versions: {},
      disks: [
        { path: '/music', free_bytes: 1000, total_bytes: 2000, exists: true, writable: true },
      ],
      sources: [
        {
          source: 'youtube',
          status: 'healthy',
          latency_ms: 5,
          detail: 'Last YouTube download completed',
          checked_at: '2026-09-19T00:00:00Z',
        },
      ],
      events: [],
      database: { mode: 'wal', schema: 1, retained_events: 0 },
      library: {
        status: 'done',
        walked: 1,
        indexed: 1,
        errors: 0,
        elapsed: 1,
        detail: 'Scan complete',
        total_files: 1,
        roots: ['/music'],
      },
      queue,
      capabilities: { settings: true, events: true, search: true, downloads: true },
      navidrome: null,
      last_download: null,
    })
    let queue: object = {
      paused: false,
      source_paused: false,
      paused_sources: ['bandcamp', 'soundcloud'],
      source_labels: { bandcamp: 'Bandcamp', soundcloud: 'SoundCloud' },
    }
    await page.route('**/api/diagnostics', (route) => route.fulfill({ json: diagnostics(queue) }))
    await page.goto('/diagnostics')
    await expect(page.getByText('Bandcamp downloads')).toBeVisible()
    await expect(page.getByText('SoundCloud downloads')).toBeVisible()
    await expect(page.getByText('Paused after repeated blocking errors.')).toHaveCount(2)
    // YouTube is not paused, so its own line says nothing about a pause.
    await expect(
      page.locator('.readiness-item').filter({ hasText: 'YouTube download helper' }),
    ).not.toContainText('Paused')

    queue = {
      paused: false,
      source_paused: true,
      paused_sources: ['youtube'],
      source_labels: { youtube: 'YouTube' },
    }
    await page.reload()
    await expect(
      page.locator('.readiness-item').filter({ hasText: 'YouTube download helper' }),
    ).toContainText('Paused')
    await expect(page.getByText('Bandcamp downloads')).toHaveCount(0)
  })
})

test.describe('paused sources', () => {
  test('each paused site has its own line and its own resume button', async ({ page }) => {
    let paused = ['youtube', 'bandcamp']
    const resumed: string[] = []
    const controls = () => ({
      paused: false,
      source_paused: paused.includes('youtube'),
      paused_sources: paused,
      source_labels: { youtube: 'YouTube', bandcamp: 'Bandcamp' },
    })
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable in this fixture' } }),
    )

    await page.route('**/api/jobs*', (route) =>
      route.fulfill({
        json: {
          jobs: [],
          controls: controls(),
          summary: { active: 0, failed: 0, failure_reasons: [] },
        },
      }),
    )

    await page.route('**/api/queue/resume-source*', (route) => {
      const source = new URL(route.request().url()).searchParams.get('source') ?? ''
      resumed.push(source)
      paused = paused.filter((name) => name !== source)
      return route.fulfill({ json: { controls: controls(), errors: [] } })
    })

    await page.goto('/downloads')
    const youtube = page
      .getByRole('alert')
      .filter({ hasText: 'YouTube paused after repeated blocking errors.' })
    const bandcamp = page
      .getByRole('alert')
      .filter({ hasText: 'Bandcamp paused after repeated blocking errors.' })
    await expect(youtube).toBeVisible()
    await expect(bandcamp).toBeVisible()

    await bandcamp.getByRole('button', { name: 'Try Bandcamp again' }).click()
    await expect(bandcamp).toHaveCount(0)
    // Resuming one site leaves the other's line alone.
    await expect(youtube).toBeVisible()
    expect(resumed).toEqual(['bandcamp'])

    await youtube.getByRole('button', { name: 'Try YouTube again' }).click()
    await expect(youtube).toHaveCount(0)
    expect(resumed).toEqual(['bandcamp', 'youtube'])
  })

  test('a server that sends only the YouTube flag still gets its line', async ({ page }) => {
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable in this fixture' } }),
    )

    await page.route('**/api/jobs*', (route) =>
      route.fulfill({
        json: {
          jobs: [],
          controls: { paused: false, source_paused: true },
          summary: { active: 0, failed: 0, failure_reasons: [] },
        },
      }),
    )
    await page.goto('/downloads')
    await expect(page.getByRole('button', { name: 'Try YouTube again' })).toBeVisible()
  })
})
