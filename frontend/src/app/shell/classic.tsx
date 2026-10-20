import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ArrowDownToLine,
  Coffee,
  Command,
  Disc3,
  Heart,
  House,
  Library,
  ListMusic,
  MicVocal,
  Music,
  Search,
  Settings2,
  Sparkles,
  Star,
  X,
} from 'lucide-react'

import type { LibraryPlaylist } from '../../api'
import { activeCount, useJobs } from '../../features/downloads/jobs'
import { QueueDock } from '../../features/downloads/queue-dock'
import { isLinkText, useLinkSheet } from '../../features/links/links'
import { ListenerAvatar } from '../../features/listener/avatar'
import { useListenerUi } from '../../features/listener/sheet'
import { PetFace, usePerchShown } from '../../features/music-bot/pet-host'
import { usePetSettings } from '../../features/music-bot/pet-settings'
import { artUrl, usePlayer } from '../../features/player/player'
import { validateSearch } from '../../features/search/search-params'
import { cx } from '../../lib/cx'
import { usePhone } from '../../lib/use-phone'
import { IconButton, Kbd } from '../../ui'
import { useLiveEvents } from '../live-events'
import { CommandPalette } from '../palette'
import { useAlbumCount, useServerVersion, useSidebarPlaylists } from './shell-data'

/* Where a row lights up. A row names the part of the address it owns, so a detail page keeps its
   section lit: Search owns the catalog pages (an album or artist found by searching), and each
   library row owns the views and detail pages under it. */
const startsWithPath = (pathname: string, section: string) =>
  pathname === section || pathname.startsWith(`${section}/`)

const catalogSections = ['/search', '/albums', '/artists', '/podcasts']

const topItems = [
  { to: '/', label: 'Home', icon: House, lit: (path: string) => path === '/' },
  {
    to: '/search',
    label: 'Search',
    icon: Search,
    lit: (path: string) => catalogSections.some((section) => startsWithPath(path, section)),
  },
  {
    to: '/music-bot',
    label: 'Octive',
    icon: Sparkles,
    lit: (path: string) => startsWithPath(path, '/music-bot'),
  },
] as const

const libraryItems = [
  { to: '/library/albums', label: 'Albums', icon: Disc3 },
  { to: '/library/artists', label: 'Artists', icon: MicVocal },
  { to: '/library/tracks', label: 'Tracks', icon: Music },
  { to: '/library/playlists', label: 'Playlists', icon: ListMusic },
] as const

const systemItems = [
  { to: '/downloads', label: 'Downloads', icon: ArrowDownToLine },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/diagnostics', label: 'Diagnostics', icon: Activity },
] as const

/* The phone's bar has five tabs, and Library is one tab for all four views. */
const phoneTabs = [
  ...topItems.slice(0, 2),
  {
    to: '/library/albums',
    label: 'Library',
    icon: Library,
    lit: (path: string) => startsWithPath(path, '/library'),
  },
  topItems[2],
  {
    to: '/downloads',
    label: 'Downloads',
    icon: ArrowDownToLine,
    lit: (path: string) => startsWithPath(path, '/downloads'),
  },
] as const

const SUPPORT_LINKS = [
  { href: 'https://www.musicares.org/donations/', label: 'Donate to MusiCares', icon: Heart },
  { href: 'https://ko-fi.com/colinleahy', label: 'Buy me a coffee', icon: Coffee },
  { href: 'https://github.com/LeahyCC/musimo', label: 'Star on GitHub', icon: Star },
] as const

// No height or text size here: each row sets its own, since `cx` does not merge two classes for
// the same property and the one Tailwind prints later would win.
const rowClassName = cx(
  'flex flex-none items-center gap-[11px] rounded-[8px] px-[10px]',
  'coarse:min-h-11',
)
const litProps = { 'className': 'bg-active text-accent', 'aria-current': 'page' } as const
const idleProps = { className: 'text-muted hover:text-text' } as const
/* The router would light a row by its own rules (a prefix match on a detail page, or the root
   link everywhere), so every link is given the same props whichever way the router judges it. */
