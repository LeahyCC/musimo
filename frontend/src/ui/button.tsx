import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

export type ButtonVariant = 'default' | 'primary' | 'danger'

const variantClassNames: Record<ButtonVariant, string> = {
  default: 'border-line-strong bg-hover text-text hover:bg-active',
  primary:
    'border-accent bg-accent text-accent-ink hover:bg-[color-mix(in_oklab,var(--color-accent)_75%,var(--color-text))]',
  danger: 'border-danger-line bg-hover text-danger hover:bg-danger-bg',
}

/** The `.button` look as a class string, for elements the component can't wrap (routed links). */
export function buttonClassName(variant: ButtonVariant = 'default', className?: ClassName) {
  return cx(
    'inline-flex min-h-[39px] items-center justify-center gap-[10px] rounded-md border px-[14px] py-[10px] text-small font-medium',
    'coarse:min-h-11 coarse:min-w-11',
    variantClassNames[variant],
    className,
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-ui="button"
      data-variant={variant}
      className={buttonClassName(variant, className)}
      {...props}
    />
  )
})
