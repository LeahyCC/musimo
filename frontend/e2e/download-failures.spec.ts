import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { DownloadJob, MusicResult } from '../src/api'
import { ORIGIN } from './env'

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
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
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

/** Alternating tall and short cards, so a wrong height is impossible to miss. */
const varied = (index: number): DownloadJob => {
  const tall = index % 2 === 1
  return {
    ...failed,
    id: `failed-${index}`,
    batch_id: tall ? 'album-batch' : '',
    batch_label: tall ? 'Fixture album' : '',
    track_id: 200 + index,
    meta: { ...failed.meta, id: 200 + index, title: `Recording ${index}` },
    attempts: index,
    tool_tail: tall ? Array.from({ length: 12 }, (_, line) => `log line ${line}`).join('\n') : '',
    warnings: tall ? ['Tag write skipped', 'Scan deferred', 'Artwork missing'] : [],
    final_path: tall ? `/music/Fixture artist/Fixture album/Recording ${index}.opus` : '',
    candidates: tall
      ? Array.from({ length: 3 }, (_, pick) => ({
          id: `candidate-${index}-${pick}`,
          title: `Candidate ${pick}`,
          artist: 'Fixture artist',
          duration: 180,
          score: 0.4,
          topic: false,
          reason: 'duration close',
        }))
      : [],
    created_at: index,
    updated_at: index,
  }
}

/**
 * Scroll the whole virtual list, sampling every frame, and report any card that runs into
 * the one above it. Frame-by-frame matters: a card positioned from an estimated height
 * overlaps its neighbour only until measurement lands, and that flash is the visible bug.
 */
async function overlaps(page: Page) {
  return page.evaluate(async () => {
    const list = document.querySelector('#main .virtual-list')
    if (!(list instanceof HTMLElement)) throw new Error('Missing virtual list')
    const seen = new Set<string>()
    const frame = () => new Promise((painted) => requestAnimationFrame(painted))
    const sample = () => {
      const cards = [...document.querySelectorAll('#main .job-card')]
        .map((node) => ({
          title: node.querySelector('strong')?.textContent ?? '',
          box: node.getBoundingClientRect(),
        }))
        // A card being swapped in has no box yet, which is not two cards on each other.
        .filter((card) => card.box.height > 0)
        .sort((left, right) => left.box.top - right.box.top)
      if (cards.length < 3) return
      for (const [index, card] of cards.entries()) {
        const above = cards[index - 1]
        if (index > 0 && above && card.box.top < above.box.bottom - 1)
          seen.add(`${above.title} over ${card.title}`)
      }
    }
    const reach = list.scrollHeight - list.clientHeight
    for (let top = 0; top <= reach + 240; top += 120) {
      list.scrollTo({ top })
      await frame()
      sample()
      await frame()
      sample()
    }
    return [...seen]
  })
}

test('a long failure queue lists cards without overlapping, and can be grouped or cleared', async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable in this fixture' } }),
  )
  const jobs = Array.from({ length: 9 }, (_, index) => varied(index))
  await page.route('**/api/jobs*', (route) =>
    route.fulfill({
      json: {
        jobs,
        controls: { paused: false, source_paused: false },
        summary: { active: 0, failed: jobs.length, failure_reasons: [] },
      },
    }),
  )
  const cleared: string[] = []
  await page.route('**/api/queue/*', (route) => {
    cleared.push(new URL(route.request().url()).pathname.split('/').pop() ?? '')
    route.fulfill({ json: { controls: { paused: false, source_paused: false }, errors: [] } })
  })

  await page.goto('/downloads')
  await page.getByRole('button', { name: 'Failed (9)', exact: true }).click()
  // Cards flow inside one offset container. Giving each card its own absolute offset is
  // what let a card be drawn over its neighbour before its real height was measured.
  const wrappers = await page
    .locator('#main .job-card')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.parentElement ? getComputedStyle(node.parentElement).position : 'detached',
      ),
    )
  expect(wrappers.length).toBeGreaterThan(2)
  expect([...new Set(wrappers)]).toEqual(['static'])
  expect(await overlaps(page)).toEqual([])

  // Filtering by group reorders the list, which is when index-keyed measurements went stale.
  const groups = page.getByRole('group', { name: 'Failures by download group' })
  await expect(groups.getByRole('button', { name: 'Single tracks (5)' })).toBeVisible()
  await groups.getByRole('button', { name: 'Fixture album (4)' }).click()
  await expect(page.locator('#main .job-card')).toHaveCount(4)
  await groups.getByRole('button', { name: 'Fixture album (4)' }).click()
  await expect(page.locator('#main .virtual-list')).toBeVisible()
  expect(await overlaps(page)).toEqual([])

  await page.getByRole('button', { name: 'Clear failed (9)' }).click()
  await expect.poll(() => cleared).toContain('clear-failed')
})

test('a queued card keeps its own height when a job above it finishes', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  const queued = Array.from({ length: 9 }, (_, index) => ({
    ...varied(index),
    stage: 'queued' as const,
  }))
  const controls = { paused: false, source_paused: false }
  const summary = { active: queued.length, failed: 0, failure_reasons: [] }
  await page.route('**/api/snapshot', async (route) => {
    // Real settings, invented jobs: the live stream has to be running for a reorder.
    const live = await route.fetch()
    const snapshot: unknown = await live.json()
    const settings =
      snapshot !== null && typeof snapshot === 'object' ? { ...(snapshot as object) } : {}
    await route.fulfill({ json: { ...settings, cursor: 0, jobs: queued, controls, summary } })
  })

  await page.route('**/api/jobs*', (route) =>
    route.fulfill({ json: { jobs: queued, controls, summary } }),
  )

  const finished = { ...queued[3], stage: 'done', updated_at: 99, tool_tail: '', warnings: [] }
  // Held back so the whole queue can be measured before anything finishes.
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/events*', async (route) => {
    await held
    await route.fulfill({
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: `id: 1\nevent: change\ndata: ${JSON.stringify({
        kind: 'job.updated',
        payload: finished,
      })}\n\n`,
    })
  })

  await page.goto('/downloads')
  await expect(page.getByRole('button', { name: 'Queue (9)', exact: true })).toBeVisible()
  expect(await overlaps(page)).toEqual([])

  // The finished job leaves the queue, so every card below it shifts up one position while
  // staying on screen. Measurements have to follow the card, not the position.
  release()
  await expect(page.getByRole('button', { name: 'Queue (8)', exact: true })).toBeVisible()
  expect(await overlaps(page)).toEqual([])
})

test('history tab shows empty state when no jobs finished', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        cursor: 0,
        jobs: [],
        controls: { paused: false, source_paused: false },
        summary: { active: 0, failed: 0, failure_reasons: [] },
        settings: {
          destination: { value: '/music' },
          output_format: { value: 'original' },
        },
      },
    }),
  )

  await page.route('**/api/history?*', (route) =>
    route.fulfill({
      json: { jobs: [], total: 0 },
    }),
  )

  await page.goto('/downloads')
  await expect(page.getByRole('button', { name: 'Queue (0)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('Nothing has finished yet.')).toBeVisible()
})
