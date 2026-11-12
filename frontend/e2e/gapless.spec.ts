import type { APIRequestContext, Page } from '@playwright/test'

import { libraryAlbumsSchema, type LibraryTrack } from '../src/api'
import { NETWORK_RETRY_DELAY_MS } from '../src/features/player/network-retry'
import { PREFETCH_AFTER_SECONDS, PREFETCH_BYTES } from '../src/features/player/track-prefetch'
import { bodyText, librarySong, playerFixtures, requestBody } from './library-fixtures'
import { toasts } from './nav'
import { expect, test } from './test'

// The test stream is 30 seconds of silence whatever the song says, so the songs say the same.
const song = (id: string, title: string) => librarySong(id, { title, duration: 30 })
const alpha = song('song-a', 'Alpha')
const bravo = song('song-b', 'Bravo')
const charlie = song('song-c', 'Charlie')
const delta = song('song-d', 'Delta')
// Long enough for a request started at the prefetch point to have reached the page's listener.
const NO_PREFETCH_WAIT_MS = 1500
// How much sooner than the real end the hidden-tab test's songs say they end.
const EARLY_END = 5

type Scrobble = { id: string; submission: boolean }

/** Empties the saved queue. A refused clear would leave a song for every later page to restore. */
async function clearSavedQueue(request: APIRequestContext) {
  const response = await request.put('/api/player/queue', {
    data: { ids: [], current: '', position: 0 },
  })
  expect(response.status()).toBe(204)
}

// The cache test saves a real queue on the server, and every later page restores it. The page
// leaves the app first (it sends nothing on the way out), so no save from it can land after the
// clear. It is not closed: the `test` fixture still takes its routes down afterwards.
test.afterEach(async ({ page, request }) => {
  await page.goto('about:blank')
  await clearSavedQueue(request)
})

/**
 * Restores this queue with its first song loaded and not playing, answers 404 for the streams of
 * `unplayable`, and records every scrobble.
 */
async function restoreQueue(page: Page, queue: LibraryTrack[], unplayable: string[] = []) {
  const scrobbles: Scrobble[] = []
  // Pinned so the stage does not depend on the machine's graphics.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: queue[0]?.id ?? '', position: 0, entry: queue } }
        : { status: 204 },
    ),
  )

  await page.route('**/api/player/scrobble', async (route) => {
    const body = requestBody(route)
    scrobbles.push({ id: bodyText(body, 'id') ?? '', submission: body.submission === true })
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  for (const id of unplayable)
    await page.route(`**/api/player/stream/${id}`, (route) => route.fulfill({ status: 404 }))
  return scrobbles
}

/** Starts the restored queue and moves the playing song to its last seconds. */
async function playToTheEnd(page: Page, seconds = 27, path = '/') {
  await page.goto(path)
  // Now Playing has no footer. Its heading is the song.
  const player =
    path === '/now-playing'
      ? page.getByRole('heading', { level: 1 })
      : page.getByRole('contentinfo')
  await expect(player).toContainText('Alpha')
  await page.keyboard.press('Space')
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  await active.evaluate((element: HTMLAudioElement, at) => {
    element.currentTime = at
  }, seconds)
}

test('the next song loads into the standby element and takes over when the song ends', async ({
  page,
}) => {
  const scrobbles = await restoreQueue(page, [alpha, bravo, charlie])
  await playToTheEnd(page)
  const active = page.locator('audio.library-audio[data-role="active"]')
  const standby = page.locator('audio.library-audio[data-role="standby"]')

  // Loaded while Alpha still plays, then the two swap roles.
  await expect(standby).toHaveAttribute('src', /song-b/)
  await expect(active).toHaveAttribute('src', /song-b/, { timeout: 15_000 })
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  // What follows the element is the song, not the element.
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title ?? ''))
    .toBe('Bravo')
  await expect.poll(() => scrobbles).toContainEqual({ id: 'song-a', submission: true })
  await expect.poll(() => scrobbles).toContainEqual({ id: 'song-b', submission: false })
})

