import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'

import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { usePhone } from '../../lib/use-phone'
import { usePlayer } from '../player/player'
import { useBotChat } from './bot-chat'
import { ChatPanel } from './chat-panel'
import { Pet } from './pet'
import type { PetState } from './pet-mood'
import { perchStyle, PHONE_PERCH_LIFT, placePopover } from './pet-placement'
import type { PopoverPlacement } from './pet-placement'
import { petPixels, setPetSettings } from './pet-settings'
import type { PetChattiness, PetPosition, PetSize } from './pet-settings'
import { usePetLook, usePetState } from './use-pet'

/* Where the pet lives and what opening it does. The host sits in the shell once: it draws the
   perch on the footer player, owns the chat popover (desktop) or sheet (phone) and the quick
   menu, and lets other spots, such as Now Playing, open the same chat from their own pet. */

/** A bubble fades after this; the dot stays until the chat is opened. */
const BUBBLE_MS = 8_000
/** How long a press must last to count as a long-press on touch. */
const LONG_PRESS_MS = 500

type PetHost = {
  /** Opens or closes the chat from the pet the person used, which focus returns to on close. */
  toggle: (from: HTMLElement) => void
  openMenu: (from: HTMLElement, at?: { x: number; y: number }) => void
}

const PetHostContext = createContext<PetHost | null>(null)

const usePetHost = () => {
  const host = useContext(PetHostContext)
  if (!host) throw new Error('usePetHost needs PetHostProvider')
  return host
}

/** Whether the footer perch is drawn now. Elsewhere (the phone's top bar, the sidebar) shows the face. */
export function usePerchShown(): boolean {
  const { settings } = usePetLook()
  const player = usePlayer()
  const phone = usePhone()
  const layout = useLayout()
  const nowPlaying = useRouterState({
    select: (state) => state.location.pathname === '/now-playing',
  })
  if (settings.hidden) return false
  // The Listening room has no footer on a wide window. Its player dock holds a spot of its own.
  if (layout === 'room' && !phone) return false
  // The footer stands down on Now Playing while a library track plays; the page has its own spot.
  if (nowPlaying && player.libraryTrack) return false
  // A phone hides the mini player until something plays.
  if (phone && !player.libraryTrack && !player.track) return false
  return true
}

export function PetHostProvider({ children }: { children: ReactNode }) {
  const chat = useBotChat()
  const look = usePetLook()
  const player = usePlayer()
  const phone = usePhone()
  const navigate = useNavigate()
  const onPage = useRouterState({ select: (state) => state.location.pathname === '/music-bot' })
  const anchor = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ from: HTMLElement; at: { x: number; y: number } } | null>(null)

  const { setOpen, open } = chat
  const close = useCallback(() => {
    setOpen(false)
    // Focus goes back to the pet that opened the chat, if it is still on the page. After the
    // chat has gone: while the phone's sheet is still a modal, everything outside it is inert.
    const from = anchor.current
    requestAnimationFrame(() => {
      if (from?.isConnected) from.focus()
    })
  }, [setOpen])

  const toggle = useCallback(
    (from: HTMLElement) => {
      setMenu(null)
      if (onPage) {
        // The page already is the chat. Its box takes the focus instead of a second copy opening.
        document.querySelector<HTMLTextAreaElement>('[data-bot-page] textarea')?.focus()
        return
      }

      if (open && anchor.current === from) {
        close()
        return
      }
      anchor.current = from
      setOpen(true)
    },
    [open, setOpen, close, onPage],
  )

  const openMenu = useCallback((from: HTMLElement, at?: { x: number; y: number }) => {
    const box = from.getBoundingClientRect()
    anchor.current = from
    setMenu({ from, at: at ?? { x: box.left, y: box.top } })
  }, [])

  useNewReplySound(chat.unread, look.settings.sounds, player.playing)
  const host = useMemo(() => ({ toggle, openMenu }), [toggle, openMenu])

  return (
    <PetHostContext.Provider value={host}>
      {children}
      <FooterPerch />
      {/* On the page the chat is already on screen, and the page holds `open` so replies read
          there are not counted as waiting. */}
      {open &&
        !onPage &&
        (phone ? <ChatSheet onClose={close} /> : <ChatPopover anchor={anchor} onClose={close} />)}
      {menu && (
        <QuickMenu
          from={menu.from}
          at={menu.at}
          onClose={(refocus) => {
            setMenu(null)
            if (refocus && menu.from.isConnected) menu.from.focus()
          }}
          onOpenChat={() => toggle(menu.from)}
          onSettings={() => void navigate({ to: '/settings/user', hash: 'music-bot-pet' })}
        />
      )}
    </PetHostContext.Provider>
  )
}

