import type { APIRequestContext } from '@playwright/test'
import { z } from 'zod'

import {
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  libraryTracksSchema,
  playerQueueSchema,
} from '../src/api'
import { generatedPlayerAudio } from './library-fixtures'
import { botModelFixtures } from './proposal-fixtures'
import { expect, test } from './test'

/* The chat's preview, confirmation and stale path against the real proposal routes, SQLite and
   scanner, on the generated tagged files global setup writes. Only the language model is
   replaced: the chat route returns a fixed plan, as music-bot.spec.ts does. What the server
   makes of that plan (its songs, summary, sample and receipts) is the server's own. */

const plan = {
  change_filters: [],
  allow_artists: [],
  add_count: 0,
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: [],
  genres: ['Rock'],
  year_from: null,
  year_to: null,
  favourites: true,
  history: 'any',
  exclude_played_days: 0,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 0,
  limit: 100,
  similar_to_current: false,
  explanation: '',
}

async function likedPlaylist(request: APIRequestContext) {
  return libraryPlaylistDetailSchema.parse(
    await (await request.get('/api/library/playlists/liked')).json(),
  )
}

test('a preview from the real routes: summary, save, queue, a like removed, refresh', async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000)
  await request.post('/api/library/scan')
  await expect
    .poll(
      async () =>
        libraryTracksSchema.parse(await (await request.get('/api/library/tracks?q=Bot')).json())
          .items.length,
    )
    .toBe(4)
  const songs = libraryTracksSchema.parse(
    await (await request.get('/api/library/tracks?q=Bot')).json(),
  ).items
  const before = await likedPlaylist(request)
  const playlistName = `Preview check ${info.project.name}`
  try {
    for (const song of songs) {
      if (before.entry.some((liked) => liked.id === song.id)) continue
      await request.post(`/api/library/playlists/${before.id}/songs`, {
        data: { song_id_to_add: song.id },
      })
    }
    await request.put('/api/player/queue', { data: { ids: [], current: '', position: 0 } })
    await generatedPlayerAudio(page)
    await botModelFixtures(page)
    if (!info.project.name.includes('mobile'))
      await page.setViewportSize({ width: 1100, height: 1000 })
    await page.route('**/api/music-bot/chat', (route) =>
      route.fulfill({
        json: {
          plan,
          tracks: songs,
          total_seconds: 120,
          shortfall_seconds: 0,
          summary: 'the chat’s own sentence',
          elapsed_ms: 4,
          generation_seed: 11,
        },
      }),
    )
    const card = page.locator('[data-bot="card"]').last()
    await page.goto('/music-bot')
    // The card's top at the top of the view, which is the part worth looking at.
    const shot = async (name: string) => {
      await card.evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `../runtime/bot-preview/${name}-${info.project.name}.png` })
    }
    await page
      .getByRole('textbox', { name: /^Ask .+ for music$/ })
      .fill('my favourite rock, as a preview')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const list = card.getByRole('list', { name: 'Proposed songs' })

    // The server's own summary and facts, read from the four generated songs.
    await expect(list.getByRole('listitem')).toHaveCount(4)
    await expect(card).toContainText('4 songs, 2.0 minutes.')
    await expect(card).not.toContainText('the chat’s own sentence')
    const facts = card.getByLabel('About this preview')
    await expect(facts).toContainText('2 artists')
    await expect(facts).toContainText('Rock (4)')
    await expect(facts).toContainText('1985–1998')
    await expect(facts).not.toContainText(/BPM|tempo/i)
    expect(
      playerQueueSchema.parse(await (await request.get('/api/player/queue')).json()).entry,
    ).toEqual([])
    await shot('preview')

    // Save: a playlist of exactly the four, once.
    await card.getByRole('button', { name: 'Save as playlist' }).click()
    await card.getByLabel('Playlist name').fill(playlistName)
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(`Saved as the playlist “${playlistName}”.`)).toBeVisible()
    const playlists = libraryPlaylistsSchema.parse(
      await (await request.get('/api/library/playlists')).json(),
    ).items
    const made = playlists.filter((entry) => entry.name === playlistName)
    expect(made).toHaveLength(1)
    expect(made[0]?.songCount).toBe(4)

    // Queue: the receipt's ids go to the player, which saves them.
    await card.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect(card).toContainText('IN YOUR QUEUE')
    await expect
      .poll(async () =>
        playerQueueSchema
          .parse(await (await request.get('/api/player/queue')).json())
          .entry.map((song) => song.id)
          .sort(),
      )
      .toEqual(songs.map((song) => song.id).sort())
    await card.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Replace upcoming' })).toBeVisible()

    // A like is removed behind the preview. The Liked playlist is what this request depends on.
    const liked = await likedPlaylist(request)
    const victim = songs.find((song) => song.title === 'Bot Orchard')
    const at = liked.entry.findIndex((song) => song.id === victim?.id)
    expect(at).toBeGreaterThanOrEqual(0)
    await request.post(`/api/library/playlists/${liked.id}/songs`, {
      data: { song_index_to_remove: at },
    })
    await card.getByRole('button', { name: 'Replace upcoming' }).click()
    const problem = card.locator('[data-bot="problem"]')
    await expect(problem).toContainText('This preview is out of date.')
    await expect(problem).toContainText('Bot Orchard: like changed')
    // Nothing was queued, and the list still shows the four it was.
    await expect(list.getByRole('listitem')).toHaveCount(4)
    expect(
      playerQueueSchema.parse(await (await request.get('/api/player/queue')).json()).entry,
    ).toEqual([])

    await shot('stale')

    await problem.getByRole('button', { name: 'Refresh preview' }).click()
    await expect(
      page.getByText('Refreshed the preview: 1 song left. Check it before you confirm.'),
    ).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(list).not.toContainText('Bot Orchard')
    await expect(card).toContainText('REVISION 2')
    await card.getByRole('button', { name: 'Replace upcoming' }).click()
    await expect(card).toContainText('IN YOUR QUEUE')
  } finally {
    // Back to the likes the stack had: a like this test removed returns, one it added goes.
    for (const song of songs) {
      const now = await likedPlaylist(request)
      const index = now.entry.findIndex((liked) => liked.id === song.id)
      const was = before.entry.some((liked) => liked.id === song.id)
      if (was && index < 0)
        await request.post(`/api/library/playlists/${now.id}/songs`, {
          data: { song_id_to_add: song.id },
        })
      else if (!was && index >= 0)
        await request.post(`/api/library/playlists/${now.id}/songs`, {
          data: { song_index_to_remove: index },
        })
    }
    for (const entry of libraryPlaylistsSchema
      .parse(await (await request.get('/api/library/playlists')).json())
      .items.filter((item) => item.name === playlistName))
      await request.delete(`/api/library/playlists/${entry.id}`)
    await request.put('/api/player/queue', { data: { ids: [], current: '', position: 0 } })
  }
})

