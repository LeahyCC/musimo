import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { MusicResult } from '../src/api'
import { ORIGIN } from './env'

// Invented catalog records. Settings, queue, diagnostics and events use the real API.
const track: MusicResult = {
  id: 101,
  kind: 'track',
  title: 'Test recording',
  artist: 'Fixture artist',
  artist_id: 7,
  album: 'Fixture album',
  album_id: 42,
  art: '',
  duration: 180,
  year: 2020,
  explicit: false,
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

async function catalogFixtures(page: Page) {
  await page.route('**/api/search?*', async (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    const items = kind === 'track' ? [track] : kind === 'album' ? [album] : []
    await route.fulfill({ json: { items, total: items.length, next_index: null, cached: false } })
  })
  await page.route('**/api/album-years?*', (route) => route.fulfill({ json: { '42': 2020 } }))
  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: { album, tracks: [track], label: 'Fixture label', duration: 180, complete: true },
    }),
  )
}

test.beforeEach(async ({ page }) => {
  // A provider outage or remote asset must never determine a browser test result.
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) {
      await route.abort()
    } else {
      await route.fallback()
    }
  })
  await catalogFixtures(page)
})

test('keyboard search, tab and sort survive navigation and refresh', async ({ page }) => {
  await page.goto('/search')
  await expect(page.getByRole('status').filter({ hasText: /^Live$/ })).toBeVisible()
  await page.keyboard.press('/')
  const search = page.getByRole('textbox', { name: 'Search music or paste a link' })
  await expect(search).toBeFocused()
  await search.fill('Fixture')
  await search.press('Enter')
  await page.getByRole('button', { name: 'Tracks', exact: true }).click()
  await expect(page.getByText('Test recording', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('title')
  await page.reload()
  await expect(search).toHaveValue('Fixture')
  await expect(page.getByRole('button', { name: 'Tracks', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('title')
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Settings' })
    .click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.goBack()
  await expect(search).toHaveValue('Fixture')
  await expect(page.getByText('Test recording', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('popularity keeps an exact artist name ahead of larger fuzzy matches', async ({ page }) => {
  const exact: MusicResult = {
    ...album,
    id: 11270,
    kind: 'artist',
    title: 'Tipper',
    artist: 'Tipper',
    artist_id: 11270,
    popularity: 4248,
  }
  const larger: MusicResult = {
    ...exact,
    id: 7004075,
    title: 'Bryson Tiller',
    artist: 'Bryson Tiller',
    artist_id: 7004075,
    popularity: 994430,
  }
  await page.route('**/api/search?*', (route) =>
    route.fulfill({
      json: { items: [larger, exact], total: 2, next_index: null, cached: false },
    }),
  )
  await page.goto('/search?q=tipper&tab=artist&sort=popularity')
  await expect(page.getByRole('article').first()).toContainText('Tipper')
})

test('catalog failure offers retry and recovers', async ({ page }) => {
  await page.route(
    '**/api/search?*',
    (route) =>
      route.fulfill({
        status: 503,
        json: { detail: 'Catalog temporarily unavailable' },
      }),
    { times: 1 },
  )
  await page.goto('/search?q=Fixture&tab=track')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Catalog temporarily unavailable')
  await alert.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Test recording', { exact: true })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test('saved settings survive reload and update a second browser tab through SSE', async ({
  page,
  context,
}) => {
  await page.goto('/settings')
  const peer = await context.newPage()
  await peer.goto('/settings')
  await expect(peer.getByRole('status').filter({ hasText: /^Live$/ })).toBeVisible()
  const label = `E2E library ${Date.now()}`
  await page.getByRole('textbox', { name: 'Library label' }).fill(label)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved. You can safely refresh.')).toBeVisible()
  await expect(peer.getByRole('textbox', { name: 'Library label' })).toHaveValue(label)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Library label' })).toHaveValue(label)
  await peer.close()
})

test('a failed save keeps the draft and allows a successful retry', async ({ page }) => {
  let fail = true
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PATCH' && fail) {
      fail = false
      await route.fulfill({ status: 503, json: { detail: 'Temporary write failure' } })
    } else {
      await route.fallback()
    }
  })
  await page.goto('/settings')
  const label = `Recovered ${Date.now()}`
  await page.getByRole('textbox', { name: 'Library label' }).fill(label)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Temporary write failure')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Library label' })).toHaveValue(label)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved. You can safely refresh.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Library label' })).toHaveValue(label)
})

test('queue pause and resume persist through refresh', async ({ page, request }) => {
  expect((await request.post('/api/queue/resume')).ok()).toBe(true)
  await page.goto('/downloads')
  await page.getByRole('button', { name: 'Pause all', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume all', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Resume all', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause all', exact: true })).toBeVisible()
})

test('activity clear persists and diagnostics export is valid JSON', async ({ page, request }) => {
  const changed = await request.patch('/api/settings', {
    data: { library_label: `Activity ${Date.now()}` },
  })
  expect(changed.ok()).toBe(true)
  await page.goto('/diagnostics')
  await expect(page.getByRole('heading', { name: 'Musimo is ready.' })).toBeVisible()
  const activity = page.getByRole('region', { name: 'Recent activity entries' })
  await expect(activity).toBeVisible()
  expect((await activity.boundingBox())?.height).toBeLessThanOrEqual(320)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(page.getByText('No recent activity. New events will appear here.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('No recent activity. New events will appear here.')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Export', exact: true }).click()
  expect(await (await download).failure()).toBeNull()
  const exported = await request.get('/api/diagnostics/export')
  expect(exported.ok()).toBe(true)
  const data: unknown = await exported.json()
  expect(data).toMatchObject({ database: { mode: 'wal' }, health: { status: 'ok' } })
})

test('album download skips owned tracks and recovers from failure', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/batches', async (route) => {
    const body: unknown = route.request().postDataJSON()
    expect(body).toMatchObject({ album_id: 42, missing_only: true })
    attempts += 1
    await route.fulfill(
      attempts === 1
        ? { status: 503, json: { detail: 'Queue temporarily unavailable' } }
        : { json: { id: 'fixture', jobs: [], skipped: 1 } },
    )
  })
  await page.goto('/search?q=Fixture&tab=album')
  await page.getByRole('article').hover()
  await page.getByRole('button', { name: 'Download missing tracks from Fixture album' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Queue temporarily unavailable')
  await alert.getByRole('button', { name: 'Retry' }).click()
  await page.getByText('Nothing missing · 1 skipped').click()
  await expect(page.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible()
  expect(attempts).toBe(2)
})

test('preview playback, volume and navigation remain usable', async ({ page }) => {
  await page.route('**/api/preview/101?*', (route) =>
    route.fulfill({
      json: { url: '/assets/e2e-silence.wav', source: 'Generated' },
    }),
  )

  await page.goto('/search?q=Fixture&tab=track')
  await page.getByRole('button', { name: 'Find preview Test recording' }).click()
  const player = page.getByRole('contentinfo')
  const audio = player.locator('audio')
  await expect(player.getByRole('slider', { name: 'Preview position' })).toBeEnabled()
  await expect(player.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible()
  await player.getByRole('button', { name: 'Pause preview', exact: true }).click()
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  const volume = player.getByRole('slider', { name: 'Preview volume' })
  await volume.focus()
  await volume.press('Home')
  await volume.press('ArrowRight')
  await expect(volume).toHaveValue('0.01')
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.volume))
    .toBeCloseTo(0.01)
  await player.getByRole('button', { name: 'Mute preview', exact: true }).click()
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.muted)).toBe(true)
  await player.getByRole('button', { name: 'Unmute preview', exact: true }).click()
  const position = player.getByRole('slider', { name: 'Preview position' })
  await position.focus()
  await position.press('ArrowRight')
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0)
  await player.getByRole('link', { name: 'Test recording', exact: true }).click()
  await expect(page).toHaveURL(/\/albums\/42\?track=101/)
  await expect(player.getByRole('link', { name: 'Test recording', exact: true })).toBeVisible()
  await expect(volume).toHaveValue('0.01')
  await player.getByRole('button', { name: 'Restart preview' }).click()
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false)
  await player.getByRole('button', { name: 'Close preview' }).click()
  await expect(audio).not.toHaveAttribute('src')
  await expect(player.getByRole('button', { name: 'Play preview', exact: true })).toBeDisabled()
  await page.reload()
  await expect(volume).toHaveValue('0.01')
})

