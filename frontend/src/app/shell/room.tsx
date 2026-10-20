import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ArrowDownToLine,
  House,
  Library,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { api, libraryAlbumsSchema } from '../../api'
import { activeCount, useJobs } from '../../features/downloads/jobs'
import { ListenerAvatar } from '../../features/listener/avatar'
import { useListenerUi } from '../../features/listener/sheet'
import { PetFace, usePerchShown } from '../../features/music-bot/pet-host'
import { usePetSettings } from '../../features/music-bot/pet-settings'
import { useNowPlayingTakesOver, usePlayer } from '../../features/player/player'
import { PlayerDock, RoomMiniPlayer } from '../../features/player/player-dock'
import { cx } from '../../lib/cx'
import { usePhone } from '../../lib/use-phone'
import { useLiveEvents } from '../live-events'
import { CommandPalette, openCommandPalette } from '../palette'

/* The same edge as `max-tablet:` (`--breakpoint-tablet`, 68.75rem). Under it the dock lies down as
   a bar under the page, so the page keeps the width it needs. */
const NARROW_QUERY = '(width < 68.75rem)'
const subscribeNarrow = (notify: () => void) => {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const useNarrow = () =>
  useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  )

const inSection = (pathname: string, section: string) =>
  pathname === section || pathname.startsWith(`${section}/`)

type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  /** Whether the item is lit for this address. Search stays lit on the catalog's own pages. */
  active: (pathname: string) => boolean
}

const mainNav: NavItem[] = [
  { to: '/', label: 'Home', icon: House, active: (path) => path === '/' },
  {
    to: '/search',
    label: 'Search',
    icon: Search,
    active: (path) =>
      ['/search', '/albums', '/artists', '/podcasts'].some((s) => inSection(path, s)),
  },
  {
    // `/library` opens the view the Library was last on.
    to: '/library',
    label: 'Library',
    icon: Library,
    active: (path) => inSection(path, '/library'),
  },
  {
    to: '/music-bot',
    label: 'Octive',
    icon: Sparkles,
    active: (path) => inSection(path, '/music-bot'),
  },
  {
    to: '/downloads',
    label: 'Queue',
    icon: ArrowDownToLine,
    active: (path) => inSection(path, '/downloads'),
  },
]

const systemNav: NavItem[] = [
  {
    to: '/settings',
    label: 'Settings',
    icon: Settings2,
    active: (path) => inSection(path, '/settings'),
  },
  {
    to: '/diagnostics',
    label: 'Diagnostics',
    icon: Activity,
    active: (path) => inSection(path, '/diagnostics'),
  },
]

const libraryViews: Record<string, string> = {
  albums: 'ALBUMS',
  artists: 'ARTISTS',
  tracks: 'TRACKS',
  playlists: 'PLAYLISTS',
}