const lookOf = (lit: boolean) => (lit ? litProps : idleProps)
/* A phone's tab only changes color; the sidebar's row also gets a wash. */
const tabLookOf = (lit: boolean) =>
  lit ? ({ 'className': 'text-accent', 'aria-current': 'page' } as const) : idleProps

const groupHeadingClassName =
  'px-[10px] pt-[20px] pb-[8px] text-tiny font-semibold tracking-[0.6px] text-faint'

/* The active download count. The sidebar and the phone's bar draw it differently; `nav-badge` is
   the hook `e2e/cards.spec.ts` and `e2e/phone.spec.ts` read it by. */
function DownloadsBadge({ count, phone }: { count: number; phone: boolean }) {
  if (count < 1) return null
  return (
    <span
      className={cx(
        'nav-badge grid place-items-center rounded-pill text-accent-ink',
        phone
          ? 'absolute top-[5px] left-[calc(50%+6px)] h-[18px] min-w-[18px] bg-accent-hot px-[5px] text-caption font-bold'
          : 'ml-auto h-[18px] min-w-[20px] bg-accent px-[6px] text-tiny font-[650]',
      )}
    >
      <span className="sr-only">, </span>
      {count}
      <span className="sr-only"> active</span>
    </span>
  )
}

/* Now Playing is reached from the footer player's cover, title and queue button, so it has no
   permanent row. While a library track is loaded it gets one at the end of the upper group, where
   the spacer above Downloads absorbs it: nothing above or below it moves when it appears. */
function NowPlayingRow({ pathname }: { pathname: string }) {
  const { libraryTrack } = usePlayer()
  if (!libraryTrack) return null
  const art = artUrl(libraryTrack)
  return (
    <Link
      to="/now-playing"
      className={cx(rowClassName, 'h-[36px] text-lead')}
      activeProps={lookOf(startsWithPath(pathname, '/now-playing'))}
      inactiveProps={lookOf(startsWithPath(pathname, '/now-playing'))}
    >
      {art ? (
        <img className="size-[18px] shrink-0 rounded-[4px] object-cover" src={art} alt="" />
      ) : (
        <Disc3 size={18} />
      )}
      <span className="flex-1">Now Playing</span>
    </Link>
  )
}

const playlistPath = (id: string) => `/library/playlists/${encodeURIComponent(id)}`

/* The playlists under LIBRARY: Liked first, then the most recently changed. Cover art comes from
   the player's art route, as a track's does. */
function PlaylistRows({
  pathname,
  likedId,
  rows,
}: {
  pathname: string
  likedId: string
  rows: readonly LibraryPlaylist[]
}) {
  if (!rows.length) return null
  return (
    <>
      <p className={groupHeadingClassName}>PLAYLISTS</p>
      {rows.map((playlist) => {
        const lit = pathname === playlistPath(playlist.id)
        const liked = playlist.id === likedId
        return (
          <Link
            key={playlist.id}
            to="/library/playlists/$playlistId"
            params={{ playlistId: playlist.id }}
            activeOptions={{ exact: true }}
            className={cx(
              'flex h-[34px] flex-none items-center gap-[10px] rounded-[8px] px-[10px] text-body coarse:min-h-11',
              !lit && 'hover:bg-sunken',
            )}
            activeProps={lookOf(lit)}
            inactiveProps={lookOf(lit)}
          >
            <span
              className={cx(
                'grid size-[20px] shrink-0 place-items-center overflow-hidden rounded-[4px]',
                liked ? 'bg-accent text-accent-ink' : 'bg-hover text-muted',
              )}
            >
              {liked ? (
                <Heart size={11} fill="currentColor" />
              ) : playlist.coverArt ? (
                <img
                  className="size-full object-cover"
                  src={`/api/player/art/${encodeURIComponent(playlist.coverArt)}`}
                  alt=""
                />
              ) : (
                <ListMusic size={11} />
              )}
            </span>
            <span className="truncate">{playlist.name}</span>
          </Link>
        )
      })}
    </>
  )
}