test('a hidden tab with slow timers starts the next song before the last one ends', async ({
  page,
  browserName,
}) => {
  // Chromium lets a worker's timers run while audio plays in a hidden tab. WebKit and Firefox hold
  // them back too, and there the `ended` event does the handover, as it did before the worker.
  test.skip(browserName !== 'chromium', 'Only Chromium keeps worker timers unthrottled.')
  // A hidden tab holds the page's timers to about one a second. The clock is installed before the
  // page loads and frozen once the song plays, which is slower still: the only timer that can run
  // is the worker's. Media events are not timers, so the audio and its events carry on.
  await page.clock.install()
  await page.addInitScript((earlyEnd) => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true })
    // What the media elements report, in order. Media events do not bubble, so this listens while
    // they travel down.
    const log: string[] = []
    Object.assign(window, { audioLog: log })
    for (const type of ['play', 'ended'])
      document.addEventListener(
        type,
        (event) => {
          const src = (event.target as HTMLAudioElement).getAttribute('src') ?? ''
          log.push(`${type}:${src.split('/').pop()}`)
        },
        true,
      )
    // The library elements say each stream is five seconds shorter than it is, and the songs say
    // the same. The player then times the handover for an end five seconds before the real one,
    // so `ended` cannot get there first however busy the machine is. Left to the real end, the
    // handover is 40 ms early, and a loaded machine lets `ended` win that race.
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration')?.get
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get(this: HTMLMediaElement) {
        const length = real?.call(this) as number
        return this.classList.contains('library-audio') && Number.isFinite(length)
          ? length - earlyEnd
          : length
      },
    })
  }, EARLY_END)
  const early = (track: LibraryTrack) => ({ ...track, duration: 30 - EARLY_END })
  await restoreQueue(page, [alpha, bravo, charlie].map(early))
  await playToTheEnd(page, 27 - EARLY_END)
  await expect(page.locator('audio.library-audio[data-role="standby"]')).toHaveAttribute(
    'src',
    /song-b/,
  )
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)

  const log = () => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog)
  await expect
    .poll(async () => (await log()).includes('play:song-b'), { timeout: 15_000 })
    .toBe(true)

  // Bravo started while Alpha was still playing, so it was the worker that did it, not `ended`.
  expect(await log()).not.toContain('ended:song-a')
})

test('both library elements feed the analyser, so the visualizer survives a handover', async ({
  page,
}) => {
  // The picture is not checked here, only the audio graph: count the distinct elements that get a
  // source on it. One would mean every other song plays past the analyser.
  await page.addInitScript(() => {
    const wired = new Set<HTMLMediaElement>()
    const create = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (element) {
      // Only the library pair counts.
      if (element.classList.contains('library-audio')) wired.add(element)
      document.documentElement.dataset.wired = String(wired.size)
      return create.call(this, element)
    }
  })
  await restoreQueue(page, [alpha, bravo])
  await playToTheEnd(page)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo', { timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-wired', '2')
})

test('a quiet track is boosted the same on both library elements', async ({ page }) => {
  // +6 dB is about twice as loud, and a peak of 0.3 leaves room for it. At full volume the
  // element cannot go past 1, so the rest has to come from that element's gain stage, and both
  // elements must have one or every other track would miss it.
  const quiet = (id: string, title: string) =>
    librarySong(id, {
      title,
      duration: 30,
      replayGain: { trackGain: 6, trackPeak: 0.3 },
    })
  await page.addInitScript(() => {
    localStorage.setItem('musimo.player-volume', '1')
    const boosts = new Map<HTMLMediaElement, GainNode>()
    const source = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (element) {
      const node = source.call(this, element)
      const connect = node.connect.bind(node)
      node.connect = ((target: AudioNode) => {
        if (target instanceof GainNode) boosts.set(element, target)
        return connect(target)
      }) as typeof node.connect

      return node
    }

    // Read back by the test: the gain on whichever library element is playing.
    Object.assign(window, {
      playingBoost: () => {
        const active = document.querySelector<HTMLAudioElement>(
          'audio.library-audio[data-role="active"]',
        )
        return active ? (boosts.get(active)?.gain.value ?? 0) : 0
      },
    })
  })
  await restoreQueue(page, [quiet('song-a', 'Alpha'), quiet('song-b', 'Bravo')])
  await playToTheEnd(page)
  const boost = () =>
    page.evaluate(() => (window as unknown as { playingBoost: () => number }).playingBoost())

  await expect.poll(boost).toBeCloseTo(10 ** (6 / 20), 1)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo', { timeout: 15_000 })
  await expect.poll(boost).toBeCloseTo(10 ** (6 / 20), 1)
})

/** The stream ids fetched by the prefetcher, as opposed to the audio elements. */
function prefetchedStreams(page: Page) {
  const ids: string[] = []
  page.on('request', (request) => {
    const match = /\/api\/player\/stream\/([^/?]+)/.exec(request.url())
    if (match?.[1] && request.resourceType() === 'fetch') ids.push(match[1])
  })

  return ids
}

