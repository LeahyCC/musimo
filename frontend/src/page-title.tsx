import type { ReactNode } from 'react'

import { cx } from './cx'

/**
 * The heading block every route opens with: a small eyebrow, the page name, and room for a chip.
 * `compact` is for a page whose controls need the first phone screen: a phone shrinks the name to
 * the small heading size and keeps the chip on the name's row.
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
