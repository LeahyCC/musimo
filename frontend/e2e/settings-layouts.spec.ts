import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { BUILT_IN_THEMES } from '../src/theme/themes'
import { rgb } from './theme-fixtures'

/* Settings › Yours (layout, Home page, Follow system) and the two layouts of Server settings and
   Diagnostics. The theme cards, the editor and the boot script are in `theme.spec.ts`. */

const theme = (id: string) => {
  const found = BUILT_IN_THEMES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No theme ${id}`)

  return found
}
const canvas = (id: string) => rgb(theme(id).colors['--color-canvas'])

const seedLayout = (page: Page, layout: 'classic' | 'room') =>
  page.addInitScript((value) => localStorage.setItem('musimo.layout', value), layout)

const backdropIs = (page: Page, color: string) =>
  expect(page.locator('html')).toHaveCSS('background-color', color)

test.describe('Follow system', () => {
  test('the dark or light half follows the device, live, and keeps the family', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/settings/user')
    await page.getByRole('radio', { name: 'Slate dark' }).check()
    await backdropIs(page, canvas('slate-dark'))

    await page.getByRole('switch', { name: 'Follow system' }).check()
    await backdropIs(page, canvas('slate-light'))
    // The halves are the device's to choose now.
    await expect(page.getByRole('radio', { name: 'Slate dark' })).toBeDisabled()
    await expect(page.getByRole('radio', { name: 'Slate light' })).toBeChecked()

    await page.emulateMedia({ colorScheme: 'dark' })
    await backdropIs(page, canvas('slate-dark'))
    await expect(page.getByRole('radio', { name: 'Slate dark' })).toBeChecked()

    // Another family keeps following.
    await page.getByRole('button', { name: 'Use Sunset' }).click()
    await backdropIs(page, canvas('sunset-dark'))
    await page.emulateMedia({ colorScheme: 'light' })
    await backdropIs(page, canvas('sunset-light'))
  })

  test('turning it off keeps what is on screen and hands the halves back', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/settings/user')
    await page.getByRole('switch', { name: 'Follow system' }).check()
    await backdropIs(page, canvas('musimo-light'))

    await page.getByRole('switch', { name: 'Follow system' }).uncheck()
    await backdropIs(page, canvas('musimo-light'))
    await expect(page.getByRole('radio', { name: 'Musimo light' })).toBeChecked()
    await page.emulateMedia({ colorScheme: 'dark' })
    await backdropIs(page, canvas('musimo-light'))
    await page.getByRole('radio', { name: 'Musimo dark' }).check()
    await backdropIs(page, canvas('musimo-dark'))
  })

  test('the first frame is the half the device asks for, before the app runs', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/settings/user')
    await page.getByRole('radio', { name: 'Violet dark' }).check()
    await page.getByRole('switch', { name: 'Follow system' }).check()
    await backdropIs(page, canvas('violet-dark'))

    // Only the boot script may paint, as in `theme.spec.ts`, and the device now says light.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.route('**/*', (route) => {
      const request = route.request()
      if (request.resourceType() !== 'script' || request.url().endsWith('/theme-boot.js')) {
        return route.continue()
      }

      return route.abort()
    })
    await page.reload()
    await expect(page.locator('#root')).toBeEmpty()
    await backdropIs(page, canvas('violet-light'))
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')

    await page.unrouteAll()
    await page.reload()
    await backdropIs(page, canvas('violet-light'))
  })

  test('a theme of your own has no other half, so it stays as it is', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/settings/user')
    await page.getByRole('button', { name: 'Duplicate and edit Musimo dark' }).click()
    await page.getByLabel('Name', { exact: true }).fill('Mine')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('radio', { name: 'Mine' })).toBeChecked()

    await page.getByRole('switch', { name: 'Follow system' }).check()
    await expect(page.getByRole('radio', { name: 'Mine' })).toBeChecked()
    await backdropIs(page, canvas('musimo-dark'))
    await expect(page.getByText('stays as it is')).toBeVisible()
  })
})

test.describe('Layout and Home page', () => {
  test('the layout picker switches the app, keeps the route, and is remembered', async ({
    page,
  }) => {
    await page.goto('/settings/user')
    await expect(page.getByRole('radio', { name: 'Classic' })).toBeChecked()
    await expect(page.locator('html')).not.toHaveAttribute('data-layout', 'room')

    await page.getByRole('radio', { name: 'Listening room' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'room')
    await expect(page).toHaveURL(/\/settings\/user$/)
    expect(await page.evaluate(() => localStorage.getItem('musimo.layout'))).toBe('room')
    // The Listening room names the second half for what is in it.
    await expect(page.getByRole('link', { name: 'Appearance & you' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('radio', { name: 'Listening room' })).toBeChecked()
    await page.getByRole('radio', { name: 'Classic' }).check()
    await expect(page.getByRole('link', { name: 'Yours' })).toBeVisible()
  })

  test('each Home section has a switch, and Show all brings them back', async ({ page }) => {
    await page.goto('/settings/user')
    const jump = page.getByRole('switch', { name: 'Jump back in' })
    const showAll = page.getByRole('button', { name: 'Show all' })
    await expect(page.getByRole('switch')).toHaveCount(7)
    await expect(showAll).toBeDisabled()

    await jump.uncheck()
    await page.getByRole('switch', { name: 'Ask Octive' }).uncheck()
    expect(await page.evaluate(() => localStorage.getItem('musimo.home-sections'))).toBe(
      JSON.stringify({
        continue: true,
        stats: true,
        jump: false,
        fresh: true,
        mostPlayed: true,
        octive: false,
      }),
    )

    await page.reload()
    await expect(jump).not.toBeChecked()
    await showAll.click()
    await expect(jump).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Ask Octive' })).toBeChecked()
    expect(await page.evaluate(() => localStorage.getItem('musimo.home-sections'))).toBeNull()
  })

  for (const layout of ['classic', 'room'] as const) {
    test(`Yours passes axe in the ${layout} layout`, async ({ page }) => {
      await seedLayout(page, layout)
      await page.goto('/settings/user')
      await page.getByRole('heading', { name: 'Theme', exact: true }).waitFor()
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    })
  }
})

test.describe('Server settings', () => {
  test('Classic has the section index, the Listening room has none', async ({ page }) => {
    await page.goto('/settings')
    const index = page.getByRole('navigation', { name: 'Settings sections' })
    await expect(index.getByRole('link')).toHaveText([
      'Your library',
      'Audio quality',
      'Queue & retries',
      'Sources',
      'Music bot',
    ])
    await index.getByRole('link', { name: 'Sources' }).click()
    await expect(page.locator('#sources')).toBeInViewport()

    await seedLayout(page, 'room')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your library', level: 2 })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0)
    for (const title of ['Audio quality', 'Queue & retries', 'Sources', 'Music bot']) {
      await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    }
  })

  for (const layout of ['classic', 'room'] as const) {
    test(`a source is a switch, and the save bar still carries the edit (${layout})`, async ({
      page,
    }) => {
      await seedLayout(page, layout)
      await page.goto('/settings')
      const deezer = page.getByRole('switch', { name: 'Deezer', exact: true })
      await expect(deezer).toBeVisible()
      await expect(page.locator('.save-bar')).toHaveCount(0)

      const was = await deezer.isChecked()
      await deezer.setChecked(!was)
      await expect(page.locator('.save-bar')).toBeVisible()
      await expect(page.getByText('You have unsaved changes.')).toBeVisible()
      await deezer.setChecked(was)
    })

    test(`Server settings pass axe (${layout})`, async ({ page }) => {
      await seedLayout(page, layout)
      await page.goto('/settings')
      await page.getByRole('heading', { name: 'Your library', level: 2 }).waitFor()
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    })
  }
})

test.describe('Diagnostics', () => {
  test('Classic draws a card per check under a summary banner', async ({ page }) => {
    await page.goto('/diagnostics')
    await expect(page.getByRole('heading', { name: 'Ready to download?' })).toBeVisible()
    const cards = page.locator('.readiness-panel .readiness-item')
    await expect(cards.filter({ hasText: 'Library scan' })).toBeVisible()
    await expect(cards.filter({ hasText: 'Library scan' }).locator('.readiness-badge')).toHaveText(
      /Ready|Not ready/,
    )
    await expect(page.getByRole('button', { name: 'Recheck' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Export', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Recent activity entries' })).toBeVisible()
  })

  test('the Listening room draws the pipeline, the checks list and the activity panel', async ({
    page,
    isMobile,
  }) => {
    await seedLayout(page, 'room')
    await page.goto('/diagnostics')
    await expect(page.getByRole('heading', { name: 'Ready to download?' })).toBeVisible()

    const steps = page.getByRole('list', { name: 'Pipeline' }).getByRole('listitem')
    await expect(steps).toHaveCount(5)
    await expect(steps.filter({ hasText: 'Catalog' })).toBeVisible()
    await expect(steps.filter({ hasText: 'Player' })).toBeVisible()
    expect(await steps.locator('.font-semibold').allTextContents()).toEqual([
      'Catalog',
      'Sources',
      'Worker',
      'Library',
      'Player',
    ])

    const panel = page.locator('.readiness-panel')
    await expect(panel.getByText('Library scan')).toBeVisible()
    await expect(panel.locator('.readiness-badge').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Recheck' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Export', exact: true })).toBeVisible()
    // The activity sits beside the checks rather than under them, where there is room for both.
    if (!isMobile) {
      const checks = await panel.boundingBox()
      const activity = await page.getByRole('heading', { name: 'Recent activity' }).boundingBox()
      expect(checks && activity && activity.x > checks.x + checks.width - 1).toBe(true)
    }
  })

  for (const layout of ['classic', 'room'] as const) {
    test(`Diagnostics passes axe (${layout})`, async ({ page }) => {
      await seedLayout(page, layout)
      await page.goto('/diagnostics')
      await page.getByRole('heading', { name: 'System readiness' }).waitFor()
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    })
  }
})
