import { forwardRef } from 'react'
import type { AnchorHTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

/** The `.text-link` look as a class string, for elements the component can't wrap (routed links,
 * or a button standing in for a link). */
export function textLinkClassName(className?: ClassName) {
  return cx(
    'inline-flex items-center gap-2 text-small text-accent',
    'hover:text-[color-mix(in_oklab,var(--color-accent)_60%,var(--color-text))]',
    // A short link ("View all") is narrower than a touch target, so it gets the width as well.
    'coarse:min-h-11 coarse:min-w-11 coarse:justify-center',
    className,
  )
}

export const TextLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function TextLink({ className, ...props }, ref) {
    return <a ref={ref} data-ui="text-link" className={textLinkClassName(className)} {...props} />
  },
)
