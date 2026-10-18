import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { BUILT_IN_THEMES } from '../src/theme/themes'
import { generatedPlayerAudio, librarySong, playerFixtures } from './library-fixtures'
import { botModelFixtures, proposalFixtures } from './proposal-fixtures'
import type { ProposalMock } from './proposal-fixtures'

/* A result card's edits: pin a song, replace the rest, add a song, remove one, and what happens
   when an edit gets no answer or the preview changed elsewhere. The server's routes are the
   stand-in in proposal-fixtures.ts, which keeps revisions and operation ids the way the real ones
   do; tests/test_proposals.py covers the real edit route against generated files. */

const song = (n: number, over: Partial<LibraryTrack> = {}) =>
  librarySong(`tr-${n.toString(16).padStart(16, '0')}`, {
    title: `Song ${String.fromCharCode(64 + n)}`,
    artist: n % 2 ? 'Harbor Static' : 'Orchard',
    ...over,
  })
const a = song(1)
const b = song(2)
const c = song(3)
const library = [a, b, c, song(4), song(5), song(6)]
const f = song(6)
const playing = song(9, { title: 'Playing Song' })

const plan = {
  change_filters: [],
  allow_artists: [],
  add_count: 0,
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: [],
  genres: [],
  year_from: null,
  year_to: null,
  favourites: false,
  history: 'any',
  exclude_played_days: 0,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 0,
  limit: 3,
  similar_to_current: false,
  explanation: '',
}
const answer = {
  plan,
  tracks: [a, b, c],
  total_seconds: 642,
  shortfall_seconds: 0,
  summary: '3 songs, 10.7 minutes.',
  elapsed_ms: 12,
}

/** The proposal routes' stand-in for the test in progress. One worker runs a file. */
let proposals: ProposalMock

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? { ...value } : {}

/** Songs the test deleted from the library, which a search no longer finds. */
const deleted = new Set<string>()

/** A library search that starts from songs A to C. A refinement keeps the revision's songs; kept
 *  songs go first and removed ones are left out, as the real engine does. */
function startsWithThree(intent: Record<string, unknown>, base: string[]): LibraryTrack[] {
  const context = record(intent.context)
  const gone = strings(record(intent.filters).exclude_ids)
  const keep = strings(context.keep_ids)
  const from =
    intent.scope === 'proposal'
      ? library.filter((s) => (base.length ? base : strings(context.proposal_ids)).includes(s.id))
      : [a, b, c].filter((s) => !deleted.has(s.id))
  const rest = from.filter((s) => !gone.includes(s.id) && !keep.includes(s.id))
  return [...library.filter((s) => keep.includes(s.id)), ...rest]
}

async function fixtures(page: Page, reply: Record<string, unknown> = answer) {
  await playerFixtures(page)
  await generatedPlayerAudio(page)
  await botModelFixtures(page)
  await page.route('**/api/music-bot/chat', (route) => route.fulfill({ json: reply }))
  deleted.clear()
  proposals = await proposalFixtures(page, library)
  proposals.pick = startsWithThree
  await page.route('**/api/player/queue', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { current: playing.id, position: 0, entry: [playing] } })
    return route.fulfill({ status: 204 })
  })
}

const box = (page: Page) => page.getByRole('textbox', { name: /^Ask .+ for music$/ })
const card = (page: Page) => page.locator('[data-bot="card"]').last()
const rows = (page: Page) =>
  card(page).locator('ol[aria-label="Proposed songs"] > li, [data-bot="list-row"]')
const pin = (page: Page, title: string) => card(page).getByRole('button', { name: `Pin ${title}` })
const another = (page: Page) =>
  card(page).getByRole('button', { name: /^(Another set|Replace the rest)$/ })
const addSong = (page: Page) => card(page).getByRole('button', { name: 'Add a song', exact: true })

