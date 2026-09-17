import type { HTMLAttributes } from 'react'

import { cx } from '../cx'

/** A small, always-good-colored label, e.g. "SAVED IN YOUR DATABASE". */
export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-ui="tag"
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-sm bg-good-bg px-[9px] py-[6px] text-micro tracking-[1px] text-good',
        'max-phone:text-caption',
        className,
      )}
      {...props}
    />
  )
}

export type StatusChipVariant = 'default' | 'good'

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: StatusChipVariant
}

/** A source or job status label, e.g. a provider's "healthy" / "degraded" state. */
export function StatusChip({ variant = 'default', className, ...props }: StatusChipProps) {
  return (
    <span
      data-ui="status-chip"
      className={cx(
        'rounded-[5px] border px-[8px] py-[4px] text-caption',
        variant === 'good'
          ? 'border-good-line bg-good-bg text-good'
          : 'border-partial-line bg-partial-bg text-partial',
        className,
      )}
      {...props}
    />
  )
}

export type OwnershipVariant = 'owned' | 'partial' | 'failed' | 'missing'

export interface OwnershipProps extends HTMLAttributes<HTMLSpanElement> {
  variant: OwnershipVariant
}

const ownershipVariantClassNames: Record<OwnershipVariant, string> = {
  owned: 'text-accent bg-owned-bg',
  partial: 'text-partial bg-partial-bg',
  failed: 'text-danger bg-danger-bg',
  missing: 'text-muted bg-active',
}

/** A track or album's library-ownership badge: in the library, another edition, failed, missing. */
export function Ownership({ variant, className, ...props }: OwnershipProps) {
  return (
    <span
      data-ui="ownership"
      className={cx(
        'inline-flex w-fit items-center gap-[4px] whitespace-nowrap rounded-sm px-[7px] py-[4px] text-tiny',
        ownershipVariantClassNames[variant],
        className,
      )}
      {...props}
    />
  )
}
