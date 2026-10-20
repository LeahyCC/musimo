import { useEffect } from 'react'

import { keyboardGeometry } from './keyboard'

/** Whether the focus is in somewhere that takes typing, the only thing an on-screen keyboard is for. */
function typing(): boolean {
  const focused = document.activeElement
  if (focused instanceof HTMLTextAreaElement) return true
  if (focused instanceof HTMLInputElement)
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(
      focused.type,
    )
  return focused instanceof HTMLElement && focused.isContentEditable
}

/**
 * Follows the on-screen keyboard while the component is mounted, for a screen whose text box has
 * to stay above it (the music bot's chat on a phone). It mirrors the keyboard onto <html> as
 * `data-keyboard`, `--keyboard-inset` and `--keyboard-top`, and style.css does the rest: it hides
 * the bars marked `data-keyboard-hide` and seats the chat on top of the keyboard.
 */
export function useKeyboard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    const viewport = window.visualViewport
    let width = window.innerWidth
    let tallest = window.innerHeight
    let last = { inset: '', top: '', open: false }

    const read = () => {
      // A turn of the phone starts over, since the tallest height belongs to one width.
      if (window.innerWidth !== width) {
        width = window.innerWidth
        tallest = window.innerHeight
      }
      tallest = Math.max(tallest, window.innerHeight)
      const geometry = keyboardGeometry({
        layout: window.innerHeight,
        tallest,
        visible: viewport?.height ?? window.innerHeight,
        top: viewport?.offsetTop ?? 0,
      })
      // Only a focused text field brings a keyboard up. Without this, a pinch zoom (which shrinks the
      // visible viewport) or a window made shorter would hide the bars as if one were.
      const open = geometry.open && typing()
      const inset = `${geometry.inset}px`
      const top = `${geometry.top}px`
      // The visual viewport fires scroll often while a keyboard is up, and every write to <html>'s
      // custom properties restyles the whole page, so only a change is written.
      if (inset !== last.inset) root.style.setProperty('--keyboard-inset', inset)
      if (top !== last.top) root.style.setProperty('--keyboard-top', top)
      if (open !== last.open) root.toggleAttribute('data-keyboard', open)
      last = { inset, top, open }
    }

    read()
    viewport?.addEventListener('resize', read)
    viewport?.addEventListener('scroll', read)
    window.addEventListener('resize', read)
    return () => {
      viewport?.removeEventListener('resize', read)
      viewport?.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      root.removeAttribute('data-keyboard')
      root.style.removeProperty('--keyboard-inset')
      root.style.removeProperty('--keyboard-top')
    }
  }, [active])
}