async function say(page: Page, text: string) {
  await box(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

async function open(page: Page, isMobile: boolean) {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/music-bot')
  await say(page, 'three songs')
  await expect(rows(page)).toHaveCount(3)
}

const titles = (rowList: Locator) => rowList.locator('strong').allTextContents()

test('pin a song and replace the rest: the pinned song stays, the others are drawn again', async ({
  page,
  isMobile,
}, info) => {
  await fixtures(page)
  await open(page, isMobile)
  await expect(another(page)).toHaveText('Another set')
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'false')
  await pin(page, 'Song A').click()
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'true')
  // With one song pinned and others not, the button says what it will do.
  await expect(another(page)).toHaveText('Replace the rest')
  expect(proposals.edits).toHaveLength(0)

  await another(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.edits).toHaveLength(1)
  expect(proposals.edits[0]).toMatchObject({
    contract_version: 5,
    revision: 1,
    edit: { kind: 'another', pinned_ids: [a.id] },
  })
  expect(String(proposals.edits[0]?.operation_id)).toMatch(/^op-[0-9a-f]{32}$/)
  const now = await titles(rows(page))
  expect(now).toHaveLength(3)
  expect(now[0]).toBe('Song A')
  expect(now).not.toEqual(['Song A', 'Song B', 'Song C'])
  // The server's revision is what the card shows: nothing was made as a new proposal.
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(0)
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Drew another set, keeping 1 pinned song')).toBeVisible()
  // The new set is a library draw, so it is reported as shown.
  await expect.poll(() => proposals.presented).toContain('pr-0000000000000001:2')

  // A song unpinned goes back to Another set with none kept.
  await pin(page, 'Song A').click()
  await expect(another(page)).toHaveText('Another set')
  await another(page).click()
  await expect(card(page)).toContainText('REVISION 3')
  expect(proposals.edits.at(-1)).toMatchObject({
    revision: 2,
    edit: { kind: 'another', pinned_ids: [] },
  })

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // Two pins make a card worth a picture.
  const [first, second] = await titles(rows(page))
  await pin(page, first ?? '').click()
  await pin(page, second ?? '').click()
  // A tall window, so the composer bar does not cover the card in the picture.
  await page.setViewportSize({ width: isMobile ? 390 : 1100, height: 1500 })
  await card(page).scrollIntoViewIfNeeded()
  await card(page).screenshot({ path: `../runtime/proposal-edits/card-${info.project.name}.png` })
})

test('every song can be pinned by keyboard, and pinning all of them says Another set again', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await pin(page, 'Song B').focus()
  await page.keyboard.press('Space')
  await expect(pin(page, 'Song B')).toHaveAttribute('aria-pressed', 'true')
  await pin(page, 'Song A').click()
  await pin(page, 'Song C').click()
  await expect(another(page)).toHaveText('Another set')
  await page.keyboard.press('Tab')
  await pin(page, 'Song B').focus()
  await page.keyboard.press('Enter')
  await expect(pin(page, 'Song B')).toHaveAttribute('aria-pressed', 'false')
  await expect(another(page)).toHaveText('Replace the rest')
  // The pin control is large enough to press on a phone.
  if (isMobile) {
    const size = await pin(page, 'Song A').boundingBox()
    expect(size?.height).toBeGreaterThanOrEqual(43)
  }
})

test('Add a song asks the server for one more, and the card shows its revision', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await pin(page, 'Song B').click()
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(rows(page)).toHaveCount(4)
  expect(proposals.edits).toHaveLength(1)
  expect(proposals.edits[0]).toMatchObject({ revision: 1, edit: { kind: 'add', count: 1 } })
  const now = await titles(rows(page))
  expect(now.slice(0, 3)).toEqual(['Song A', 'Song B', 'Song C'])
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(0)
  await expect(page.getByText('Added 1 song that fit these filters.')).toBeVisible()
  // A pin the server had not seen yet is still pinned.
  await expect(pin(page, 'Song B')).toHaveAttribute('aria-pressed', 'true')
  // Saving confirms the revision the card shows.
  await card(page).getByRole('button', { name: 'Save as playlist' }).click()
  await card(page).getByLabel('Playlist name').fill('Four')
  await card(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => proposals.saved).toEqual([{ name: 'Four', ids: expect.any(Array) }])
  expect(proposals.saved[0]?.ids).toHaveLength(4)
  expect(proposals.commits[0]).toMatchObject({ revision: 2 })
})

