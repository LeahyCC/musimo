import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

/** The `.icon-button` look as a class string, for an element the component can't wrap (a routed link). */
export function iconButtonClassName(active?: boolean, className?: ClassName) {
  return cx(
    'inline-flex items-center justify-center border-0 bg-transparent p-[7px]',
    'coarse:min-h-11 coarse:min-w-11',
    active ? 'text-accent' : 'text-muted',
    className,
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A toggled-on look (accent color) plus the matching `aria-pressed`, for on/off controls. */
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active, className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      data-ui="icon-button"
      className={iconButtonClassName(active, className)}
      {...props}
    />
  )
})
