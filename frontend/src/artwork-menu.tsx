import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { createPortal } from 'react-dom'

import { useNavigate } from '@tanstack/react-router'

import type { LibraryTrack } from './api'
import { usePlayer } from './player'

export type MenuPoint = { x: number; y: number }

/** Keeps the menu this far from the window's edge when it has to be pulled back inside it. */
const EDGE = 8

const itemClassName =
  'rounded-md border-0 bg-transparent px-[12px] py-[9px] text-left text-small text-text hover:bg-hover focus-visible:bg-hover disabled:text-faint coarse:min-h-11'

/**
 * The menu a right-click on the Now Playing artwork opens: Go to album, Go to artist, Add to
 * playlist and Full screen. It sits where the pointer was, pulled back inside the window if it
 * would run off, and closes on Escape, a click elsewhere, a resize, or choosing an item.
 * The arrow keys, Home and End move through it, and it keeps them from the stage's own shortcuts.
 *
 * It is drawn in the body, because the stage's slot is a size container and that would make a
 * `fixed` menu position itself against the slot. In full screen only the stage is on screen, so
 * there it goes inside the stage instead.
 */
export function ArtworkMenu({
  track,
  at,
  fullscreen,
  onFullscreen,
  onClose,
}: {
  track: LibraryTrack
  at: MenuPoint
  fullscreen: boolean
  onFullscreen: () => void
  onClose: () => void
}) {
  const player = usePlayer()
  const navigate = useNavigate()
  const list = useRef<HTMLDivElement>(null)
  const [host] = useState(() => document.fullscreenElement ?? document.body)
  const [opener] = useState(() => document.activeElement)
  const [placed, setPlaced] = useState<MenuPoint>(at)

  const items = () =>
    Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])

  useLayoutEffect(() => {
    const box = list.current?.getBoundingClientRect()
    if (!box) return
    setPlaced({
      x: Math.max(EDGE, Math.min(at.x, window.innerWidth - box.width - EDGE)),
      y: Math.max(EDGE, Math.min(at.y, window.innerHeight - box.height - EDGE)),
    })
  }, [at])

  // The player re-renders the stage several times a second, so the parent's `onClose` is read
  // through a ref: listeners are added once, and the focus below is only ever set once.
  const closing = useRef(onClose)
  closing.current = onClose

  useEffect(() => {
    items()[0]?.focus()
    const dismiss = () => closing.current()
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !list.current?.contains(event.target)) dismiss()
    }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  function close(refocus: boolean) {
    onClose()
    if (refocus && opener instanceof HTMLElement) opener.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = items()
    const current = buttons.findIndex((button) => button === document.activeElement)
    const go = (index: number) => {
      buttons[(index + buttons.length) % buttons.length]?.focus()
    }

    switch (event.key) {
      case 'Escape':
        close(true)
        break
      case 'Tab':
        close(false)

        return
      case 'ArrowDown':
        go(current + 1)
        break
      case 'ArrowUp':
        go(current - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(buttons.length - 1)
        break
      default:
        return
    }
    // The stage answers to the arrow keys too, and this menu is inside it in full screen.
    event.preventDefault()
    event.stopPropagation()
  }

  const choose = (run: () => void) => () => {
    close(false)
    run()
  }

  // The playlist sheet is a modal dialog of the page, which full screen would leave off screen.
  const addToPlaylist = () => {
    if (!document.fullscreenElement) {
      player.openPlaylistPicker()

      return
    }
    void document.exitFullscreen().then(player.openPlaylistPicker, player.openPlaylistPicker)
  }

  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label="Now Playing artwork"
      onKeyDown={onKeyDown}
      style={{ left: placed.x, top: placed.y }}
      className="fixed z-overlay grid min-w-[170px] gap-[2px] rounded-[8px] border border-line bg-raised p-[4px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]"
    >
      <button
        type="button"
        role="menuitem"
        className={itemClassName}
        disabled={!track.albumId}
        onClick={choose(() => {
          if (track.albumId) {
            void navigate({ to: '/library/albums/$albumId', params: { albumId: track.albumId } })
          }
        })}
      >
        Go to album
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClassName}
        disabled={!track.artistId}
        onClick={choose(() => {
          if (track.artistId) {
            void navigate({
              to: '/library/artists/$artistId',
              params: { artistId: track.artistId },
            })
          }
        })}
      >
        Go to artist
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClassName}
        onClick={choose(addToPlaylist)}
      >
        Add to playlist
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClassName}
        onClick={choose(onFullscreen)}
      >
        {fullscreen ? 'Exit full screen' : 'Full screen'}
      </button>
    </div>,
    host,
  )
}