test('"add a song" in the chat is an add edit when the filters are the same', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  // The chat's own answer to "add a song" has its list and a raised limit; the card shows the
  // server's pick instead, so a song the chat chose is not what appears.
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: { ...answer, plan: { ...plan, add_count: 1, limit: 4 }, tracks: [a, b, c, f] },
    }),
  )
  await say(page, 'add another song')
  await expect(card(page)).toContainText('REVISION 2')
  await expect(rows(page)).toHaveCount(4)
  expect(proposals.edits).toHaveLength(1)
  expect(proposals.edits[0]).toMatchObject({ revision: 1, edit: { kind: 'add', count: 1 } })
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(0)
  expect(await titles(rows(page))).not.toEqual(['Song A', 'Song B', 'Song C', 'Song F'])
})

test('"add a song" with changed filters keeps the exact list as a new proposal, as before', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: {
        ...answer,
        plan: { ...plan, add_count: 1, limit: 4, genres: ['Rock'] },
        tracks: [a, b, c, f],
      },
    }),
  )
  await say(page, 'add a rock song')
  await expect(rows(page)).toHaveCount(4)
  // The edit route cannot change a filter, so the chat's list is stored as it stands.
  expect(proposals.edits).toHaveLength(0)
  expect(proposals.creates).toHaveLength(2)
  expect(proposals.creates[1]).toMatchObject({
    scope: 'proposal',
    context: { proposal_ids: [a.id, b.id, c.id, f.id] },
  })
  // A list with no search behind it has nothing to draw from, so it offers no edits.
  await expect(addSong(page)).toHaveCount(0)
  await expect(another(page)).toHaveCount(0)
  await expect(pin(page, 'Song A')).toHaveCount(0)
})

test('Remove is a remove edit: a new revision, and the song does not come back', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(rows(page)).toHaveCount(2)
  expect(proposals.edits).toHaveLength(1)
  expect(proposals.edits[0]).toMatchObject({ revision: 1, edit: { kind: 'remove', ids: [a.id] } })
  expect(proposals.creates).toHaveLength(1)
  await expect(page.getByText(/Removed 1 song\. It won’t come back/)).toBeVisible()
  // Another set and Add a song draw from the library, and never bring the removed song back.
  await another(page).click()
  await expect(card(page)).toContainText('REVISION 3')
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 4')
  expect(await titles(rows(page))).not.toContain('Song A')
  // A chat follow-up carries the removal too.
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({ json: { ...answer, plan: { ...plan, genres: ['Rock'] } } }),
  )
  await say(page, 'only rock')
  await expect(card(page)).toContainText('REVISION 5')
  expect(proposals.refines.at(-1)?.body.intent).toMatchObject({
    filters: { exclude_ids: [a.id] },
  })
  expect(await titles(rows(page))).not.toContain('Song A')
})

test('removing the last song stays a local clear', async ({ page, isMobile }) => {
  await fixtures(page, { ...answer, tracks: [a], total_seconds: 214 })
  proposals.pick = () => [a]
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/music-bot')
  await say(page, 'one song')
  await expect(rows(page)).toHaveCount(1)
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(rows(page)).toHaveCount(0)
  await expect(card(page)).toContainText('None of your library matches')
  expect(proposals.edits).toHaveLength(0)
  expect(proposals.creates).toHaveLength(1)
})

test('a follow-up carries the pinned songs into a library search, and drops them from a refinement', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await pin(page, 'Song B').click()

  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({ json: { ...answer, plan: { ...plan, genres: ['Rock'] } } }),
  )
  await say(page, 'only rock')
  await expect(card(page)).toContainText('REVISION 3')
  expect(proposals.refines.at(-1)?.body.intent).toMatchObject({
    scope: 'library',
    filters: { exclude_ids: [a.id] },
    context: { keep_ids: [b.id], pinned_ids: [b.id], add_count: null },
  })
  // The server kept the pin first, and the card shows it pinned.
  await expect(pin(page, 'Song B')).toHaveAttribute('aria-pressed', 'true')

  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: { ...answer, plan: { ...plan, scope: 'proposal', exclude_artists: ['Orchard'] } },
    }),
  )
  await say(page, 'drop Orchard')
  await expect(card(page)).toContainText('REVISION 4')
  expect(proposals.refines.at(-1)?.body.intent).toMatchObject({
    scope: 'proposal',
    filters: { exclude_ids: [a.id] },
    context: { keep_ids: [], pinned_ids: [] },
  })
  // A refinement of a list has no draw to protect a song from, so the card offers no pins.
  await expect(pin(page, 'Song B')).toHaveCount(0)
  await expect(another(page)).toHaveCount(0)
})

