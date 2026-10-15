/* Where the chat popover goes, next to a pet that can sit on the left, middle or right of the
   footer, or on the Now Playing stage. Plain geometry: no DOM, so the rules can be tested. */

export type Box = { left: number; top: number; width: number; height: number }

/** The design's popover: 400 wide, up to 560 tall. */
export const POPOVER_WIDTH = 400
export const POPOVER_MAX_HEIGHT = 560
/** Clear space kept between the popover and the window's edges, the top bar and the pet. */
export const POPOVER_GAP = 12
/** Shorter than this and the popover is no longer usable, so it is laid out anyway at this. */
const POPOVER_MIN_HEIGHT = 320

export type PopoverPlacement = Box & { side: 'above' | 'below'; arrowLeft: number }

/**
 * Prefers above the pet (it perches on the footer, so that is where the room is), with its left
 * edge a little left of the pet so the arrow lands on it, then clamps into the window. `topLimit`
 * is the bottom of the sticky top bar, which the popover never covers.
 */
export function placePopover(
  anchor: Box,
  viewport: { width: number; height: number },
  topLimit: number,
): PopoverPlacement {
  const width = Math.min(POPOVER_WIDTH, viewport.width - POPOVER_GAP * 2)
  const roomAbove = anchor.top - POPOVER_GAP - Math.max(topLimit + POPOVER_GAP, POPOVER_GAP)
  const anchorBottom = anchor.top + anchor.height
  const roomBelow = viewport.height - POPOVER_GAP - (anchorBottom + POPOVER_GAP)
  const side = roomAbove >= Math.min(POPOVER_MAX_HEIGHT, roomBelow) ? 'above' : 'below'
  const room = side === 'above' ? roomAbove : roomBelow
  const height = Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, room))
  const centre = anchor.left + anchor.width / 2
  const wanted = centre - 40
  const left = Math.min(Math.max(wanted, POPOVER_GAP), viewport.width - POPOVER_GAP - width)
  const top = side === 'above' ? anchor.top - POPOVER_GAP - height : anchorBottom + POPOVER_GAP
  // The arrow points at the pet's middle, kept off the rounded corners.
  const arrowLeft = Math.min(Math.max(centre - left, 24), width - 24)
  return { left, top, width, height, side, arrowLeft }
}

/** The design keeps the pet this far in from the footer's edge when it sits left or right. */
export const PERCH_INSET = 29
/** On a phone the pet stands this far above the mini player, clear of its seek strip. */
export const PHONE_PERCH_LIFT = 7

/**
 * The pet's horizontal spot on the bar, as CSS for the perch's absolutely placed button. The
 * phone always uses the left, where the mini player has only its cover underneath.
 */
export function perchStyle(
  position: 'left' | 'centre' | 'right',
  phone: boolean,
): { left?: string; right?: string; transform?: string } {
  if (phone) return { left: '8px' }
  if (position === 'centre') return { left: '50%', transform: 'translateX(-50%)' }
  if (position === 'right') return { right: `${PERCH_INSET}px` }
  return { left: `${PERCH_INSET}px` }
}
