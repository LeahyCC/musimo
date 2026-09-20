import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import type { DownloadJob, MusicResult } from '../src/api'
import { COLOR_TOKENS } from '../src/theme/tokens'
import { librarySong, ORIGIN, playerFixtures } from './library-fixtures'

// Phone-width layout checks. Everything here runs on the mobile project only; the same
// screens at desktop width are covered by the specs for each screen.
test.skip(({ isMobile }) => !isMobile, 'Phone layout only.')

const track: MusicResult = {
  id: 101,
  kind: 'track',
  title: 'Recording 1',
  artist: 'Fixture artist',
  artist_id: 7,
  album: 'Fixture album',
  album_id: 42,
  art: '',
  duration: 180,
  year: 2020,
  explicit: true,
  preview: '',
  isrc: '',
  popularity: 1,
  track_count: 1,
  record_type: 'album',
  ownership: 'missing',
  matched_paths: [],
  matched_by: '',
  matched_album: '',
  owned_count: 0,
  coverage_verified: true,
  disc: 1,
  position: 1,
}
const album: MusicResult = { ...track, id: 42, kind: 'album', title: 'Fixture album' }
const activeJob: DownloadJob = {
  id: 'active-job',
  batch_id: '',
  batch_label: '',
  album_id: 42,
  catalog: 'deezer',
  source: 'youtube',
  track_id: 101,
  format: 'original',
  target: '/music',
  stage: 'downloading',
  desired: 'run',
  meta: {
    id: 101,
    title: 'Recording 1',
    artist: 'Fixture artist',
    album: 'Fixture album',
    art: '',
    duration: 180,
  },
  candidates: [],
  selected: '',
  check_match: false,
  attempts: 1,
  retry_at: 0,
  progress: 0.4,
  downloaded: 2_000_000,
  total: 5_000_000,
  speed: 350_000,
  eta: 9,
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
}
const queue = (jobs: DownloadJob[]) => ({
  jobs,
  controls: { paused: false, source_paused: false },
  summary: { active: jobs.length, failed: 0, failure_reasons: [] },
})

async function catalogFixtures(page: Page, jobs: DownloadJob[] = []) {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })

  await page.route('**/api/snapshot', async (route) => {
    const live = await route.fetch()
    const body: unknown = await live.json()
    const snapshot = body !== null && typeof body === 'object' ? { ...(body as object) } : {}
    await route.fulfill({ json: { ...snapshot, ...queue(jobs) } })
  })

  await page.route('**/api/jobs', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: queue(jobs) }) : route.fallback(),
  )

  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: {
        album,
        tracks: [track, { ...track, id: 102, title: 'Recording 2', explicit: false }],
        label: 'Fixture label',
        duration: 360,
        complete: true,
      },
    }),
  )

  await page.route(/\/api\/artists\/7(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        artist: { id: 7, name: 'Fixture artist', art: '' },
        items: [album],
        total: 1,
        next_index: null,
      },
    }),
  )
  await page.route('**/api/artists/7/top', (route) => route.fulfill({ json: { tracks: [] } }))
  await page.route('**/api/artists/7/download-plan*', (route) =>
    route.fulfill({
      json: {
        albums: [
          {
            id: 42,
            title: 'Fixture album',
            art: '',
            year: '2020',
            error: '',
            tracks: [{ id: 101, duration: 180, owned: false, identity: 'a' }],
          },
        ],
      },
    }),
  )
}

async function libraryFixtures(page: Page) {
  await playerFixtures(page)
  const songs = [librarySong('s1', { title: 'Beacon' }), librarySong('s2', { title: 'Anchor' })]
  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({ json: { items: [], next_offset: null, total: 0 } }),
  )

  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({
      json: { id: 'album-1', name: 'Clear Water', artist: 'Harbor Static', song: songs },
    }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/playlists',
    (route) => route.fulfill({ json: { items: [], liked_id: 'liked' } }),
  )

  await page.route('**/api/library/playlists/liked', (route) =>
    route.fulfill({ json: { id: 'liked', name: 'Liked', entry: [] } }),
  )
  await page.route('**/api/player/lyrics/*', (route) => route.fulfill({ json: { items: [] } }))
}

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('Element has no box')
  return rect
}

