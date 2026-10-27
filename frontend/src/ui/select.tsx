import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SelectHTMLAttributes,
} from 'react'

import { Check } from 'lucide-react'

import { cx } from '../lib/cx'

/** One row of the list, read from the `<select>`'s own options when it opens. */
export type PickerOption = { value: string; label: string; disabled: boolean; group?: string }

/** The options a `<select>` holds right now, with the label of the `<optgroup>` around each. */
export function readOptions(select: HTMLSelectElement): PickerOption[] {
  return Array.from(select.options).map((option) => ({
    value: option.value,
    label: option.label || option.text,
    disabled: option.disabled,
    group:
      option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : undefined,
  }))
}

/** The next row the arrow keys land on, skipping disabled ones and stopping at the ends. */
export function stepOption(options: readonly PickerOption[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < options.length; index += step)
    if (!options[index]?.disabled) return index
  return from
}

/** The first enabled row whose label starts with what was typed, looking after `from` first. */
export function matchOption(options: readonly PickerOption[], typed: string, from: number): number {
  const text = typed.toLowerCase()
  const order = [...options.keys()].map((offset) => (from + 1 + offset) % options.length)
  return (
    order.find(
      (index) => !options[index]?.disabled && options[index]?.label.toLowerCase().startsWith(text),
    ) ?? -1
  )
}

// React tracks a select's value itself, so a plain `select.value = …` would not reach `onChange`.
// Setting it through the prototype's setter and firing a real `change` is what a person's own pick
// does, so every caller's `onChange` and every form keeps working unchanged.
function choose(select: HTMLSelectElement, value: string) {
  if (select.value === value) return
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' '])

// `(pointer: coarse)` alone misses a phone that calls its primary pointer fine. Either query is a
// finger, and a finger gets the system picker: the drawn list has no chrome to close it with.
const nativePicker = () =>
  typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches

/**
 * A real `<select>` whose list is drawn by the app instead of the browser. The `<select>` keeps the
 * value, the form field, `onChange`, the label and what a screen reader hears; only opening it is
 * taken over, and only with a mouse or trackpad. A touch screen keeps the phone's own picker, which
 * is large, familiar and already dismissible. Some phones report the tap as a mouse, so the choice
 * follows the pointer query, not the event's pointer type.
 *
 * The list is a manual popover beside the `<select>`, so it sits in the top layer above any clipping
 * and, inside a modal sheet, is still part of that sheet rather than behind it.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ onPointerDown, onKeyDown, ...props }, forwarded) {
    const select = useRef<HTMLSelectElement | null>(null)
    const list = useRef<HTMLSpanElement>(null)
    const listId = useId()
    const [options, setOptions] = useState<PickerOption[] | null>(null)
    const [name, setName] = useState('')
    const [active, setActive] = useState(0)
    const typed = useRef({ text: '', at: 0 })

    const setRef = useCallback(
      (element: HTMLSelectElement | null) => {
        select.current = element
        if (typeof forwarded === 'function') forwarded(element)
        else if (forwarded) forwarded.current = element
      },
      [forwarded],
    )

    const close = useCallback((refocus: boolean) => {
      setOptions(null)
      if (list.current?.matches(':popover-open')) list.current.hidePopover()
      if (refocus) select.current?.focus()
    }, [])

    const open = () => {
      const element = select.current
      if (!element || element.disabled) return
      const rows = readOptions(element)
      if (!rows.length) return
      setOptions(rows)
      setActive(Math.max(0, element.selectedIndex))
      // The list is named like its select, which may be labelled by a <label> rather than a prop.
      setName(element.getAttribute('aria-label') ?? element.labels?.[0]?.textContent?.trim() ?? '')
    }

    // Placed once the rows are in the page, so the list knows its own height: under the select,
    // or over it when the window has more room above.
    useEffect(() => {
      const element = select.current
      const popup = list.current
      if (!options || !element || !popup) return
      if (!popup.matches(':popover-open')) popup.showPopover()
      const box = element.getBoundingClientRect()
      const height = popup.offsetHeight
      const below = window.innerHeight - box.bottom
      const above = box.top
      const top = below >= height + 8 || below >= above ? box.bottom + 4 : box.top - height - 4
      popup.style.top = `${Math.max(8, top)}px`
      popup.style.left = `${Math.min(box.left, window.innerWidth - popup.offsetWidth - 8)}px`
      popup.style.minWidth = `${box.width}px`
      popup.focus({ preventScroll: true })
      popup.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
      // The list is placed against the page as it is now, so a scroll or resize closes it.
      const away = (event: Event) => {
        if (event.target instanceof Node && popup.contains(event.target)) return
        close(false)
      }

      // A tap on the picture does not move focus, so blur never fires and the list stays up.
      const outside = (event: PointerEvent) => {
        const target = event.target
        if (!(target instanceof Node)) return
        if (popup.contains(target) || element.contains(target)) return
        close(false)
      }
      window.addEventListener('scroll', away, true)
      window.addEventListener('resize', away)
      document.addEventListener('pointerdown', outside)
      return () => {
        window.removeEventListener('scroll', away, true)
        window.removeEventListener('resize', away)
        document.removeEventListener('pointerdown', outside)
      }
    }, [options, close])

    useEffect(() => {
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }, [active])

    const pick = (index: number) => {
      const row = options?.[index]
      if (!row || row.disabled || !select.current) return
      choose(select.current, row.value)
      close(true)
    }

    const onSelectPointerDown = (event: ReactPointerEvent<HTMLSelectElement>) => {
      onPointerDown?.(event)
      if (event.defaultPrevented || event.button !== 0) return
      if (event.pointerType === 'touch' || nativePicker()) return
      event.preventDefault()
      select.current?.focus()
      if (options) close(false)
      else open()
    }

    const onSelectKeyDown = (event: ReactKeyboardEvent<HTMLSelectElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented || !OPEN_KEYS.has(event.key)) return
      // A coarse pointer means the phone's picker, keyboard or not.
      if (matchMedia('(pointer: coarse)').matches) return
      event.preventDefault()
      open()
    }

    const onListKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
      if (!options) return
      const last = options.length - 1
      if (event.key === 'ArrowDown') setActive(stepOption(options, active, 1))
      else if (event.key === 'ArrowUp') setActive(stepOption(options, active, -1))
      else if (event.key === 'Home') setActive(stepOption(options, -1, 1))
      else if (event.key === 'End') setActive(stepOption(options, last + 1, -1))
      else if (event.key === 'Enter' || event.key === ' ') pick(active)
      else if (event.key === 'Escape') close(true)
      else if (event.key === 'Tab') {
        close(true)
        return
      } else if (event.key.length === 1) {
        const now = Date.now()
        typed.current = {
          text: now - typed.current.at < 700 ? typed.current.text + event.key : event.key,
          at: now,
        }
        const found = matchOption(options, typed.current.text, active)
        if (found >= 0) setActive(found)
      } else return
      event.preventDefault()
    }

    let group: string | undefined
    return (
      <>
        <select
          ref={setRef}
          aria-expanded={options ? true : undefined}
          aria-controls={options ? listId : undefined}
          onPointerDown={onSelectPointerDown}
          onKeyDown={onSelectKeyDown}
          {...props}
        />
        {/* Spans, not divs: some selects sit inside a <label>, which only takes inline content. */}
        <span
          ref={list}
          id={listId}
          popover="manual"
          role="listbox"
          tabIndex={-1}
          data-ui="select-list"
          aria-label={name || undefined}
          aria-activedescendant={options ? `${listId}-${active}` : undefined}
          onKeyDown={onListKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) close(false)
          }}
          className={cx(
            // `inset-auto` undoes the popover's own full-screen inset; top and left are set inline. No
            // display class: one would beat the browser rule that hides a closed popover.
            'fixed inset-auto m-0 max-h-[min(320px,calc(100dvh-16px))] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain',
            'rounded-[10px] border border-line-strong bg-raised p-[4px] text-small text-text outline-none',
            'shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]',
          )}
        >
          {options?.map((row, index) => {
            const heading = row.group !== group ? row.group : undefined
            group = row.group
            const selected = row.value === select.current?.value
            return (
              <span className="block" key={`${row.group ?? ''}:${row.value}:${index}`}>
                {heading && (
                  <span className="block px-[10px] pt-[8px] pb-[4px] text-tiny font-semibold tracking-[0.5px] text-faint uppercase">
                    {heading}
                  </span>
                )}
                <span
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={row.disabled || undefined}
                  data-active={index === active}
                  className={cx(
                    'flex min-h-[32px] cursor-pointer items-center gap-[8px] rounded-[7px] py-[6px] pr-[10px] pl-[8px] whitespace-nowrap',
                    index === active && 'bg-hover',
                    selected ? 'text-accent' : 'text-text',
                    row.disabled && 'cursor-default opacity-50',
                  )}
                  onPointerMove={() => !row.disabled && setActive(index)}
                  onClick={() => pick(index)}
                >
                  <Check
                    aria-hidden="true"
                    size={14}
                    className={cx('shrink-0', !selected && 'invisible')}
                  />
                  {row.label}
                </span>
              </span>
            )
          })}
        </span>
      </>
    )
  },
)
