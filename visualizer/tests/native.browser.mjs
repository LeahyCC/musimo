import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs'

// The native renderer's counterpart to replay.browser.mjs: same determinism,
// seek and isolation questions, asked of the WebGL2 path instead of Butterchurn.
// Every native study answers them, because a study's own frame hook and its
// settings are part of what a seek has to reconstruct.
// Run with the independent preview serving on 5180, or point PREVIEW_URL at
// another port when a worktree runs its own server.
const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5180'
const STUDIES = ['tunnel', 'kaleidoscope3', 'julia', 'contours']
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
  const output = new URL('../test-results/', import.meta.url)
  await mkdir(output, { recursive: true })
  const results = {}
  for (const study of STUDIES) {
    const result = await page.evaluate(async (study) => {
      const { VisualizerEngine } = await import('/src/engine.ts')
      // Decoding the recording is the slow part and it is the same for every
      // study, so the first study leaves it on the window for the rest. The
      // host snapshot below is taken after that, or this check's own cache
      // would read as the renderer having changed the realm.
      if (!window.__fixture) {
        const score = await fetch('/songs/dive-extended-mix.song.json').then((r) => r.json())
        const analysis = await fetch('/songs/dive-extended-mix.analysis.json').then((r) => r.json())
        score.analysis = {
          hopSeconds: analysis.analysis.hopSamples / analysis.analysis.sampleRate,
          columns: analysis.analysis.featureColumns,
          frames: analysis.features,
        }
        const audio = await fetch('/local/dive.opus').then((r) => r.arrayBuffer())
        const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(audio)
        window.__fixture = {
          score,
          pcm: {
            sampleRate: decoded.sampleRate,
            left: decoded.getChannelData(0),
            right: decoded.getChannelData(1),
          },
        }
      }
      const { score, pcm } = window.__fixture
      const hostRandom = Math.random
      const globalNames = () =>
        Object.getOwnPropertyNames(window).filter((name) => !/^\d+$/.test(name))
      const hostGlobals = globalNames()
      // A native engine keeps its canvas for the life of its WebGL context, so
      // every case here gets its own canvas as the studio page already does.
      async function create(seed = score.seed, width = 640) {
        const canvas = document.createElement('canvas')
        document.body.append(canvas)
        const engine = new VisualizerEngine(canvas, pcm, width, { ...score, seed })
        await engine.load(study)
        await engine.startAt(0)
        return { canvas, engine }
      }
      // The native path draws to the default framebuffer, so the pixels come
      // back through the renderer rather than a 2D context.
      async function hash(engine) {
        const digest = await crypto.subtle.digest('SHA-256', engine.readPixels())
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
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

      // A setting is an input to the deterministic frame, so the seek
      // assertions below run with one moved off its default. Reconstruction has
      // to reproduce the changed picture, not the authored one.
      const declared = second.engine.studyManifest?.settings ?? []
      const tuned = declared[0]
      const tunedValue = tuned
        ? Math.min(tuned.max, Math.max(tuned.min, tuned.default + tuned.step * 3))
        : 0
      if (tuned) second.engine.setSetting(tuned.name, tunedValue)

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

      // Back to the authored value, same destination: a different picture, so
      // the setting really did take part in rebuilding the history.
      if (tuned) second.engine.setSetting(tuned.name, tuned.default)
      await second.engine.startAt(30)
      const defaultSeekHash = await hash(second.engine)

      // Live option and setting updates must not need a rebuild, and must move
      // the picture.
      await second.engine.startAt(30)
      const beforeTuning = await hash(second.engine)
      second.engine.setOptions({ theme: 'ember', motion: 2 })
      if (tuned) second.engine.setSetting(tuned.name, tunedValue)
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
        tunedSetting: tuned ? { name: tuned.name, value: tunedValue } : null,
        settingsChangedTheReconstruction: tuned ? seeks[0].hash !== defaultSeekHash : null,
        tuningChangedTheImage: beforeTuning !== afterTuning,
        images,
        renderSubmissionP95: costs[Math.floor(costs.length * 0.95)],
      }
    }, study)
    for (const [index, image] of result.images.entries()) {
      await writeFile(
        new URL(`native-${study}-seek-${index}.png`, output),
        Buffer.from(image.split(',')[1], 'base64'),
      )
    }
    delete result.images
    results[study] = result
    console.log(study, JSON.stringify(result, null, 2))
  }
  await writeFile(new URL('native-results.json', output), JSON.stringify(results, null, 2) + '\n')
  for (const [study, result] of Object.entries(results)) {
    const where = (what) => `${study}: ${what}`
    assert.equal(result.firstHash, result.secondHash, where('display batching changed playback'))
    assert.notEqual(result.firstHash, result.otherHash, where('a different seed changed nothing'))
    assert.equal(result.firstHash, result.restartedHash, where('restart changed playback'))
    assert.equal(result.firstHash, result.pausedHash, where('the paused frame changed'))
    assert.equal(result.seeks[0].hash, result.seeks[2].hash, where('seek reconstruction changed'))
    assert(
      result.seeks.every((seek) => seek.frames <= 120),
      where('seek work exceeded its bound'),
    )
    assert(result.exactClock, where('the media clock drifted'))
    assert(result.jumped, where('a large jump did not ask for a reconstruction'))
    assert(result.noLeakedRealms, where('the native path created a renderer realm'))
    assert(result.hostUnchanged, where('the native path changed the host realm'))
    assert(result.tuningChangedTheImage, where('live options and settings missed the shaders'))
    assert(
      result.settingsChangedTheReconstruction,
      where('a setting did not take part in the reconstruction'),
    )
  }
  assert.deepEqual(errors, [], 'browser reported errors')
} finally {
  await browser.close()
}
