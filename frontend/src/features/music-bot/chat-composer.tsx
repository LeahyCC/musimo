import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Music2, SendHorizontal, X } from 'lucide-react'

import { cx } from '../../lib/cx'
import { Button } from '../../ui'
import { usePlayer } from '../player/player'
import { MAX_PROMPT, useBotChat } from './bot-chat'
import { LIKE_STARTER, startersFor } from './starters'
import { usePetLook } from './use-pet'

/** `panel` is the popover and sheet; `page` and `room` are the full page in each layout. */
export type ComposerLook = 'panel' | 'page' | 'room'

export function Composer({
  autoFocus,
  look = 'panel',
}: {
  autoFocus: boolean
  look?: ComposerLook
}) {
  const chat = useBotChat()
  const player = usePlayer()
  const win95 = usePetLook().pixel
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const locked = chat.locked !== null
  const cancellable = chat.thinking || chat.applying
  const waiting = cancellable || chat.confirming || chat.holding
  const latest = chat.log.at(-1)
  const offersReplies = latest?.kind === 'reply' && latest.suggestions.length > 0
  const onPage = look !== 'panel'
  const refining = look === 'room' && chat.reply !== null
  // The empty chat already offers these in its middle, so the row only appears under a conversation.
  const prompts = onPage && !locked && chat.log.length > 0 ? startersFor(player.libraryTrack) : []

  useEffect(() => {
    if (autoFocus && !offersReplies) field.current?.focus()
    // Only on opening.
  }, [])

  // The box grows with its text up to about five lines, then scrolls.
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight + 2, 120)}px`
  }, [text])

  function submit() {
    if (!text.trim() || waiting || locked) return
    const sending = text
    setText('')
    void chat.send(sending)
  }

  function ask(prompt: string) {
    if (prompt === LIKE_STARTER && player.libraryTrack)
      chat.setReference({
        id: player.libraryTrack.id,
        label: `${player.libraryTrack.title} · ${player.libraryTrack.artist}`,
      })
    void chat.send(prompt)
  }

  const placeholder =
    chat.locked === 'busy'
      ? 'Chat opens when the scan finishes'
      : chat.locked === 'offline'
        ? 'Waiting for the model server'
        : chat.locked === 'nomodel'
          ? 'Choose a model to start'
          : refining
            ? 'Refine, or ask for something new'
            : `Ask ${chat.name} for music`

  return (
    <form
      data-bot="composer"
      className={cx(
        'grid shrink-0 gap-[8px]',
        onPage ? 'bg-canvas pt-[12px] pb-[4px]' : 'border-t border-line px-[12px] py-[10px]',
      )}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {chat.reference && (
        <div className="flex min-w-0 items-center gap-[8px] text-tiny text-muted">
          <span>Reference</span>
          <span className="inline-flex h-[28px] min-w-0 items-center gap-[6px] rounded-pill border border-accent py-0 pr-[2px] pl-[10px] text-text coarse:h-11">
            <Music2 size={12} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{chat.reference.label}</span>
            <button
              type="button"
              aria-label="Clear reference"
              onClick={() => chat.setReference(null)}
              className="grid size-[24px] shrink-0 place-items-center rounded-pill border-0 bg-transparent p-0 text-muted hover:bg-hover hover:text-text coarse:size-10"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
      )}
      {prompts.length > 0 && (
        <div role="group" aria-label="Prompts" className="flex flex-wrap gap-[8px]">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              data-bot="prompt"
              disabled={waiting}
              onClick={() => ask(prompt)}
              className="inline-flex h-[30px] items-center rounded-pill border border-line-strong bg-sunken px-[12px] text-tiny whitespace-nowrap text-muted hover:text-text disabled:opacity-50 coarse:min-h-11"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      <div
        className={cx(
          'flex items-end gap-[8px]',
          onPage &&
            'items-center rounded-[12px] border border-line-strong bg-sunken py-[6px] pr-[6px] pl-[14px] focus-within:border-accent',
        )}
      >
        <textarea
          ref={field}
          rows={1}
          maxLength={MAX_PROMPT}
          aria-label={`Ask ${chat.name} for music`}
          placeholder={placeholder}
          disabled={locked}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          data-bot="field"
          className={cx(
            'min-w-0 flex-1 resize-none overflow-y-auto text-small leading-[1.35] text-text placeholder:text-faint disabled:opacity-55',
            onPage
              ? 'min-h-[36px] border-0 bg-transparent px-0 py-[8px] outline-0'
              : 'min-h-[39px] rounded-[8px] border border-line-strong bg-sunken px-[11px] py-[10px]',
          )}
        />
        {cancellable ? (
          <Button className="shrink-0" onClick={chat.cancel}>
            Cancel
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            aria-label="Send"
            className={cx('min-w-11 shrink-0 px-[12px]', onPage && 'size-[38px] rounded-[9px] p-0')}
            disabled={locked || chat.confirming || chat.holding || !text.trim()}
          >
            {win95 ? 'Send' : <SendHorizontal size={16} aria-hidden="true" />}
          </Button>
        )}
      </div>
      {!win95 && (
        <div className="flex justify-between gap-[10px] text-micro text-faint">
          <span>
            {locked
              ? 'Your music keeps playing while you wait.'
              : onPage
                ? 'Goes by your tags and play history. Can’t hear the music, so moods and tempos are off the menu.'
                : 'Goes by your tags and play history. Can’t hear the music.'}
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {waiting || locked
              ? ''
              : text.length
                ? `${text.length.toLocaleString()} / 2,000`
                : 'Enter to send'}
          </span>
        </div>
      )}
    </form>
  )
}