test('the next two songs are fetched ahead from the fifth second, long before the standby element loads', async ({
  page,
}) => {
  // Counts the position updates a playing song makes in the second before the prefetch point, so
  // the check that nothing was fetched yet is made after the player has really seen that second.
  await page.addInitScript(
    (before) => {
      const seen = { ticks: 0 }
      Object.assign(window, { ticksBeforePrefetch: seen })
      document.addEventListener(
        'timeupdate',
        (event) => {
          const element = event.target
          if (!(element instanceof HTMLAudioElement) || element.dataset.role !== 'active') return
          if (
            !element.paused &&
            element.currentTime >= before.from &&
            element.currentTime < before.to
          )
            seen.ticks += 1
        },
        true,
      )
    },
    { from: PREFETCH_AFTER_SECONDS - 1, to: PREFETCH_AFTER_SECONDS },
  )
  await restoreQueue(page, [alpha, bravo, charlie, delta])
  const prefetched = prefetchedStreams(page)
  // One second before the point, and well before the last 15 seconds when the standby loads.
  await playToTheEnd(page, PREFETCH_AFTER_SECONDS - 1)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { ticksBeforePrefetch: { ticks: number } }).ticksBeforePrefetch
            .ticks,
      ),
    )
    .toBeGreaterThanOrEqual(2)
  expect(prefetched).toEqual([])
  // Then, once it passes the point, both are fetched.
  await expect.poll(() => prefetched).toEqual(['song-b', 'song-c'])
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).not.toHaveAttribute('src', /song-b/)
})

test('the prefetched start of the next song answers the element from the browser cache', async ({
  page,
  request,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Only Chromium has the DevTools protocol.')
  test.setTimeout(60_000)
  // No stream mock: a mocked response is never cached, and any route turns the cache off for the
  // whole page. The real stream route, the real local files and the real cache have to agree.
  // A saved queue would be restored on load, and its song's stream requested before the prefetch,
  // so the second song's first request would not be the prefetch this test looks for.
  await clearSavedQueue(request)
  expect((await request.post('/api/library/scan')).ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/library/albums?q=Prefetch%20Cache%20Fixture')
        return libraryAlbumsSchema.parse(await response.json()).items.length
      },
      { timeout: 30_000 },
    )
    .toBe(1)
  const response = await request.get('/api/library/albums?q=Prefetch%20Cache%20Fixture')
  const album = libraryAlbumsSchema.parse(await response.json()).items[0]!
  // The listener fixture's route would switch the cache off. The page keeps the name it stored.
  await page.unroute('**/api/listeners')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const streams = new Map<string, { requestId: string; type: string }[]>()
  const servedFromCache = new Set<string>()
  // What each stream request was answered with, and how many bytes it read: all of them, and
  // those that came over the network rather than out of the cache.
  const answers = new Map<string, { status: number; contentRange: string }>()
  const read = new Map<string, { bytes: number; network: number }>()
  cdp.on('Network.requestWillBeSent', (event) => {
    const id = /\/api\/player\/stream\/([^/?]+)/.exec(event.request.url)?.[1]
    if (id)
      streams.set(id, [
        ...(streams.get(id) ?? []),
        { requestId: event.requestId, type: event.type ?? '' },
      ])
  })
  // Chrome says "served from cache" in two ways: this event for its memory cache, and a flag on
  // the response for its disk cache. A media request is answered from the disk cache.
  cdp.on('Network.requestServedFromCache', (event) => servedFromCache.add(event.requestId))
  cdp.on('Network.responseReceived', (event) => {
    if (event.response.fromDiskCache) servedFromCache.add(event.requestId)
    const range = Object.entries(event.response.headers).find(
      ([name]) => name.toLowerCase() === 'content-range',
    )
    answers.set(event.requestId, {
      status: event.response.status,
      contentRange: range ? String(range[1]) : '',
    })
  })

  cdp.on('Network.dataReceived', (event) => {
    const before = read.get(event.requestId) ?? { bytes: 0, network: 0 }
    read.set(event.requestId, {
      bytes: before.bytes + event.dataLength,
      network: before.network + event.encodedDataLength,
    })
  })

  await page.goto(`/library/albums/${album.id}`)
  await page.getByRole('button', { name: 'Play all', exact: true }).click()
  const active = page.locator('audio.library-audio[data-role="active"]')
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime), {
      timeout: 15_000,
    })
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)

  // The prefetch is a fetch() for the second song, made while the first still plays.
  await expect
    .poll(() => [...streams.values()].flat().filter((item) => item.type === 'Fetch').length)
    .toBe(1)
  const [secondId] = [...streams.entries()].find(([, items]) => items[0]?.type === 'Fetch') ?? []
  expect(secondId).toBeTruthy()
  // It asked for the first part of the file and was given just that. The song is bigger than
  // that, so the rest was not fetched ahead. Without the Range header the whole file would come
  // back as a 200, and the cache would not keep it.
  const prefetch = streams.get(secondId!)!.find((item) => item.type === 'Fetch')!
  await expect.poll(() => read.get(prefetch.requestId)?.bytes).toBe(PREFETCH_BYTES)
  const answer = answers.get(prefetch.requestId)
  expect(answer?.status).toBe(206)
  const size = Number(/^bytes 0-(\d+)\/(\d+)$/.exec(answer?.contentRange ?? '')?.[2])
  expect(answer?.contentRange).toBe(`bytes 0-${PREFETCH_BYTES - 1}/${size}`)
  expect(size).toBeGreaterThan(PREFETCH_BYTES)

  // Into the last 15 seconds, when the standby element loads the second song.
  await active.evaluate((element: HTMLAudioElement) => {
    element.currentTime = element.duration - 10
  })
  await expect(standby).toHaveAttribute('src', new RegExp(`/${secondId}$`))
  await expect
    .poll(() => (streams.get(secondId!) ?? []).some((item) => item.type === 'Media'))
    .toBe(true)
  const firstMedia = streams.get(secondId!)!.find((item) => item.type === 'Media')!
  await expect.poll(() => servedFromCache.has(firstMedia.requestId)).toBe(true)
  // The element has read well into the song by now. What it read from the first part came out of
  // the cache; only what lay past the prefetch, if it got that far, came over the network.
  await expect
    .poll(() => read.get(firstMedia.requestId)?.bytes ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(1024 * 1024)
  const media = read.get(firstMedia.requestId)!
  expect(media.network).toBeLessThanOrEqual(Math.max(0, media.bytes - PREFETCH_BYTES) + 64 * 1024)
})

