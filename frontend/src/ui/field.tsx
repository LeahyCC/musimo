import { forwardRef } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react'

import { cx } from '../cx'

/* `cx` only joins strings, so a caller cannot swap the border, the text color or the width by
   passing another utility for the same property: which one wins is up to the order of the built
   sheet. The two things callers need to change are options here instead. */
export interface FieldOptions {
  /** Paints the border and the text in the danger color, alongside `aria-invalid`. */
  invalid?: boolean
  /** Off for a field that sits in a row and takes its width from `className`. */
  fullWidth?: boolean
  /** `sunken` is the filter and toolbar look: the sunken surface, a lighter line, a tighter box. */
  tone?: 'raised' | 'sunken'
}

const fieldClassName = ({ invalid, fullWidth = true, tone = 'raised' }: FieldOptions) =>
  cx(
    'border text-small disabled:opacity-[0.55] coarse:min-h-11 coarse:text-base',
    tone === 'sunken'
      ? 'rounded-[7px] bg-sunken p-[8px]'
      : 'rounded-[5px] bg-raised px-[11px] py-[10px]',
    fullWidth && 'w-full',
    invalid
      ? 'border-danger-line text-danger'
      : cx(tone === 'sunken' ? 'border-line' : 'border-line-strong', 'text-text'),
  )

/** A text/number input sized for settings, filters and forms: 16px text and 44px height on `coarse`. */
export const Field = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldOptions
>(function Field({ className, invalid, fullWidth, tone, ...props }, ref) {
  return (
    <input
      ref={ref}
      data-ui="field"
      aria-invalid={invalid || undefined}
      className={cx(fieldClassName({ invalid, fullWidth, tone }), className)}
      {...props}
    />
  )
})

/** The `<select>` counterpart to `Field`, same look and the same touch sizing. */
export const FieldSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldOptions
>(function FieldSelect({ className, children, invalid, fullWidth, tone, ...props }, ref) {
  return (
    <select
      ref={ref}
      data-ui="field"
      aria-invalid={invalid || undefined}
      className={cx(fieldClassName({ invalid, fullWidth, tone }), className)}
      {...props}
    >
      {children}
    </select>
  )
})