/** The words for the pet's button: who it is, whether a reply waits, and what pressing does. */
function petLabel(name: string, unread: boolean, open: boolean) {
  return `${name}, music bot. ${unread ? 'New reply. ' : ''}${open ? 'Close chat' : 'Open chat'}`
}

type PetButtonProps = {
  size: number
  /** The button's own box: at least 44px, so it is a comfortable target. */
  box: number
  state: PetState
  ring?: boolean
  className?: string
  style?: CSSProperties
  dotStyle?: CSSProperties
}

/** The pet as a button: Enter or Space opens the chat, the context menu key or a long-press the menu. */
function PetButton({ size, box, state, ring, className, style, dotStyle }: PetButtonProps) {
  const host = usePetHost()
  const chat = useBotChat()
  const look = usePetLook()
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)
  const onPage = useRouterState({ select: (s) => s.location.pathname === '/music-bot' })
  const open = chat.open && !onPage

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== 'touch') return
    const target = event.currentTarget
    const entry = {
      fired: false,
      timer: setTimeout(() => {
        entry.fired = true
        host.openMenu(target)
      }, LONG_PRESS_MS),
    }
    press.current = entry
  }

  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer)
  }

  return (
    <button
      type="button"
      data-pet="button"
      aria-label={petLabel(look.settings.name, chat.unread, open)}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(event) => {
        // A long-press already opened the menu; its release is not also a tap.
        if (press.current?.fired) {
          press.current = null
          return
        }
        host.toggle(event.currentTarget)
      }}
      onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        const fromKeyboard = event.clientX === 0 && event.clientY === 0
        host.openMenu(
          event.currentTarget,
          fromKeyboard ? undefined : { x: event.clientX, y: event.clientY },
        )
      }}
      onPointerDown={onPointerDown}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
      className={cx(
        'flex items-end justify-center rounded-[12px] border-0 bg-transparent p-0 [-webkit-touch-callout:none] select-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
      style={{ width: box, height: box, ...style }}
    >
      <Pet
        kind={look.settings.kind}
        state={state}
        size={size}
        motion={look.motion}
        pixel={look.pixel}
        ring={ring}
        paint={look.paint}
      />
      {chat.unread && (
        <i
          aria-hidden="true"
          data-pet="dot"
          className="absolute top-[6px] right-[6px] size-[11px] rounded-full bg-accent-hot shadow-[0_0_0_2px_var(--color-canvas)]"
          style={dotStyle}
        />
      )}
    </button>
  )
}