test('the next Deezer song is prepared only in the last minute of the playing one', async ({
  page,
}) => {
  const echo = librarySong('dz-9', {
    title: 'Echo',
    duration: 30,
    origin: 'deezer',
    deezerId: 9,
  })
  await restoreQueue(page, [alpha, echo])
  // The library elements report a length that always leaves `secondsLeft` to go, however far the
  // stream has played, and the test sets it. That puts the song exactly where it needs to be, a
  // second either side of the last minute, instead of waiting for the playhead to get there.
  // `ticks` counts the position updates the page has had, so a check that nothing was asked for
  // is made after the player has really looked.
  await page.addInitScript(() => {
    Object.assign(window, { secondsLeft: 61, ticks: 0 })
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration')?.get
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get(this: HTMLMediaElement) {
        const length = real?.call(this) as number
        const left = (window as unknown as { secondsLeft: number }).secondsLeft
        return this.classList.contains('library-audio') && Number.isFinite(length)
          ? this.currentTime + left
          : length
      },
    })

    document.addEventListener(
      'timeupdate',
      (event) => {
        if (event.target instanceof HTMLAudioElement && event.target.dataset.role === 'active')
          (window as unknown as { ticks: number }).ticks += 1
      },
      true,
    )
  })
  const ticks = () => page.evaluate(() => (window as unknown as { ticks: number }).ticks)
  /** Waits for the player to have handled `count` more position updates. */
  const laterTicks = async (count: number) => {
    const start = await ticks()
    await expect.poll(ticks).toBeGreaterThanOrEqual(start + count)
  }
  const prepares: string[] = []
  // Only the prepare: a POST for the song. The account's track list is asked for as well.
  await page.route('**/api/player/account/dz-9', async (route) => {
    if (route.request().method() === 'POST') prepares.push(route.request().url())
    await route.fulfill({ json: { play: 'busy', detail: 'The Deezer account is busy.' } })
  })

  await playToTheEnd(page, 6)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)
  // Past the prefetch point with 61 seconds to go, one second short of the last minute. The song
  // is next in the queue and prefetching is on, so only that second keeps the prepare back.
  await laterTicks(3)
  expect(prepares).toEqual([])

  // With 60 seconds to go the prepare goes out.
  await page.evaluate(() => Object.assign(window, { secondsLeft: 60 }))
  await expect.poll(() => prepares).toHaveLength(1)
  // It was made once: later updates in the same minute do not ask again.
  await laterTicks(3)
  expect(prepares).toHaveLength(1)
})