/** How many albums the library holds, from the browse endpoint's total. Undefined until known. */
function useAlbumCount(enabled: boolean) {
  const query = useQuery({
    queryKey: ['library-album-count'],
    queryFn: ({ signal }) => api('library/albums?size=1', libraryAlbumsSchema, { signal }),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
  return query.data?.total
}

/**
 * The header's page title and its mono line. The line says only what the app knows: the date, a
 * count the server reports, the live connection, or what the page is. Nothing here is invented.
 */
function useHeading(pathname: string, status: string): [string, string] {
  const libraryList = /^\/library\/(albums|artists|tracks|playlists)$/.exec(pathname)
  const albums = useAlbumCount(pathname === '/' || Boolean(libraryList))
  const downloads = useJobs((data) => ({ active: activeCount(data), failed: data.summary.failed }))
  const { libraryTrack } = usePlayer()
  const count = albums === undefined ? '' : `${albums.toLocaleString('en-GB')} ALBUMS`

  if (pathname === '/') {
    const day = new Date()
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      .replace(',', '')
      .toUpperCase()
    return ['Home', [day, count].filter(Boolean).join(' · ')]
  }
  if (pathname === '/search') return ['Search', 'CATALOG · CHECKED AGAINST YOUR LIBRARY']
  if (inSection(pathname, '/albums')) return ['Album', 'CATALOG']
  if (inSection(pathname, '/artists')) return ['Artist', 'CATALOG']
  if (inSection(pathname, '/podcasts')) return ['Podcast', 'PODCASTS']
  if (libraryList) {
    const view = libraryViews[libraryList[1] ?? ''] ?? ''
    return ['Library', [view, count].filter(Boolean).join(' · ')]
  }
  if (inSection(pathname, '/library/playlists')) return ['Playlist', 'LIBRARY · PLAYLISTS']
  if (/^\/library\/artists\/[^/]+(\/songs)?$/.test(pathname)) return ['Artist', 'LIBRARY · ARTISTS']
  if (inSection(pathname, '/library')) return ['Album', 'LIBRARY · ALBUMS']
  if (pathname === '/now-playing') {
    const from = [libraryTrack?.artist, libraryTrack?.album].filter(Boolean).join(' · ')
    return ['Now playing', from.toUpperCase()]
  }
  if (pathname === '/music-bot') return ['Octive', 'BUILDS QUEUES FROM YOUR LIBRARY']
  if (pathname === '/downloads') {
    const { active = 0, failed = 0 } = downloads.data ?? {}
    if (!downloads.data) return ['Downloads', '']
    return [
      'Downloads',
      [`${active} ACTIVE`, failed ? `${failed} FAILED` : ''].filter(Boolean).join(' · '),
    ]
  }
  if (pathname === '/settings/user') return ['Settings', 'YOURS']
  if (pathname === '/settings') return ['Settings', 'SAVED TO THIS SERVER']
  if (pathname === '/diagnostics') return ['Diagnostics', `LIVE UPDATES · ${status.toUpperCase()}`]
  return ['Musimo', '']
}

/** Live is the only state that needs no attention, so every other one gets the warning dot. */
function StatusDot({ status, className }: { status: string; className: string }) {
  return (
    <i
      aria-hidden="true"
      className={cx(
        'absolute size-[7px] rounded-full',
        status === 'Live' ? 'bg-accent' : 'bg-warn',
        className,
      )}
    />
  )
}

function Badge({ count }: { count: number }) {
  if (!count) return null
  return (
    // `nav-badge` carries no styling; it is the hook the specs find the count with.
    <span className="nav-badge absolute top-[6px] right-[10px] grid h-[16px] min-w-[16px] place-items-center rounded-pill bg-accent-hot px-[4px] text-caption font-bold text-accent-ink max-phone:top-[8px] max-phone:right-auto max-phone:left-[calc(50%+6px)]">
      <span className="sr-only">, </span>
      {count}
      <span className="sr-only"> active</span>
    </span>
  )
}

const searchKey =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'

/** The Listening room layout: a rail, the page, and a player dock on the right. */
export function RoomShell() {
  const status = useLiveEvents()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const phone = usePhone()
  const narrow = useNarrow()
  const activeDownloads = useJobs(activeCount).data ?? 0
  const petHidden = usePetSettings().hidden
  const perched = usePerchShown()
  const [title, subtitle] = useHeading(pathname, status)
  const listener = useListenerUi()

  // Now Playing has every control the dock has, so the dock stands down beside it, as the Classic
  // footer does. A preview has no Now Playing, so it keeps the dock there.
  const onStage = useNowPlayingTakesOver()
  const dock = !phone && !onStage

  // `/` searches in Classic. Here it opens the palette, which is this layout's search.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select') || event.target.isContentEditable)
      if (!editing && event.key === '/') {
        event.preventDefault()
        openCommandPalette()
      }
    }
    window.addEventListener('keydown', open)
    return () => window.removeEventListener('keydown', open)
  }, [])

  const navLink = (item: NavItem, children: ReactNode, className: string) => {
    const active = item.active(pathname)
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'relative',
          className,
          active ? 'bg-active text-accent' : 'text-muted hover:text-text',
        )}
      >
        {children}
      </Link>
    )
  }

  return (
    <div
      className={cx(
        'grid h-dvh gap-[8px] overflow-hidden bg-sidebar p-[8px] text-text',
        dock
          ? 'grid-cols-[72px_minmax(0,1fr)_var(--dock-width)] grid-rows-[minmax(0,1fr)] max-tablet:grid-cols-[72px_minmax(0,1fr)] max-tablet:grid-rows-[minmax(0,1fr)_auto]'
          : 'grid-cols-[72px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]',
        'max-phone:block max-phone:h-auto max-phone:min-h-dvh max-phone:overflow-visible max-phone:bg-canvas max-phone:p-0',
      )}
    >
      <CommandPalette />
      <a
        className="absolute top-[-60px] z-skip bg-accent p-[10px] text-accent-ink focus:top-0"
        href="#main"
      >
        Skip to content
      </a>
      {/* On a phone the page runs on under the floating player and tab bar, so it fades out
          behind them rather than showing through the gaps around them. */}
      {/* `z-sticky`, the save bar's level: it is later in the page, so the bar draws over the
          fade, and every other control the page has draws under it. */}
      {phone && (
        <div
          aria-hidden="true"
          data-stage-hide=""
          className="pointer-events-none fixed inset-x-0 bottom-0 z-sticky h-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+28px)] bg-linear-to-t from-canvas from-45% to-transparent"
        />
      )}
      {/* `sidebar` carries no styling; it is the hook the specs measure the phone's tab bar with.
          The rail on a wide window. On a phone, a pill of five tabs floating over the page's
          foot, with the mini player floating above it: the room's two bars are islands, where
          Classic's are docked to the edge. */}
      <nav
        aria-label="Main navigation"
        data-stage-hide=""
        className={cx(
          'sidebar flex flex-col items-center gap-[4px] py-[10px]',
          dock && 'max-tablet:row-span-2',
          'max-phone:fixed max-phone:right-[calc(12px+var(--safe-right))] max-phone:bottom-[calc(8px+var(--safe-bottom))] max-phone:left-[calc(12px+var(--safe-left))] max-phone:z-bar max-phone:grid max-phone:h-[calc(var(--nav-height)-8px)] max-phone:grid-cols-5 max-phone:gap-[2px] max-phone:rounded-pill max-phone:bg-raised max-phone:p-[5px] max-phone:shadow-[0_10px_30px_color-mix(in_oklab,var(--color-shadow)_45%,transparent)] max-phone:ring-1 max-phone:ring-line-strong',
        )}
      >
        <Link
          to="/"
          aria-label="Musimo home"
          className="mb-[10px] grid h-[48px] place-items-center text-display font-bold tracking-[-1px] max-phone:hidden"
        >
          <span aria-hidden="true">
            m<span className="text-accent">.</span>
          </span>
        </Link>
        {mainNav.map((item) => {
          const Icon = item.icon
          // A hidden pet hands its face, and its new-reply dot, to Octive. So does a phone with
          // nothing playing, where there is no mini player for it to stand on.
          const face = item.to === '/music-bot' && (petHidden || (phone && !perched))
          return navLink(
            item,
            <>
              {face ? <PetFace size={20} /> : <Icon size={20} />}
              {item.label}
              {item.to === '/downloads' && <Badge count={activeDownloads} />}
            </>,
            cx(
              'flex h-[56px] w-[60px] flex-none flex-col items-center justify-center gap-[5px] rounded-[14px] text-tiny font-medium',
              'max-phone:h-full max-phone:w-auto max-phone:gap-[3px] max-phone:rounded-pill',
            ),
          )
        })}
        <span className="flex-1 max-phone:hidden" />
        {systemNav.map((item) => {
          const Icon = item.icon
          return navLink(
            item,
            <>
              <Icon size={19} aria-hidden="true" />
              <span className="sr-only">{item.label}</span>
              {item.to === '/diagnostics' && (
                <StatusDot
                  status={status}
                  className="top-[10px] right-[10px] shadow-[0_0_0_2px_var(--color-sidebar)]"
                />
              )}
            </>,
            'grid size-[44px] flex-none place-items-center rounded-[12px] max-phone:hidden',
          )
        })}
      </nav>
      <div
        className={cx(
          'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] bg-canvas',
          'max-phone:block max-phone:overflow-visible max-phone:rounded-none',
        )}
      >
        <header
          data-stage-hide=""
          className={cx(
            'flex h-[64px] shrink-0 items-center gap-[12px] px-[clamp(16px,2.4vw,28px)]',
            'max-phone:sticky max-phone:top-0 max-phone:z-header max-phone:h-[calc(var(--topbar-height)+var(--safe-top))] max-phone:gap-[8px] max-phone:bg-canvas max-phone:pt-[var(--safe-top)] max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pl-[calc(16px+var(--safe-left))]',
          )}
        >
          {phone ? (
            <ListenerAvatar />
          ) : (
            listener.name && (
              <button
                type="button"
                className="max-w-[9rem] shrink-0 truncate text-body font-semibold"
                aria-label={`Listening as ${listener.name}`}
                onClick={listener.open}
              >
                {listener.name}
              </button>
            )
          )}
          <div className="flex min-w-0 flex-1 items-baseline gap-[10px]">
            <span className="text-heading font-semibold tracking-[-0.4px] whitespace-nowrap max-phone:text-subtitle">
              {title}
            </span>
            <span className="truncate font-mono text-tiny tracking-[0.4px] text-faint max-phone:hidden">
              {subtitle}
            </span>
          </div>
          <button
            type="button"
            className="flex h-[38px] w-[min(340px,40%)] items-center gap-[10px] rounded-[10px] border border-line bg-sunken pr-[8px] pl-[12px] text-left text-body text-faint hover:border-line-strong max-phone:hidden"
            aria-keyshortcuts="Meta+K Control+K /"
            onClick={openCommandPalette}
          >
            <Search size={16} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Search or paste a link</span>
            <span
              aria-hidden="true"
              className="rounded-[5px] bg-hover px-[6px] py-[2px] font-mono text-tiny text-muted"
            >
              {searchKey}
            </span>
          </button>
          {systemNav.map((item) => {
            const Icon = item.icon
            return navLink(
              item,
              <>
                <Icon size={18} aria-hidden="true" />
                <span className="sr-only">{item.label}</span>
                {item.to === '/diagnostics' && (
                  <StatusDot status={status} className="top-[9px] right-[9px]" />
                )}
              </>,
              'hidden size-[40px] shrink-0 place-items-center rounded-[12px] bg-sunken coarse:size-11 max-phone:grid',
            )
          })}
        </header>
        {status !== 'Live' && (
          <div
            className="bg-warn-bg px-[clamp(16px,2.4vw,28px)] py-[8px] text-small text-warn"
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
        {/* A wide window scrolls the page inside its pane. A phone scrolls the document, so the
            page is padded past the mini player and the tab bar, and past the pet standing on the
            mini player while it is there. */}
        <main
          id="main"
          className={cx(
            '@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-[clamp(16px,2.4vw,28px)] pt-[4px] pb-[32px]',
            'max-phone:overflow-visible max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pl-[calc(16px+var(--safe-left))]',
            'max-phone:pt-[8px]',
            perched
              ? 'max-phone:pb-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+76px)]'
              : 'max-phone:pb-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+32px)]',
          )}
        >
          <Outlet />
        </main>
      </div>
      {dock && (
        <div className="flex min-h-0 flex-col max-tablet:col-start-2 max-tablet:row-start-2">
          <PlayerDock bar={narrow} />
        </div>
      )}
      {phone && !onStage && <RoomMiniPlayer />}
    </div>
  )
}
