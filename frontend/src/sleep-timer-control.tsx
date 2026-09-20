import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { Moon, X } from 'lucide-react'

import { cx } from './cx'
import { durationText, usePlayer } from './player'
import { parseSleepChoice, SLEEP_MINUTES, sleepChoiceValue } from './sleep-timer'
import { IconButton } from './ui'

const NO_QUEUE_END = 'Not with shuffle or repeat'

/**
 * The Now Playing sleep timer: a moon button that opens a short menu of the same choices the old
 * select had. While a timer runs the button is accented, the time left sits beside it, and the
 * cross next to that cancels in one press. Arrow keys move through the menu, Escape closes it and
 * returns to the button, and choosing an item closes it.
 *
 * The row sits at the foot of the column, so the menu always opens upward.
 */
export function SleepTimerControl() {
  const { sleep, setSleep, shuffle, repeat } = usePlayer()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menuId = useId()
  // Shuffle and repeat never come to the last track, so the timer that waits for it is not offered.
  const noQueueEnd = shuffle || repeat !== 'off'
  const current = sleep ? sleepChoiceValue(sleep.choice) : 'off'

  const items = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])

  useEffect(() => {
    if (!open) return
    // Open on the running choice, so the arrows start from where the timer is.
    const buttons = items()
    const running = buttons.find((button) => button.getAttribute('aria-checked') === 'true')
    ;(running ?? buttons[0])?.focus()
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

  const choices = [
    { value: 'off', label: 'Off', disabled: false },
    { value: 'track', label: 'End of track', disabled: false },
    { value: 'queue', label: 'End of album or queue', disabled: noQueueEnd },
    ...SLEEP_MINUTES.map((minutes) => ({
      value: String(minutes),
      label: `${minutes} minutes`,
      disabled: false,
    })),
  ]

  return (
    <div ref={root} className="relative flex items-center gap-[2px]">
      <IconButton
        ref={trigger}
        size="compact"
        active={sleep !== null}
        // The menu says which choice is running, so a pressed state would be read out twice.
        aria-pressed={undefined}
        aria-label="Sleep timer"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Moon size={17} />
      </IconButton>
      {sleep && (
        <>
          <span role="timer" aria-label="Sleep time left" className="text-tiny tabular-nums">
            {durationText(sleep.remaining)}
          </span>
          <IconButton size="compact" aria-label="Cancel sleep timer" onClick={() => setSleep(null)}>
            <X size={14} />
          </IconButton>
        </>
      )}
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label="Sleep timer"
          onKeyDown={onKeyDown}
          className="absolute bottom-[calc(100%+4px)] left-0 z-overlay grid min-w-[190px] gap-[2px] rounded-[8px] border border-line bg-raised p-[4px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]"
        >
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice.value === current}
              disabled={choice.disabled}
              className={cx(
                'flex items-center justify-between gap-[12px] rounded-md border-0 bg-transparent px-[12px] py-[9px] text-left text-small hover:bg-hover focus-visible:bg-hover disabled:text-faint coarse:min-h-11',
                choice.value === current ? 'text-accent' : 'text-text',
              )}
              onClick={() => {
                close(true)
                setSleep(parseSleepChoice(choice.value))
              }}
            >
              <span className="grid">
                {choice.label}
                {choice.disabled && <small className="text-micro">{NO_QUEUE_END}</small>}
              </span>
              {choice.value === current && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
