import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs'

// Compares the native band-level port against Butterchurn's own analyser on
// identical PCM, so a regression in audio-levels.ts shows up as a number
// rather than a look-different picture.
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
    const { VisualizerEngine } = await import('/src/engine.ts')
    const audio = await fetch('/local/dive.opus').then((r) => r.arrayBuffer())
    const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(audio)
    const pcm = {
      sampleRate: decoded.sampleRate,
      left: decoded.getChannelData(0),
      right: decoded.getChannelData(1),
    }

    // Neither study needs a journey score; leaving it out keeps both engines
    // sampling the same PCM window with no timing offset.
    const canvas1 = document.createElement('canvas')
    const canvas2 = document.createElement('canvas')
    document.body.append(canvas1, canvas2)
    const reference = new VisualizerEngine(canvas1, pcm, 640)
    const native = new VisualizerEngine(canvas2, pcm, 640)
    await reference.load('sherwin')
    await native.load('tunnel')
    await reference.startAt(0)
    await native.startAt(0)

    const bands = ['bass', 'mid', 'treb', 'bassAtt', 'midAtt', 'trebAtt']
    const maxAbsolute = Object.fromEntries(bands.map((band) => [band, 0]))
    const maxRelative = Object.fromEntries(bands.map((band) => [band, 0]))

    // Both engines start from the same seeded warm-up; only the frames after
    // it are stable enough to compare, per the fast/slow longAvg switch at 50.
    const warmupFrames = 50
    const totalFrames = 20 * 60
    for (let frame = 1; frame <= totalFrames; frame++) {
      const seconds = (frame + 0.01) / 60
      reference.advance(seconds)
      native.advance(seconds)
      if (frame <= warmupFrames) continue
      const a = reference.debugAudioLevels
      const b = native.debugAudioLevels
      for (const band of bands) {
        const absolute = Math.abs(a[band] - b[band])
        const relative = absolute / Math.max(Math.abs(a[band]), 1e-9)
        if (absolute > maxAbsolute[band]) maxAbsolute[band] = absolute
        if (relative > maxRelative[band]) maxRelative[band] = relative
      }
    }

    reference.dispose()
    native.dispose()
    canvas1.remove()
    canvas2.remove()
    return { maxAbsolute, maxRelative }
  })
  const output = new URL('../test-results/', import.meta.url)
  await mkdir(output, { recursive: true })
  await writeFile(new URL('levels-results.json', output), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  for (const [band, relative] of Object.entries(result.maxRelative)) {
    assert.ok(relative <= 1e-3, `${band} relative difference ${relative} exceeded 1e-3`)
  }
  assert.deepEqual(errors, [], 'browser reported errors')
} finally {
  await browser.close()
}