/** The pet standing on the footer player's top edge, outside the bar, so no control is covered. */
function FooterPerch() {
  const shown = usePerchShown()
  const look = usePetLook()
  const phone = usePhone()
  const state = usePetState()
  if (!shown) return null
  const size = petPixels(look.settings.size, phone)
  const box = Math.max(44, size + (phone ? 14 : 12))
  const position = perchStyle(look.settings.position, phone)
  return (
    <div
      data-pet="perch"
      className="pointer-events-none fixed z-pet"
      style={
        phone
          ? {
              left: 0,
              right: 0,
              bottom: `calc(var(--nav-height) + var(--safe-bottom) + var(--player-height) + ${PHONE_PERCH_LIFT}px)`,
            }
          : {
              left: 'calc(var(--sidebar-width) + var(--safe-left))',
              right: 'var(--safe-right)',
              bottom: 'var(--player-height)',
            }
      }
    >
      {phone && (
        // A soft shadow marks the perch, since the pet's feet stop short of the seek strip.
        <i
          aria-hidden="true"
          className="absolute bottom-[-6px] h-[4px] w-[26px] rounded-[50%] bg-[color-mix(in_oklab,var(--color-shadow)_45%,transparent)]"
          style={{ left: 17 }}
        />
      )}
      <PetButton
        size={size}
        box={box}
        state={state}
        className="pointer-events-auto absolute bottom-0"
        style={position}
        dotStyle={phone ? { top: 10, right: 4, width: 9, height: 9 } : undefined}
      />
      <PetBubble position={look.settings.position} phone={phone} box={box} />
    </div>
  )
}

/**
 * The pet's spot on another page, such as beside the title on Now Playing. It wears an outline in
 * the page colour so it reads over the cover-tinted wash.
 */
export function PetSpot({ size = 36 }: { size?: number }) {
  const look = usePetLook()
  const state = usePetState()
  if (look.settings.hidden) return null
  return (
    <PetButton
      size={size}
      box={44}
      state={state}
      ring
      className="relative mr-[4px] shrink-0"
      dotStyle={{ top: 4, right: 2, width: 10, height: 10 }}
    />
  )
}

/**
 * The face shown where the pet is not: in the sidebar's Music bot row when the pet is hidden, and
 * in the phone's top bar link while nothing is playing. A dot says a reply is waiting.
 */
export function PetFace({ size }: { size: number }) {
  const look = usePetLook()
  const chat = useBotChat()
  const state = usePetState()
  return (
    <span className="relative inline-flex shrink-0" data-pet="face">
      <Pet
        kind={look.settings.kind}
        state={state}
        size={size}
        motion="off"
        pixel={look.pixel}
        paint={look.paint}
      />
      {chat.unread && (
        <i
          aria-hidden="true"
          data-pet="dot"
          className="absolute -top-[2px] -right-[3px] size-[8px] rounded-full bg-accent-hot shadow-[0_0_0_2px_var(--color-canvas)]"
        />
      )}
      {chat.unread && <span className="sr-only">, new reply</span>}
    </span>
  )
}

/**
 * A short line beside the pet while the chat is closed: a waiting reply (Normal and Chatty), and
 * in Chatty a fact about the new track. Facts only; it never rates a song, since it cannot hear one.
 */
function PetBubble({
  position,
  phone,
  box,
}: {
  position: PetPosition
  phone: boolean
  box: number
}) {
  const chat = useBotChat()
  const look = usePetLook()
  const player = usePlayer()
  const chattiness = look.settings.chattiness
  const [text, setText] = useState<{ words: string; reply: boolean } | null>(null)
  const latest = chat.log.at(-1)

  useEffect(() => {
    if (!chat.unread || chattiness === 'quiet' || chat.open) return
    setText({ words: bubbleFor(latest, chat.reply?.tracks.length ?? 0), reply: true })
    const timer = setTimeout(() => setText(null), BUBBLE_MS)
    return () => clearTimeout(timer)
    // A new reply is the trigger; the line it says is read at that moment.
  }, [chat.unread, latest?.id, chattiness, chat.open])

  const track = player.libraryTrack
  const trackId = track?.id
  const firstTrack = useRef(true)
  useEffect(() => {
    if (firstTrack.current) {
      firstTrack.current = false
      return
    }
    if (chattiness !== 'chatty' || !track || chat.open || chat.unread) return
    const where = track.album ? `, from ${track.album}` : ''
    const number = track.track ? ` Track ${track.track}.` : ''
    setText({ words: `New one: ${track.title}${where}.${number}`, reply: false })
    const timer = setTimeout(() => setText(null), BUBBLE_MS)
    return () => clearTimeout(timer)
    // Only a change of track is news.
  }, [trackId])

  useEffect(() => {
    if (chat.open) setText(null)
  }, [chat.open])

  if (!text || chat.open) return null
  const side: CSSProperties =
    phone || position === 'left'
      ? { left: (phone ? 8 : 29) + box - 22 }
      : position === 'right'
        ? { right: 29 + box - 22 }
        : { left: `calc(50% + ${box / 2 - 22}px)` }
  return (
    <div
      // A track aside repeats what the player already says, so only a reply is announced.
      role={text.reply ? 'status' : undefined}
      aria-hidden={text.reply ? undefined : true}
      data-pet="bubble"
      className="pointer-events-none absolute max-w-[240px] rounded-[12px_12px_12px_3px] border border-line-strong bg-raised px-[11px] py-[8px] text-small leading-[1.4] text-text shadow-[0_10px_26px_color-mix(in_oklab,var(--color-shadow)_40%,transparent)] max-phone:max-w-[220px]"
      style={{ ...side, bottom: box + 2 }}
    >
      {text.words}
    </div>
  )
}