test('the real server keeps shown songs across a reload, and Forget clears only them', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  await request.post('/api/library/scan')
  await expect
    .poll(
      async () =>
        libraryTracksSchema.parse(await (await request.get('/api/library/tracks?q=Bot')).json())
          .items.length,
    )
    .toBe(4)
  const songs = libraryTracksSchema.parse(
    await (await request.get('/api/library/tracks?q=Bot')).json(),
  ).items
  const memory = async () =>
    z
      .object({ revision: z.number(), results: z.number(), songs: z.number() })
      .parse(await (await request.get('/api/music-bot/memory')).json())
  const playlistCount = async () =>
    libraryPlaylistsSchema.parse(await (await request.get('/api/library/playlists')).json()).items
      .length
  const liked = (await likedPlaylist(request)).entry.length
  const playlists = await playlistCount()
  try {
    await request.delete('/api/music-bot/memory')
    await generatedPlayerAudio(page)
    await botModelFixtures(page)
    await page.route('**/api/music-bot/chat', (route) => {
      // The server's memory decides what goes last, so the browser sends no list of its own.
      expect(route.request().postDataJSON()).not.toHaveProperty('shown_ids')
      return route.fulfill({
        json: {
          plan: { ...plan, favourites: false },
          tracks: songs,
          total_seconds: 120,
          shortfall_seconds: 0,
          summary: 'the chat’s own sentence',
          elapsed_ms: 4,
          generation_seed: 11,
        },
      })
    })
    await page.goto('/music-bot')
    await page.getByRole('textbox', { name: /^Ask .+ for music$/ }).fill('some rock')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Proposed songs' })).toBeVisible()
    // The result was shown, so the server holds it: one answer, its four songs.
    await expect.poll(async () => (await memory()).songs).toBe(4)
    expect((await memory()).results).toBe(1)
    expect(await page.evaluate(() => sessionStorage.getItem('musimo.music-bot.shown'))).toBeNull()

    // Nothing is kept in the page, as on a second device, and it is still remembered.
    await page.evaluate(() => sessionStorage.clear())
    await page.reload()
    await page.getByRole('button', { name: 'Chat settings' }).click()
    const status = page.locator('[data-bot="memory-status"]')
    await expect(status).toHaveText('I am remembering 4 songs from 1 answer.')
    await expect(page.getByText(/This applies to every device\./)).toBeVisible()

    await page.getByRole('button', { name: 'Forget shown songs' }).click()
    await expect(status).toHaveText('I am not remembering any songs.')
    expect((await memory()).songs).toBe(0)
    // Likes and playlists are not touched.
    expect((await likedPlaylist(request)).entry.length).toBe(liked)
    expect(await playlistCount()).toBe(playlists)
  } finally {
    await request.delete('/api/music-bot/memory')
  }
})
