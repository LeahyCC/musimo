import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('Accessibility', () => {
  test('search page should not have accessibility violations', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('library page should not have accessibility violations', async ({ page }) => {
    await page.goto('/library')
    await page.waitForSelector('h1')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('downloads page should not have accessibility violations', async ({ page }) => {
    await page.goto('/downloads')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('settings page should not have accessibility violations', async ({ page }) => {
    await page.goto('/settings')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('diagnostics page should not have accessibility violations', async ({ page }) => {
    await page.goto('/diagnostics')
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })

  test('player at 200% zoom should not overlap', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 })
    await page.goto('/')
    // Wait for any content to load
    await page.waitForSelector('.search-input')
    // Check that key elements are not overlapping
    const footer = page.locator('.live-player')
    const queueDock = page.locator('.queue-dock')
    const saveBars = page.locator('.save-bar')

    // Verify footer is visible
    await expect(footer).toBeVisible()

    // If queue dock is present, verify it's positioned correctly relative to footer
    const queueDockCount = await queueDock.count()
    if (queueDockCount > 0) {
      const queueBox = await queueDock.boundingBox()
      const footerBox = await footer.boundingBox()
      if (queueBox && footerBox) {
        // Queue should be at or above footer bottom
        expect(queueBox.y + queueBox.height).toBeLessThanOrEqual(footerBox.y + 5)
      }
    }

    // If save bars are present, verify they're positioned correctly
    const saveBarCount = await saveBars.count()
    if (saveBarCount > 0) {
      const saveBarBox = await saveBars.first().boundingBox()
      const footerBox = await footer.boundingBox()
      if (saveBarBox && footerBox) {
        // Save bar should be above footer
        expect(saveBarBox.y + saveBarBox.height).toBeLessThanOrEqual(footerBox.y)
      }
    }
  })
})
