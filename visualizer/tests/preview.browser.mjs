import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '../../frontend/node_modules/playwright-core/index.mjs'

// The running preview to check against. A worktree serving on another port sets
// PREVIEW_URL; the production build below always uses its own temporary server.
const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5180'
const browser = await chromium.launch({ headless: true })
const server = createServer()
const results = {}
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const NativeRecorder = window.MediaRecorder
    window.previewRecorders = []
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args)
        window.previewRecorders.push(this)
      }
    }
  })
  await page.goto(PREVIEW_URL)
  await page.waitForFunction(() => !document.querySelector('#record').disabled)
  await page.locator('#quality').selectOption('1280')
  await page.waitForFunction(
    () =>
      document.querySelector('#visual').width === 1280 &&
      !document.querySelector('#record').disabled,
  )
  console.log('Preview ready at720p')
  await page.locator('#play').click()
  await page.evaluate(() => document.querySelector('#audio').pause())
  // Hold the first playback promise so two start clicks exercise the real async boundary.
  await page.evaluate(() => {
    const audio = document.querySelector('#audio')
    const nativePlay = audio.play.bind(audio)
    audio.play = async () => {
      await nativePlay()
      await new Promise((resolve) => {
        window.releasePreviewPlay = resolve
      })
    }
    window.restorePreviewPlay = () => {
      audio.play = nativePlay
    }
    document.querySelector('#record').click()
    document.querySelector('#record').click()
  })
  await page.waitForFunction(() => Boolean(window.releasePreviewPlay))
  await page.evaluate(() => {
    window.releasePreviewPlay()
    window.restorePreviewPlay()
  })
  await page.waitForFunction(() =>
    window.previewRecorders.some((recorder) => recorder.state === 'recording'),
  )
  results.singleStart = await page.evaluate(() => window.previewRecorders.length === 1)
  console.log('Delayed double-start checked')
  await page.waitForTimeout(1200)
  // A visibility return uses the same automatic rebuild path as the live preview.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForFunction(
    () =>
      window.previewRecorders[0].state === 'inactive' && !document.querySelector('#capture').hidden,
  )
  await page.waitForFunction(() => !document.querySelector('#record').disabled)
  results.rebuildStopsCapture = await page.evaluate(() => ({
    stopped: window.previewRecorders[0].stream
      .getTracks()
      .every((track) => track.readyState === 'ended'),
    audioContinues: !document.querySelector('#audio').paused,
    hasClip: document.querySelector('#recording').src.startsWith('blob:'),
  }))
  console.log('Native recording/rebuild checked')
  await page.evaluate(() => document.querySelector('#audio').pause())
  await page.close()

  // Serve only the built directory. Closing the server in finally leaves no service running.
  const root = fileURLToPath(new URL('../dist/', import.meta.url))
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.opus': 'audio/ogg',
    '.txt': 'text/plain',
  }
  server.on('request', async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        response.writeHead(403).end()
        return
      }
      const bytes = await readFile(path)
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
        'Content-Length': bytes.length,
      })
      response.end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const production = await browser.newPage()
  let rendererAsset = ''
  production.on('response', (response) => {
    if (/\/assets\/butterchurn\.min-[^/]+\.js$/.test(response.url()) && response.status() === 200)
      rendererAsset = response.url()
  })
  production.on('pageerror', (error) => errors.push(error.message))
  await production.goto(`http://127.0.0.1:${address.port}`)
  await production.waitForFunction(() => !document.querySelector('#record').disabled, {
    timeout: 30000,
  })
  results.production = await production.evaluate(() => ({
    realms: document.querySelectorAll('iframe').length,
    width: document.querySelector('#visual').width,
    ready: !document.querySelector('#play').disabled,
  }))
  results.production.rendererAsset = rendererAsset
  results.errors = errors
  await writeFile(
    new URL('../test-results/preview-results.json', import.meta.url),
    JSON.stringify(results, null, 2) + '\n',
  )
  console.log(JSON.stringify(results, null, 2))
  assert(results.singleStart)
  assert(
    results.rebuildStopsCapture.stopped &&
      results.rebuildStopsCapture.audioContinues &&
      results.rebuildStopsCapture.hasClip,
  )
  assert(results.production.ready && results.production.realms === 1 && rendererAsset)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}