/* The sidebar's last line: whether live updates are connected, the version, and the one Support
   link. Support opens a small dialog with the three places that used to be separate buttons. */
function SidebarFooter({ status }: { status: string }) {
  const version = useServerVersion()
  const dialog = useRef<HTMLDialogElement>(null)
  return (
    <footer className="mx-[10px] mt-[12px] flex items-center gap-[8px] border-t border-line pt-[12px] text-tiny text-faint">
      <i
        aria-hidden="true"
        className={cx(
          'size-[6px] shrink-0 rounded-full',
          status === 'Live' ? 'bg-accent' : 'bg-warn',
        )}
      />
      <span>
        <span role="status">{status}</span>
        {version && ` · v${version}`}
      </span>
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-[5px] border-0 bg-transparent p-0 text-faint hover:text-danger coarse:min-h-11"
        onClick={() => dialog.current?.showModal()}
      >
        <Heart size={12} />
        Support
      </button>
      <dialog
        ref={dialog}
        aria-label="Support Musimo"
        className="fixed inset-0 m-auto w-[min(360px,calc(100%-32px))] rounded-[14px] border border-line-strong bg-raised p-[18px] text-body text-text shadow-[0_20px_90px_color-mix(in_oklab,var(--color-shadow)_60%,transparent)]"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <header className="mb-[12px] flex items-center gap-[14px]">
          <h2 className="flex-1">Support Musimo</h2>
          <IconButton
            size="compact"
            aria-label="Close support"
            onClick={() => dialog.current?.close()}
          >
            <X size={16} />
          </IconButton>
        </header>
        <div className="grid gap-[8px]">
          {SUPPORT_LINKS.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              className="flex items-center gap-[10px] rounded-md border border-line px-[12px] py-[10px] text-muted hover:border-[color:var(--line-hover)] hover:text-accent coarse:min-h-11"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon size={15} />
              {label}
            </a>
          ))}
        </div>
      </dialog>
    </footer>
  )
}

function Sidebar({
  pathname,
  status,
  downloads,
}: {
  pathname: string
  status: string
  downloads: number
}) {
  const albumCount = useAlbumCount()
  const listener = useListenerUi()
  const { likedId, rows } = useSidebarPlaylists()
  const petHidden = usePetSettings().hidden
  const link = (to: string) => startsWithPath(pathname, to)
  // A playlist with a row of its own lights that row; any other playlist lights Playlists.
  const onShownPlaylist = rows.some((playlist) => pathname === playlistPath(playlist.id))
  return (
    <>
      {/* `brand` carries no styling here. The Windows 95 skin draws it as the sidebar's title bar. */}
      <button
        type="button"
        className="brand flex w-full min-w-0 items-center px-[10px] pb-[18px] text-left text-[22px] font-[650] tracking-[-0.8px]"
        aria-label={listener.name ? `Listening as ${listener.name}` : 'Who is listening?'}
        onClick={listener.open}
      >
        <span className="min-w-0 truncate">{listener.name || 'musimo'}</span>
        <span className="text-accent">.</span>
      </button>
      <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-[2px]">
        {topItems.map(({ to, label, icon: Icon, lit }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: true }}
            className={cx(rowClassName, 'h-[36px] text-lead')}
            activeProps={lookOf(lit(pathname))}
            inactiveProps={lookOf(lit(pathname))}
          >
            {/* A hidden pet hands its face, and its new-reply dot, to this row. */}
            {to === '/music-bot' && petHidden ? <PetFace size={18} /> : <Icon size={18} />}
            <span className="flex-1">{label}</span>
            {to === '/search' && (
              <span aria-hidden="true" className="text-tiny text-faint">
                /
              </span>
            )}
          </Link>
        ))}
        <p className={groupHeadingClassName}>LIBRARY</p>
        {libraryItems.map(({ to, label, icon: Icon }) => {
          const lit = to === '/library/playlists' ? link(to) && !onShownPlaylist : link(to)
          return (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: true }}
              className={cx(rowClassName, 'h-[36px] text-lead')}
              activeProps={lookOf(lit)}
              inactiveProps={lookOf(lit)}
            >
              <Icon size={18} />
              <span className="flex-1">{label}</span>
              {to === '/library/albums' && albumCount !== undefined && (
                <span className="ml-auto text-tiny text-faint">
                  {new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
                    .format(albumCount)
                    .toLowerCase()}
                </span>
              )}
            </Link>
          )
        })}
        <PlaylistRows pathname={pathname} likedId={likedId} rows={rows} />
        <NowPlayingRow pathname={pathname} />
        <div className="min-h-[20px] flex-1" />
        {systemItems.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: true }}
            className={cx(rowClassName, 'h-[34px] text-body')}
            activeProps={lookOf(link(to))}
            inactiveProps={lookOf(link(to))}
          >
            <Icon size={17} />
            <span className="flex-1">{label}</span>
            {to === '/downloads' && <DownloadsBadge count={downloads} phone={false} />}
          </Link>
        ))}
      </nav>
      <SidebarFooter status={status} />
    </>
  )
}

