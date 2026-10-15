import { useEffect, useRef, useState } from 'react'

import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ArrowDownToLine,
  Coffee,
  Disc3,
  Heart,
  Library,
  Radio,
  Search,
  SlidersHorizontal,
  Star,
} from 'lucide-react'

import { activeCount, useJobs } from '../features/downloads/jobs'
import { QueueDock } from '../features/downloads/queue-dock'
import { isLinkText, useLinkSheet } from '../features/links/links'
import { PetFace, usePerchShown } from '../features/music-bot/pet-host'
import { usePetSettings } from '../features/music-bot/pet-settings'
import { artUrl, usePlayer } from '../features/player/player'
import { validateSearch } from '../features/search/search-params'
import { cx } from '../lib/cx'
import { Kbd } from '../ui'
import { useLiveEvents } from './live-events'
import { CommandPalette } from './palette'

const navItems = [
  { to: '/search', label: 'Search', icon: Search },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/downloads', label: 'Downloads', icon: ArrowDownToLine },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
  { to: '/diagnostics', label: 'Diagnostics', icon: Activity },
] as const

/* A wide window gets a row per destination down the left edge; a phone gets the same five as a
   bottom bar, so the link turns into a stacked icon-over-label tile. `relative` is here rather
   than only on the phone because the count badge above positions against it. */
const navLinkClassName = cx(
  'relative flex items-center gap-[12px] rounded-[7px] px-[14px] py-[12px] text-lead',
  'max-phone:flex-col max-phone:justify-center max-phone:gap-[5px] max-phone:rounded-none max-phone:px-[2px] max-phone:py-[8px] max-phone:text-tiny',
)
const navLinkActiveProps = { 'className': 'bg-active text-accent', 'aria-current': 'page' } as const
const navLinkInactiveProps = { className: 'text-muted hover:bg-hover hover:text-text' } as const

/* Now Playing has no bottom bar tile: the bar's five items already fill its 64px, so a phone
   reaches the page through the mini player's cover. On a wide window it is the last row, shown
   only while a library track is loaded. Being last means it appearing or leaving moves nothing
   above it, so a click aimed at Diagnostics never lands on a row that slid. The thumbnail is
   the icon's size and stands in for it. */
function NowPlayingNavItem() {
  const { libraryTrack } = usePlayer()
  if (!libraryTrack) return null
  const art = artUrl(libraryTrack)
  return (
    <Link
      to="/now-playing"
      className={cx(navLinkClassName, 'max-phone:hidden')}
      activeProps={navLinkActiveProps}
      inactiveProps={navLinkInactiveProps}
    >
      {art ? (
        <img className="size-[19px] shrink-0 rounded-[4px] object-cover" src={art} alt="" />
      ) : (
        <Disc3 size={19} />
      )}
      <span>Now Playing</span>
    </Link>
  )
}

const sidebarActionClassName = cx(
  'flex items-center gap-[8px] rounded-md border border-line px-[9px] py-[7px] text-tiny text-muted',
  'hover:border-[color:var(--line-hover)] hover:text-accent',
)

