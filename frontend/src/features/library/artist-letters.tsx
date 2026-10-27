import { useCallback, useEffect, useRef, useState } from 'react'

import { createPortal } from 'react-dom'

import { cx } from '../../lib/cx'

export type ArtistLetter = { letter: string; offset: number }

type JumpPage = { items: { id: string }[] }

type JumpResult = {
  data?: { pages: JumpPage[] }
  hasNextPage: boolean
  isError: boolean
}

/**
 * Loads artist pages until `offset` is in hand, then asks the list to scroll there.
 * A newer offset that arrives mid-fetch replaces the one in progress, so a drag
 * does not start a second loop.
 */
export function useArtistLetterJump(
  source: {
    pages: JumpPage[] | undefined
    hasNextPage: boolean
    fetchNextPage: () => Promise<JumpResult>
  },
  onReveal: (id: string) => void,
) {
  const [jumping, setJumping] = useState(false)
  const wanted = useRef<number | null>(null)
  const running = useRef(false)
  const sourceRef = useRef(source)
  const revealRef = useRef(onReveal)
  sourceRef.current = source
  revealRef.current = onReveal

  const jump = useCallback((offset: number) => {
    wanted.current = offset
    if (running.current) return
    running.current = true
    void (async () => {
      try {
        let pages = sourceRef.current.pages
        let hasNext = sourceRef.current.hasNextPage
        while (wanted.current !== null) {
          const want = wanted.current
          wanted.current = null
          let items = pages?.flatMap((page) => page.items) ?? []
          if (!items[want] && hasNext) {
            setJumping(true)
            // fetchNextPage resolves on a failed page, with the count unchanged and a next
            // page still on offer, so stop when a fetch errors or makes no progress.
            let result = await sourceRef.current.fetchNextPage()
            let count = result.data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0
            while (count <= want && result.hasNextPage && !result.isError) {
              const before = count
              result = await sourceRef.current.fetchNextPage()
              count = result.data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0
              if (count <= before) break
            }
            pages = result.data?.pages
            hasNext = result.hasNextPage
            items = pages?.flatMap((page) => page.items) ?? []
          }
          const target = items[want]
          if (target) revealRef.current(target.id)
        }
      } finally {
        running.current = false
        setJumping(false)
      }
    })()
  }, [])

  return { jumping, jump }
}

const letterButtonClassName =
  'grid h-[28px] min-w-[28px] shrink-0 place-items-center rounded-md px-[4px] font-mono text-small text-muted hover:bg-raised hover:text-text'

/**
 * Name-sorted Artists. A wide window gets one row that scrolls sideways. A phone gets the
 * contacts strip: drag it, and the letter shows large until the finger lifts. Either way the
 * buttons stay in the tab order.
 */
export function ArtistLetters({
  phone,
  letters,
  jumping,
  onJump,
}: {
  phone: boolean
  letters: readonly ArtistLetter[]
  jumping: boolean
  onJump: (offset: number) => void
}) {
  useLetterKeys(letters, onJump)
  if (phone) return <LetterRail letters={letters} jumping={jumping} onJump={onJump} />
  return (
    <div className="mb-[16px] flex items-center gap-[8px]">
      <nav
        aria-label="Jump to letter"
        className="flex min-w-0 flex-1 flex-nowrap gap-[2px] overflow-x-auto overscroll-contain"
      >
        {letters.map(({ letter, offset }) => (
          <button
            key={letter}
            type="button"
            aria-label={`Jump to artists starting with ${letter}`}
            className={letterButtonClassName}
            onClick={() => onJump(offset)}
          >
            {letter}
          </button>
        ))}
      </nav>
      {jumping && (
        <span role="status" className="shrink-0 text-small text-muted">
          Loading artists…
        </span>
      )}
    </div>
  )
}

/** A typed letter jumps when the artist list is what has the page. Fields and dialogs keep their keys. */
function useLetterKeys(letters: readonly ArtistLetter[], onJump: (offset: number) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.key.length !== 1)
        return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      if (document.querySelector('dialog[open]')) return
      const typed = event.key.toLocaleUpperCase()
      const match = letters.find((item) => item.letter.toLocaleUpperCase() === typed)
      if (!match) return
      event.preventDefault()
      onJump(match.offset)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [letters, onJump])
}

function LetterRail({
  letters,
  jumping,
  onJump,
}: {
  letters: readonly ArtistLetter[]
  jumping: boolean
  onJump: (offset: number) => void
}) {
  const rail = useRef<HTMLElement>(null)
  const hide = useRef(0)
  const showing = useRef<string | null>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => () => window.clearTimeout(hide.current), [])

  // The strip is one target. A finger slides through it; the letter under the finger is the one
  // that jumps. Buttons stay for a keyboard and a screen reader, and do not take the touch.
  const pick = (clientY: number) => {
    const box = rail.current?.getBoundingClientRect()
    if (!box || box.height <= 0) return
    const ratio = (clientY - box.top) / box.height
    const index = Math.min(letters.length - 1, Math.max(0, Math.floor(ratio * letters.length)))
    const hit = letters[index]
    if (!hit || showing.current === hit.letter) return
    showing.current = hit.letter
    setActive(hit.letter)
    onJump(hit.offset)
  }

  const end = () => {
    showing.current = null
    window.clearTimeout(hide.current)
    hide.current = window.setTimeout(() => setActive(null), 350)
  }

  const strip = (
    <>
      <nav
        ref={rail}
        aria-label="Jump to letter"
        className="fixed z-header flex w-[32px] touch-none flex-col justify-between py-[4px] right-[var(--safe-right)] top-[calc(var(--topbar-height)+var(--safe-top)+8px)] bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+8px)]"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          window.clearTimeout(hide.current)
          event.currentTarget.setPointerCapture(event.pointerId)
          pick(event.clientY)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          pick(event.clientY)
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {letters.map(({ letter, offset }) => (
          <button
            key={letter}
            type="button"
            aria-label={`Jump to artists starting with ${letter}`}
            aria-current={active === letter ? 'true' : undefined}
            className={cx(
              'pointer-events-none grid min-h-0 flex-1 place-items-center font-mono text-[11px] leading-none',
              active === letter ? 'font-semibold text-accent' : 'text-faint',
            )}
            onClick={() => onJump(offset)}
          >
            {letter}
          </button>
        ))}
      </nav>
      {jumping && (
        <span role="status" className="sr-only">
          Loading artists…
        </span>
      )}
      {active && (
        <div className="pointer-events-none fixed inset-0 z-overlay grid place-items-center">
          <span className="grid size-[72px] place-items-center rounded-[18px] bg-raised text-[40px] font-semibold text-text shadow-[0_12px_40px_color-mix(in_oklab,var(--color-shadow)_45%,transparent)]">
            {active}
          </span>
        </div>
      )}
    </>
  )

  return createPortal(strip, document.body)
}
