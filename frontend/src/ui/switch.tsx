import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'

import { cx } from '../lib/cx'

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>

/**
 * The 38 by 22 on/off toggle. Underneath it is a checkbox with `role="switch"`, so it takes a
 * `<label>`, `checked` and `onChange` like any checkbox. The checkbox itself is see-through and
 * sits on top; on a touch screen it reaches past the drawn track to a 44px square.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, ...props },
  ref,
) {
  return (
    <span
      data-ui="switch"
      className={cx('relative inline-flex h-[22px] w-[38px] shrink-0 align-middle', className)}
    >
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className="peer absolute top-0 left-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed coarse:-top-[11px] coarse:-left-[3px] coarse:size-11"
        {...props}
      />
      <span
        aria-hidden="true"
        className={cx(
          'pointer-events-none absolute inset-0 rounded-pill bg-line-strong peer-checked:bg-accent peer-disabled:opacity-50',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-focus-visible:outline-solid',
        )}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[3px] left-[3px] size-[16px] rounded-full bg-muted transition-transform peer-checked:translate-x-[16px] peer-checked:bg-accent-ink motion-reduce:transition-none"
      />
    </span>
  )
})