function bubbleFor(
  entry: ReturnType<typeof useBotChat>['log'][number] | undefined,
  songs: number,
): string {
  if (entry?.kind === 'reply' && entry.card)
    return songs
      ? `${songs} ${songs === 1 ? 'song' : 'songs'} ready when you are.`
      : 'Nothing matched. Tap me for ideas.'
  if (entry?.kind === 'reply' && entry.mood === 'confused') return 'I have a quick question.'
  if (entry?.kind === 'error') return 'That didn’t work. Tap me to see why.'
  if (entry?.kind === 'command') return entry.text
  return 'Your reply is ready.'
}

/** Escape closes, from anywhere inside the chat. */
function useEscape(
  onClose: () => void,
  root: RefObject<HTMLElement | null>,
  anchor: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      // From inside the chat, or from the pet that opened it.
      if (root.current?.contains(active) || (active && anchor.current === active)) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, root, anchor])
}

/**
 * Moves focus into a chat that has just opened, unless the panel already took it (its text box,
 * or a question's first quick reply). With the box disabled, while offline or scanning, the first
 * control in the conversation gets it, then the first control anywhere in the chat.
 */
function focusInto(root: HTMLElement | null) {
  if (!root || root.contains(document.activeElement)) return
  const usable = ':is(button, a[href], select, textarea, input):not(:disabled)'
  const target =
    root.querySelector<HTMLElement>('[data-bot="quick-reply"]:not(:disabled)') ??
    root.querySelector<HTMLElement>('[data-bot="field"]:not(:disabled)') ??
    root.querySelector<HTMLElement>(`[data-bot="log"] ${usable}`) ??
    root.querySelector<HTMLElement>(`[data-bot="title-bar"] ${usable}`)
  target?.focus()
}