test('skipping stops the prefetch that is still running', async ({ page }) => {
  // A fetch() for a stream that never answers and records when it is aborted.
  await page.addInitScript(() => {
    const aborted: string[] = []
    const started: string[] = []
    Object.assign(window, { prefetchAborted: aborted, prefetchStarted: started })
    const real = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('/api/player/stream/')) return real(input, init)
      started.push(url)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted.push(url)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }
  })
  await restoreQueue(page, [alpha, bravo, charlie, delta])
  await playToTheEnd(page, 6)
  // The first fetch is under way and never finishes.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { prefetchStarted: string[] }).prefetchStarted),
    )
    .toEqual([expect.stringContaining('song-b')])
  const aborted = () =>
    page.evaluate(() => (window as unknown as { prefetchAborted: string[] }).prefetchAborted)
  expect(await aborted()).toEqual([])
  await page.getByRole('contentinfo').getByRole('button', { name: 'Next track' }).click()
  await expect.poll(aborted).toEqual([expect.stringContaining('song-b')])
})

test('a metered connection fetches nothing ahead', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  )
  await restoreQueue(page, [alpha, bravo, charlie])
  const prefetched = prefetchedStreams(page)
  // Past the point where a prefetch would have started, and still before the standby element
  // loads at 15 seconds from the end. The delay below runs out the time an in-flight fetch needs.
  await playToTheEnd(page, 6)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)
  await page.waitForTimeout(NO_PREFETCH_WAIT_MS)
  expect(prefetched).toEqual([])
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).not.toHaveAttribute('src', /song-b/)
})

test('a metered connection preloads the metadata only', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  )
  await restoreQueue(page, [alpha, bravo])
  await playToTheEnd(page)
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).toHaveAttribute('src', /song-b/)
  await expect
    .poll(() => standby.evaluate((element: HTMLAudioElement) => element.preload))
    .toBe('metadata')
})

type MediaEntry = { type: string; src: string; time: number; paused: boolean }

/**
 * Records what the library elements report, in order, as `window.mediaLog`. Media events do not
 * bubble, so this listens while they travel down.
 */
async function logMedia(page: Page) {
  await page.addInitScript(() => {
    const log: { type: string; src: string; time: number; paused: boolean }[] = []
    Object.assign(window, { mediaLog: log })
    // A reload sets `src` again. That happens inside the player's retry timer, so this entry is
    // there as soon as the clock has moved, where the media events come a little later. It tells
    // a reload that has not started from one whose events have not arrived.
    const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
    if (source?.set) {
      const write = source.set
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        ...source,
        set(this: HTMLMediaElement, value: string) {
          if (this.classList.contains('library-audio'))
            log.push({
              type: 'src-set',
              src: value.split('/').pop() ?? '',
              time: this.currentTime,
              paused: this.paused,
            })
          write.call(this, value)
        },
      })
    }
    for (const type of ['emptied', 'loadstart', 'loadedmetadata', 'seeked', 'playing'])
      document.addEventListener(
        type,
        (event) => {
          const element = event.target
          if (!(element instanceof HTMLAudioElement)) return
          if (!element.classList.contains('library-audio')) return
          const src = (element.getAttribute('src') ?? '').split('/').pop() ?? ''
          log.push({ type, src, time: element.currentTime, paused: element.paused })
        },
        true,
      )
  })
}

/** What the library elements have reported since entry `from`. */
const mediaSince = (page: Page, from: number) =>
  page.evaluate(
    (start) => (window as unknown as { mediaLog: MediaEntry[] }).mediaLog.slice(start),
    from,
  )

const mediaCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { mediaLog: MediaEntry[] }).mediaLog.length)

/** How many times song `id`'s source has been set again since entry `from`. */
async function sourceWrites(page: Page, from: number, id = 'song-a') {
  return (await mediaSince(page, from)).filter(
    (entry) => entry.type === 'src-set' && entry.src === id,
  ).length
}

/** Holds the clock still, so no wait the player makes runs until the test moves it on. */
async function holdClock(page: Page) {
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)
}

/**
 * Reports a network error with the clock held, then moves it to the last millisecond of `wait`
 * and checks the song has not been loaded again, and one millisecond on and checks it has, once.
 * A wait that was shorter would have loaded the song by the first check.
 */