test('an edit whose reply was lost is sent again with the same operation id and lands once', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  // The server writes the revision and the reply never arrives.
  proposals.editFault = (_body, count) => (count === 1 ? 'drop-after' : undefined)
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(rows(page)).toHaveCount(4)
  expect(proposals.edits).toHaveLength(2)
  expect(proposals.edits[1]?.operation_id).toBe(proposals.edits[0]?.operation_id)
  expect(proposals.written).toHaveLength(1)
  await expect(card(page).locator('[data-bot="problem"]')).toHaveCount(0)
  // The next press is a new operation.
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 3')
  expect(proposals.edits.at(-1)?.operation_id).not.toBe(proposals.edits[0]?.operation_id)
  await expect(rows(page)).toHaveCount(5)
})

test('an edit with no answer twice asks, and Check again uses the same operation id', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.editFault = (_body, count) => (count <= 2 ? 'drop-before' : undefined)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('I can’t tell if that went through.')
  expect(proposals.written).toHaveLength(0)
  // Nothing else can be started while it is unsettled.
  await expect(addSong(page)).toBeDisabled()
  await expect(another(page)).toBeDisabled()
  await problem.getByRole('button', { name: 'Check again' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.edits).toHaveLength(3)
  expect(new Set(proposals.edits.map((body) => body.operation_id)).size).toBe(1)
  expect(proposals.written).toHaveLength(1)
})

test('a preview refined elsewhere says it changed, makes no new proposal, and Refresh preview shows the current one', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.refineElsewhere()
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.written).toHaveLength(0)
  await expect(rows(page)).toHaveCount(3)
  await expect(addSong(page)).toBeDisabled()
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(problem).toHaveCount(0)
  // Reading the current revision is not a new proposal either.
  expect(proposals.creates).toHaveLength(1)
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 3')
  await expect(rows(page)).toHaveCount(4)
})

test('a preview that is gone says so, and storing it again waits for Refresh preview', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.prune()
  await another(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
  await expect(rows(page)).toHaveCount(3)
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(page.getByText('That preview was gone, so I stored this list again.')).toBeVisible()
  expect(proposals.creates).toHaveLength(2)
  await expect(rows(page)).toHaveCount(3)
  await expect(problem).toHaveCount(0)
})

test('a chat add on a preview refined elsewhere is not made, and no proposal is made in its place', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.refineElsewhere()
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: { ...answer, plan: { ...plan, add_count: 1, limit: 4 }, tracks: [a, b, c, f] },
    }),
  )
  await say(page, 'add another song')
  await expect(card(page).locator('[data-bot="problem"]')).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.written).toHaveLength(0)
  await expect(rows(page)).toHaveCount(3)
})

test('the edit controls wait while an edit, a request or a confirmation is running', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  let release: (() => void) | undefined
  proposals.holdEdit = new Promise<void>((resolve) => {
    release = resolve
  })
  await addSong(page).click()
  await expect(addSong(page)).toBeDisabled()
  await expect(another(page)).toBeDisabled()
  await expect(pin(page, 'Song A')).toBeDisabled()
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove from this list' })).toBeDisabled()
  await page.keyboard.press('Escape')
  release?.()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(addSong(page)).toBeEnabled()
  // A confirmation in flight holds them too.
  let confirm: (() => void) | undefined
  proposals.hold = new Promise<void>((resolve) => {
    confirm = resolve
  })
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect(addSong(page)).toBeDisabled()
  await expect(another(page)).toBeDisabled()
  confirm?.()
  await expect(card(page)).toContainText('IN YOUR QUEUE')
})

test('a cancelled edit leaves the card as it was', async ({ page, isMobile }) => {
  await fixtures(page)
  await open(page, isMobile)
  let release: (() => void) | undefined
  proposals.holdEdit = new Promise<void>((resolve) => {
    release = resolve
  })
  await addSong(page).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  await expect(rows(page)).toHaveCount(3)
  await expect(card(page)).not.toContainText('REVISION 2')
  await expect(addSong(page)).toBeEnabled()
  release?.()
})

