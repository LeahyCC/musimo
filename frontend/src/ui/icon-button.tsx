import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

/** `compact` is the 32 by 36 box a crowded row uses: the footer player and the playlist picker. */
export type IconButtonSize = 'default' | 'compact'

/** The `.icon-button` look as a class string, for an element the component can't wrap (a routed link). */
export function iconButtonClassName(
  active?: boolean,
  className?: ClassName,
  size: IconButtonSize = 'default',
) {
  return cx(
    'inline-flex items-center justify-center border-0 bg-transparent p-[7px]',
    size === 'compact' && 'min-h-[36px] min-w-[32px]',
    // After the size, so a touch screen still gets its 44px whatever the row asked for.
    'coarse:min-h-11 coarse:min-w-11',
    active ? 'text-accent' : 'text-muted',
    className,
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A toggled-on look (accent color) plus the matching `aria-pressed`, for on/off controls. */
  active?: boolean
  size?: IconButtonSize
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active, size, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      data-ui="icon-button"
      className={iconButtonClassName(active, className, size)}
      {...props}
    />
  )
})
