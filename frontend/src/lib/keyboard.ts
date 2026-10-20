/** Less than this and the change is a browser bar sliding, not an on-screen keyboard. */
export const KEYBOARD_MIN = 120

export type ViewportReading = {
  /** `window.innerHeight`, the layout viewport. */
  layout: number
  /** The tallest layout viewport seen at this width, before anything pushed it up. */
  tallest: number
  /** `visualViewport.height` and `offsetTop`: the part of the page the person can see. */
  visible: number
  top: number
}

export type KeyboardGeometry = {
  open: boolean
  /** How far the visible part stops short of the layout viewport's foot. Fixed bars sit there. */
  inset: number
  /** How far the browser has scrolled the visible part down, to keep a focused field in sight. */
  top: number
}

/**
 * Where an on-screen keyboard is, from the two viewports. iOS Safari and Android Chrome (by
 * default) leave the layout viewport alone and shrink only the visible one, so a bar fixed to the
 * bottom ends up behind the keyboard; the gap between the two is the keyboard. A browser that
 * resizes the layout viewport instead shows it as a layout shorter than the tallest seen.
 */
export function keyboardGeometry(reading: ViewportReading): KeyboardGeometry {
  const top = Math.max(0, Math.round(reading.top))
  const inset = Math.max(0, Math.round(reading.layout - reading.visible - reading.top))
  const shrunk = reading.tallest - reading.layout
  return { open: inset >= KEYBOARD_MIN || shrunk >= KEYBOARD_MIN, inset, top }
}
