import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'

import { cx } from '../cx'

/** A keyboard-shortcut hint. Hidden on a phone, where there is no keyboard to show it for. */
export const Kbd = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Kbd(
  { className, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      data-ui="kbd"
      className={cx(
        'rounded-sm border border-line-strong px-[6px] py-px text-tiny',
        'max-phone:hidden',
        className,
      )}
      {...props}
    />
  )
})
