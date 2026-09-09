// Temporary visual check: screenshot each new study during real playback.
import { chromium } from '../../frontend/node_modules/playwright/index.mjs'

const studies =
  process.argv.length > 2
    ? process.argv.slice(2, -1)
    : ['tunnel', 'kaleidoscope3', 'julia', 'contours']
const seekTo = process.argv.length > 2 ? Number(process.argv[process.argv.length - 1]) : 75
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[console]', msg.text())
})
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.getElementById('play').disabled, null, {
  timeout: 90_000,
})
for (const study of studies) {
  await page.selectOption('#preset', study)
  await page.waitForTimeout(800)
  await page.waitForFunction(
    () => !document.getElementById('render-state').textContent.includes('Preparing'),
    null,
    { timeout: 90_000 },
  )
  await page.evaluate((t) => {
    document.getElementById('audio').currentTime = t
  }, seekTo)
  await page.waitForTimeout(800)
  await page.waitForFunction(
    () => !document.getElementById('render-state').textContent.includes('Preparing'),
    null,
    { timeout: 90_000 },
  )
  const still = process.env.STILL === '1'
  if (still) {
    await page.evaluate(() => {
      document.getElementById('welcome').hidden = true
    })
    await page.waitForTimeout(4000)
  } else {
    await page.click('#play')
    await page.waitForTimeout(5000)
  }
  const state = await page.locator('#render-state').textContent()
  if (!still) await page.click('#play') // pause after capture
  await page.locator('#visual').screenshot({ path: `test-results/effect-${study}.png` })
  console.log(study, '->', state)
}
await browser.close()
console.log('done')
