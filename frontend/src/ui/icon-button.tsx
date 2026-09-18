import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

/**
 * `compact` is the 32 by 36 box a crowded row uses: the footer player and the playlist picker.
 * `box` is the 36px square the library's play, shuffle and delete share in a row's action cluster.
 */
export type IconButtonSize = 'default' | 'compact' | 'box'
/**
 * `outlined` draws a border and takes the surrounding text color: the actions on a job card.
 * `accent` is the album download control: a soft border, accent ink, and on a card a wash of the
 * page color so the icon reads over artwork. `on-media` is the Now Playing stage's controls, drawn
 * over artwork or the visualizer, so they take the on-media color a theme keeps light.
 */
export type IconButtonVariant = 'plain' | 'outlined' | 'accent' | 'accent-washed' | 'on-media'

/** The `.icon-button` look as a class string, for an element the component can't wrap (a routed link). */
export function iconButtonClassName(
  active?: boolean,
  className?: ClassName,
  size: IconButtonSize = 'default',
  variant: IconButtonVariant = 'plain',
) {
  return cx(
    'inline-flex items-center justify-center p-[7px]',
    (variant === 'plain' || variant === 'on-media') && 'border-0 bg-transparent',
    variant === 'outlined' && 'rounded-[8px] border border-line-strong bg-transparent',
    variant === 'accent' && 'rounded-[8px] border border-line bg-transparent',
    variant === 'accent-washed' && 'rounded-[8px] border border-line bg-canvas/93',
    size === 'compact' && 'min-h-[36px] min-w-[32px]',
    size === 'box' && 'h-[36px] w-[36px]',
    // After the size, so a touch screen still gets its 44px whatever the row asked for.
    'coarse:min-h-11 coarse:min-w-11',
    active || variant.startsWith('accent')
      ? 'text-accent'
      : variant === 'outlined'
        ? 'text-text'
        : variant === 'on-media'
          ? 'text-on-media'
          : 'text-muted',
    className,
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A toggled-on look (accent color) plus the matching `aria-pressed`, for on/off controls. */
  active?: boolean
  size?: IconButtonSize
  variant?: IconButtonVariant
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active, size, variant, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      data-ui="icon-button"
      className={iconButtonClassName(active, className, size, variant)}
      {...props}
    />
  )
})
