import { expect, test } from '@playwright/test'

import type { DownloadJob, MusicResult } from '../src/api'
import { emptyQueue } from './queue-fixtures'

test('card links and download controls work independently in a natural-height grid', async ({
  page,
  isMobile,
}) => {
  const albums: MusicResult[] = Array.from({ length: 13 }, (_, index) => ({
    id: 42 + index,
    kind: 'album',
    title: `Album ${index + 1}`,
    artist: 'Fixture artist',
    artist_id: 7,
    album: '',
    album_id: 42 + index,
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
  }))
  const queuedJob: DownloadJob = {
    id: 'queued-album-track',
    batch_id: 'fixture',
    batch_label: '',
    album_id: 42,
    track_id: 101,
    format: 'original',
    target: '/music',
    stage: 'queued',
    desired: 'run',
    meta: {
      id: 101,
      title: 'Queued track',
      artist: 'Fixture artist',
      album: 'Album 1',
      art: '',
      duration: 180,
    },
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
    final_path: '',
    codec: '',
    actual_bitrate: 0,
    created_at: 1,
    updated_at: 1,
    hidden: false,
  }
  // This spec asserts an exact active-download count, so the queue cannot come from the
  // backend the whole run shares.
  await emptyQueue(page)
  await page.route('**/api/search?*', (route) =>
    route.fulfill({
      json: { items: albums, total: albums.length, next_index: null, cached: false },
    }),
  )

  await page.route('**/api/albums/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const album = albums.find((item) => item.id === id)
    return route.fulfill({ json: { album, tracks: [], label: '', duration: 180, complete: true } })
  })

  await page.route('**/api/artists/7*', (route) => {
    const top = new URL(route.request().url()).pathname.endsWith('/top')
    return route.fulfill(
      top
        ? { json: { tracks: [] } }
        : {
            json: {
              artist: { id: 7, name: 'Fixture artist', art: '' },
              items: [],
              next_index: null,
            },
          },
    )
  })

  await page.route('**/api/batches', (route) =>
    route.fulfill({
      json: { id: 'fixture', jobs: [queuedJob], skipped_owned: 0, skipped_queued: 0 },
    }),
  )
  await page.goto('/search?q=Fixture&tab=album')
  const cards = page.getByRole('article')
  await expect(cards).toHaveCount(13)
  await expect(page.locator('.virtual-list')).toHaveCount(0)
  const download = cards
    .first()
    .getByRole('button', { name: 'Download missing tracks from Album 1' })
  await expect(download).toHaveCSS('opacity', isMobile ? '1' : '0')
  await download.focus()
  await expect(download).toHaveCSS('opacity', '1')
  await expect(cards.first().getByText('to /music · Original source quality')).toBeVisible()
  await download.click()
  await expect(page).toHaveURL(/\/search\?/)
  await expect(cards.first().getByText('1 queued')).toBeVisible()
  await expect(cards.first().getByText('to /music · Original source quality')).toBeVisible()
  await cards.first().getByRole('link', { name: 'Fixture artist' }).click()
  await expect(page).toHaveURL(/\/artists\/7$/)
  await page.goBack()
  await expect(cards).toHaveCount(13)
  await expect(cards.first().getByText('1 queued')).toBeVisible()
  // A phone carries the count on the Downloads item in its bottom bar; wider layouts float a dock.
  const dock = page.getByRole('button', { name: 'Open queue, 1 active downloads' })
  if (isMobile) {
    await expect(dock).toBeHidden()
    await expect(
      page.getByRole('navigation', { name: 'Main navigation' }).locator('.nav-badge'),
    ).toHaveText(/^,?\s*1\s*active$/)
  } else {
    await expect(dock).toBeVisible()
  }
  await cards.first().click({ position: { x: 12, y: 60 } })
  await expect(page).toHaveURL(/\/albums\/42$/)
})

