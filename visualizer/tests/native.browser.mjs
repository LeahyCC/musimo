import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs'

// The native renderer's counterpart to replay.browser.mjs: same determinism,
// seek and isolation questions, asked of the WebGL2 path instead of Butterchurn.
// Run with the independent preview serving on 5180, or point PREVIEW_URL at
// another port when a worktree runs its own server.
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
    // A native engine keeps its canvas for the life of its WebGL context, so
    // every case here gets its own canvas as the studio page already does.
    async function create(seed = score.seed, width = 640) {
      const canvas = document.createElement('canvas')
      document.body.append(canvas)
      const engine = new VisualizerEngine(canvas, pcm, width, { ...score, seed })
      await engine.load('tunnel')
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
    const floatBuffers = first.engine.floatBuffers
    const settings = { ...first.engine.studySettings }

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
    for (const position of [30, 10, 30]) {
      await second.engine.startAt(position)
      seeks.push({
        position: second.engine.position,
        frames: second.engine.reconstructedFrames,
        ms: second.engine.reconstructionMs,
        hash: await hash(second.engine),
      })
      if (images.length < 2) images.push(second.canvas.toDataURL())
    }
    const jumped = second.engine.advance(300) === false

    // Live option and setting updates must not need a rebuild, and must move
    // the picture.
    await second.engine.startAt(30)
    const beforeTuning = await hash(second.engine)
    second.engine.setOptions({ theme: 'ember', motion: 2 })
    second.engine.setSetting('glow', 1.6)
    second.engine.advance(30 + 1 / 60)
    const afterTuning = await hash(second.engine)

    const costs = [...second.engine.costs].sort((a, b) => a - b)
    second.engine.dispose()
    second.canvas.remove()

    const noLeakedRealms = document.querySelectorAll('iframe').length === 0
    const hostUnchanged =
      Math.random === hostRandom && globalNames().join('|') === hostGlobals.join('|')
    return {
      firstHash,
      pausedHash,
      secondHash,
      otherHash,
      restartedHash,
      exactClock,
      seeks,
      jumped,
      noLeakedRealms,
      hostUnchanged,
      floatBuffers,
      settings,
      tuningChangedTheImage: beforeTuning !== afterTuning,
      images,
      renderSubmissionP95: costs[Math.floor(costs.length * 0.95)],
    }
  })
  const output = new URL('../test-results/', import.meta.url)
  await mkdir(output, { recursive: true })
  for (const [index, image] of result.images.entries()) {
    await writeFile(
      new URL(`native-seek-${index}.png`, output),
      Buffer.from(image.split(',')[1], 'base64'),
    )
  }
  delete result.images
  await writeFile(new URL('native-results.json', output), JSON.stringify(result, null, 2) + '\n')
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
  assert(result.exactClock, 'the media clock drifted')
  assert(result.jumped, 'a large jump did not ask for a reconstruction')
  assert(result.noLeakedRealms, 'the native path created a renderer realm')
  assert(result.hostUnchanged, 'the native path changed the host realm')
  assert(result.tuningChangedTheImage, 'live options and settings did not reach the shaders')
  assert.deepEqual(errors, [], 'browser reported errors')
} finally {
  await browser.close()
}