/** Desktop: a popover anchored to the pet, never taller than the room under the top bar. */
function ChatPopover({
  anchor,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const chat = useBotChat()
  const root = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<PopoverPlacement | null>(null)
  useEscape(onClose, root, anchor)

  useLayoutEffect(() => {
    const measure = () => {
      const from = anchor.current
      if (!from?.isConnected) return
      const box = from.getBoundingClientRect()
      const bar = document.querySelector('header.sticky')?.getBoundingClientRect().bottom ?? 0
      const next = placePopover(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
        bar,
      )
      // Most scrolls move nothing the popover hangs from, so they must not re-render the chat.
      setPlace((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next))
    }

    // Only a scroll that can move the pet counts; scrolling the conversation itself cannot.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      measure()
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [anchor])

  const placed = place !== null
  useEffect(() => {
    if (placed) focusInto(root.current)
  }, [placed])

  if (!place) return null
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Chat with ${chat.name}`}
      data-bot="popover"
      className="fixed z-chat"
      style={{ left: place.left, top: place.top, width: place.width, height: place.height }}
    >
      <div
        aria-hidden="true"
        data-bot="arrow"
        className={cx(
          'absolute size-[14px] rotate-45 bg-raised',
          place.side === 'above'
            ? 'bottom-[-7px] border-r border-b border-line-strong'
            : 'top-[-7px] border-t border-l border-line-strong',
        )}
        style={{ left: place.arrowLeft - 7 }}
      />
      <div className="absolute inset-0 overflow-hidden rounded-[16px] border border-line-strong shadow-[0_20px_60px_color-mix(in_oklab,var(--color-shadow)_47%,transparent)]">
        <ChatPanel layout="popover" onClose={onClose} autoFocus />
      </div>
    </div>
  )
}

/** Phone: a bottom sheet over the page. Its handle and the close button both put it away. */
function ChatSheet({ onClose }: { onClose: () => void }) {
  const chat = useBotChat()
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element || element.open) return
    // showModal() focuses the first control, the handle, so the chat's own choice is put back.
    const chosen = document.activeElement
    element.showModal()
    if (chosen instanceof HTMLElement && element.contains(chosen)) chosen.focus()
    else focusInto(element.querySelector('[data-bot="panel"]'))
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-label={`Chat with ${chat.name}`}
      data-bot="sheet"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="chat-sheet fixed inset-x-0 top-auto bottom-0 m-0 flex h-[calc(100dvh-64px-var(--safe-top))] max-h-none w-full max-w-none flex-col overflow-hidden rounded-t-[16px] border-0 border-t border-line-strong bg-raised p-0 pb-[var(--safe-bottom)] text-text"
    >
      <button
        type="button"
        aria-label="Close chat"
        onClick={onClose}
        className="grid h-[24px] shrink-0 place-items-center border-0 bg-transparent p-0 coarse:min-h-0"
      >
        <i aria-hidden="true" className="h-[5px] w-[36px] rounded-[3px] bg-line-strong" />
      </button>
      <div className="relative min-h-0 flex-1">
        <ChatPanel layout="sheet" onClose={onClose} autoFocus />
      </div>
    </dialog>
  )
}

const QUICK_GROUPS: readonly {
  label: string
  key: 'size' | 'position' | 'chattiness'
  options: readonly { value: PetSize | PetPosition | PetChattiness; label: string }[]
}[] = [
  {
    label: 'Size',
    key: 'size',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
  },
  {
    label: 'Sit on',
    key: 'position',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'centre', label: 'Centre' },
      { value: 'right', label: 'Right' },
    ],
  },
  {
    label: 'Chattiness',
    key: 'chattiness',
    options: [
      { value: 'quiet', label: 'Quiet' },
      { value: 'normal', label: 'Normal' },
      { value: 'chatty', label: 'Chatty' },
    ],
  },
]

/** Right-click, long-press, Shift+F10 or the context menu key on the pet. */
function QuickMenu({
  from,
  at,
  onClose,
  onOpenChat,
  onSettings,
}: {
  from: HTMLElement
  at: { x: number; y: number }
  onClose: (refocus: boolean) => void
  onOpenChat: () => void
  onSettings: () => void
}) {
  const chat = useBotChat()
  const look = usePetLook()
  const menu = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const { settings } = look

  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const width = element.offsetWidth
    const height = element.offsetHeight
    const left = Math.min(Math.max(8, at.x), window.innerWidth - width - 8)
    const top = Math.min(Math.max(8, at.y - height - 8), window.innerHeight - height - 8)
    setPlace({ left, top })
    element.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [at])

  useEffect(() => {
    const away = (event: globalThis.PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !from.contains(event.target as Node))
        onClose(false)
    }

    // Escape from anywhere: Safari does not focus a button it clicks, so after picking a size the
    // key may arrive on the page rather than in the menu. Caught on the way down and marked
    // handled, so an open chat behind the menu stays open: one Escape closes one thing.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose(true)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape, { capture: true })
    }
  }, [from, onClose])

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowLeft'
    ) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Tab') onClose(false)
  }

  const row =
    'flex w-full items-center justify-between gap-[12px] rounded-[6px] border-0 bg-transparent px-[12px] py-[9px] text-left text-small whitespace-nowrap text-text hover:bg-hover focus-visible:bg-hover coarse:min-h-11'
  return (
    <div
      ref={menu}
      role="menu"
      aria-label={settings.name}
      data-pet="menu"
      onKeyDown={keys}
      className="fixed z-chat grid w-[264px] gap-[2px] rounded-[8px] border border-line bg-raised p-[4px] text-small shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]"
      style={place ?? { left: at.x, top: at.y, visibility: 'hidden' }}
    >
      <button
        type="button"
        role="menuitem"
        className={row}
        onClick={() => {
          onClose(false)
          onOpenChat()
        }}
      >
        {chat.open ? 'Close chat' : 'Open chat'}
        <kbd className="font-[inherit] text-tiny text-faint">Enter</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        className={row}
        disabled={!chat.log.length && !chat.reply}
        onClick={() => {
          chat.clear()
          onClose(true)
        }}
      >
        Clear chat
      </button>
      <div role="separator" className="my-[4px] h-px bg-line" />
      {QUICK_GROUPS.map((group) => (
        <div
          key={group.key}
          role="group"
          aria-label={group.label}
          className="grid grid-cols-[72px_1fr] items-center gap-[8px] py-[4px] pr-[8px] pl-[12px]"
        >
          <span className="text-tiny text-muted">{group.label}</span>
          <div className="flex gap-[2px] rounded-[7px] border border-line bg-sunken p-[2px]">
            {group.options.map((option) => {
              const on = settings[group.key] === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => setPetSettings({ [group.key]: option.value })}
                  className={cx(
                    'flex-1 rounded-[5px] border-0 px-[4px] py-[5px] text-tiny whitespace-nowrap coarse:min-h-10',
                    on
                      ? 'bg-active font-medium text-text'
                      : 'bg-transparent text-muted hover:text-text',
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div role="separator" className="my-[4px] h-px bg-line" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={settings.motion === 'off'}
        className={row}
        onClick={() => setPetSettings({ motion: settings.motion === 'off' ? 'system' : 'off' })}
      >
        Still pet (no animation)
        <span className="text-tiny text-faint">{settings.motion === 'off' ? 'On' : 'Off'}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={cx(row, 'grid justify-start gap-[2px]')}
        onClick={() => {
          setPetSettings({ hidden: true })
          onClose(false)
        }}
      >
        Hide {settings.name}
        <small className="text-tiny text-muted">Chat stays under Music bot in the sidebar</small>
      </button>
      <button
        type="button"
        role="menuitem"
        className={row}
        onClick={() => {
          onClose(false)
          onSettings()
        }}
      >
        Pet settings&hellip;
      </button>
    </div>
  )
}

/**
 * A soft two-note chirp for a reply that lands with the chat closed. Off unless switched on, and
 * only while nothing plays: it never sounds over the music or touches its volume.
 */
function useNewReplySound(unread: boolean, enabled: boolean, playing: boolean) {
  const was = useRef(unread)
  useEffect(() => {
    const arrived = unread && !was.current
    was.current = unread
    if (!arrived || !enabled || playing) return
    try {
      const context = new AudioContext()
      const gain = context.createGain()
      gain.gain.value = 0.04
      gain.connect(context.destination)

      ;[880, 1320].forEach((frequency, index) => {
        const tone = context.createOscillator()
        tone.type = 'sine'
        tone.frequency.value = frequency
        tone.connect(gain)
        const start = context.currentTime + index * 0.09
        tone.start(start)
        tone.stop(start + 0.08)
      })
      setTimeout(() => void context.close(), 400)
    } catch {
      /* No audio output, or the browser refused one. A chirp is not worth an error. */
    }
  }, [unread, enabled, playing])
}
