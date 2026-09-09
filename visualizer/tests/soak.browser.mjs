// Temporary soak check: seek, then simulate seconds of rendering without
// real-time playback, then screenshot the canvas in steady state.
// Usage: node tests/soak.browser.mjs <study> <seekSeconds> <soakSeconds> <outname> [optionsJson]
// optionsJson, when given, is written to the studio localStorage key before
// page load, so customized themes/motion/trails/sensitivity/seed apply.
import { chromium } from '../../frontend/node_modules/playwright/index.mjs'

const [, , study = 'phosphor', seekArg = '25', soakArg = '40', name = 'soak', optionsJson] =
  process.argv
const seekTo = Number(seekArg)
const soakSeconds = Number(soakArg)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 500)))
if (optionsJson) {
  await page.addInitScript((json) => {
    try {
      localStorage.setItem('musimo.studio.visual', json)
    } catch {
      /* storage disabled: soak runs with defaults */
    }
  }, optionsJson)
}
await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.getElementById('play').disabled, null, {
  timeout: 90_000,
})
await page.selectOption('#preset', study)
await page
  .waitForFunction(
    () => document.getElementById('render-state').textContent.includes('Preparing'),
    null,
    { timeout: 15_000 },
  )
  .catch(() => console.log('note: study rebuild began before poll started'))
await page.waitForFunction(
  () => !document.getElementById('render-state').textContent.includes('Preparing'),
  null,
  { timeout: 120_000 },
)
await page.evaluate((t) => {
  document.getElementById('audio').currentTime = t
}, seekTo)
// Wait for the seek rebuild to actually begin, then for it to finish.
await page
  .waitForFunction(
    () => document.getElementById('render-state').textContent.includes('Preparing'),
    null,
    { timeout: 15_000 },
  )
  .catch(() => console.log('note: rebuild began before poll started'))
await page.waitForFunction(
  () => !document.getElementById('render-state').textContent.includes('Preparing'),
  null,
  { timeout: 120_000 },
)
await page.waitForTimeout(2000)
// The seek rebuild must actually land near the target before soaking.
await page.waitForFunction(
  (target) => Math.abs((window.__engine?.position ?? -1) - target) < 0.5,
  seekTo,
  { timeout: 120_000 },
)
const landed = await page.evaluate(() => window.__engine?.position ?? -1)
console.log('landed at', landed.toFixed(2), 's')
const frames = await page.evaluate(async (total) => {
  let engine = window.__engine
  if (!engine) return -1
  let t = engine.position
  const end = t + total
  while (t < end) {
    t = Math.min(end, t + 0.4)
    engine.advance(t)
    await new Promise((resolve) => setTimeout(resolve, 0))
    engine = window.__engine ?? engine
  }
  return Math.round((window.__engine?.position ?? -1) * 60)
}, soakSeconds)
console.log('soaked to frame', frames)
await page.evaluate(() => {
  document.getElementById('welcome').hidden = true
})
await page.waitForTimeout(300)
await page.locator('#visual').screenshot({ path: `test-results/${name}.png` })
console.log('saved', name)
await browser.close()
