import { expect, test } from '@playwright/test'

import type { DownloadJob, MusicResult } from '../src/api'

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
  explicit: false,
  preview: '',
  isrc: '',
  popularity: 1,
  track_count: 1,
  record_type: 'album',
  ownership: 'missing',
  matched_paths: [],
  owned_count: 0,
  coverage_verified: true,
  disc: 1,
  position: 1,
}

const failed: DownloadJob = {
  id: 'failed-job',
  batch_id: 'album-batch',
  batch_label: 'Fixture album',
  album_id: 42,
  track_id: track.id,
  format: 'original',
  target: '/music',
  stage: 'failed',
  desired: 'run',
  meta: {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    art: '',
    duration: track.duration,
  },
  candidates: [],
  selected: '',
  check_match: false,
  attempts: 1,
  retry_at: 0,
  progress: 0,
  downloaded: 0,
  total: 0,
  speed: 0,
  eta: null,
  error_code: 'NO_MATCH',
  error: 'No sufficiently close recording found',
  retryable: false,
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

test('failed downloads show a count, cause and retry state', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:18765') await route.abort()
    else await route.fallback()
  })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable in this fixture' } }),
  )

  await page.route('**/api/jobs*', (route) =>
    route.fulfill({
      json: {
        jobs: [failed],
        controls: { paused: false, source_paused: false },
        summary: {
          active: 0,
          failed: 1,
          failure_reasons: [
            {
              code: failed.error_code,
              message: failed.error,
              count: 1,
            },
          ],
        },
      },
    }),
  )

  await page.route('**/api/albums/42*', (route) =>
    route.fulfill({
      json: {
        album: { ...track, id: 42, kind: 'album', title: 'Fixture album' },
        tracks: [track],
        label: 'Fixture label',
        duration: track.duration,
        complete: true,
      },
    }),
  )

  await page.route('**/api/jobs/failed-job/retry', (route) =>
    route.fulfill({
      json: { ...failed, stage: 'queued', error_code: '', error: '', updated_at: 2 },
    }),
  )

  await page.goto('/downloads')
  await expect(page.getByRole('button', { name: 'Retry failed (1)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Failed (1)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Failed (1)', exact: true }).click()
  await expect(page.getByLabel('Failure summary')).toContainText(
    'No matching recording was found on YouTube. Nothing was downloaded.',
  )

  await page.goto('/albums/42')
  await expect(page.getByText('Download failed', { exact: true })).toHaveAttribute(
    'title',
    'No matching recording was found on YouTube. Nothing was downloaded.',
  )
  await page.getByRole('button', { name: /Retry Recording 1/ }).click()
  await expect(page.getByText('Queued', { exact: true })).toBeVisible()
})