async function expectReloadAfter(page: Page, wait: number) {
  const from = await mediaCount(page)
  await fireNetworkError(page)
  await page.clock.runFor(wait - 1)
  expect(await sourceWrites(page, from)).toBe(0)
  await page.clock.runFor(1)
  expect(await sourceWrites(page, from)).toBe(1)
  return from
}

/**
 * Handler coverage, not a real drop. The playing element is given a made-up network error and an
 * `error` event, which is what a busy or restarting server would make the browser report, and
 * this gives back where the element was. The error stays until the element starts loading again,
 * as a real one does. The connection itself is fine and the test stream keeps playing, so only
 * the entries `logMedia` makes show whether the player really loaded it again. What the browser
 * does on a real refusal is covered only where a test aborts the reload with a route.
 */
async function fireNetworkError(page: Page) {
  return page.locator('audio.library-audio[data-role="active"]').evaluate((element) => {
    Object.defineProperty(element, 'error', {
      configurable: true,
      get: () => ({ code: MediaError.MEDIA_ERR_NETWORK }),
    })

    element.addEventListener('loadstart', () => Reflect.deleteProperty(element, 'error'), {
      once: true,
    })
    element.dispatchEvent(new Event('error'))
    return (element as HTMLAudioElement).currentTime
  })
}

/**
 * Plays the restored queue from `seconds` in, and waits until the stream is really playing there.
 * `playToTheEnd` returns once play is pressed, which can be before the first metadata is in, and
 * a drop then would race the song's own first load.
 */
async function playFrom(page: Page, seconds: number, path = '/') {
  await playToTheEnd(page, seconds, path)
  await expect
    .poll(() =>
      page
        .locator('audio.library-audio[data-role="active"]')
        .evaluate(
          (element: HTMLAudioElement, at) =>
            element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
            !element.seeking &&
            element.currentTime >= at,
          seconds,
        ),
    )
    .toBe(true)
}

/**
 * What song A reported from the reload on: the first time it was emptied after entry `from`. Empty
 * until then. Events from before the drop, such as the seek that set the test up, are left out.
 */
async function reloadSince(page: Page, from: number) {
  const entries = (await mediaSince(page, from)).filter((entry) => entry.src === 'song-a')
  const start = entries.findIndex((entry) => entry.type === 'emptied')
  return start < 0 ? [] : entries.slice(start)
}

/**
 * Waits for the player to load song A again after a drop logged from entry `from`: emptied and
 * started afresh, then moved back to where it stopped once the metadata was in, in that order.
 * With `playing` it also waits for it to play.
 */
async function waitForReload(page: Page, from: number, playing: boolean) {
  const wanted = [
    'emptied',
    'loadstart',
    'loadedmetadata',
    'seeked',
    ...(playing ? ['playing'] : []),
  ]
  await expect
    .poll(async () => {
      let next = 0
      for (const entry of await reloadSince(page, from)) if (entry.type === wanted[next]) next += 1
      return next >= wanted.length
    })
    .toBe(true)
}

test('a dropped connection reloads the song where it stopped instead of skipping it', async ({
  page,
}) => {
  await logMedia(page)
  const scrobbles = await restoreQueue(page, [alpha, bravo])
  // Now Playing is where the status line shows.
  await playFrom(page, 10, '/now-playing')
  const active = page.locator('audio.library-audio[data-role="active"]')
  const status = page.getByText('Lost the connection to the server. Trying again…')
  const from = await mediaCount(page)
  const at = await fireNetworkError(page)
  await expect(status).toBeVisible()
  const reconnecting = page
    .getByRole('button', { name: 'Pause, reconnecting', exact: true })
    .filter({ visible: true })
  await expect(reconnecting.first()).toBeVisible()
  await waitForReload(page, from, true)

  // Started from where it stopped, not from the top.
  const seeked = (await reloadSince(page, from)).find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  expect(seeked?.time).toBeLessThan(at + 2)
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alpha')
  await expect(status).toHaveCount(0)
  await expect(reconnecting).toHaveCount(0)
  await expect(toasts(page)).not.toContainText('Skipped')
  // The reload is the same listen, so "now playing" went out once.
  expect(scrobbles.filter((entry) => entry.id === 'song-a' && !entry.submission)).toHaveLength(1)
})

