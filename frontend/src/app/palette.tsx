import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ArrowDownToLine,
  AudioLines,
  Globe,
  House,
  Library,
  Link as LinkIcon,
  Maximize2,
  Music2,
  Palette,
  PanelsTopLeft,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Waves,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { api, librarySchema, libraryTrackSearchSchema } from '../api'
import type { LibraryTrack } from '../api'
import { eyebrowClassName, overlayDialogClassName } from '../components/review-sheet'
import { isLinkText, useLinkSheet } from '../features/links/links'
import { useNowPlayingPopout } from '../features/now-playing/now-playing-popout'
import { artUrl, usePlayer } from '../features/player/player'
import { cx } from '../lib/cx'
import { getLayout, setLayout, useLayout } from '../lib/layout'
import { Kbd, useToast } from '../ui'

type Command = {
  label: string
  sub?: string
  icon?: LucideIcon
  /** A cover to draw in place of the icon. */
  art?: string
  run: () => void
}
type Group = { label: string; items: Command[] }

const pages = [
  { label: 'Home', to: '/', icon: House },
  { label: 'Search music', to: '/search', icon: Search },
  { label: 'Library', to: '/library', icon: Library },
  { label: 'Now Playing', to: '/now-playing', icon: AudioLines },
  { label: 'Downloads', to: '/downloads', icon: ArrowDownToLine },
  { label: 'Octive', to: '/music-bot', icon: Sparkles },
  { label: 'Settings', to: '/settings', icon: Settings2 },
  { label: 'Diagnostics', to: '/diagnostics', icon: Activity },
] as const

const layoutNames = { classic: 'Classic', room: 'Listening room' } as const

const rowClassName =
  'flex w-full items-center gap-[12px] rounded-[10px] border-0 px-[10px] py-[8px] text-left text-inherit hover:bg-hover coarse:min-h-11'
// No colours here: each row picks one pair, since `cx` does not merge two of the same property.
const tileClassName = 'grid size-[32px] shrink-0 place-items-center overflow-hidden rounded-[8px]'

const OPEN_EVENT = 'musimo:open-palette'

/** Opens the palette from a button, such as the Listening room's header search. */
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT))

