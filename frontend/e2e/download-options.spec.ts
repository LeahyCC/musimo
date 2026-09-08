import { expect, test } from '@playwright/test'

import type { MusicResult } from '../src/api'

for (const count of [2, 30]) {
  test(`download options stay usable with ${count} tracks`, async ({ page }, testInfo) => {
    const origin = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:18765').origin
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET')
        await route.abort()
      else await route.fallback()
    })
    const tracks: MusicResult[] = Array.from({ length: count }, (_, index) => ({
      id: 101 + index,
      kind: 'track',
      title: `Recording ${index + 1}`,
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
      track_count: count,
      record_type: 'album',
      ownership: 'owned',
      matched_paths: [],
      owned_count: 1,
      coverage_verified: true,
      disc: 1,
      position: index + 1,
    }))
    await page.route('**/api/albums/42*', (route) =>
      route.fulfill({
        json: {
          album: {
            ...tracks[0],
            id: 42,
            kind: 'album',
            title: 'Fixture album',
            owned_count: count,
          },
          tracks,
          label: 'Fixture label',
          duration: count * 180,
          complete: true,
        },
      }),
    )

    await page.route('**/api/jobs', (route) =>
      route.fulfill({
        json: {
          jobs: [],
          controls: { paused: false, source_paused: false },
          summary: { active: 0, failed: 0, failure_reasons: [] },
        },
      }),
    )
    await page.route('**/api/events*', (route) => route.abort())
    await page.goto('/albums/42')
    const first = page.getByRole('button', {
      name: 'Download options for Recording 1',
      exact: true,
    })
    const second = page.getByRole('button', {
      name: 'Download options for Recording 2',
      exact: true,
    })
    const panel = page.getByRole('dialog', {
      name: 'Download options for Recording 1',
      exact: true,
    })
    await first.click()
    await expect(panel).toBeVisible()
    await expect(first).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('combobox', { name: 'Download to' })).toBeFocused()
    // Hit testing catches the original bug: a later transformed row painted over the popup.
    await expect
      .poll(() =>
        panel.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return (
            [rect.top + 10, rect.bottom - 10].every((y) =>
              element.contains(document.elementFromPoint(rect.left + rect.width / 2, y)),
            ) &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          )
        }),
      )
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(first).toBeFocused()
    await first.press('Enter')
    await expect(panel).toBeVisible()
    await page.getByRole('heading', { name: 'Fixture album', exact: true }).click()
    await expect(panel).toBeHidden()
    await first.click()
    await second.focus()
    await second.press('Enter')
    await expect(panel).toBeHidden()
    await expect(
      page.getByRole('dialog', { name: 'Download options for Recording 2', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    if (count > 12) {
      await first.click()
      const list = page.getByRole('region', { name: 'Tracks', exact: true })
      await list.evaluate((element) => {
        element.scrollTop += 120
      })
      await expect(panel).toBeHidden()
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      const last = page.getByRole('button', {
        name: `Download options for Recording ${count}`,
        exact: true,
      })
      await last.focus()
      await last.press('Enter')
      const lastPanel = page.getByRole('dialog', {
        name: `Download options for Recording ${count}`,
        exact: true,
      })
      await expect(lastPanel).toBeVisible()
      await expect
        .poll(() =>
          lastPanel.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return (
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              element.contains(
                document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 10),
              )
            )
          }),
        )
        .toBe(true)

      await testInfo.attach('last-row-popup', {
        body: await page.screenshot({ path: testInfo.outputPath('last-row-popup.png') }),
        contentType: 'image/png',
      })
    }
  })
}
