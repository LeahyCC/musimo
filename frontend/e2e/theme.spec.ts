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
  // Every script but the boot script is refused, whatever serves it: the built bundle under
  // /assets or a dev server's modules under /src.
  let refused = 0
  await page.route('**/*', (route) => {
    const request = route.request()
    if (request.resourceType() !== 'script' || request.url().endsWith('/theme-boot.js')) {
      return route.continue()
    }
    refused += 1

    return route.abort()
  })

  await page.goto('/')
  // Proof the app never ran, so the paint below can only be the boot script's.
  expect(refused).toBeGreaterThan(0)
  await expect(page.locator('#root')).toBeEmpty()

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

test('a saved theme that no longer exists stops being painted', async ({ page }) => {
  // The active id names nothing, but the boot script's copy is still there. Left alone, it would
  // flash the dead theme on every load before the app put the default back.
  await page.addInitScript(
    ([id, vars]: readonly [string, string]) => {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', 'yes')
      localStorage.setItem('musimo.theme', id)
      localStorage.setItem('musimo.theme-vars', vars)
    },
    ['custom-gone', JSON.stringify(themeVars(LIGHT_THEME))] as const,
  )

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Library', exact: true }).first()).toBeVisible()

  const left = await page.evaluate(
    (keys: string[]) => keys.map((key) => localStorage.getItem(key)),
    KEYS,
  )
  expect(left).toEqual([null, null, null])
  expect(await painted(page)).toMatchObject({ inline: '', scheme: '' })
})

test('one unreadable saved theme does not cost the others', async ({ page }) => {
  const broken = {
    id: 'custom-broken',
    name: 'Broken',
    scheme: 'dark',
    colors: { '--color-canvas': 'red' },
  }
  const retired = {
    ...LIGHT_THEME,
    colors: { ...LIGHT_THEME.colors, '--color-retired': '#123456' },
  }
  await page.addInitScript(
    ([active, custom]: readonly [string, string]) => {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', 'yes')
      localStorage.setItem('musimo.theme', active)
      localStorage.setItem('musimo.custom-themes', custom)
    },
    [LIGHT_THEME.id, JSON.stringify({ version: 1, themes: [broken, retired] })] as const,
  )

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Library', exact: true }).first()).toBeVisible()

  // The theme with a token this build has never heard of still loads and paints, and the boot
  // script's copy, which was never written, now is.
  await expect(page.locator(backdrop)).toHaveCSS(
    'background-color',
    rgb(LIGHT_THEME.colors['--color-canvas']),
  )
  const kept = await page.evaluate(() => ({
    custom: localStorage.getItem('musimo.custom-themes') ?? '',
    vars: localStorage.getItem('musimo.theme-vars') ?? '',
  }))
  expect(kept.custom).toContain('custom-broken')
  expect(JSON.parse(kept.vars)).toMatchObject(themeVars(LIGHT_THEME))
})
