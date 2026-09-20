import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import { X } from 'lucide-react'

import { usePlayer } from './player'
import { IconButton, Kbd } from './ui'

const EDITABLE = 'input,select,textarea,[contenteditable]:not([contenteditable="false"])'
/* Widgets that use the arrow keys for themselves: the tab list moves between tabs, a menu and a
   list box between items, a slider by a step. */
const ARROW_OWNERS = '[role="tablist"],[role="menu"],[role="listbox"],[role="slider"]'
/* A box that can be focused and scrolls, like the queue and the history. */
const SCROLL_BOXES = '[tabindex="0"]'

const SEEK_SECONDS = 5
const VOLUME_STEP = 0.05

/**
 * Whether a Now Playing shortcut may take this key press. It may not while a text field, a select
 * or a slider has focus (`input` covers both the field and the range), while a dialog is open (the
 * command palette, the playlist sheet, the cheat sheet), when a modifier is held (those belong to
 * the browser and the palette's own Ctrl or Cmd+K), or after something else has already used the
 * key. With `arrows` set, a tab list, menu or list box that has focus keeps the arrow keys too.
 */
export function pageKeyIsFree(event: KeyboardEvent, arrows = false): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false
  if (document.querySelector('dialog[open]')) return false
  const target = event.target
  if (target instanceof Element) {
    if (target.closest(EDITABLE)) return false
    if (arrows && target.closest(ARROW_OWNERS)) return false
  }

  return true
}

// Up and Down are what scrolls a focused box, and a queue too long for its panel has to be
// reachable from the keyboard, so the volume gives way to it while that box has focus.
function scrollsItself(target: EventTarget | null): boolean {
  const box = target instanceof Element ? target.closest(SCROLL_BOXES) : null

  return box !== null && box.scrollHeight > box.clientHeight
}

/**
 * The Now Playing page's own keys, for as long as the page is open and `enabled`: Left and Right
 * seek five seconds, Shift with either goes to the previous or next track, Up and Down change the
 * volume, M mutes, S switches the stage between small and large, and `?` opens the cheat sheet.
 * L and Q, which choose a tab, live with the tabs. Space is the player's own, and already play or
 * pause everywhere but on a control that uses it.
 *
 * Only the keys the stage does not answer for: while the stage is full screen or holds focus its
 * own shortcuts (the same arrows and M, and N, P, F, V, H and the brackets) are in charge, so a
 * press is never handled twice. `?` and S are the exceptions, and work from either, except that S
 * leaves full screen alone, which has one size.
 */
export function usePageShortcuts({
  enabled,
  stage,
  onHelp,
  onSize,
}: {
  enabled: boolean
  /** The docked stage, or a ref that is empty while it is not mounted. */
  stage: RefObject<HTMLElement | null>
  onHelp: () => void
  /** Undefined where the stage has one size (a phone), so S does nothing. */
  onSize?: () => void
}) {
  const player = usePlayer()
  const latest = useRef({ enabled, stage, onHelp, onSize, player })
  latest.current = { enabled, stage, onHelp, onSize, player }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const {
        enabled: on,
        stage: stageRef,
        onHelp: help,
        onSize: size,
        player: playback,
      } = latest.current
      if (!on) return

      if (event.key === '?') {
        if (event.repeat || !pageKeyIsFree(event)) return
        event.preventDefault()
        help()

        return
      }

      if (event.key === 's' || event.key === 'S') {
        if (!size || event.repeat || document.fullscreenElement || !pageKeyIsFree(event)) return
        event.preventDefault()
        size()

        return
      }

      // The stage handles its own keys, on the same window, while it is full screen or focused.
      if (document.fullscreenElement || stageRef.current?.contains(document.activeElement)) return
      if (!pageKeyIsFree(event, true)) return

      const now = playback.audio()?.currentTime ?? playback.position
      switch (event.key) {
        case 'ArrowLeft':
          if (event.shiftKey) {
            // A held key would skip through the queue.
            if (!event.repeat) playback.previous()
          } else playback.seek(Math.max(0, now - SEEK_SECONDS))
          break
        case 'ArrowRight':
          if (event.shiftKey) {
            if (!event.repeat) playback.next()
          } else playback.seek(Math.min(playback.length || now + SEEK_SECONDS, now + SEEK_SECONDS))
          break
        case 'ArrowUp':
          if (scrollsItself(event.target)) return
          playback.setVolume(Math.min(1, playback.volume + VOLUME_STEP))
          break
        case 'ArrowDown':
          if (scrollsItself(event.target)) return
          playback.setVolume(Math.max(0, playback.volume - VOLUME_STEP))
          break
        case 'm':
        case 'M':
          if (!event.repeat) playback.toggleMute()
          break
        default:
          return
      }
      event.preventDefault()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

type Shortcut = { keys: string[]; action: string }

const PAGE_SHORTCUTS: Shortcut[] = [
  { keys: ['Space'], action: 'Play or pause' },
  { keys: ['←', '→'], action: 'Back or forward 5 seconds' },
  { keys: ['Shift ←', 'Shift →'], action: 'Previous or next track' },
  { keys: ['↑', '↓'], action: 'Volume up or down' },
  { keys: ['M'], action: 'Mute' },
  { keys: ['L'], action: 'Lyrics, and again for large type' },
  { keys: ['Q'], action: 'Up next' },
  { keys: ['S'], action: 'Small or large stage' },
  { keys: ['?'], action: 'This list' },
]

const STAGE_SHORTCUTS: Shortcut[] = [
  { keys: ['F'], action: 'Full screen' },
  { keys: ['V'], action: 'Artwork or visualizer' },
  { keys: ['['], action: 'Previous visualizer preset' },
  { keys: [']'], action: 'Next visualizer preset' },
  { keys: ['H'], action: 'Visualizer debug overlay' },
  { keys: ['N', 'P'], action: 'Next or previous track' },
  { keys: ['Esc'], action: 'Leave full screen' },
]

function ShortcutList({ title, items }: { title: string; items: Shortcut[] }) {
  return (
    <section className="grid gap-[8px]">
      <h3 className="text-tiny font-semibold tracking-[1.5px] text-faint uppercase">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-[16px] gap-y-[8px]">
        {items.map((item) => (
          <div key={item.action} className="contents">
            <dt className="flex flex-wrap gap-[4px]">
              {item.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd className="text-small text-text">{item.action}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * The cheat sheet: a small modal that lists the page's shortcuts and the stage's own. It follows
 * `open`, and says so through `onClose` when it shuts itself (Escape, a click on the backdrop or
 * the close button), so the page's state never disagrees with the dialog's.
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(440px,calc(100%-32px))] rounded-[16px] border border-line bg-raised p-[22px] text-text backdrop:bg-scrim/60"
      aria-labelledby="now-playing-shortcuts-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close()
      }}
    >
      <header className="mb-[16px] flex items-start justify-between gap-[12px]">
        <h2 id="now-playing-shortcuts-title" className="text-heading">
          Keyboard shortcuts
        </h2>
        <IconButton
          size="compact"
          aria-label="Close shortcuts"
          onClick={() => dialog.current?.close()}
        >
          <X size={18} />
        </IconButton>
      </header>
      <div className="grid gap-[20px]">
        <ShortcutList title="Now Playing" items={PAGE_SHORTCUTS} />
        <ShortcutList title="On the stage (click it, or go full screen)" items={STAGE_SHORTCUTS} />
      </div>
    </dialog>
  )
}
