import type { Page } from '@playwright/test'

/** The shell's main navigation: the sidebar on a wide window, the bottom bar on a phone. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' })

/**
 * The link to the library's first view. A phone's bar has one Library tab; the sidebar has a
 * LIBRARY group whose first row is Albums, with the album count after its name.
 */
export const libraryLink = (page: Page) =>
  mainNav(page).getByRole('link', { name: /^(Library|Albums)\b/ })

/** Where the shell says what the footer player could not do, or did: one toast region. */
export const toasts = (page: Page) => page.locator('[data-ui="toast-region"]')