function PhoneTabs({ pathname, downloads }: { pathname: string; downloads: number }) {
  const petHidden = usePetSettings().hidden
  return (
    <nav aria-label="Main navigation" className="grid h-full auto-cols-fr grid-flow-col">
      {phoneTabs.map(({ to, label, icon: Icon, lit }) => (
        <Link
          key={label}
          to={to}
          activeOptions={{ exact: true }}
          className="relative flex flex-col items-center justify-center gap-[4px] px-[2px] py-[8px] text-tiny font-medium"
          activeProps={tabLookOf(lit(pathname))}
          inactiveProps={tabLookOf(lit(pathname))}
        >
          {to === '/music-bot' && petHidden ? <PetFace size={20} /> : <Icon size={20} />}
          <span>{label}</span>
          {to === '/downloads' && <DownloadsBadge count={downloads} phone />}
        </Link>
      ))}
    </nav>
  )
}

/* The palette listens for Ctrl or Cmd with K on the window. This presses that key for the top
   bar's button, so the button and the shortcut cannot disagree about what opens it. */
function openPalette() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
}

export function ClassicShell() {
  const status = useLiveEvents()
  const input = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navigate = useNavigate()
  const location = useRouterState({ select: (s) => s.location })
  const params = new URLSearchParams(location.searchStr)
  const [text, setText] = useState(params.get('q') ?? '')
  const links = useLinkSheet()
  const phone = usePhone()
  // The sidebar and the phone's bar both carry the active download count. Selecting the count
  // keeps progress ticks from re-rendering the whole shell.
  const activeDownloads = useJobs(activeCount).data ?? 0
  const perched = usePerchShown()
  const petHidden = usePetSettings().hidden

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

  const octiveIcon: ReactNode =
    // On a phone with nothing playing there is no mini player to perch on, so the pet tucks into
    // the Ask Octive pill. A wide window always has the footer. A hidden pet already shows its
    // face in the Octive tab, and two faces would announce each reply twice.
    phone && !perched && !petHidden ? <PetFace size={22} /> : <Sparkles size={16} />

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
          measure the bottom bar with. `data-stage-hide` takes it away on a phone's Now Playing. */}
      <aside
        data-stage-hide=""
        className={cx(
          'sidebar fixed inset-y-0 left-[var(--safe-left)] flex w-[var(--sidebar-width)] flex-col gap-[2px] overflow-x-hidden overflow-y-auto border-r border-line bg-sidebar px-[12px] pt-[20px] pb-[14px]',
          'max-phone:inset-x-0 max-phone:top-auto max-phone:z-bar max-phone:h-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:w-auto max-phone:overflow-visible max-phone:border-t max-phone:border-r-0 max-phone:p-0 max-phone:pr-[var(--safe-right)] max-phone:pb-[var(--safe-bottom)] max-phone:pl-[var(--safe-left)]',
        )}
      >
        {phone ? (
          <PhoneTabs pathname={location.pathname} downloads={activeDownloads} />
        ) : (
          <Sidebar pathname={location.pathname} status={status} downloads={activeDownloads} />
        )}
      </aside>
      <div className="ml-[calc(var(--sidebar-width)+var(--safe-left))] pr-[var(--safe-right)] max-phone:ml-0 max-phone:pr-0">
        <header
          data-stage-hide=""
          className={cx(
            'sticky top-0 z-header flex h-[calc(var(--topbar-height)+var(--safe-top))] items-center gap-[16px] border-b border-line bg-canvas px-[32px] pt-[var(--safe-top)]',
            'max-tablet:px-[24px]',
            'max-phone:gap-[8px] max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pl-[calc(16px+var(--safe-left))]',
          )}
        >
          {phone && <ListenerAvatar />}
          <form
            className="flex h-[38px] max-w-[560px] flex-1 items-center max-phone:min-w-0 gap-[10px] rounded-[10px] border border-line bg-sunken px-[12px] text-faint max-phone:max-w-none coarse:h-11"
            onSubmit={(e) => {
              e.preventDefault()
              clearTimeout(debounce.current)
              if (links.submit(text)) return
              void navigate({ to: '/search', search: { q: text } })
            }}
          >
            <Search size={17} className="shrink-0" />
            <input
              ref={input}
              className="min-w-0 flex-1 border-0 bg-transparent text-body text-text placeholder:text-faint"
              aria-label="Search music or paste a link"
              placeholder={phone ? 'Search or paste a link' : 'Search music or paste a link'}
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
            <Kbd className="text-faint max-phone:hidden">/</Kbd>
          </form>
          {/* The sidebar's footer says whether updates are live; a phone has no sidebar. */}
          {phone && (
            <span role="status" className="sr-only">
              {status}
            </span>
          )}
          <div className="flex-1 max-phone:hidden" />
          <button
            type="button"
            aria-label="Command palette"
            className="inline-flex h-[34px] shrink-0 items-center gap-[6px] rounded-[9px] border border-line bg-transparent px-[10px] text-small text-muted hover:border-line-strong hover:text-text max-phone:hidden coarse:h-11"
            onClick={openPalette}
          >
            <Command size={14} />K
          </button>
          <Link
            to="/music-bot"
            className="inline-flex h-[34px] shrink-0 items-center gap-[8px] rounded-pill border border-line py-0 pr-[12px] pl-[8px] text-small text-text hover:border-good-line coarse:min-h-11 coarse:min-w-11 coarse:justify-center max-phone:size-[44px] max-phone:px-0"
          >
            {octiveIcon}
            {/* A phone's bar gives the search field the room, so the face or the sparkle stands
                for the words there, and they stay for readers. */}
            <span className="max-phone:sr-only">Ask Octive</span>
          </Link>
        </header>
        {links.sheet}
        {status !== 'Live' && (
          <div
            className="bg-warn-bg px-[32px] py-[8px] text-small text-warn max-phone:pr-[calc(20px+var(--safe-right))] max-phone:pl-[calc(20px+var(--safe-left))]"
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
        {/* The desktop padding is Now Playing's to rely on: it takes back all but 24px of the 130px
            at the bottom, and counts the top padding in its `--page-pad`. On a phone the bottom
            follows the player and nav so the last row is never under them, plus about 44px
            while the pet stands above the mini player. */}
        <main
          id="main"
          className={cx(
            'm-auto max-w-[1360px] px-[40px] pt-[36px] pb-[130px] wide:pt-[48px] max-tablet:px-[24px] max-phone:pr-[calc(20px+var(--safe-right))] max-phone:pl-[calc(20px+var(--safe-left))]',
            'max-phone:pt-[24px]',
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