test('a reload saves the queue where the song stopped, not at its start', async ({ page }) => {
  await logMedia(page)
  // Loading the song again resets the element to 0 and reports that before the seek back lands.
  await page.addInitScript(() => {
    const times: number[] = []
    Object.assign(window, { timeLog: times })
    document.addEventListener(
      'timeupdate',
      (event) => {
        const element = event.target
        if (element instanceof HTMLAudioElement && element.dataset.role === 'active')
          times.push(element.currentTime)
      },
      true,
    )
  })
  await restoreQueue(page, [alpha, bravo])
  const saved: number[] = []
  await page.route('**/api/player/queue', async (route) => {
    if (route.request().method() === 'PUT') saved.push(Number(requestBody(route).position))
    await route.fallback()
  })
  await playFrom(page, 15)
  const from = await mediaCount(page)
  const savedBefore = saved.length
  const timesBefore = await page.evaluate(
    () => (window as unknown as { timeLog: number[] }).timeLog.length,
  )
  const at = await fireNetworkError(page)
  await waitForReload(page, from, true)
  // A pause saves the queue, and saves go out in order, so once this one is in any save the
  // reload made is in too.
  const afterReload = saved.length
  await page.keyboard.press('Space')
  await expect.poll(() => saved.length).toBeGreaterThan(afterReload)
  // The element did report 0 while it loaded. The saved queue did not take it.
  const times = await page.evaluate(
    (start) => (window as unknown as { timeLog: number[] }).timeLog.slice(start),
    timesBefore,
  )
  expect(times).toContain(0)
  for (const position of saved.slice(savedBefore))
    expect(position).toBeGreaterThanOrEqual((at - 1) * 1000)
})

test('a reload the server refuses is tried again rather than skipping the song', async ({
  page,
}) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  // The server is still down when the first reload goes out, and back for the next. The browser
  // reports a refused load as a source it cannot play, not as a dropped connection.
  let refused = 0
  await page.route('**/api/player/stream/song-a', async (route) => {
    if (refused > 0) return route.fallback()
    refused += 1
    return route.abort('connectionrefused')
  })
  const from = await mediaCount(page)
  const at = await fireNetworkError(page)
  await waitForReload(page, from, true)
  expect(refused).toBe(1)
  const reload = await reloadSince(page, from)
  expect(reload.filter((entry) => entry.type === 'loadstart')).toHaveLength(2)
  const seeked = reload.find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await expect(toasts(page)).not.toContainText('Skipped')
})

test('the play button shows it is reconnecting until the song is back', async ({ page }) => {
  // The clock is held still so the wait before the reload lasts until the test moves it on.
  await page.clock.install()
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const player = page.getByRole('contentinfo')
  const reconnecting = player.getByRole('button', { name: 'Pause, reconnecting', exact: true })
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)
  const from = await mediaCount(page)
  await fireNetworkError(page)
  // Classic has no status line, so the button is what says it.
  await expect(reconnecting).toBeVisible()
  await expect(reconnecting.locator('[data-reconnecting]')).toBeVisible()
  await expect(toasts(page)).not.toContainText('Lost the connection')
  await page.clock.runFor(NETWORK_RETRY_DELAY_MS)
  await waitForReload(page, from, true)
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(reconnecting).toHaveCount(0)
})

