import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { DEFAULT_THEME } from '../src/theme/themes'
import { LIGHT_THEME, rgb, themeVars } from './theme-fixtures'

/* The page background is declared on `:root`, so `html` is the element that carries it. `body` only
   sets a margin and reports a transparent background whatever the theme is. */
const backdrop = 'html'

const KEYS = ['musimo.theme', 'musimo.custom-themes', 'musimo.theme-vars']

const stored = [
  LIGHT_THEME.id,
  JSON.stringify({ version: 1, themes: [LIGHT_THEME] }),
  JSON.stringify(themeVars(LIGHT_THEME)),
] as const

const seed = ([active, custom, vars]: readonly [string, string, string]) => {
  localStorage.setItem('musimo.theme', active)
  localStorage.setItem('musimo.custom-themes', custom)
  localStorage.setItem('musimo.theme-vars', vars)
}

const painted = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)

    return {
      canvas: style.getPropertyValue('--color-canvas').trim(),
      raised: style.getPropertyValue('--color-raised').trim(),
      accent: style.getPropertyValue('--color-accent').trim(),
      scheme: root.style.colorScheme,
      /* The default theme is the absence of an inline value, not another one. */
      inline: root.style.getPropertyValue('--color-canvas'),
    }
  })

test('a stored theme is painted before the app script runs', async ({ page }) => {
  await page.addInitScript(seed, stored)
  // Only the boot script may paint here, so the bundle never gets to run. What is on screen after
  // this is what a person sees on the first frame of an ordinary load.
  await page.route('**/assets/*.js', (route) => route.abort())

  await page.goto('/')

  await expect(page.locator(backdrop)).toHaveCSS(
    'background-color',
    rgb(LIGHT_THEME.colors['--color-canvas']),
  )

  expect(await painted(page)).toMatchObject({
    canvas: LIGHT_THEME.colors['--color-canvas'],
    raised: LIGHT_THEME.colors['--color-raised'],
    inline: LIGHT_THEME.colors['--color-canvas'],
    scheme: 'light',
  })
})

test('the app keeps the stored theme once it has loaded', async ({ page }) => {
  await page.addInitScript(seed, stored)

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Library', exact: true }).first()).toBeVisible()

  await expect(page.locator(backdrop)).toHaveCSS(
    'background-color',
    rgb(LIGHT_THEME.colors['--color-canvas']),
  )

  expect(await painted(page)).toMatchObject({
    canvas: LIGHT_THEME.colors['--color-canvas'],
    accent: LIGHT_THEME.colors['--color-accent'],
    scheme: 'light',
  })
})

test('clearing the keys returns the default theme', async ({ page }) => {
  // No init script here: the keys have to survive one reload and then be gone for good.
  await page.goto('/')
  await page.evaluate(seed, stored)
  await page.reload()

  await expect(page.locator(backdrop)).toHaveCSS(
    'background-color',
    rgb(LIGHT_THEME.colors['--color-canvas']),
  )

  await page.evaluate((keys: string[]) => {
    for (const key of keys) localStorage.removeItem(key)
  }, KEYS)
  await page.reload()

  await expect(page.locator(backdrop)).toHaveCSS(
    'background-color',
    rgb(DEFAULT_THEME.colors['--color-canvas']),
  )

  expect(await painted(page)).toMatchObject({
    canvas: DEFAULT_THEME.colors['--color-canvas'],
    inline: '',
    scheme: '',
  })
})