test('artist review counts selections, excludes failed albums and retries submission', async ({
  page,
}) => {
  const ep: MusicResult = {
    ...album,
    id: 43,
    album_id: 43,
    title: 'Fixture EP',
    album: 'Fixture EP',
    year: 2022,
    record_type: 'ep',
  }
  const single: MusicResult = {
    ...album,
    id: 44,
    album_id: 44,
    title: 'Fixture single',
    album: 'Fixture single',
    year: 2023,
    record_type: 'single',
  }

  await page.route(/\/api\/artists\/7(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        artist: { id: 7, name: 'Fixture artist', art: '' },
        items: [album, ep, single],
        next_index: null,
      },
    }),
  )

  await page.route('**/api/artists/7/top', (route) =>
    route.fulfill({
      json: {
        tracks: [
          {
            ...track,
            id: 103,
            title: 'Guest appearance',
            artist: 'Another artist',
            artist_id: 8,
            album: 'Another artist album',
            album_id: 99,
            popularity: 110,
          },
          { ...track, title: 'Most popular song', popularity: 100 },
          { ...track, id: 102, title: 'Second popular song', popularity: 90 },
        ],
      },
    }),
  )
  const foreignAlbum: MusicResult = {
    ...album,
    id: 99,
    album_id: 99,
    title: 'Another artist album',
    album: 'Another artist album',
    artist: 'Another artist',
    artist_id: 8,
  }
  await page.route('**/api/albums/99*', (route) =>
    route.fulfill({
      json: {
        album: foreignAlbum,
        tracks: [],
        label: 'Fixture label',
        duration: 180,
        complete: true,
      },
    }),
  )

  await page.route('**/api/artists/7/download-plan*', (route) => {
    const allMusic = new URL(route.request().url()).searchParams.get('all_music') === 'true'
    return route.fulfill({
      json: {
        albums: [
          {
            id: 42,
            title: 'Fixture album',
            art: '',
            year: '2020',
            error: '',
            tracks: [
              { id: 101, duration: 180, owned: true, identity: 'isrc:one' },
              { id: 102, duration: 180, owned: false, identity: 'isrc:two' },
            ],
          },
          {
            id: 43,
            title: 'Second album',
            art: '',
            year: '2021',
            error: '',
            tracks: [{ id: 103, duration: 180, owned: false, identity: 'isrc:three' }],
          },
          {
            id: 44,
            title: 'Unavailable album',
            art: '',
            year: '2022',
            error: 'Lookup failed',
            tracks: [],
          },
          ...(allMusic
            ? [
                {
                  id: 45,
                  title: 'Fixture single',
                  art: '',
                  year: '2022',
                  error: '',
                  tracks: [{ id: 104, duration: 180, owned: false, identity: 'isrc:four' }],
                },
              ]
            : []),
        ],
      },
    })
  })
  let attempts = 0
  await page.route('**/api/artist-batches', async (route) => {
    const body: unknown = route.request().postDataJSON()
    expect(body).toEqual({
      artist_id: 7,
      album_ids: [42, 43],
      all_music: false,
      missing_only: true,
      format: 'mp3',
      target: '/music',
    })
    attempts += 1
    await route.fulfill(
      attempts === 1
        ? { status: 503, json: { detail: 'Queue unavailable; try again' } }
        : {
            json: {
              id: 'artist-fixture',
              jobs: [],
              albums: 0,
              skipped_owned: 1,
              skipped_queued: 2,
            },
          },
    )
  })
  await page.goto('/artists/7')
  await expect(page.locator('main section > .section-heading h2')).toHaveText([
    'Popular songs',
    'Popular albums',
    'Discography',
  ])
  await expect(page.getByText('Most popular song', { exact: true })).toBeVisible()
  const popularAlbums = page.getByRole('region', { name: 'Popular albums' })
  await expect(popularAlbums.getByRole('article')).toHaveCount(1)
  await expect(popularAlbums).not.toContainText('Another artist album')
  const discography = page.getByRole('region', { name: 'Discography' })
  await expect(discography.getByRole('article')).toHaveCount(2)
  await expect(discography.getByRole('article').first()).toContainText('Fixture EP')
  await discography.getByRole('combobox', { name: 'Show' }).selectOption('album')
  await expect(page).toHaveURL(/type=album/)
  await expect(discography.getByRole('article')).toHaveCount(1)
  await discography.getByRole('combobox', { name: 'Sort' }).selectOption('title-desc')
  await expect(page).toHaveURL(/sort=title-desc/)
  await page.reload()
  await expect(discography.getByRole('combobox', { name: 'Show' })).toHaveValue('album')
  await expect(discography.getByRole('combobox', { name: 'Sort' })).toHaveValue('title-desc')
  await page.getByRole('button', { name: 'Download all music' }).click()
  const musicDialog = page.getByRole('dialog', { name: 'Choose music to download' })
  await expect(musicDialog.getByText('3 releases · 3 songs', { exact: true })).toBeVisible()
  await expect(musicDialog.getByRole('checkbox', { name: /Fixture single/ })).toBeChecked()
  await musicDialog.getByRole('button', { name: 'Close download selection' }).click()
  await page.getByRole('button', { name: 'Download all albums' }).click()
  const dialog = page.getByRole('dialog', { name: 'Choose albums to download' })
  await expect(dialog.getByText('2 albums · 2 songs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /Unavailable album/ })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /Second album/ }).uncheck()
  await expect(dialog.getByText('1 albums · 1 songs', { exact: true })).toBeVisible()
  await dialog.getByRole('checkbox', { name: 'Skip songs already in my library' }).uncheck()
  await expect(dialog.getByText('1 albums · 2 songs', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Select none' }).click()
  await expect(dialog.getByRole('button', { name: 'Download 0 albums (0 songs)' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Select all' }).click()
  await dialog.getByRole('checkbox', { name: 'Skip songs already in my library' }).check()
  await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('mp3')
  const confirm = dialog.getByRole('button', { name: 'Download 2 albums (2 songs)' })
  await confirm.click()
  await expect(dialog.getByRole('alert')).toContainText('Queue unavailable; try again')
  await confirm.click()
  await dialog.getByRole('link', { name: 'Open downloads' }).click()
  await expect(page.getByRole('heading', { name: 'Downloads', exact: true })).toBeVisible()
  await expect(dialog).not.toBeVisible()
  expect(attempts).toBe(2)
})

test('track link focuses highlighted row and back to results restores search', async ({ page }) => {
  await page.goto('/search')
  const search = page.getByRole('textbox', { name: 'Search music or paste a link' })
  await search.fill('Fixture')
  await search.press('Enter')
  await page.getByRole('button', { name: 'Tracks', exact: true }).click()
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('title')
  await page.getByText('Test recording', { exact: true }).click()
  await expect(page).toHaveURL(/\/albums\/42/)
  const backButton = page.getByRole('button', { name: 'Back to results' })
  await expect(backButton).toBeVisible()
  await backButton.click()
  await expect(page).toHaveURL(/\/search\?.*q=Fixture/)
  await expect(search).toHaveValue('Fixture')
  await expect(page.getByRole('button', { name: 'Tracks', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('title')
})

test('preview link focuses track row with aria-current', async ({ page }) => {
  const trackWithPreview: MusicResult = {
    ...track,
    id: 105,
    title: 'Track with preview',
    preview: `${ORIGIN}/generated/test-recording.wav`,
  }
  const manyTracks = [
    trackWithPreview,
    ...Array.from({ length: 20 }, (_, i) => ({
      ...track,
      id: 200 + i,
      title: `Track ${i + 1}`,
    })),
  ]
  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: {
        album,
        tracks: manyTracks,
        label: 'Fixture label',
        duration: 180 * manyTracks.length,
        complete: true,
      },
    }),
  )
  await page.goto('/albums/42')
  await page.getByRole('button', { name: 'Preview Track with preview' }).click()
  const player = page.locator('footer.live-player')
  await expect(player.getByRole('link', { name: 'Track with preview', exact: true })).toBeVisible()
  await player.getByRole('link', { name: 'Track with preview', exact: true }).click()
  await expect(page).toHaveURL(/\/albums\/42\?track=105/)
  const selectedRow = page.locator('.track-row[aria-current="true"]')
  await expect(selectedRow).toBeVisible()
  await expect(selectedRow).toBeFocused()
  await expect(selectedRow).toContainText('Track with preview')
})

test('no preview state shows disabled button and label', async ({ page }) => {
  const trackNoPreview: MusicResult = { ...track, id: 106, title: 'No preview track', preview: '' }
  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: {
        album,
        tracks: [trackNoPreview],
        label: 'Fixture label',
        duration: 180,
        complete: true,
      },
    }),
  )

  await page.route('**/api/preview/106*', (route) =>
    route.fulfill({ json: { url: null, source: null } }),
  )
  await page.goto('/albums/42')
  await page.getByRole('button', { name: 'Find preview No preview track' }).click()
  const player = page.locator('footer.live-player')
  await expect(player.getByText('No preview available for this track.')).toBeVisible()
  const artButton = page.getByRole('button', { name: 'No preview No preview track' })
  await expect(artButton).toBeDisabled()
  const noPreviewButton = page.getByRole('button', { name: 'No preview', exact: true })
  if (await noPreviewButton.isVisible({ timeout: 100 }).catch(() => false)) {
    await expect(noPreviewButton).toBeDisabled()
    await expect(noPreviewButton).toHaveAttribute('title', 'No preview available')
  }
})