export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const list = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [lookup, setLookup] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const onStage = useRouterState({ select: (state) => state.location.pathname === '/now-playing' })
  const popout = useNowPlayingPopout()
  const { libraryTrack } = usePlayer()
  const layout = useLayout()
  const toast = useToast()
  const links = useLinkSheet()
  const link = isLinkText(text)

  // The library is only asked once typing pauses, and never for a link, which is not a search.
  useEffect(() => {
    const term = text.trim()
    const timer = setTimeout(() => setLookup(open && !link && term.length >= 2 ? term : ''), 200)
    return () => clearTimeout(timer)
  }, [text, open, link])
  const songs = useQuery({
    queryKey: ['palette-songs', lookup],
    queryFn: ({ signal }) =>
      api(
        `library/tracks/search?q=${encodeURIComponent(lookup)}&size=5`,
        libraryTrackSearchSchema,
        { signal },
      ),
    enabled: Boolean(lookup),
    staleTime: 30_000,
  })

  const rescan = useMutation({
    mutationFn: () => api('library/scan', librarySchema, { method: 'POST' }),
    onSuccess: () => toast.show({ tone: 'good', text: 'Scanning the music folder for changes.' }),
    onError: (error) => toast.show({ tone: 'danger', text: error.message }),
  })

  const showStage = () => {
    if (!onStage) void navigate({ to: '/now-playing' })
  }

  // Presets are only visible on the visualizer, so the commands that act on
  // it switch the stage to it first. Everything goes through the provider's
  // state; it owns what the browser remembers.
  const showVisualizer = () => {
    showStage()
    if (popout.view !== 'visualizer') popout.toggleView()
  }

  const cycle = (delta: number) => {
    showVisualizer()
    popout.cyclePreset(delta)
  }

  const fullscreenVisualizer = () => {
    showVisualizer()
    const stage = popout.dockedStage.current
    if (stage) {
      // Already mounted, so ask now, while the click still counts as a gesture.
      stage
        .requestFullscreen()
        .catch(() => popout.setNotice('Press F on the player for full screen.'))

      return
    }
    // Not on screen (another route, or playing in the popout). The provider closes the popout,
    // navigates, and asks once the stage mounts. If that is refused the user is still on Now
    // Playing with a notice, which is the fallback to plain navigation.
    popout.popoutToFullscreen()
  }
  // No WebGL 2 means the stage only ever shows artwork, and with no library track loaded Now
  // Playing has no stage, so in both cases these would do nothing.
  const visualizerCommands: Command[] =
    popout.canVisualize && libraryTrack
      ? [
          {
            label: 'Toggle visualizer',
            icon: Waves,
            // From another route the stage is out of sight, so a toggle there could land on Now
            // Playing with the visualizer just switched off. Arriving always shows it; toggling
            // is for when the stage is already in front.
            run: () => (onStage ? popout.toggleView() : showVisualizer()),
          },
          { label: 'Next visualizer preset', icon: Waves, run: () => cycle(1) },
          { label: 'Previous visualizer preset', icon: Waves, run: () => cycle(-1) },
          { label: 'Fullscreen visualizer', icon: Maximize2, run: fullscreenVisualizer },
        ]
      : []

  const searchCatalog = (query: string) => void navigate({ to: '/search', search: { q: query } })
  const openSong = (song: LibraryTrack) =>
    song.albumId
      ? void navigate({
          to: '/library/albums/$albumId',
          params: { albumId: song.albumId },
          search: { track: song.id },
        })
      : void navigate({ to: '/library/tracks', search: { q: song.title } })

  const term = text.trim().toLowerCase()
  const matches = (command: Command) =>
    !term || `${command.label} ${command.sub ?? ''}`.toLowerCase().includes(term)
  const groups: Group[] = []
  if (link)
    groups.push({
      label: '',
      items: [{ label: 'Review this link', sub: text.trim(), icon: LinkIcon, run: reviewLink }],
    })
  else {
    const library = (songs.data?.items ?? []).map((song) => ({
      label: song.title,
      sub: `Song · ${song.artist}`,
      icon: Music2,
      art: artUrl(song),
      run: () => openSong(song),
    }))
    const catalog =
      term.length >= 2
        ? [
            {
              label: `Search music for “${text.trim()}”`,
              sub: 'Search the catalog',
              icon: Globe,
              run: () => searchCatalog(text.trim()),
            },
          ]
        : []
    const more: Group[] = [
      { label: 'In your library', items: library },
      { label: 'Catalog', items: catalog },
      {
        label: 'Go to',
        items: pages.map((page) => ({
          label: page.label,
          icon: page.icon,
          run: () => void navigate({ to: page.to }),
        })),
      },
      {
        label: 'Actions',
        items: [
          {
            label: 'Change theme',
            sub: 'Pick how Musimo looks',
            icon: Palette,
            run: () => void navigate({ to: '/settings/user' }),
          },
          {
            label: 'Switch layout',
            sub: `${layoutNames[layout]} now`,
            icon: PanelsTopLeft,
            run: () => setLayout(getLayout() === 'classic' ? 'room' : 'classic'),
          },
          {
            label: 'Rescan library',
            sub: 'Look for new and changed files',
            icon: RefreshCw,
            run: () => rescan.mutate(),
          },
          ...visualizerCommands,
        ],
      },
    ]
    // What was typed picks out commands; library songs and the catalog row are already about it.
    for (const group of more)
      groups.push({
        ...group,
        items:
          group.label === 'In your library' || group.label === 'Catalog'
            ? group.items
            : group.items.filter(matches),
      })
  }
  const shown = groups.filter((group) => group.items.length)
  const flat = shown.flatMap((group) => group.items)
  const current = Math.min(active, Math.max(flat.length - 1, 0))

  function reviewLink() {
    links.submit(text)
  }

  const close = () => dialog.current?.close()
  const run = (command: Command) => {
    close()
    command.run()
  }

  useEffect(() => {
    const open = () => {
      setText('')
      setActive(0)
      setOpen(true)
      if (!dialog.current?.open) dialog.current?.showModal()
      input.current?.focus()
    }

    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (dialog.current?.open) {
          dialog.current.close()
          return
        }
        open()
      }
    }
    window.addEventListener('keydown', key)
    window.addEventListener(OPEN_EVENT, open)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener(OPEN_EVENT, open)
    }
  }, [])

  // The highlighted row follows the arrow keys, so it has to stay in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, flat.length])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!flat.length) return
      setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const command = flat[current]
      if (command) run(command)
    }
  }

  let at = -1
  return (
    <>
      <dialog
        ref={dialog}
        className={overlayDialogClassName('palette')}
        aria-label="Command palette"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialog.current) close()
        }}
      >
        <label className="flex h-[56px] flex-none items-center gap-[12px] border-b border-line px-[16px] text-faint">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            className="min-w-0 flex-1 border-0 bg-transparent text-base text-text outline-none placeholder:text-faint"
            aria-label="Search commands or music"
            // Focus stays here while the arrow keys move through the list, so the list is a
            // listbox this box controls and the highlighted row is its active descendant.
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            value={text}
            placeholder="Search, jump to a page, or paste a link"
            onChange={(e) => {
              setText(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            aria-label="ESC, close command palette"
            className="rounded-[5px] border border-line-strong bg-transparent px-[6px] py-px font-mono text-tiny text-faint"
            onClick={close}
          >
            ESC
          </button>
        </label>
        <div ref={list} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-[6px]">
          <div id={listId} role="listbox" aria-label="Commands">
            {shown.map((group, groupIndex) => (
              <div
                key={group.label || 'link'}
                role="group"
                aria-labelledby={group.label ? `${listId}-group-${groupIndex}` : undefined}
                aria-label={group.label ? undefined : 'Link'}
              >
                {group.label && (
                  <p
                    id={`${listId}-group-${groupIndex}`}
                    className={cx(eyebrowClassName, 'px-[10px] pt-[10px] pb-[4px]')}
                  >
                    {group.label}
                  </p>
                )}
                {group.items.map((command) => {
                  at += 1
                  const isActive = at === current
                  const Icon = command.icon
                  const index = at
                  return (
                    <div
                      key={`${group.label}:${command.label}:${index}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      className={cx(
                        rowClassName,
                        'cursor-pointer',
                        isActive ? 'bg-active' : 'bg-transparent',
                      )}
                      onClick={() => run(command)}
                      onPointerMove={() => setActive(index)}
                    >
                      <span
                        className={cx(
                          tileClassName,
                          link ? 'bg-canvas text-accent' : 'bg-hover text-muted',
                        )}
                      >
                        {command.art ? (
                          <img src={command.art} alt="" className="size-full object-cover" />
                        ) : (
                          Icon && <Icon size={16} aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{command.label}</span>
                        {command.sub && (
                          <span className="block truncate text-small text-muted">
                            {command.sub}
                          </span>
                        )}
                      </span>
                      {isActive && <Kbd className="border-0 text-muted">↵</Kbd>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {!flat.length && <p className="px-[10px] py-[12px] text-muted">Nothing matches.</p>}
        </div>
        <footer className="flex flex-none gap-[16px] border-t border-line px-[16px] py-[10px] font-mono text-tiny text-faint uppercase max-phone:hidden">
          <span>↑↓ Move</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
          <span className="ml-auto">Tip: paste a link to download it</span>
        </footer>
      </dialog>
      {links.sheet}
    </>
  )
}
