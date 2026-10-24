/**
 * The browse card a person opened, remembered across the trip to its detail page so
 * coming back can restore more than a pixel: the card itself, on screen, with focus.
 * Session storage only — this is about one visit's navigation, not a preference.
 */

const RETURN_ANCHOR_KEY = 'musimo.library-return-anchor'

export type ReturnAnchor = { path: string; id: string }

export function readReturnAnchor(): ReturnAnchor | null {
  try {
    const raw = sessionStorage.getItem(RETURN_ANCHOR_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && 'path' in parsed && 'id' in parsed) {
      const { path, id } = parsed as { path: unknown; id: unknown }
      if (typeof path === 'string' && typeof id === 'string' && id) return { path, id }
    }
  } catch {
    // A private window still has the router's pixel restoration.
  }
  return null
}

export function writeReturnAnchor(anchor: ReturnAnchor | null) {
  try {
    if (anchor) sessionStorage.setItem(RETURN_ANCHOR_KEY, JSON.stringify(anchor))
    else sessionStorage.removeItem(RETURN_ANCHOR_KEY)
  } catch {
    // As above: losing the anchor only loses the focus half of the restore.
  }
}

/** The card a browse item lives in, wherever the layout put it. */
export function browseAnchorElement(id: string) {
  return document.querySelector(`[data-browse-anchor="${CSS.escape(id)}"]`)
}

/**
 * Puts a card back on screen and gives it the focus it had when it was opened, if it is
 * not already in view. Returns false when the card is not rendered (yet, or any more).
 */
export function revealBrowseItem(id: string) {
  const element = browseAnchorElement(id)
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const pane = document.querySelector('#main')
  const paneRect = pane?.getBoundingClientRect()
  // In the Listening room the pane, not the window, is the viewport for the list, so
  // visibility is judged against the pane's own edges, chrome and all.
  const paneIsScroller = Boolean(paneRect && pane && pane.scrollHeight > pane.clientHeight)
  const top = paneIsScroller && paneRect ? paneRect.top : 0
  const bottom = paneIsScroller && paneRect ? paneRect.bottom : window.innerHeight
  if (rect.bottom < top + 24 || rect.top > bottom - 24) element.scrollIntoView({ block: 'center' })
  const opener =
    element.querySelector<HTMLElement>('button[aria-label^="Open "]') ??
    element.querySelector<HTMLElement>('button')
  opener?.focus({ preventScroll: true })
  return true
}
