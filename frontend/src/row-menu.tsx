import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { MoreHorizontal } from 'lucide-react'

import { cx } from './cx'
import { IconButton } from './ui'

export type RowMenuAction = {
  label: string
  onSelect: () => void
  disabled?: boolean
}

// The floating player and the phone's bottom bar cover the foot of the viewport, so a menu that
// would end inside that strip opens upward instead.
const FOOT_ROOM = 150

/**
 * A small "more actions" menu for a row: one button that opens a short list. Arrow keys move
 * through it, Escape closes it and returns to the button, and choosing an action closes it.
 */
export function RowMenu({
  label,
  actions,
  className,
  disabled,
}: {
  /** Names the button for a screen reader, e.g. "More actions for Second Wind". */
  label: string
  actions: RowMenuAction[]
  className?: string
  disabled?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [upward, setUpward] = useState(false)
  const menuId = useId()

  const items = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])

  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current?.getBoundingClientRect()
    const height = list.current?.getBoundingClientRect().height ?? 0
    if (button) setUpward(window.innerHeight - button.bottom < height + FOOT_ROOM)
  }, [open])

  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  function close(refocus: boolean) {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = items()
    const at = buttons.findIndex((button) => button === document.activeElement)
    const go = (index: number) => {
      event.preventDefault()
      buttons[(index + buttons.length) % buttons.length]?.focus()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') close(false)
    else if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(buttons.length - 1)
  }

  return (
    <div ref={root} className={cx('relative flex-none', className)}>
      <IconButton
        ref={trigger}
        size="compact"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={17} />
      </IconButton>
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={cx(
            'absolute right-0 z-overlay grid min-w-[170px] gap-[2px] rounded-[8px] border border-line bg-raised p-[4px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]',
            upward ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]',
          )}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              className="rounded-md border-0 bg-transparent px-[12px] py-[9px] text-left text-small text-text hover:bg-hover focus-visible:bg-hover disabled:text-faint coarse:min-h-11"
              onClick={() => {
                close(true)
                action.onSelect()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