test('"less aggressive, keep the tempo" is refused with the reason, and the open card is left alone', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  // What the server answers while no energy measurement is on: a refusal with tag-based
  // alternatives, never a guess from genre or title.
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: {
        plan: {
          ...plan,
          action: 'unsupported',
          explanation: 'Tempo and energy need audio analysis, which is not enabled.',
          suggestions: ['Songs from the 90s'],
        },
        tracks: [],
        total_seconds: 0,
        shortfall_seconds: 0,
        summary: 'Tempo and energy need audio analysis, which is not enabled.',
        elapsed_ms: 4,
      },
    }),
  )
  await say(page, 'less aggressive, keep the tempo')
  await expect(
    page.getByText('Tempo and energy need audio analysis, which is not enabled.').first(),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Songs from the 90s' })).toBeVisible()
  expect(proposals.creates).toHaveLength(1)
  expect(proposals.refines).toHaveLength(0)
  expect(proposals.edits).toHaveLength(0)
  await expect(rows(page)).toHaveCount(3)
  await expect(card(page)).toContainText('PREVIEW, NOT APPLIED')
})

test('a stored older preview with no edit fields still opens, and edits', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  // What an older build left in the tab: an intent without removed, kept or pinned songs.
  await page.evaluate(() => {
    const raw = sessionStorage.getItem('musimo.music-bot.preview')
    if (!raw) throw new Error('No stored preview')
    const stored: {
      intent: { filters: Record<string, unknown>; context: Record<string, unknown> }
    } = JSON.parse(raw)
    delete stored.intent.filters.exclude_ids
    for (const key of ['keep_ids', 'pinned_ids', 'add_count']) delete stored.intent.context[key]
    sessionStorage.setItem('musimo.music-bot.preview', JSON.stringify(stored))
  })
  await page.reload()
  await expect(rows(page)).toHaveCount(3)
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'false')
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
})

test('the Windows 95 list pins and edits too', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The skin is a desktop look.')
  await fixtures(page)
  const win95 = BUILT_IN_THEMES.find((entry) => entry.id === 'win95-light')
  if (!win95) throw new Error('No Windows 95 theme')
  await page.goto('/settings/user')
  await page.getByText(win95.name, { exact: true }).first().click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'win95')
  await open(page, false)
  await expect(page.locator('[data-bot="list-view"]')).toBeVisible()
  await pin(page, 'Song A').click()
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'true')
  await another(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.edits[0]).toMatchObject({ edit: { kind: 'another', pinned_ids: [a.id] } })
  // Pressing a pin does not make the row the reference song.
  await expect(page.getByText('Reference')).toHaveCount(0)
})

test('Refresh preview leaves out a kept song that left the library, and says so', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(rows(page)).toHaveCount(4)
  // The file is deleted. The next confirmation is refused as stale and names the song.
  deleted.add(b.id)
  proposals.deleteSong(b.id)
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview is out of date.')
  await expect(problem).toContainText('Song B: not in the library')
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 3')
  // The request left the gone song out of the kept songs, so the server did not refuse it.
  const sent = record(record(proposals.refines.at(-1)?.body.intent).context)
  expect(strings(sent.keep_ids)).not.toContain(b.id)
  expect(strings(sent.keep_ids).length).toBeGreaterThan(0)
  await expect(page.getByText('1 song no longer in your library was dropped.')).toBeVisible()
  await expect(problem).toHaveCount(0)
  // What is left of the kept songs. The stand-in's search adds nothing to them.
  expect(await titles(rows(page))).toEqual(['Song A', 'Song C'])
})

