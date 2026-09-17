import type { HTMLAttributes } from 'react'

import { cx } from '../cx'

/** A bordered content box: settings sources, diagnostics cards, the readiness panel. */
export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      data-ui="panel"
      className={cx('rounded-[8px] border border-line p-[23px]', 'max-tablet:p-[18px]', className)}
      {...props}
    />
  )
}

/** A centered placeholder for a page or section with nothing in it yet. */
export function EmptyPanel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      data-ui="empty-panel"
      className={cx(
        'flex min-h-[390px] flex-col items-center justify-center gap-[20px] rounded-[9px] border border-line p-[30px] text-center',
        '[&>svg]:text-muted [&_p]:max-w-[400px] [&_p]:text-lead',
        className,
      )}
      {...props}
    />
  )
}