const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/* Every control on screen that a thumb would miss or that iOS Safari would zoom into. A text
   control under 16px triggers the zoom; a tap target under 44px is the WCAG floor. */
const undersized = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('input, select, textarea')) {
      if (['checkbox', 'radio', 'range'].includes((el as HTMLInputElement).type)) continue
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const size = parseFloat(getComputedStyle(el).fontSize)
      if (size < 16) out.push(`${el.tagName} ${el.getAttribute('aria-label') ?? ''} ${size}px`)
    }

    for (const el of document.querySelectorAll<HTMLElement>(
      "[data-ui='icon-button'], [data-ui='button'], [data-ui='text-link'], [data-ui='tab']",
    )) {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (rect.height < 44 || rect.width < 44)
        out.push(
          `${el.dataset.ui ?? el.className} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        )
    }

    return out
  })

test('the library and download tabs each fit one row at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await libraryFixtures(page)
  await page.goto('/library')
  const tabs = page.getByRole('navigation', { name: 'Library views' }).getByRole('button')
  await expect(tabs).toHaveCount(5)
  const rows = new Set<number>()
  for (const tab of await tabs.all()) {
    const rect = await box(tab)
    rows.add(Math.round(rect.y))
    expect(rect.x + rect.width).toBeLessThanOrEqual(360)
    expect(rect.height).toBeGreaterThanOrEqual(44)
  }
  expect(rows.size).toBe(1)
  expect(await pageOverflow(page)).toBe(0)

  await catalogFixtures(page, [activeJob])
  await page.goto('/downloads')
  const downloadTabs = page.locator('.download-tabs').getByRole('button')
  await expect(downloadTabs).toHaveCount(4)
  const tabRows = new Set<number>()
  for (const tab of await downloadTabs.all()) {
    const rect = await box(tab)
    tabRows.add(Math.round(rect.y))
    expect(rect.x + rect.width).toBeLessThanOrEqual(360)
  }
  expect(tabRows.size).toBe(1)
  expect(await pageOverflow(page)).toBe(0)
})

const longAlbum = {
  id: 'album-1',
  name: 'An Unreasonably Long Album Title That Keeps Going Well Past Any Sensible Width (Deluxe Remastered Anniversary Edition)',
  artist: 'Harbor Static',
  artistId: 'artist-1',
  coverArt: 'cover-1',
  year: 2018,
  songCount: 2,
  duration: 428,
  genre: 'Ambient',
  song: [librarySong('s1', { title: 'Beacon' }), librarySong('s2', { title: 'Anchor' })],
}

test('a library detail header puts the cover beside the text, actions below, and clamps a long title', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await libraryFixtures(page)
  await page.route('**/api/library/albums/album-1', (route) => route.fulfill({ json: longAlbum }))
  await page.goto('/library/albums/album-1')

  const header = page.locator('.collection-header')
  const title = header.getByRole('heading', { level: 1 })
  await expect(title).toContainText('An Unreasonably')
  await expect(header).toContainText('ALBUM · 2018')
  await expect(header.getByRole('link', { name: 'Harbor Static' })).toBeVisible()
  const cover = await box(header.locator('.collection-cover'))
  const text = await box(title)
  const meta = await box(header.locator('.library-count'))
  const playAll = await box(header.getByRole('button', { name: 'Play all' }))
  // A small cover, with the title to its right and starting inside the cover's height.
  expect(cover.width).toBeGreaterThanOrEqual(96)
  expect(cover.width).toBeLessThanOrEqual(112)
  expect(text.x).toBeGreaterThanOrEqual(cover.x + cover.width)
  expect(text.y).toBeLessThan(cover.y + cover.height)
  // The actions get a row of their own under both, on the cover's left edge.
  expect(playAll.y).toBeGreaterThanOrEqual(cover.y + cover.height)
  expect(playAll.y).toBeGreaterThanOrEqual(meta.y + meta.height)
  expect(Math.abs(playAll.x - cover.x)).toBeLessThan(2)
  // Two lines at most, so a long title never pushes the actions off the first screen.
  const lines = await title
    .locator('span')
    .evaluate((element) => getComputedStyle(element).webkitLineClamp)
  expect(lines).toBe('2')
  expect(await pageOverflow(page)).toBe(0)
})

test('the first track of a library album is on the first screen with a player loaded', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await libraryFixtures(page)
  await page.route('**/api/library/albums/album-1', (route) => route.fulfill({ json: longAlbum }))
  await page.goto('/library/albums/album-1')
  await page.getByRole('button', { name: 'Play all' }).click()
  const player = page.getByRole('contentinfo')
  await expect(player).toContainText('Beacon')

  const firstRow = await box(page.locator('.library-track-row').first())
  // Not under the mini player either: the row's whole height clears its top edge.
  expect(firstRow.y).toBeLessThan(844)
  expect(firstRow.y + firstRow.height).toBeLessThanOrEqual((await box(player)).y)
})

const libraryAlbums = Array.from({ length: 12 }, (_, index) => ({
  id: `album-${index + 1}`,
  name: `Album ${index + 1}`,
  artist: 'Harbor Static',
  songCount: 8,
  year: 2000 + index,
  playCount: index,
  coverArt: 'cover-1',
}))

test('the library shows its first album in the top half and keeps its controls in a Filter sheet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({
      json: {
        items: libraryAlbums,
        next_offset: null,
        total: libraryAlbums.length,
        genres: ['Ambient', 'Jazz'],
        years: [2011, 2000],
      },
    }),
  )
  await page.goto('/library')
  const firstCard = page.locator('.library-card').first()
  await expect(firstCard).toBeVisible()
  expect((await box(firstCard)).y).toBeLessThan(844 * 0.45)

  // One row: the search field and a single Filter button. Sort, genre, years and the view toggle
  // are not on the page until the sheet opens.
  const search = await box(page.getByLabel('Search albums'))
  const filter = page.getByRole('button', { name: 'Filter', exact: true })
  const filterBox = await box(filter)
  expect(
    Math.abs(search.y + search.height / 2 - (filterBox.y + filterBox.height / 2)),
  ).toBeLessThan(8)
  expect(filterBox.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByLabel('Sort home')).toBeHidden()
  await expect(page.getByText('All genres', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'List view' })).toBeHidden()
  // The count reads under the list rather than in a toolbar.
  await expect(page.getByText('12 of 12 loaded')).toBeVisible()

  await filter.click()
  const sheet = page.getByRole('dialog', { name: 'Filter albums' })
  await expect(sheet.getByLabel('Sort home')).toBeVisible()
  await expect(sheet.getByText('All years', { exact: true })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Grid view' })).toBeVisible()
  await sheet.getByText('All genres', { exact: true }).click()
  await sheet.getByLabel('Jazz').check()
  // The sheet sits on the screen's edges and nothing in it is a small tap or a zoom trigger.
  expect(await undersized(page)).toEqual([])
  expect(await pageOverflow(page)).toBe(0)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()
  // The button now says a filter is on.
  await expect(page.getByRole('button', { name: 'Filter (1)', exact: true })).toBeVisible()

  await page.setViewportSize({ width: 360, height: 780 })
  expect(await pageOverflow(page)).toBe(0)
  expect(await undersized(page)).toEqual([])
})

test('search results start in the top half with Filters and Sort on one compact row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await catalogFixtures(page)
  await page.route('**/api/search?*', async (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    const items =
      kind === 'track'
        ? [1, 2, 3].map((id) => ({ ...track, id: 100 + id, title: `Recording ${id}` }))
        : kind === 'album'
          ? [album]
          : []
    await route.fulfill({ json: { items, total: items.length, next_index: null, cached: false } })
  })
  await page.goto('/search?q=Fixture')
  const firstRow = page.locator('.track-row').first()
  await expect(firstRow).toBeVisible()
  expect((await box(firstRow)).y).toBeLessThan(844 * 0.5)

  // No eyebrow, and the heading is the small size, so it does not crowd the results.
  await expect(page.getByText('DISCOVER YOUR NEXT FAVOURITE')).toBeHidden()
  const heading = page.getByRole('heading', { level: 1, name: /Results for/ })
  const headingSize = await heading.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize),
  )
  expect(headingSize).toBeLessThanOrEqual(20)

  // Filters and Sort share one row under the tabs.
  const filters = await box(page.getByRole('button', { name: 'Filters', exact: true }))
  const sort = await box(page.getByRole('combobox', { name: 'Sort' }))
  const tabs = await box(page.getByRole('button', { name: 'Tracks', exact: true }))
  expect(Math.abs(filters.y - sort.y)).toBeLessThan(8)
  expect(filters.y).toBeGreaterThanOrEqual(tabs.y + tabs.height)
  // The hint is help inside the Filters panel now, not a line on the page.
  await expect(page.getByText(/Filters and sort apply to loaded results/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await expect(page.getByText(/Filters and sort apply to loaded results/)).toBeVisible()

  await page.setViewportSize({ width: 360, height: 780 })
  expect(await pageOverflow(page)).toBe(0)
  expect(await undersized(page)).toEqual([])
})

test('the mini player is one row and hands the rest to Now Playing', async ({ page }) => {
  await libraryFixtures(page)
  await page.goto('/library/albums/album-1')
  const player = page.getByRole('contentinfo')
  await expect(player).toBeHidden()
  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(player).toContainText('Beacon')
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('No viewport')
  const nav = await box(page.locator('.sidebar'))
  const rect = await box(player)
  expect(rect.height).toBeLessThan(90)
  expect(rect.y + rect.height).toBeCloseTo(nav.y, 0)
  for (const name of ['Volume', 'Shuffle', 'Repeat off', 'Previous track']) {
    await expect(player.getByRole(name === 'Volume' ? 'slider' : 'button', { name })).toBeHidden()
  }
  await expect(player.getByRole('button', { name: 'Next track' })).toBeVisible()
  await expect(player.getByRole('button', { name: 'Close player' })).toBeVisible()
  const seek = player.getByRole('slider', { name: 'Playback position' })
  await expect(seek).toBeEnabled()
  await seek.focus()
  await seek.press('ArrowRight')
  await expect
    .poll(() =>
      player
        .locator('audio.library-audio[data-role="active"]')
        .evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0)
  // The seek bar runs along the player's top edge rather than taking a row of its own.
  const seekRect = await box(seek)
  expect(seekRect.width).toBeGreaterThan(viewport.width - 40)
  expect(seekRect.y).toBeLessThanOrEqual(rect.y)
  // Content is padded past the player and bottom bar, so the last row is never under them.
  const padding = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('main')!).paddingBottom),
  )
  expect(padding).toBeGreaterThanOrEqual(rect.height + nav.height)

  await player.getByRole('link', { name: 'Beacon' }).click()
  await expect(page.getByRole('heading', { name: 'Beacon' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Shuffle' })).toBeVisible()
  // The page repeats the mini player's title, play, next, close and seek bar, so the player
  // steps aside.
  await expect(player).toBeHidden()
  await expect(page.getByRole('button', { name: 'Close player' })).toBeVisible()
  await page.getByRole('button', { name: 'Add to playlist' }).click()
  await expect(page.getByRole('dialog', { name: 'Add track to playlist' })).toBeVisible()
})

test('the save bar and the active count both clear the bottom bar', async ({ page }) => {
  await catalogFixtures(page, [activeJob])
  await page.goto('/settings')
  await page.getByLabel('Library label').fill('Changed')
  const saveBar = page.locator('.save-bar')
  await saveBar.scrollIntoViewIfNeeded()
  const nav = await box(page.locator('.sidebar'))
  const bar = await box(saveBar)
  expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y)
  const button = await box(page.getByRole('button', { name: 'Save changes' }))
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? '',
      { x: button.x + button.width / 2, y: button.y + button.height / 2 },
    ),
  ).toContain('Save changes')
  await expect(page.getByRole('button', { name: /Open queue/ })).toBeHidden()
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Downloads' }),
  ).toContainText('1')
})

test('touch controls are 44px and no text control is small enough to zoom', async ({ page }) => {
  await catalogFixtures(page)
  await page.goto('/albums/42')
  await expect(page.getByText('Recording 1', { exact: true })).toBeVisible()
  // The format choice has moved into the options popover; the row keeps its two buttons.
  await expect(page.getByRole('combobox', { name: 'Format for Recording 1' })).toBeHidden()
  await page.getByRole('button', { name: 'Download options for Recording 1', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Download options for Recording 1', exact: true })
  await expect(panel.getByRole('combobox', { name: 'Format', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  // The explicit badge stays visible beside a truncated title.
  await expect(page.locator('.track-row').first().locator('.explicit')).toBeInViewport()

  expect(await undersized(page)).toEqual([])
})

test('Your settings is one column and stays inside a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto('/settings/user')
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  expect(await undersized(page)).toEqual([])
  expect(await pageOverflow(page)).toBe(0)

  await page
    .getByRole('button', { name: /^Duplicate and edit/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Readability' })).toBeVisible()
  expect(await undersized(page)).toEqual([])
  expect(await pageOverflow(page)).toBe(0)

  // One column: every color swatch starts at the same left edge.
  const swatches = page.locator("input[type='color']")
  await expect(swatches).toHaveCount(COLOR_TOKENS.length)
  const lefts = new Set<number>()
  for (const swatch of await swatches.all()) lefts.add(Math.round((await box(swatch)).x))
  expect(lefts.size).toBe(1)

  // Save rides in a sticky bar, so it is on screen and clear of the bottom bar wherever the page
  // is scrolled: at the top, and at the very end.
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const nav = await box(page.locator('.sidebar'))
  for (const y of [0, 100_000]) {
    await page.evaluate((top: number) => window.scrollTo(0, top), y)
    await expect
      .poll(async () => (await box(save)).y + (await box(save)).height)
      .toBeLessThanOrEqual(nav.y)
    expect((await box(save)).y).toBeGreaterThanOrEqual(0)
  }

  // Picking a theme is the main control on the page, so its row is a full touch target.
  await page.getByRole('button', { name: 'Cancel' }).click()
  for (const label of await page.locator('label:has(input[type=radio])').all()) {
    expect((await box(label)).height).toBeGreaterThanOrEqual(44)
  }
})

test('the artist download selection is a bottom sheet', async ({ page }) => {
  await catalogFixtures(page)
  await page.goto('/artists/7')
  await page.getByRole('button', { name: 'Download all albums' }).click()
  const sheet = page.getByRole('dialog', { name: 'Choose albums to download' })
  await expect(sheet.getByRole('button', { name: 'Download 1 album (1 song)' })).toBeVisible()
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('No viewport')
  const rect = await box(sheet)
  expect(rect.x).toBe(0)
  expect(rect.width).toBe(viewport.width)
  expect(rect.y + rect.height).toBeCloseTo(viewport.height, 0)
  expect(await pageOverflow(page)).toBe(0)
})
