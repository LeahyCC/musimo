import { forwardRef } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react'

import { cx } from '../cx'

const fieldClassName =
  'w-full rounded-[5px] border border-line-strong bg-raised px-[11px] py-[10px] text-small text-text disabled:opacity-[0.55] coarse:min-h-11 coarse:text-[16px]'

/** A text/number input sized for settings, filters and forms: 16px text and 44px height on `coarse`. */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Field({ className, ...props }, ref) {
    return <input ref={ref} data-ui="field" className={cx(fieldClassName, className)} {...props} />
  },
)

/** The `<select>` counterpart to `Field`, same look and the same touch sizing. */
export const FieldSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function FieldSelect({ className, children, ...props }, ref) {
    return (
      <select ref={ref} data-ui="field" className={cx(fieldClassName, className)} {...props}>
        {children}
      </select>
    )
  },
)
