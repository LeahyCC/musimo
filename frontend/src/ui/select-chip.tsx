import { ChevronDown } from 'lucide-react'

import { cx } from '../lib/cx'

export type SelectChipOption<Value extends string> = { value: Value; label: string }

export interface SelectChipProps<Value extends string> {
  /** The muted word in front of the value, e.g. "Sort". Also the select's accessible name. */
  label: string
  value: Value
  options: readonly SelectChipOption<Value>[]
  onChange: (value: Value) => void
  /** The value that counts as "not filtering". Any other value draws the chip in its active look. */
  defaultValue?: Value
  disabled?: boolean
  className?: string
}

/**
 * Classic's 36px toolbar control: "Sort Recently added ⌄". A real `<select>` lies over the whole
 * chip, invisible, so a click, a tap or the keyboard opens the platform's own picker and a screen
 * reader hears an ordinary labelled select. The text drawn underneath is only for the eye.
 */
export function SelectChip<Value extends string>({
  label,
  value,
  options,
  onChange,
  defaultValue,
  disabled,
  className,
}: SelectChipProps<Value>) {
  const active = defaultValue !== undefined && value !== defaultValue
  const shown = options.find((option) => option.value === value)?.label ?? value

  return (
    <span
      data-ui="select-chip"
      data-active={active || undefined}
      className={cx(
        'relative inline-flex h-[36px] shrink-0 items-center gap-[6px] rounded-[8px] border pr-[10px] pl-[12px] text-body whitespace-nowrap text-text coarse:min-h-11',
        active ? 'border-good-line bg-active' : 'border-line bg-sunken',
        // The select is see-through, so the ring it would draw has to go on the chip.
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid',
        disabled && 'opacity-50',
        className,
      )}
    >
      <span aria-hidden="true" className="text-muted">
        {label}
      </span>
      <span aria-hidden="true">{shown}</span>
      <ChevronDown aria-hidden="true" size={14} />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value)
          if (next) onChange(next.value)
        }}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed coarse:text-base"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}
