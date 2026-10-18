import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Plus, X } from 'lucide-react'

import { cx } from '../lib/cx'

const pillClassName =
  'inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-pill text-small whitespace-nowrap coarse:min-h-11'

export interface FilterChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'onClick'
> {
  /** The muted word in front, e.g. "Genre". */
  label: string
  /** What the filter is set to, e.g. "Latin". */
  value: string
  onRemove: () => void
}

/**
 * A filter that is on, from the Listening room's library toolbar: "Genre Latin ×". The whole pill
 * is the remove button, so the target is the pill and not the small cross.
 */
export function FilterChip({ label, value, onRemove, className, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      data-ui="filter-chip"
      aria-label={`Remove filter ${label}: ${value}`}
      className={cx(
        pillClassName,
        'border-0 bg-active pr-[6px] pl-[11px] text-text hover:bg-hover',
        className,
      )}
      onClick={onRemove}
      {...props}
    >
      <span className="text-muted">{label}</span>
      {value}
      <X aria-hidden="true" size={13} />
    </button>
  )
}

export interface AddChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The filter it adds, e.g. "Year". */
  children: ReactNode
}

/** The dashed "+ Year" pill beside the filter chips, for a filter that is not on yet. */
export function AddChip({ children, className, type = 'button', ...props }: AddChipProps) {
  return (
    <button
      type={type}
      data-ui="add-chip"
      className={cx(
        pillClassName,
        'border border-dashed border-line-strong bg-transparent px-[11px] text-muted hover:text-text',
        className,
      )}
      {...props}
    >
      <Plus aria-hidden="true" size={13} />
      {children}
    </button>
  )
}
