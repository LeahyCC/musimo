import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { BUILT_IN_THEMES, DEFAULT_THEME } from '../src/theme/themes'
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

/* Phase T2: the personal settings page. These drive the picker and the editor the way a person
   does, and look in storage only where the point of the step is that something persists. */

const CANVAS = '#3a0f3f'
const ACCENT = '#ffd166'

const backdropIs = (target: Page, hex: string) =>
  expect(target.locator(backdrop)).toHaveCSS('background-color', rgb(hex))

async function duplicateDefault(page: Page, name: string) {
  await page.goto('/settings/user')
  await page.getByRole('button', { name: `Duplicate and edit ${DEFAULT_THEME.name}` }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
}

/** The two colors the rest of these tests recognise a changed theme by. */
async function recolor(page: Page) {
  await page.getByLabel('Page background hex value').fill(CANVAS)
  await page.getByLabel('Accent hex value', { exact: true }).fill(ACCENT)
}

test('a duplicate previews the whole app while it is being edited', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])

  await recolor(page)

  await backdropIs(page, CANVAS)
  expect(await painted(page)).toMatchObject({ canvas: CANVAS, accent: ACCENT })
  // A preview is never written down, so a reload here would lose it.
  expect(await page.evaluate(() => localStorage.getItem('musimo.custom-themes'))).toBeNull()
})

test('Cancel puts the saved theme back', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await backdropIs(page, CANVAS)

  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.getByRole('radio', { name: DEFAULT_THEME.name })).toBeChecked()
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])
  expect(await painted(page)).toMatchObject({ inline: '', scheme: '' })
})

test('leaving the page with unsaved edits asks first, then puts the saved theme back', async ({
  page,
}) => {
  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await backdropIs(page, CANVAS)

  // Staying keeps the draft and its preview.
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByRole('link', { name: 'Server' }).click()
  await expect(page).toHaveURL(/\/settings\/user$/)
  await backdropIs(page, CANVAS)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('link', { name: 'Server' }).click()

  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])
  expect(await painted(page)).toMatchObject({ inline: '' })
})

test('a saved theme can be edited in place', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved “Plum”' })).toBeVisible()

  await page.getByRole('button', { name: 'Edit Plum', exact: true }).click()
  await page.getByLabel('Accent hex value', { exact: true }).fill('#66d1ff')
  expect(await painted(page)).toMatchObject({ accent: '#66d1ff' })
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('radio', { name: 'Plum' })).toBeChecked()
  await expect(page.getByRole('radio')).toHaveCount(BUILT_IN_THEMES.length + 1)
  await page.reload()
  // The boot script's copy was rewritten along with the theme, so the new accent is there on
  // the first frame.
  expect(await painted(page)).toMatchObject({ canvas: CANVAS, accent: '#66d1ff' })
})

test('a half-typed color says what is wrong and holds the last good one', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  const field = page.getByLabel('Page background hex value')
  await field.fill('#fff')

  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Use a # followed by six or eight digits.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Page background' })).toBeVisible()
  // The app keeps painting the last whole value rather than flashing the default.
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])

  await field.fill(CANVAS)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await backdropIs(page, CANVAS)
})

test('the editor shows the colors the rest of the page cannot', async ({ page }) => {
  await duplicateDefault(page, 'Plum')

  const preview = page.getByRole('region', { name: 'Preview' })
  await expect(preview.getByText('Failed')).toBeVisible()
  await expect(preview.getByText('Text over artwork')).toBeVisible()
  await expect(preview.getByText('A warning message.')).toBeVisible()

  await page.getByLabel('Error hex value', { exact: true }).fill('#ff00aa')
  await expect(preview.getByText('An error message.')).toHaveCSS('color', rgb('#ff00aa'))
})

test('Save keeps the theme and it survives a reload', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('radio', { name: 'Plum' })).toBeChecked()
  await backdropIs(page, CANVAS)

  await page.reload()

  await backdropIs(page, CANVAS)
  await expect(page.getByRole('radio', { name: 'Plum' })).toBeChecked()
  expect(await painted(page)).toMatchObject({ canvas: CANVAS, accent: ACCENT, inline: CANVAS })
})

test('a theme exports to a file and imports back', async ({ page }) => {
  await duplicateDefault(page, 'Roundtrip')
  await recolor(page)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('radio', { name: 'Roundtrip' })).toBeChecked()

  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Roundtrip' }).click(),
  ])
  expect(file.suggestedFilename()).toBe('Roundtrip.musimo-theme.json')
  const written = await file.path()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete Roundtrip' }).click()
  await expect(page.getByRole('radio', { name: 'Roundtrip' })).toHaveCount(0)

  await page.getByLabel('Import a theme file').setInputFiles(written)

  await expect(page.getByRole('radio', { name: 'Roundtrip' })).toBeChecked()
  await backdropIs(page, CANVAS)
})

test('a file that is not a theme is refused and changes nothing', async ({ page }) => {
  await page.goto('/settings/user')

  await page.getByLabel('Import a theme file').setInputFiles({
    name: 'not-a-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ "hello": true }'),
  })

  await expect(page.getByRole('alert')).toContainText('not a Musimo theme')
  await expect(page.getByRole('radio')).toHaveCount(BUILT_IN_THEMES.length)
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])
  expect(await page.evaluate(() => localStorage.getItem('musimo.custom-themes'))).toBeNull()
})

test('deleting the active theme falls back to the default', async ({ page }) => {
  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await page.getByRole('button', { name: 'Save' }).click()
  await backdropIs(page, CANVAS)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete Plum' }).click()

  await expect(page.getByRole('radio', { name: DEFAULT_THEME.name })).toBeChecked()
  await backdropIs(page, DEFAULT_THEME.colors['--color-canvas'])
})

test('a second tab follows a theme saved in the first', async ({ page, context }) => {
  const other = await context.newPage()
  await other.goto('/library')
  await backdropIs(other, DEFAULT_THEME.colors['--color-canvas'])

  await duplicateDefault(page, 'Plum')
  await recolor(page)
  await page.getByRole('button', { name: 'Save' }).click()

  await backdropIs(other, CANVAS)
  await other.close()
})

test('the command palette opens the page', async ({ page }) => {
  await page.goto('/')
  // The shortcut is a window listener an effect adds, so the shell has to be on screen first.
  // Pressing straight after goto is a race WebKit loses.
  await page.getByRole('link', { name: 'Library', exact: true }).first().waitFor()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor()

  await page.getByRole('button', { name: 'Change theme' }).click()

  await expect(page.getByRole('heading', { name: 'Your settings' })).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/user$/)
  // One Settings entry in the chrome, and it is highlighted here as well as on /settings.
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Settings' }),
  ).toHaveAttribute('aria-current', 'page')
})

test('the Settings guard still fires when switching to Yours', async ({ page }) => {
  await page.goto('/settings')
  await page.getByLabel('Library label').fill('Unsaved draft')

  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()

    return dialog.dismiss()
  })
  await page.getByRole('link', { name: 'Yours' }).click()

  await expect.poll(() => asked).toContain('unsaved changes')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})

test('the page passes axe under the default and a light theme', async ({ page }) => {
  await page.goto('/settings/user')
  await page.getByRole('heading', { name: 'Appearance' }).waitFor()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  // The editor is another page's worth of controls, so it is audited on its own.
  await page.getByRole('button', { name: `Duplicate and edit ${DEFAULT_THEME.name}` }).click()
  await page.getByRole('heading', { name: 'Readability' }).waitFor()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  await page.addInitScript(seed, stored)
  await page.goto('/settings/user')
  await page.getByRole('heading', { name: 'Appearance' }).waitFor()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})
