import type { CSSProperties } from 'react'

import type { PetState } from './pet-mood'
import { PixelPet } from './pet-pixel'
import type { PetKind, PetMotion, PetPaint } from './pet-settings'
import { ShapePet } from './pet-shape'

/* The pet is drawn from boxes and clip paths in percentages of its size, so one drawing scales
   from the 16px title bar icon to the 72px greeting. Its body takes `--pet-color` (the theme
   accent unless a colour was picked) and its face `--pet-ink` (the matching accent ink), so the
   face always meets the theme's own text-on-accent contrast. Props and bubbles use raised,
   line-strong, text and muted, so any theme dresses them.

   Animation is CSS only (the keyframes are in style.css), which costs nothing on the main thread
   while music plays. "reduced" keeps blinks, talking and fades and drops hops, sways and travel;
   "off" holds each pose still. */

export type PetProps = {
  kind: PetKind
  state: PetState
  /** The drawing's width and height in pixels. */
  size: number
  motion: PetMotion
  /** The Windows 95 skin's 16 by 16 pixel art. */
  pixel?: boolean
  /** A thin outline in the page colour, so the pet reads over the Now Playing cover wash. */
  ring?: boolean
  /** A picked colour. Without one the pet wears the theme accent. */
  paint?: PetPaint | null
}

export function Pet({ paint, ...props }: PetProps) {
  const style = paint
    ? ({ '--pet-color': paint.body, '--pet-ink': paint.ink } as CSSProperties)
    : undefined
  return (
    <span className="pet inline-block shrink-0 align-bottom" style={style} aria-hidden="true">
      {props.pixel ? <PixelPet {...props} /> : <ShapePet {...props} />}
    </span>
  )
}
