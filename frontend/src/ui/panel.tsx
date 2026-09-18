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

/**
 * A centered placeholder for a page or section with nothing in it yet. `tall` is the whole-page
 * kind, which takes more of the viewport than a section's.
 */
export function EmptyPanel({
  tall,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { tall?: boolean }) {
  return (
    <section
      data-ui="empty-panel"
      className={cx(
        'mt-[30px] flex flex-col items-center justify-center gap-[20px] rounded-[9px] border border-line p-[30px] text-center',
        tall ? 'min-h-[55vh]' : 'min-h-[390px]',
        '[&>svg]:text-muted [&_p]:max-w-[400px] [&_p]:text-lead',
        className,
      )}
      {...props}
    />
  )
}
