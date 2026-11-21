import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

import { cx } from '../../lib/cx'
import { FieldSelect } from '../../ui'
import { useBotChat } from './bot-chat'
import { DISCOVERY_LABELS } from './proposals'
import type { Discovery } from './proposals'
import { usePetLook } from './use-pet'

const CHOICES: readonly Discovery[] = ['close', 'balanced', 'explore']

/** How far a library search reaches from what the person already knows. It belongs to this
 *  conversation and applies to the next request; Clear chat puts it back to Balanced. `flush` is
 *  the phone page, which pads its own sides. */
export function DiscoveryBar({ flush = false }: { flush?: boolean }) {
  const chat = useBotChat()
  const win95 = usePetLook().pixel
  const group = useRef<HTMLDivElement>(null)
  const busy = chat.thinking || chat.applying || chat.confirming || chat.holding

  if (win95)
    return (
      <div className="flex shrink-0 items-center gap-[6px] px-[4px] py-[6px]" data-bot="discovery">
        <label htmlFor="bot-discovery" className="whitespace-nowrap">
          Discovery:
        </label>
        <FieldSelect
          id="bot-discovery"
          fullWidth={false}
          value={chat.discovery}
          disabled={busy}
          onChange={(event) => chat.setDiscovery(event.target.value as Discovery)}
        >
          {CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {DISCOVERY_LABELS[choice]}
            </option>
          ))}
        </FieldSelect>
      </div>
    )

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const at = CHOICES.indexOf(chat.discovery)
    const next = CHOICES[(at + step + CHOICES.length) % CHOICES.length]
    if (!next) return
    chat.setDiscovery(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-discovery="${next}"]`)?.focus()
  }

  return (
    <div
      className={cx(
        'flex shrink-0 items-center gap-[10px] border-b border-line text-tiny text-muted',
        flush ? 'py-[6px]' : 'px-[12px] py-[8px]',
      )}
      data-bot="discovery"
    >
      <span id="bot-discovery-label" className="whitespace-nowrap">
        Discovery
      </span>
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby="bot-discovery-label"
        onKeyDown={keys}
        className="flex min-w-0 gap-[2px] rounded-[7px] border border-line bg-sunken p-[2px] max-phone:grid max-phone:flex-1 max-phone:grid-cols-3"
      >
        {CHOICES.map((choice) => {
          const on = choice === chat.discovery
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              data-discovery={choice}
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={busy}
              onClick={() => chat.setDiscovery(choice)}
              className={cx(
                'rounded-[5px] border-0 px-[9px] py-[5px] text-tiny whitespace-nowrap disabled:opacity-50 coarse:min-h-11 max-phone:px-[4px]',
                on
                  ? 'bg-active font-medium text-text'
                  : 'bg-transparent text-muted hover:text-text',
              )}
            >
              {DISCOVERY_LABELS[choice]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
