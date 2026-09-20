import type { Page } from '@playwright/test'

const EMPTY = {
  jobs: [],
  controls: { paused: false, source_paused: false },
  summary: { active: 0, failed: 0, failure_reasons: [] },
}

/**
 * Serve an empty download queue instead of the test backend's.
 *
 * One container serves the whole run and its queue outlives every spec, so a spec that
 * asserts download-button labels or the queue count has to supply that state itself. Two
 * routes are needed, not one: `/api/jobs` answers `useJobs`, and `/api/snapshot` writes the
 * same `['jobs']` cache entry when the live-event stream starts, so mocking either alone
 * leaves the other free to put real jobs back.
 *
 * Settings come through untouched. The download button reads the destination and output
 * format from them, and no spec writes either. The live event stream is left connected: it
 * can only carry job state the backend actually has, and the fixture's music mount is not
 * writable by the app user, so no spec can enqueue one.
 *
 * Call this after the catch-all origin guard: Playwright tries the most recently added
 * route first, so registering it earlier would let the guard's `fallback()` win.
 */
export async function emptyQueue(page: Page): Promise<void> {
  await page.route('**/api/snapshot', async (route) => {
    // Settings and the event cursor are passed through so the live stream still starts where
    // the backend is, rather than replaying its whole retained window into the page.
    const live = await route.fetch()
    if (!live.ok()) return route.fulfill({ response: live })
    const body: unknown = await live.json()
    const snapshot = body !== null && typeof body === 'object' ? { ...(body as object) } : {}
    await route.fulfill({ json: { ...snapshot, ...EMPTY } })
  })

  await page.route('**/api/jobs', async (route) => {
    // A POST here enqueues a download, so only the listing is answered from the fixture.
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ json: EMPTY })
  })
}

/**
 * Report the saved destination as a writable folder.
 *
 * The fixture's music mount is not writable by the app user, and the review sheets keep
 * Download off for a destination that cannot be written to. A spec that queues from a sheet
 * with mocked endpoints calls this, so the button behaves as it does on a working install.
 * A spec about the read-only case adds its own diagnostics route afterwards, which wins.
 */
export async function writableDestination(page: Page): Promise<void> {
  await page.route('**/api/diagnostics', async (route) => {
    const [live, saved] = await Promise.all([route.fetch(), page.request.get('/api/settings')])
    const body = (await live.json()) as { disks: { path: string }[] }
    const settings = (await saved.json()) as { destination: { value: string } }
    const path = settings.destination.value
    await route.fulfill({
      json: {
        ...body,
        disks: [
          ...body.disks.filter((disk) => disk.path !== path),
          { path, free_bytes: 1000, total_bytes: 2000, exists: true, writable: true },
        ],
      },
    })
  })
}
