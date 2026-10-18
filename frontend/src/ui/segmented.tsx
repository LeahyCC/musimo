import { useId } from 'react'
import type { ReactNode } from 'react'

import { cx } from '../lib/cx'

export type SegmentedOption<Value extends string> = {
  value: Value
  label: ReactNode
  /** Needed when `label` is only an icon. */
  ariaLabel?: string
}

export interface SegmentedProps<Value extends string> {
  /** Names the group for assistive tech, e.g. "Settings for". */
  label: string
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange: (value: Value) => void
  className?: string
}

/**
 * The two-to-four way switch: Settings' Server / Yours, the stage's Art / MilkDrop, Octive's scope.
 * Each segment is a real radio button, hidden, under a label that draws the look, so the arrow keys,
 * the tab order and what a screen reader says are the browser's own.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedProps<Value>) {
  const name = useId()

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-ui="segmented"
      className={cx(
        'inline-flex w-fit shrink-0 rounded-[9px] border border-line bg-sunken p-[3px]',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <label
            key={option.value}
            className={cx(
              'inline-flex h-[30px] cursor-pointer items-center justify-center gap-[6px] rounded-md px-[14px] text-small font-medium whitespace-nowrap coarse:min-h-11',
              selected ? 'bg-active text-text' : 'text-muted hover:text-text',
              // The radio is hidden, so its focus ring goes on the label.
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid',
            )}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={selected}
              aria-label={option.ariaLabel}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        )
      })}
    </div>
  )
}