test('a playing song that keeps losing its connection stops on it once the reloads run out', async ({
  page,
}) => {
  await page.clock.install()
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  await holdClock(page)
  const player = page.getByRole('contentinfo')
  const active = page.locator('audio.library-audio[data-role="active"]')
  // Each drop comes as soon as the reload plays, so the song never gets far enough past the
  // last drop for the count to start again. The clock is moved by the test, so each wait is
  // measured: 1, 2 and then 3 times the base.
  for (let reload = 0; reload < 3; reload += 1) {
    const from = await expectReloadAfter(page, NETWORK_RETRY_DELAY_MS * (reload + 1))
    await waitForReload(page, from, true)
  }
  const afterThird = await mediaCount(page)
  const at = await fireNetworkError(page)
  // The reloads have run out, so no wait is made however long the clock runs.
  await page.clock.runFor(NETWORK_RETRY_DELAY_MS * 10)
  expect(await sourceWrites(page, afterThird)).toBe(0)
  // A server restart outlasts the reloads. Skipping would fail the next songs too and blame the
  // music folder, so it stays on this one.
  const lost = toasts(page)
    .locator('[data-ui="toast"]')
    .filter({ hasText: 'Lost the connection to the server. Press play to try again.' })
  await expect(lost).toBeVisible()
  await expect(toasts(page)).not.toContainText('Skipped')
  await expect(player).toContainText('Alpha')
  await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect.poll(() => active.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  // A toast with an action stays until it is used.
  await page.clock.fastForward(10_000)
  await expect(lost).toBeVisible()

  // Its Play loads the song again and carries on from where it stopped.
  const from = await mediaCount(page)
  await lost.getByRole('button', { name: 'Play', exact: true }).click()
  await waitForReload(page, from, true)
  const seeked = (await reloadSince(page, from)).find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  await expect(lost).toHaveCount(0)
  await expect(player).toContainText('Alpha')
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
})

test('a pause while the reload waits keeps the song paused', async ({ page }) => {
  await page.clock.install()
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await holdClock(page)
  const from = await mediaCount(page)
  await fireNetworkError(page)
  // The player still shows it playing, so the press pauses it.
  await page
    .getByRole('contentinfo')
    .getByRole('button', { name: 'Pause, reconnecting', exact: true })
    .click()
  // The wait is still out: it is the clock that ends it, not the time the press took.
  expect(await sourceWrites(page, from)).toBe(0)
  await page.clock.runFor(NETWORK_RETRY_DELAY_MS)
  expect(await sourceWrites(page, from)).toBe(1)
  await waitForReload(page, from, false)
  const reload = await reloadSince(page, from)
  expect(reload.filter((entry) => entry.type === 'playing')).toEqual([])
  expect(await active.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  await expect(
    page.getByRole('contentinfo').getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible()
})

test('a paused song that keeps losing its connection waits for play instead of skipping', async ({
  page,
}) => {
  await page.clock.install()
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await page.keyboard.press('Space')
  await expect.poll(() => active.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  await holdClock(page)
  for (let reload = 0; reload < 3; reload += 1) {
    const from = await expectReloadAfter(page, NETWORK_RETRY_DELAY_MS * (reload + 1))
    await waitForReload(page, from, false)
  }
  const afterThird = await mediaCount(page)
  const at = await fireNetworkError(page)
  await page.clock.runFor(NETWORK_RETRY_DELAY_MS * 10)
  expect(await sourceWrites(page, afterThird)).toBe(0)
  await expect(toasts(page)).toContainText(
    'Lost the connection to the server. Press play to try again.',
  )
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await expect(toasts(page)).not.toContainText('Skipped')

  // Play loads it again and carries on from where it stopped.
  const from = await mediaCount(page)
  await page.keyboard.press('Space')
  await waitForReload(page, from, true)
  const seeked = (await reloadSince(page, from)).find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
})

test('a song chosen while the reload waits is the one that plays', async ({ page }) => {
  await page.clock.install()
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await holdClock(page)
  const from = await mediaCount(page)
  await fireNetworkError(page)
  await expect(
    page.getByRole('contentinfo').getByRole('button', { name: 'Pause, reconnecting' }),
  ).toBeVisible()
  await page.getByRole('contentinfo').getByRole('button', { name: 'Next track' }).click()
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  // The new song does not show the old one reconnecting.
  await expect(
    page.getByRole('contentinfo').getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible()
  // Past the moment the reload would have happened. Nothing can be polled for here: the check is
  // that nothing happens, to either song. A reload that fired on Bravo would empty and load it
  // again, and seek it to where Alpha dropped.
  const settled = await mediaCount(page)
  await page.clock.runFor(NETWORK_RETRY_DELAY_MS * 2)
  expect(await sourceWrites(page, from, 'song-a')).toBe(0)
  expect(await sourceWrites(page, settled, 'song-b')).toBe(0)
  const after = await mediaSince(page, settled)
  expect(after.filter((entry) => entry.type === 'emptied' || entry.type === 'loadstart')).toEqual(
    [],
  )
  await expect(active).toHaveAttribute('src', /song-b/)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
  // Alpha dropped at 10 seconds, and Bravo has only just started.
  expect(await active.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThan(10)
})

test('a song that cannot be played is skipped and the player says which', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie], ['song-b'])
  await playToTheEnd(page)
  const player = page.getByRole('contentinfo')
  await expect(toasts(page)).toHaveText('Skipped Bravo, it could not be played', {
    timeout: 15_000,
  })
  await expect(player).toContainText('Charlie')
})

test('three failures in a row stop the queue with a message', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie, delta], ['song-a', 'song-b', 'song-c'])
  await page.goto('/')
  const player = page.getByRole('contentinfo')
  await expect(
    toasts(page).getByText(/^Stopped after 3 tracks in a row could not be played/),
  ).toBeVisible()
  // The fourth song was never tried.
  await expect(player).toContainText('Charlie')
  await expect(player).not.toContainText('Delta')
})
