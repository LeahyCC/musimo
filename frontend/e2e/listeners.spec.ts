import type { Locator, Page } from '@playwright/test'

import { expect, test } from './test'

/**
 * A tap lands on the control, which the phone's bottom sheet has to prove: Playwright's own click
 * aims at the wrong place inside a native dialog there.
 */
async function press(control: Locator) {
  await expect(control).toBeVisible()
  const covered = await control.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit !== el && !(hit instanceof Node && el.contains(hit))
  })
  expect(covered).toBe(false)
  await control.evaluate((el: HTMLElement) => {
    el.click()
  })
}

/** The listeners mock would hide a real create. These tests talk to the isolated server. */
test.beforeEach(async ({ page }) => {
  await page.unroute('**/api/listeners')
})

const names = (page: Page) => page.getByRole('dialog')

async function openNames(page: Page) {
  await page.getByRole('button', { name: /^Listening as / }).click()
  await expect(names(page)).toBeVisible()
}

/** Open `name`, creating it when this install does not have it yet. */
async function pickOrCreate(page: Page, name: string) {
  await openNames(page)
  const sheet = names(page)
  const choice = sheet.getByRole('button', { name: new RegExp(`^${name}( Current)?$`) })
  if ((await choice.count()) > 0) {
    if ((await choice.getAttribute('aria-current')) === 'true') await page.keyboard.press('Escape')
    else await press(choice)
  } else {
    await press(sheet.getByRole('button', { name: 'Create a new name' }))
    await sheet.getByLabel('Name').fill(name)
    await press(sheet.getByRole('button', { name: 'Create', exact: true }))
  }
  await expect(page.getByRole('button', { name: `Listening as ${name}` })).toBeVisible()
  await expect(names(page)).toBeHidden()
}

test('a name is remembered, and a blank or a duplicate stays on the sheet', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Listening as Listener' })).toBeVisible()
  await openNames(page)
  const sheet = names(page)
  await press(sheet.getByRole('button', { name: 'Create a new name' }))
  await press(sheet.getByRole('button', { name: 'Create', exact: true }))
  await expect(sheet.getByRole('alert')).toHaveText('Enter a name.')
  await sheet.getByLabel('Name').fill('Listener')
  await press(sheet.getByRole('button', { name: 'Create', exact: true }))
  await expect(sheet.getByRole('alert')).toHaveText('That name is already in use.')

  const sam = sheet.getByRole('button', { name: /^Sam( Current)?$/ })
  if ((await sam.count()) > 0) await press(sam)
  else {
    await sheet.getByLabel('Name').fill('Sam')
    await press(sheet.getByRole('button', { name: 'Create', exact: true }))
  }
  await expect(page.getByRole('button', { name: 'Listening as Sam' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Listening as Sam' })).toBeVisible()
  await pickOrCreate(page, 'Listener')
})

test('a playlist from another name goes back to the list', async ({ page, request }) => {
  let id = ''
  try {
    const created = await request.post('/api/library/playlists', {
      data: { name: `Switch check ${Date.now()}`, song_ids: [] },
    })
    expect(created.ok()).toBeTruthy()
    const body = (await created.json()) as { id?: unknown }
    id = typeof body.id === 'string' ? body.id : ''
    expect(id).toMatch(/^pl-/)
    await page.goto(`/library/playlists/${id}`)
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/library/playlists/${id}`)
    await pickOrCreate(page, 'Sam')
    await expect.poll(() => new URL(page.url()).pathname).toBe('/library/playlists')
    await page.reload()
    await expect(page.getByRole('button', { name: 'Listening as Sam' })).toBeVisible()
  } finally {
    if (id) await request.delete(`/api/library/playlists/${id}`)
  }
})

test('the listening room shows the name in the top bar', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('musimo.layout', 'room')
  })
  await page.goto('/')
  const rail = page.locator('.sidebar')
  await expect(page.getByRole('button', { name: 'Listening as Listener' })).toBeVisible()
  await expect(rail).not.toContainText('Listener')
})