test('Refresh preview on a refined list leaves out a song that left the library, and says so', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({
      json: { ...answer, plan: { ...plan, scope: 'proposal' } },
    }),
  )
  // A refinement of the list on the card. The stand-in keeps every song of it.
  await say(page, 'just these')
  await expect(card(page)).toContainText('REVISION 2')
  expect(await titles(rows(page))).toEqual(['Song A', 'Song B', 'Song C'])
  // The file is deleted. A refinement must leave proposal_ids out, so the card cannot drop the
  // song itself: the server leaves it out of the stored list and says which.
  deleted.add(c.id)
  proposals.deleteSong(c.id)
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('Song C: not in the library')
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 3')
  expect(record(proposals.refines.at(-1)?.body.intent)).toMatchObject({
    scope: 'proposal',
    context: { proposal_ids: [] },
  })
  await expect(page.getByText('1 song no longer in your library was dropped.')).toBeVisible()
  await expect(problem).toHaveCount(0)
  await expect(card(page).locator('[data-bot="missing"]')).toHaveCount(0)
  expect(await titles(rows(page))).toEqual(['Song A', 'Song B'])
  // And it confirms.
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  await expect.poll(() => proposals.handed.at(-1)).toEqual([a.id, b.id])
})

test('a chat follow-up that refines a list says which songs left the library', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({ json: { ...answer, plan: { ...plan, scope: 'proposal' } } }),
  )
  await say(page, 'just these')
  await expect(card(page)).toContainText('REVISION 2')
  deleted.add(c.id)
  proposals.deleteSong(c.id)
  await say(page, 'just these again')
  await expect(card(page)).toContainText('REVISION 3')
  await expect(page.getByText('1 song no longer in your library was dropped.')).toBeVisible()
  expect(await titles(rows(page))).toEqual(['Song A', 'Song B'])
})

test('an edit refused because a kept song left the library lists it, and Refresh preview leaves it out', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  deleted.add(b.id)
  proposals.deleteSong(b.id)
  // Nothing on the card says the song is gone yet. The refusal makes the card read the revision.
  await addSong(page).click()
  const missing = card(page).locator('[data-bot="missing"]')
  await expect(missing).toContainText('1 song in this preview is no longer in your library.')
  await expect(rows(page)).toHaveCount(3)
  expect(proposals.written).toHaveLength(1)
  await missing.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 3')
  await expect(missing).toHaveCount(0)
  expect(
    strings(record(record(proposals.refines.at(-1)?.body.intent).context).keep_ids),
  ).not.toContain(b.id)
  // And the card edits again.
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 4')
})

test('a kept song that cannot play is named, stays, and is the one thing that can be removed', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 2')
  proposals.breakSong(b.id)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('A kept song can’t play right now: Song B.')
  expect(proposals.written).toHaveLength(1)
  // Nothing was dropped, and everything else waits.
  await expect(rows(page)).toHaveCount(4)
  await expect(addSong(page)).toBeDisabled()
  await expect(another(page)).toBeDisabled()
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove from this list' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await card(page).getByRole('button', { name: 'More actions for Song B' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(card(page)).toContainText('REVISION 3')
  await expect(problem).toHaveCount(0)
  await expect(rows(page)).toHaveCount(3)
  expect(proposals.edits.at(-1)).toMatchObject({ edit: { kind: 'remove', ids: [b.id] } })
  await addSong(page).click()
  await expect(card(page)).toContainText('REVISION 4')
})

