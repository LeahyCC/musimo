import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs'

// The acceptance check for the Dive journey, which now runs on the native
// renderer. Every question it asks is the same as when Dive was a Butterchurn
// preset: batching, seed, restart, pause, the seek into the return at 222
// seconds and back, clock jumps, a moving landing, a cancelled load, no
// renderer realm and an untouched host realm.
// Run with the independent preview serving on 5180, or point PREVIEW_URL at
// another port when a worktree runs its own server. This uses the existing
// frontend browser-test dependency and never touches the visible preview tab.
const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5180'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
await page.route('**/src/main.ts*', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: '' }),
)
await page.route('**/@vite/client', (route) =>
  route.fulfill({ contentType: 'text/javascript', body: '' }),
)
try {
  await page.goto(PREVIEW_URL)
  const result = await page.evaluate(async () => {
    const hostRandom = Math.random
    const globalNames = () =>
      Object.getOwnPropertyNames(window).filter((name) => !/^\d+$/.test(name))
    const hostGlobals = globalNames()
    const { VisualizerEngine } = await import('/src/engine.ts')
    const score = await fetch('/songs/dive-extended-mix.song.json').then((r) => r.json())
    const analysis = await fetch('/songs/dive-extended-mix.analysis.json').then((r) => r.json())
    score.analysis = {
      hopSeconds: analysis.analysis.hopSamples / analysis.analysis.sampleRate,
      columns: analysis.analysis.featureColumns,
      frames: analysis.features,
    }
    const audio = await fetch('/local/dive.opus').then((r) => r.arrayBuffer())
    const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(audio)
    const pcm = {
      sampleRate: decoded.sampleRate,
      left: decoded.getChannelData(0),
      right: decoded.getChannelData(1),
    }
    async function create(seed = score.seed, width = 640) {
      const canvas = document.createElement('canvas')
      document.body.append(canvas)
      const engine = new VisualizerEngine(canvas, pcm, width, { ...score, seed })
      await engine.load('dive')
      await engine.startAt(0)
      return { canvas, engine }
    }
    // The native path draws to the default framebuffer, so the pixels come back
    // through the renderer rather than a 2D context.
    async function hash(engine) {
      const digest = await crypto.subtle.digest('SHA-256', engine.readPixels())
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      )
    }
    const first = await create()
    for (let frame = 1; frame <= 180; frame++) first.engine.advance((frame + 0.01) / 60)
    const firstHash = await hash(first.engine)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const pausedHash = await hash(first.engine)
    const hostUnchangedAfterFirst =
      Math.random === hostRandom && globalNames().join('|') === hostGlobals.join('|')
    const second = await create()
    const other = await create(score.seed + 1)
    for (let frame = 3; frame <= 180; frame += 3) {
      second.engine.advance((frame + 0.01) / 60)
      other.engine.advance((frame + 0.01) / 60)
    }
    const secondHash = await hash(second.engine)
    const otherHash = await hash(other.engine)
    const exactClock = second.engine.position === 3
    await second.engine.startAt(0)
    for (let frame = 1; frame <= 180; frame++) second.engine.advance((frame + 0.01) / 60)
    const restartedHash = await hash(second.engine)
    first.engine.dispose()
    first.canvas.remove()
    other.engine.dispose()
    other.canvas.remove()
    const seeks = []
    const images = []
    for (const position of [222, 164, 222]) {
      await second.engine.startAt(position)
      seeks.push({
        position: second.engine.position,
        frames: second.engine.reconstructedFrames,
        ms: second.engine.reconstructionMs,
        hash: await hash(second.engine),
        state: second.engine.journeyState,
      })
      if (images.length < 2) images.push(second.canvas.toDataURL())
    }
    const jumped = second.engine.advance(300) === false
    await second.engine.startAt(164, () => 166.25)
    const landed = second.engine.position === 166.25
    const costs = [...second.engine.costs].sort((a, b) => a - b)
    second.engine.dispose()
    second.canvas.remove()
    // A native load builds synchronously once it starts, so the engine yields
    // before it takes the canvas. Disposing in the same turn must still cancel.
    const cancelled = new VisualizerEngine(document.createElement('canvas'), pcm, 640, score)
    const loading = cancelled.load('dive')
    cancelled.dispose()
    let aborted = false
    try {
      await loading
    } catch (error) {
      aborted = error.name === 'AbortError'
    }
    const noLeakedRealms = document.querySelectorAll('iframe').length === 0
    const hostUnchanged =
      hostUnchangedAfterFirst &&
      Math.random === hostRandom &&
      globalNames().join('|') === hostGlobals.join('|')
    return {
      firstHash,
      pausedHash,
      secondHash,
      otherHash,
      restartedHash,
      exactClock,
      seeks,
      jumped,
      landed,
      aborted,
      noLeakedRealms,
      hostUnchanged,
      images,
      renderSubmissionP95: costs[Math.floor(costs.length * 0.95)],
    }
  })
  const output = new URL('../test-results/', import.meta.url)
  await mkdir(output, { recursive: true })
  for (const [index, image] of result.images.entries()) {
    await writeFile(
      new URL(`journey-seek-${index}.png`, output),
      Buffer.from(image.split(',')[1], 'base64'),
    )
  }
  delete result.images
  await writeFile(new URL('replay-results.json', output), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  assert.equal(result.firstHash, result.secondHash, 'display batching changed same-seed playback')
  assert.notEqual(result.firstHash, result.otherHash, 'different seeds did not change the material')
  assert.equal(result.firstHash, result.restartedHash, 'restart changed same-seed playback')
  assert.equal(result.firstHash, result.pausedHash, 'paused frame changed')
  assert.equal(result.seeks[0].hash, result.seeks[2].hash, 'seek reconstruction changed')
  assert(
    result.seeks.every((seek) => seek.frames <= 120),
    'seek work exceeded its bound',
  )
  assert(
    result.exactClock &&
      result.jumped &&
      result.landed &&
      result.aborted &&
      result.noLeakedRealms &&
      result.hostUnchanged,
  )
  assert.deepEqual(errors, [], 'browser reported errors')
} finally {
  await browser.close()
}