export function Shell() {
  const status = useLiveEvents()
  const input = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navigate = useNavigate()
  const location = useRouterState({ select: (s) => s.location })
  const params = new URLSearchParams(location.searchStr)
  const [text, setText] = useState(params.get('q') ?? '')
  const links = useLinkSheet()
  // The phone bottom bar carries the active download count that the dock shows elsewhere.
  // Selecting the count keeps progress ticks from re-rendering the whole shell.
  const activeDownloads = useJobs(activeCount).data ?? 0
  const petHidden = usePetSettings().hidden
  const perched = usePerchShown()

  useEffect(() => {
    clearTimeout(debounce.current)
    setText(new URLSearchParams(location.searchStr).get('q') ?? '')
  }, [location.searchStr])

  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select') || event.target.isContentEditable)
      if (!editing && event.key === '/') {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', focus)
    return () => {
      window.removeEventListener('keydown', focus)
      clearTimeout(debounce.current)
    }
  }, [])

  return (
    <div className="min-h-screen">
      <CommandPalette />
      <QueueDock />
      <a
        className="absolute top-[-60px] z-skip bg-accent p-[10px] text-accent-ink focus:top-0"
        href="#main"
      >
        Skip to content
      </a>
      {/* `sidebar` carries no styling; it is the hook `e2e/app.spec.ts` and `e2e/phone.spec.ts`
          measure the bottom bar with. */}
      <aside
        className={cx(
          'sidebar fixed inset-y-0 left-[var(--safe-left)] flex w-[var(--sidebar-width)] flex-col border-r border-line bg-sidebar px-[19px] pt-[33px] pb-[98px]',
          'max-tablet:px-[13px]',
          'max-phone:inset-x-0 max-phone:top-auto max-phone:z-bar max-phone:h-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:w-auto max-phone:border-t max-phone:border-r-0 max-phone:pt-0 max-phone:pr-[var(--safe-right)] max-phone:pb-[var(--safe-bottom)] max-phone:pl-[var(--safe-left)]',
        )}
      >
        {/* `brand` carries no styling here. The Windows 95 skin draws it as the sidebar's title bar. */}
        <Link
          to="/search"
          className="brand flex items-center px-[8px] text-display font-[650] tracking-[-1px] max-phone:hidden"
        >
          musimo<span className="text-accent">.</span>
        </Link>
        <div className="mx-[12px] mt-[51px] mb-[17px] text-micro tracking-[1.6px] text-faint max-phone:hidden">
          YOUR MUSIC, AT HOME
        </div>
        <nav
          aria-label="Main navigation"
          className="grid gap-[7px] max-phone:h-full max-phone:auto-cols-fr max-phone:grid-flow-col max-phone:gap-0"
        >
          {navItems.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={navLinkClassName}
              activeProps={navLinkActiveProps}
              inactiveProps={navLinkInactiveProps}
            >
              <Icon size={19} />
              <span>{label}</span>
              {to === '/search' && <Kbd className="ml-auto !text-small opacity-60">/</Kbd>}
              {to === '/downloads' && activeDownloads > 0 && (
                // Only the phone bottom bar shows the count; wider layouts have the queue dock.
                <span className="nav-badge hidden max-phone:absolute max-phone:top-[5px] max-phone:left-[calc(50%+6px)] max-phone:grid max-phone:h-[18px] max-phone:min-w-[18px] max-phone:place-items-center max-phone:rounded-pill max-phone:bg-accent-hot max-phone:px-[5px] max-phone:text-caption max-phone:font-bold max-phone:text-accent-ink">
                  <span className="sr-only">, </span>
                  {activeDownloads}
                  <span className="sr-only"> active</span>
                </span>
              )}
            </Link>
          ))}
          <NowPlayingNavItem />
          <Link
            to="/music-bot"
            className={cx(navLinkClassName, 'max-phone:hidden')}
            activeProps={navLinkActiveProps}
            inactiveProps={navLinkInactiveProps}
          >
            {/* A hidden pet hands its face, and its new-reply dot, to this row. */}
            {petHidden ? <PetFace size={19} /> : <Radio size={19} />}
            <span>Music bot</span>
          </Link>
        </nav>
        <footer className="mx-[7px] mt-auto text-small text-muted max-phone:hidden">
          <div className="flex items-center gap-[10px]">
            <Radio size={18} />
            <div>
              Made for your library
              <small className="mt-[5px] block text-faint">Self-hosted music</small>
            </div>
          </div>
          <div className="mt-[14px] grid gap-[6px]">
            <a
              className={sidebarActionClassName}
              href="https://www.musicares.org/donations/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Heart size={14} fill="var(--color-danger)" stroke="var(--color-danger)" />
              Donate
            </a>
            <a
              className={sidebarActionClassName}
              href="https://ko-fi.com/colinleahy"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Coffee size={14} />
              Buy me a coffee
            </a>
            <a
              className={sidebarActionClassName}
              href="https://github.com/LeahyCC/musimo"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Star size={14} />
              Star on GitHub
            </a>
          </div>
        </footer>
      </aside>
      <div className="ml-[calc(var(--sidebar-width)+var(--safe-left))] pr-[var(--safe-right)] max-phone:ml-0 max-phone:pr-0">
        <header
          className={cx(
            'sticky top-0 z-header flex h-[calc(var(--topbar-height)+var(--safe-top))] items-center justify-between gap-[18px] border-b border-line bg-canvas px-[43px] pt-[var(--safe-top)]',
            'max-tablet:px-[27px]',
            'max-phone:gap-[12px] max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pl-[calc(16px+var(--safe-left))]',
          )}
        >
          <form
            className="flex w-[min(660px,80%)] items-center gap-[12px] text-muted max-phone:w-full"
            onSubmit={(e) => {
              e.preventDefault()
              clearTimeout(debounce.current)
              if (links.submit(text)) return
              void navigate({ to: '/search', search: { q: text } })
            }}
          >
            <Search size={20} />
            <input
              ref={input}
              className="min-w-0 flex-1 border-0 bg-transparent py-[12px] text-lead text-text placeholder:text-faint max-phone:py-[10px]"
              aria-label="Search music or paste a link"
              placeholder="Search music or paste a link"
              value={text}
              onPaste={(e) => {
                clearTimeout(debounce.current)
                links.paste(e, setText)
              }}
              onChange={(e) => {
                const value = e.target.value
                setText(value)
                clearTimeout(debounce.current)
                // A link opens its review sheet when pasted or submitted, and is never searched.
                if (isLinkText(value)) return
                debounce.current = setTimeout(() => {
                  void navigate({
                    to: '/search',
                    search: {
                      ...validateSearch(
                        Object.fromEntries(new URLSearchParams(location.searchStr)),
                      ),
                      q: value,
                    },
                  })
                }, 200)
              }}
            />
            <Kbd>/</Kbd>
          </form>
          <Link
            to="/music-bot"
            className="inline-flex shrink-0 items-center justify-center gap-[6px] text-small underline coarse:min-h-11 coarse:min-w-11"
          >
            {/* On a phone with nothing playing there is no mini player to perch on, so the pet
                tucks into this link. A wide window always has the footer. Under 380px the bar
                has no room for both, so the face stands for the words, which stay for readers. */}
            {!perched && (
              <span className="hidden max-phone:inline-flex">
                <PetFace size={22} />
              </span>
            )}
            <span className={cx(!perched && 'max-[380px]:sr-only')}>Music bot</span>
          </Link>
          <span
            className="flex items-center gap-[7px] text-tiny whitespace-nowrap text-muted"
            role="status"
          >
            <i
              className={cx('size-[6px] rounded-full', status === 'Live' ? 'bg-accent' : 'bg-warn')}
            />
            {status}
          </span>
        </header>
        {links.sheet}
        {status !== 'Live' && (
          <div
            className="bg-warn-bg px-[43px] py-[8px] text-small text-warn max-phone:pr-[calc(20px+var(--safe-right))] max-phone:pl-[calc(20px+var(--safe-left))]"
            role="status"
          >
            {status === 'Offline'
              ? 'Cannot reach Musimo. Reconnecting automatically.'
              : status === 'Reconnecting'
                ? 'Connection lost. Reconnecting…'
                : status === 'Syncing'
                  ? 'Syncing changes…'
                  : 'Connecting to live updates…'}
          </div>
        )}
        {/* The bottom padding follows the player and nav on a phone so the last row is never under
            them. */}
        {/* On a phone the pet stands about 44px above the mini player, so the page keeps that
            much more room while it is there. */}
        <main
          id="main"
          className={cx(
            'm-auto max-w-[1360px] px-[43px] pt-[36px] pb-[130px] wide:pt-[48px] max-tablet:px-[27px] max-phone:pt-[24px] max-phone:pr-[calc(20px+var(--safe-right))] max-phone:pl-[calc(20px+var(--safe-left))]',
            perched
              ? 'max-phone:pb-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+76px)]'
              : 'max-phone:pb-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+32px)]',
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