test('a pin the server has not seen survives a remove', async ({ page, isMobile }) => {
  await fixtures(page)
  await open(page, isMobile)
  await pin(page, 'Song B').click()
  await card(page).getByRole('button', { name: 'More actions for Song A' }).click()
  await page.getByRole('menuitem', { name: 'Remove from this list' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(pin(page, 'Song B')).toHaveAttribute('aria-pressed', 'true')
  // It is still sent: the next Another set keeps it.
  await another(page).click()
  await expect(card(page)).toContainText('REVISION 3')
  expect(proposals.edits.at(-1)).toMatchObject({ edit: { kind: 'another', pinned_ids: [b.id] } })
})

test('a pin the server has not seen survives a refresh', async ({ page, isMobile }) => {
  await fixtures(page)
  await open(page, isMobile)
  await pin(page, 'Song C').click()
  proposals.fault = () => 'stale'
  await card(page).getByRole('button', { name: 'Add to queue', exact: true }).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  await expect(pin(page, 'Song C')).toHaveAttribute('aria-pressed', 'true')
  await expect(pin(page, 'Song A')).toHaveAttribute('aria-pressed', 'false')
})

test('while an edit has no answer the chat cannot start another request', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  let chats = 0
  await page.route('**/api/music-bot/chat', (route) => {
    chats += 1
    return route.fulfill({
      json: { ...answer, plan: { ...plan, add_count: 1, limit: 4 }, tracks: [a, b, c, f] },
    })
  })
  proposals.editFault = (_body, count) => (count <= 2 ? 'drop-after' : undefined)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('I can’t tell if that went through.')
  // The lost attempt did land. Typing the same request cannot send it as a second one.
  await box(page).fill('add a song')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await box(page).press('Enter')
  expect(chats).toBe(0)
  await expect(card(page).getByRole('button', { name: 'Remove filter' })).toHaveCount(0)
  await problem.getByRole('button', { name: 'Check again' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.written).toHaveLength(1)
  expect(new Set(proposals.edits.map((body) => body.operation_id)).size).toBe(1)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('a cancelled Check again still offers Check again with the same operation id', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.editFault = (_body, count) => (count <= 2 ? 'drop-before' : undefined)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  const check = problem.getByRole('button', { name: 'Check again' })
  await expect(check).toBeVisible()
  let release: (() => void) | undefined
  proposals.holdEdit = new Promise<void>((resolve) => {
    release = resolve
  })
  await check.click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  // Whether the cancelled check landed is still not known, so the hold stays and so does its id.
  await expect(check).toBeEnabled()
  await expect(addSong(page)).toBeDisabled()
  release?.()
  proposals.holdEdit = undefined
  await expect.poll(() => proposals.edits.length).toBe(3)
  await check.click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(new Set(proposals.edits.map((body) => body.operation_id)).size).toBe(1)
  expect(proposals.written).toHaveLength(1)
})

test('a Check again that is refused ends the hold, so the chat is not left waiting', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.editFault = (_body, count) => (count <= 2 ? 'drop-before' : undefined)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('I can’t tell if that went through.')
  // A definite answer that nothing was edited: the library changed while it ran.
  await page.route(/\/api\/music-bot\/proposals\/pr-[0-9a-f]{16}\/edits$/, (route) =>
    route.fulfill({
      status: 409,
      json: {
        contract_version: 5,
        status: 'error',
        error: {
          code: 'snapshot_changed',
          message: 'The library changed while the request ran. Try again.',
          fields: [],
        },
      },
    }),
  )
  await problem.getByRole('button', { name: 'Check again' }).click()
  await expect(problem).toHaveCount(0)
  await expect(addSong(page)).toBeEnabled()
  await box(page).fill('add a song')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('every press makes its own operation id, even for the same edit of the same revision', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  let release: (() => void) | undefined
  proposals.holdEdit = new Promise<void>((resolve) => {
    release = resolve
  })
  await addSong(page).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible()
  release?.()
  proposals.holdEdit = undefined
  await expect.poll(() => proposals.edits.length).toBe(1)
  await addSong(page).click()
  await expect.poll(() => proposals.edits.length).toBe(2)
  expect(proposals.edits[1]?.operation_id).not.toBe(proposals.edits[0]?.operation_id)
})

test('a chat follow-up on a preview refined elsewhere says it changed and makes no new proposal', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  await page.route('**/api/music-bot/chat', (route) =>
    route.fulfill({ json: { ...answer, plan: { ...plan, genres: ['Rock'] } } }),
  )
  proposals.refineElsewhere()
  await say(page, 'only rock')
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
  await expect(rows(page)).toHaveCount(3)
  await problem.getByRole('button', { name: 'Refresh preview' }).click()
  await expect(card(page)).toContainText('REVISION 2')
  expect(proposals.creates).toHaveLength(1)

  // The same when the proposal is gone.
  proposals.prune()
  await say(page, 'only rock again')
  await expect(problem).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
})

test('Check again on a proposal that was pruned says it changed, not that the id was reused', async ({
  page,
  isMobile,
}) => {
  await fixtures(page)
  await open(page, isMobile)
  proposals.editFault = (_body, count) => (count <= 2 ? 'drop-after' : undefined)
  await addSong(page).click()
  const problem = card(page).locator('[data-bot="problem"]')
  await expect(problem).toContainText('I can’t tell if that went through.')
  proposals.prune()
  await problem.getByRole('button', { name: 'Check again' }).click()
  await expect(problem).toContainText('This preview changed.')
  expect(proposals.creates).toHaveLength(1)
})
