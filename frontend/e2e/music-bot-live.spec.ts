import { expect, test } from '@playwright/test'

import {
  libraryPlaylistDetailSchema,
  libraryTracksSchema,
  playerQueueSchema,
  settingsSchema,
} from '../src/api'

test('live Ollama interprets, refines and applies real library songs through the browser', async ({
  page,
  request,
}, info) => {
  test.skip(
    !process.env.MUSIMO_LIVE_OLLAMA,
    'Opt in with an Ollama URL reachable from the isolated server.',
  )
  test.setTimeout(180_000)
  const old = settingsSchema.parse(await (await request.get('/api/settings')).json())
  try {
    expect(
      (
        await request.patch('/api/settings', {
          data: {
            ollama_url: process.env.MUSIMO_LIVE_OLLAMA,
            ollama_model: process.env.MUSIMO_LIVE_MODEL ?? 'qwen2.5-coder:7b',
            music_timezone: 'Pacific/Honolulu',
          },
        })
      ).ok(),
    ).toBeTruthy()
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
    const liked = libraryPlaylistDetailSchema.parse(
      await (await request.get('/api/library/playlists/liked')).json(),
    )
    for (const song of songs)
      await request.post(`/api/library/playlists/${liked.id}/songs`, {
        data: { song_id_to_add: song.id },
      })
    const today = songs.find((song) => song.title === 'Bot Played Today')!
    await request.post('/api/player/scrobble', { data: { id: today.id, submission: true } })
    await request.put('/api/player/queue', { data: { ids: [], current: '', position: 0 } })
    await page.goto('/music-bot')
    const box = page.getByRole('textbox', { name: /^Ask .+ for music$/ })
    await box.fill('Queue an hour of my favourite 90s music, excluding songs played today.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const proposal = page.getByRole('list', { name: 'Proposed songs' })
    await expect(proposal.getByRole('listitem')).toHaveCount(2, { timeout: 100_000 })
    await expect(proposal).not.toContainText('Bot Played Today')
    await expect(proposal).not.toContainText('Bot Eighties')
    await expect(page.getByText(/59\.0 minutes short/).first()).toBeVisible()
    await proposal
      .getByRole('listitem')
      .filter({ hasText: 'Bot Harbor' })
      .getByRole('button', { name: /^More actions for/ })
      .click()
    await page.getByRole('menuitem', { name: 'Use as reference' }).click()
    await box.fill('remove that artist')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(proposal.getByRole('listitem')).toHaveCount(1, { timeout: 100_000 })
    await expect(proposal).toContainText('Bot Orchard')
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click()
    const audio = page.locator('audio.library-audio[data-role="active"]')
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
      .toBeGreaterThan(0)

    await expect
      .poll(async () =>
        playerQueueSchema
          .parse(await (await request.get('/api/player/queue')).json())
          .entry.map((song) => song.id),
      )
      .toEqual([songs.find((song) => song.title === 'Bot Orchard')!.id])
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: `../runtime/milestone1/live-${info.project.name}.png`,
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect
      .poll(
        async () =>
          playerQueueSchema.parse(await (await request.get('/api/player/queue')).json()).entry,
      )
      .toEqual([])
  } finally {
    await request.patch('/api/settings', {
      data: {
        ollama_url: old.ollama_url.value,
        ollama_model: old.ollama_model.value,
        music_timezone: old.music_timezone.value,
      },
    })
  }
})
