// Probe: verify studio options from localStorage reach the panel and engine.
import { chromium } from '../../frontend/node_modules/playwright/index.mjs'

const optionsJson = process.argv[2] ?? '{"theme":"ember"}'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
await page.addInitScript((json) => {
  localStorage.setItem('musimo.studio.visual', json)
}, optionsJson)
await page.goto('http://127.0.0.1:5180', { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.getElementById('play').disabled, null, {
  timeout: 90_000,
})
const state = await page.evaluate(() => ({
  stored: localStorage.getItem('musimo.studio.visual'),
  theme: document.getElementById('theme').value,
  motion: document.getElementById('motion').value,
  trails: document.getElementById('trails').value,
  sensitivity: document.getElementById('sensitivity').value,
  seedLabel: document.getElementById('seed-value').textContent,
}))
console.log(JSON.stringify(state, null, 2))
await browser.close()