test('badge shows distinct states for owned, edition, queued, and downloaded', async ({ page }) => {
  const tracks: MusicResult[] = [
    {
      id: 1,
      kind: 'track',
      title: 'Owned Track',
      artist: 'Artist',
      artist_id: 1,
      album: 'Album',
      album_id: 1,
      art: '',
      duration: 200,
      year: 2020,
      explicit: false,
      preview: '',
      isrc: '',
      popularity: 1,
      track_count: 0,
      record_type: '',
      ownership: 'owned',
      matched_paths: ['/music/track1.flac'],
      matched_by: 'isrc',
      matched_album: '',
      owned_count: 0,
      coverage_verified: true,
      disc: 1,
      position: 1,
    },
    {
      id: 2,
      kind: 'track',
      title: 'Edition Track',
      artist: 'Artist',
      artist_id: 1,
      album: 'Album',
      album_id: 1,
      art: '',
      duration: 200,
      year: 2020,
      explicit: false,
      preview: '',
      isrc: '',
      popularity: 1,
      track_count: 0,
      record_type: '',
      ownership: 'edition',
      matched_paths: ['/music/track2.flac'],
      matched_by: 'tags',
      matched_album: 'Album Deluxe Edition',
      owned_count: 0,
      coverage_verified: true,
      disc: 1,
      position: 2,
    },
    {
      id: 3,
      kind: 'track',
      title: 'Queued Track',
      artist: 'Artist',
      artist_id: 1,
      album: 'Album',
      album_id: 1,
      art: '',
      duration: 200,
      year: 2020,
      explicit: false,
      preview: '',
      isrc: '',
      popularity: 1,
      track_count: 0,
      record_type: '',
      ownership: 'missing',
      matched_paths: [],
      matched_by: '',
      matched_album: '',
      owned_count: 0,
      coverage_verified: true,
      disc: 1,
      position: 3,
    },
    {
      id: 4,
      kind: 'track',
      title: 'Done Track',
      artist: 'Artist',
      artist_id: 1,
      album: 'Album',
      album_id: 1,
      art: '',
      duration: 200,
      year: 2020,
      explicit: false,
      preview: '',
      isrc: '',
      popularity: 1,
      track_count: 0,
      record_type: '',
      ownership: 'missing',
      matched_paths: [],
      matched_by: '',
      matched_album: '',
      owned_count: 0,
      coverage_verified: true,
      disc: 1,
      position: 4,
    },
  ]

  const jobs: DownloadJob[] = [
    {
      id: 'queued-job',
      batch_id: '',
      batch_label: '',
      album_id: 1,
      track_id: 3,
      format: 'original',
      target: '/music',
      stage: 'queued',
      desired: 'run',
      meta: {
        id: 3,
        title: 'Queued Track',
        artist: 'Artist',
        album: 'Album',
        art: '',
        duration: 200,
      },
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
      final_path: '',
      codec: '',
      actual_bitrate: 0,
      created_at: 1,
      updated_at: 1,
      hidden: false,
    },
    {
      id: 'done-job',
      batch_id: '',
      batch_label: '',
      album_id: 1,
      track_id: 4,
      format: 'original',
      target: '/music',
      stage: 'done',
      desired: 'run',
      meta: {
        id: 4,
        title: 'Done Track',
        artist: 'Artist',
        album: 'Album',
        art: '',
        duration: 200,
      },
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
      final_path: '/music/track4.flac',
      codec: '',
      actual_bitrate: 0,
      created_at: 1,
      updated_at: 1,
      hidden: false,
    },
  ]

  await page.route('**/api/search?*', (route) =>
    route.fulfill({
      json: { items: tracks, total: tracks.length, next_index: null, cached: false },
    }),
  )

  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      json: {
        jobs,
        controls: { paused: false, source_paused: false },
        summary: { active: 1, failed: 0, failure_reasons: [] },
      },
    }),
  )

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        settings: {},
        cursor: 0,
        jobs,
        controls: { paused: false, source_paused: false },
        summary: { active: 1, failed: 0, failure_reasons: [] },
      },
    }),
  )

  await page.goto('/search?q=test&tab=track')
  const rows = page.locator('.track-row')
  await expect(rows).toHaveCount(4)

  // Owned track shows "In library"
  await expect(rows.nth(0).locator('.ownership.owned')).toHaveText('In library')

  // Edition track shows "Another edition in library (Album Deluxe Edition)"
  await expect(rows.nth(1).locator('.ownership.partial')).toHaveText(
    'Another edition in library (Album Deluxe Edition)',
  )

  // Queued track shows the job stage
  await expect(rows.nth(2).locator('.ownership.missing')).toHaveText('Queued')

  // Done track shows "Downloaded earlier"
  await expect(rows.nth(3).locator('.ownership.missing')).toHaveText('Downloaded earlier')
})
