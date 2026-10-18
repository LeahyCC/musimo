import type { ReactNode } from 'react'

import { cx } from '../lib/cx'
import { useLayout } from '../lib/layout'

/**
 * The heading block every route opens with: a small eyebrow, the page name, and room for a chip.
 * `compact` is for a page whose controls need the first phone screen: a phone shrinks the name to
 * the small heading size and keeps the chip on the name's row. The Listening room's header already
 * carries the page name, so there the heading is for screen readers and only the chip is drawn.
 */
export function PageTitle({
  eyebrow,
  title,
  compact = false,
  children,
}: {
  eyebrow: string
  title: string
  compact?: boolean
  children?: ReactNode
}) {
  if (useLayout() === 'room')
    return (
      <>
        <h1 className="sr-only">{title}</h1>
        {children && <div className="mb-[14px] flex justify-end">{children}</div>}
      </>
    )

  return (
    <div
      className={cx(
        'mt-[1px] mb-[23px] flex items-center justify-between gap-[20px]',
        compact
          ? 'max-phone:mb-[12px] max-phone:gap-[10px]'
          : 'max-phone:flex-wrap max-phone:items-start max-phone:gap-[15px]',
      )}
    >
      <div className={compact ? 'min-w-0' : undefined}>
        <p
          className={cx(
            'text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption',
            compact ? 'mb-[12px] max-phone:mb-[4px]' : 'mb-[12px]',
          )}
        >
          {eyebrow}
        </p>
        <h1 className={compact ? 'max-phone:text-heading' : undefined}>{title}</h1>
      </div>
      {children}
    </div>
  )
}
