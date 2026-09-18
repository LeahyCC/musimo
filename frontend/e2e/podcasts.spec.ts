import { expect, test } from '@playwright/test'

import type { DownloadJob } from '../src/api'
import { playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'
import { episodes, podcast, searchFixtures } from './search-fixtures'

test('a podcast is found in search and one episode queues without the music filters', async ({
  page,
}) => {
  await playerFixtures(page)
  await emptyQueue(page)
  await searchFixtures(page)
  const posted: unknown[] = []
  await page.route('**/api/podcast-episodes', async (route) => {
    posted.push(route.request().postDataJSON())
    const episode = episodes[0]!
    const job: DownloadJob = {
      id: 'episode-job',
      batch_id: '',
      batch_label: '',
      album_id: 0,
      catalog: 'podcast',
      track_id: episode.id,
      format: 'original',
      target: '/music',
      stage: 'queued',
      desired: 'run',
      meta: {
        id: episode.id,
        title: episode.title,
        artist: podcast.author,
        album: podcast.title,
        art: '',
        duration: episode.duration,
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
    await route.fulfill({ json: job })
  })

  await page.goto('/search?q=Fixture&tab=podcast')
  // Podcasts come from another directory, so the music filters and sort do not apply.
  await expect(page.getByRole('button', { name: 'Filters' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Tide Tables' }).click()

  await expect(page).toHaveURL(/\/podcasts\/77$/)
  await expect(page.getByRole('heading', { name: 'Tide Tables', level: 1 })).toBeVisible()
  await expect(page.getByText('Jul 31, 2026 · 4 h 1 min')).toBeVisible()

  await page.getByRole('searchbox').fill('slack')
  await expect(page.getByText('The Long Ebb')).toHaveCount(0)
  await page.getByRole('searchbox').fill('')

  await page.getByRole('button', { name: 'Download The Long Ebb' }).click()
  await expect(page.getByRole('button', { name: 'The Long Ebb is queued' })).toBeDisabled()
  expect(posted).toEqual([{ podcast_id: 77, episode_id: 7701 }])
})
