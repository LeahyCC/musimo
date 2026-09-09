// Temporary probe: watch render-state while switching to a study.
import { chromium } from '../../frontend/node_modules/playwright/index.mjs'

const study = process.argv[2] ?? 'phosphor'
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 800))
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 800)))
await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.getElementById('play').disabled, null, {
  timeout: 90_000,
})
console.log('loaded:', await page.locator('#render-state').textContent())
await page.selectOption('#preset', study)
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000)
  const state = await page.locator('#render-state').textContent()
  const status = await page.locator('#status').textContent()
  console.log(`${(i + 1) * 2}s`, '|', state, '|', status)
  if (state.includes('Ready') || state.includes('unavailable')) break
}
await browser.close()
