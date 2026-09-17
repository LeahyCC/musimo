import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { createRoot } from 'react-dom/client'

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useBlocker,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router'
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Coffee,
  Folder,
  Heart,
  Library,
  LockKeyhole,
  Minus,
  Radio,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react'

import {
  api,
  destinationTestSchema,
  diagnosticsSchema,
  settingsSchema,
  snapshotSchema,
  sourceSchema,
} from './api'
import type { SettingKey } from './api'
import { librarySchema } from './api'
import { namingSchema } from './api'
import { controlsSchema, jobSchema } from './api'
import { cx } from './cx'
import { activeCount, DownloadsPage, QueueDock, updateJob, useJobs } from './downloads'
import type { QueueData } from './downloads'
import { LibraryPanel } from './library-panel'
import { PopoutProvider } from './now-playing-popout'
import { CommandPalette } from './palette'
import { PlayerProvider } from './player'
import { RecentActivity } from './recent-activity'
import { AlbumPage, ArtistPage, SearchPage, validateArtistSearch, validateSearch } from './search'
import { startTheme } from './theme/store'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  Field,
  FieldSelect,
  Kbd,
  Panel,
  StatusChip,
  Tag,
  textLinkClassName,
} from './ui'

import './style.css'

const LibraryPage = lazy(() =>
  import('./library').then((module) => ({ default: module.LibraryPage })),
)
const NowPlayingPage = lazy(() =>
  import('./library').then((module) => ({ default: module.NowPlayingPage })),
)

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})
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
const sidebarActionClassName = cx(
  'flex items-center gap-[8px] rounded-md border border-line px-[9px] py-[7px] text-tiny text-muted',
  'hover:border-[color:var(--line-hover)] hover:text-accent',
)

function useLiveEvents() {
  const client = useQueryClient()
  const [status, setStatus] = useState('Connecting')

  useEffect(() => {
    let stream: EventSource | undefined
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const connect = async () => {
      try {
        const snapshot = await api('snapshot', snapshotSchema, {
          signal: controller.signal,
        })
        if (disposed) return
        client.setQueryData(['settings'], snapshot.settings)
        client.setQueryData(['jobs'], {
          jobs: snapshot.jobs,
          controls: snapshot.controls,
          summary: snapshot.summary,
        })
        stream = new EventSource(`/api/events?after=${snapshot.cursor}`)
        stream.onopen = () => setStatus('Live')
        stream.onerror = () => setStatus('Reconnecting')
        stream.addEventListener('change', (event: MessageEvent<string>) => {
          const raw: unknown = JSON.parse(event.data)
          if (typeof raw !== 'object' || !raw || !('kind' in raw)) return
          if (raw.kind === 'job.updated' && 'payload' in raw) {
            const parsed = jobSchema.safeParse(raw.payload)
            if (parsed.success) {
              updateJob(client, parsed.data)
              if (['done', 'failed', 'cancelled'].includes(parsed.data.stage)) {
                void client.invalidateQueries({ queryKey: ['history'] })
                void client.invalidateQueries({ queryKey: ['activity'] })
              }
            }
            return
          }

          if (raw.kind === 'queue.updated' && 'payload' in raw) {
            const parsed = controlsSchema.safeParse(raw.payload)
            if (parsed.success)
              client.setQueryData(['jobs'], (old: QueueData | undefined) => ({
                jobs: old?.jobs ?? [],
                controls: parsed.data,
                summary: old?.summary ?? { active: 0, failed: 0, failure_reasons: [] },
              }))
            return
          }

          void client.invalidateQueries({ queryKey: ['activity'] })

          if (raw.kind === 'library.updated' && 'payload' in raw) {
            const parsed = librarySchema.safeParse(raw.payload)
            if (parsed.success) {
              client.setQueryData(['library'], parsed.data)
              if (parsed.data.status !== 'scanning') {
                void client.invalidateQueries({ queryKey: ['search'] })
                void client.invalidateQueries({ queryKey: ['album'] })
                void client.invalidateQueries({ queryKey: ['artist'] })
                void client.invalidateQueries({ queryKey: ['artist-download-plan'] })
              }
            }
          } else {
            void client.invalidateQueries({ queryKey: ['settings'] })
            void client.invalidateQueries({ queryKey: ['diagnostics'] })
          }
        })

        stream.addEventListener('reset', () => {
          stream?.close()
          setStatus('Syncing')
          void connect()
        })
      } catch {
        if (!disposed) {
          setStatus('Offline')
          timer = setTimeout(() => void connect(), 2000)
        }
      }
    }
    void connect()
    return () => {
      disposed = true
      controller.abort()
      stream?.close()
      clearTimeout(timer)
    }
  }, [client])

  return status
}

function Shell() {
  const status = useLiveEvents()
  const input = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navigate = useNavigate()
  const location = useRouterState({ select: (s) => s.location })
  const params = new URLSearchParams(location.searchStr)
  const [text, setText] = useState(params.get('q') ?? '')
  // The phone bottom bar carries the active download count that the dock shows elsewhere.
  // Selecting the count keeps progress ticks from re-rendering the whole shell.
  const activeDownloads = useJobs(activeCount).data ?? 0

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
          measure the bottom bar with. Desktop pins a column down the left edge, a phone pins a
          bar across the bottom whose height and padding grow by the home-indicator inset. */}
      <aside
        className={cx(
          'sidebar fixed top-0 bottom-0 left-[var(--safe-left)] flex w-[var(--sidebar-width)] flex-col border-r border-line bg-sidebar pt-[33px] pr-[19px] pb-[98px] pl-[19px]',
          'max-tablet:pr-[13px] max-tablet:pl-[13px]',
          'max-phone:top-auto max-phone:right-0 max-phone:bottom-0 max-phone:left-0 max-phone:z-bar max-phone:h-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:w-auto max-phone:border-t max-phone:border-r-0 max-phone:pt-0 max-phone:pr-[var(--safe-right)] max-phone:pb-[var(--safe-bottom)] max-phone:pl-[var(--safe-left)]',
        )}
      >
        <Link
          to="/search"
          className="flex items-center px-[8px] text-display font-[650] tracking-[-1px] max-phone:hidden"
        >
          musimo<span className="text-accent">.</span>
        </Link>
        <div className="mt-[51px] mr-[12px] mb-[17px] ml-[12px] text-micro tracking-[1.6px] text-faint max-phone:hidden">
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
              // The selected destination keeps its accent while the pointer is over it, so the
              // hover pair is repeated here rather than left to the inactive one.
              activeProps={{
                'className': 'bg-active text-accent hover:bg-active hover:text-accent',
                'aria-current': 'page',
              }}
              inactiveProps={{ className: 'text-muted hover:bg-hover hover:text-text' }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {to === '/search' && <Kbd className="ml-auto !text-small opacity-60">/</Kbd>}
              {to === '/downloads' && activeDownloads > 0 && (
                // Only the phone bottom bar shows the count; wider layouts have the queue dock.
                <span className="nav-badge hidden max-phone:absolute max-phone:top-[5px] max-phone:left-[calc(50%+6px)] max-phone:grid max-phone:h-[18px] max-phone:min-w-[18px] max-phone:place-items-center max-phone:rounded-[9px] max-phone:bg-accent-hot max-phone:px-[5px] max-phone:text-caption max-phone:font-bold max-phone:text-accent-ink">
                  <span className="sr-only">, </span>
                  {activeDownloads}
                  <span className="sr-only"> active</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
        <footer className="mt-auto mr-[7px] mb-0 ml-[7px] text-small text-muted max-phone:hidden">
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
      <div className="ml-[calc(var(--sidebar-width)+var(--safe-left))] pr-[var(--safe-right)] max-phone:mr-0 max-phone:ml-0 max-phone:pr-0">
        <header
          className={cx(
            'sticky top-0 z-header flex h-[calc(var(--topbar-height)+var(--safe-top))] items-center justify-between gap-[18px] border-b border-line bg-canvas pt-[var(--safe-top)] pr-[43px] pb-0 pl-[43px]',
            'max-tablet:pr-[27px] max-tablet:pl-[27px]',
            'max-phone:gap-[12px] max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pl-[calc(16px+var(--safe-left))]',
          )}
        >
          <form
            className="flex w-[min(660px,80%)] items-center gap-[12px] text-muted max-phone:w-full"
            onSubmit={(e) => {
              e.preventDefault()
              clearTimeout(debounce.current)
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
              onChange={(e) => {
                const value = e.target.value
                setText(value)
                clearTimeout(debounce.current)
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
          <span
            className="flex items-center gap-[7px] text-tiny whitespace-nowrap text-muted"
            role="status"
          >
            <i
              className={cx(
                'h-[6px] w-[6px] rounded-full',
                status === 'Live' ? 'bg-accent' : 'bg-warn',
              )}
            />
            {status}
          </span>
        </header>
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
        <main id="main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  )
}

const controls: {
  key: SettingKey
  label: string
  help: string
  min?: number
  max?: number
  section: string
}[] = [
  {
    key: 'destination',
    label: 'Download to',
    help: 'Choose a writable mounted music folder.',
    section: 'library',
  },
  {
    key: 'naming_template',
    label: 'Folder and file naming',
    help: 'Tokens: album_artist, album, artist, title, year, track, disc. Use {track:02d} for a padded number.',
    section: 'library',
  },
  {
    key: 'navidrome_mode',
    label: 'Navidrome scanning',
    help: 'Watcher uses Navidrome’s file watcher. API requests a selective scan with the same credentials file used by the player.',
    section: 'library',
  },
  {
    key: 'navidrome_url',
    label: 'Navidrome address',
    help: 'Used for playback and API scans. Playback also needs MUSIMO_NAVIDROME_CREDENTIALS_FILE mounted in Compose.',
    section: 'library',
  },
  {
    key: 'navidrome_library_id',
    label: 'Navidrome library ID',
    help: 'The library number used for API scanning.',
    section: 'library',
    min: 1,
    max: 100000,
  },
  {
    key: 'library_label',
    label: 'Library label',
    help: 'A familiar name for your primary music folder.',
    section: 'library',
  },
  {
    key: 'output_format',
    label: 'Audio format',
    help: 'Original keeps source quality. MP3 requires a lossy conversion. M4A and Opus may require conversion if the source codec differs.',
    section: 'audio',
  },
  {
    key: 'concurrency',
    label: 'Parallel downloads',
    help: 'Two is a conservative starting point for YouTube.',
    min: 1,
    max: 3,
    section: 'queue',
  },
  {
    key: 'max_attempts',
    label: 'Maximum attempts',
    help: 'Includes the first attempt. One disables automatic retries.',
    min: 1,
    max: 4,
    section: 'queue',
  },
  {
    key: 'retry_base_seconds',
    label: 'Initial backoff (seconds)',
    help: 'Retries use a random delay, increasing after each failure.',
    min: 1,
    max: 30,
    section: 'queue',
  },
  {
    key: 'retry_cap_seconds',
    label: 'Maximum backoff (seconds)',
    help: 'The upper limit for retry delays.',
    min: 30,
    max: 300,
    section: 'queue',
  },
]

function NamingPreview({ template }: { template: string }) {
  const value = useDeferredValue(template)
  const result = useQuery({
    queryKey: ['naming-preview', value],
    queryFn: ({ signal }) =>
      api(`naming-preview?template=${encodeURIComponent(value)}`, namingSchema, { signal }),
    retry: false,
  })
  return (
    <p className="naming-preview">
      {result.isError ? (
        result.error.message
      ) : (
        <code>{result.data?.path ?? 'Checking template…'}</code>
      )}
    </p>
  )
}

function SettingsPage() {
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
  })
  const [draft, setDraft] = useState<Partial<Record<SettingKey, string | number>>>({})
  const [originalValues, setOriginalValues] = useState<
    Partial<Record<SettingKey, string | number>>
  >({})
  const [conflicts, setConflicts] = useState<Partial<Record<SettingKey, string | number>>>({})
  const [saved, setSaved] = useState(false)

  const isDirty = Object.keys(draft).length > 0

  useBlocker({
    condition: isDirty,
    blockerFn: () => !window.confirm('You have unsaved changes. Leave anyway?'),
  })

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  useEffect(() => {
    if (!settings.data) return
    const newConflicts: Partial<Record<SettingKey, string | number>> = {}
    for (const key of Object.keys(draft) as SettingKey[]) {
      const original = originalValues[key]
      const current = settings.data[key]?.value
      if (original !== undefined && current !== original && current !== draft[key]) {
        newConflicts[key] = current
      }
    }
    setConflicts(newConflicts)
    if (Object.keys(newConflicts).length > 0) {
      setSaved(false)
    }
  }, [settings.data, draft, originalValues])

  const save = useMutation({
    mutationFn: () =>
      api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    onSuccess: (data) => {
      client.setQueryData(['settings'], data)
      setDraft({})
      setOriginalValues({})
      setConflicts({})
      setSaved(true)
    },
  })
  useEffect(() => {
    if (settings.isSuccess && window.location.hash) {
      const fieldId = window.location.hash.slice(1)
      const field = document.getElementById(fieldId)
      if (field) {
        field.scrollIntoView({ behavior: 'smooth', block: 'center' })
        field.focus({ preventScroll: true })
      }
    }
  }, [settings.isSuccess])

  return (
    <>
      <PageTitle eyebrow="SET IT UP YOUR WAY" title="Settings">
        <Tag>SAVED IN YOUR DATABASE</Tag>
      </PageTitle>
      <p className="page-intro">
        Preferences save without a restart. Download defaults apply to newly queued tracks.
      </p>
      {diagnostics.data &&
        (() => {
          const rootsReady = diagnostics.data.library.roots.every((root: string) => {
            const disk = diagnostics.data.disks.find((d) => d.path === root)
            return disk?.exists && disk?.writable && disk?.free_bytes !== null
          })
          const scanReady =
            diagnostics.data.library.status === 'idle' ||
            diagnostics.data.library.status === 'scanning'
          const navidromeReady = diagnostics.data.navidrome
            ? diagnostics.data.navidrome.available
            : null
          const youtubeReady =
            diagnostics.data.sources.find((s) => s.source === 'youtube')?.status === 'healthy'
          const lastDownloadOk =
            !diagnostics.data.last_download || diagnostics.data.last_download.stage === 'done'
          const overallReady =
            rootsReady && scanReady && navidromeReady !== false && youtubeReady && lastDownloadOk

          return (
            <div className={`settings-status ${overallReady ? 'ready' : 'not-ready'}`}>
              {overallReady ? (
                <>
                  <Check size={16} />
                  System ready.
                </>
              ) : (
                <>
                  <AlertCircle size={16} />
                  Some components need attention.
                </>
              )}
              <Link to="/diagnostics">View diagnostics</Link>
            </div>
          )
        })()}
      {settings.isError && (
        <ErrorBanner role="alert">
          {settings.error.message}
          <button onClick={() => void settings.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      <div className="settings-layout">
        <nav className="section-index" aria-label="Settings sections">
          <a href="#library">Library</a>
          <a href="#audio">Audio quality</a>
          <a href="#queue">Queue & retries</a>
          <a href="#sources">Sources</a>
        </nav>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          {!settings.data && !settings.isError && <p role="status">Loading settings…</p>}
          {['library', 'audio', 'queue'].map((section) => (
            <section id={section} className="settings-section" key={section}>
              <h2>
                {section === 'library'
                  ? 'Your library'
                  : section === 'audio'
                    ? 'Audio quality'
                    : 'Queue & retries'}
              </h2>
              {controls
                .filter((control) => control.section === section)
                .map(({ key, label, help, min, max }) => {
                  const setting = settings.data?.[key]
                  if (!setting) return null
                  const value = draft[key] ?? setting.value
                  return (
                    <div className="setting-row" key={key}>
                      <div>
                        <label htmlFor={key}>{label}</label>
                        <p>{help}</p>
                        {setting.locked && (
                          <small className="locked">
                            <LockKeyhole size={12} />
                            Locked by {setting.origin}
                          </small>
                        )}
                      </div>
                      <div>
                        {key === 'destination' || key === 'navidrome_mode' ? (
                          <FieldSelect
                            id={key}
                            value={value}
                            disabled={setting.locked || save.isPending}
                            onChange={(e) => {
                              if (!(key in draft)) {
                                setOriginalValues({ ...originalValues, [key]: setting.value })
                              }
                              setDraft({ ...draft, [key]: e.target.value })
                              setSaved(false)
                            }}
                          >
                            {key === 'destination'
                              ? diagnostics.data?.disks.slice(1).map((disk) => (
                                  <option
                                    key={disk.path}
                                    value={disk.path}
                                    disabled={!disk.writable}
                                  >
                                    {disk.path}
                                    {disk.writable ? '' : ' (read-only)'}
                                  </option>
                                ))
                              : ['off', 'watcher', 'api'].map((mode) => (
                                  <option key={mode} value={mode}>
                                    {mode}
                                  </option>
                                ))}
                          </FieldSelect>
                        ) : key === 'output_format' ? (
                          <FieldSelect
                            id={key}
                            value={value}
                            disabled={setting.locked || save.isPending}
                            onChange={(e) => {
                              if (!(key in draft)) {
                                setOriginalValues({ ...originalValues, [key]: setting.value })
                              }
                              setDraft({ ...draft, [key]: e.target.value })
                              setSaved(false)
                            }}
                          >
                            <option value="original">Original · no re-encoding</option>
                            <option value="m4a">M4A / AAC</option>
                            <option value="opus">Opus</option>
                            <option value="mp3">MP3 · lossy conversion</option>
                          </FieldSelect>
                        ) : (
                          <Field
                            id={key}
                            type={min === undefined ? 'text' : 'number'}
                            min={min}
                            max={max}
                            maxLength={min === undefined ? 400 : undefined}
                            required={key !== 'navidrome_url'}
                            disabled={setting.locked || save.isPending}
                            value={value}
                            onChange={(e) => {
                              if (!(key in draft)) {
                                setOriginalValues({ ...originalValues, [key]: setting.value })
                              }
                              setDraft({
                                ...draft,
                                [key]: min === undefined ? e.target.value : Number(e.target.value),
                              })
                              setSaved(false)
                            }}
                          />
                        )}
                        {conflicts[key] !== undefined && (
                          <small className="conflict">
                            Changed elsewhere to {String(conflicts[key])}
                          </small>
                        )}
                      </div>
                    </div>
                  )
                })}
              {section === 'library' && (
                <NamingPreview
                  template={String(
                    draft.naming_template ?? settings.data?.naming_template.value ?? '',
                  )}
                />
              )}
              {section === 'library' && <LibraryPanel />}
              {section === 'library' && (
                <div className="note">
                  <Folder size={17} />
                  <div>
                    Mounted folders
                    {diagnostics.data?.disks.slice(1).map((disk) => (
                      <code key={disk.path}>
                        {disk.path} · {disk.exists ? 'available' : 'missing'}
                      </code>
                    ))}
                    <small>Mount additional folders in Compose before choosing them here.</small>
                  </div>
                </div>
              )}
            </section>
          ))}
          <section id="sources" className="settings-section">
            <h2>Sources</h2>
            <div className="source-summary">
              <span className="source-logo">d.</span>
              <div>
                <h3>Deezer</h3>
                <p>Default catalog. No key required.</p>
              </div>
              <Link
                to="/diagnostics"
                data-ui="text-link"
                className={textLinkClassName('ml-auto max-phone:text-tiny')}
              >
                Test connection
                <ArrowRight size={15} />
              </Link>
            </div>
            <p className="muted small">
              YouTube supplies audio through yt-dlp. Original preserves source quality. Paid sources
              are not enabled.
            </p>
          </section>
          {/* `save-bar` is the hook `e2e/phone.spec.ts` measures against the bottom bar. The
              offset keeps it clear of the player, and on a phone the bar and home indicator. */}
          <div className="save-bar sticky bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+8px)] z-sticky flex items-center justify-between gap-[15px] rounded-[7px] border border-good-line bg-good-bg px-[17px] py-[13px] max-phone:p-[12px]">
            <span className="text-small" role="status">
              {save.isError
                ? save.error.message
                : saved
                  ? 'Saved. You can safely refresh.'
                  : Object.keys(draft).length
                    ? 'You have unsaved changes.'
                    : 'Settings are up to date.'}
            </span>
            <Button
              variant="primary"
              type="submit"
              className="max-phone:whitespace-nowrap"
              disabled={!Object.keys(draft).length || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
              {saved ? <Check size={16} /> : <ArrowRight size={16} />}
            </Button>
          </div>
        </form>
      </div>
      <RecentActivity />
    </>
  )
}

// A finished scan is a healthy state; only an interrupted, failed or cancelled one needs a
// person to look at it.
const scanIsReady = (status: string) => ['idle', 'scanning', 'done'].includes(status)

function DiagnosticsPage() {
  const client = useQueryClient()
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
  })
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const probe = useMutation({
    mutationFn: (sourceName: string) =>
      api(`diagnostics/test/${sourceName}`, sourceSchema, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['diagnostics'] }),
  })
  const testDestination = useMutation({
    mutationFn: () =>
      api('diagnostics/test/destination', destinationTestSchema, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['diagnostics'] }),
  })
  const data = diagnostics.data
  const gb = (bytes: number | null) =>
    bytes === null ? 'Unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`
  useEffect(() => {
    if (diagnostics.isSuccess && window.location.hash) {
      const sectionId = window.location.hash.slice(1)
      const section = document.getElementById(sectionId)
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }, [diagnostics.isSuccess])

  return (
    <>
      <PageTitle eyebrow="KNOW WHAT IS HAPPENING" title="Diagnostics">
        <div className="button-row">
          <Button onClick={() => void diagnostics.refetch()} disabled={diagnostics.isFetching}>
            <RefreshCw size={15} className={diagnostics.isFetching ? 'spin' : ''} />
            Refresh
          </Button>
          <a data-ui="button" className={buttonClassName()} href="/api/diagnostics/export" download>
            <ArrowDownToLine size={15} />
            Export
          </a>
        </div>
      </PageTitle>
      {diagnostics.isError && <ErrorBanner role="alert">{diagnostics.error.message}</ErrorBanner>}
      {!data && !diagnostics.isError && <p role="status">Checking your container…</p>}
      {data && (
        <>
          {(() => {
            const rootsReady = data.library.roots.every((root: string) => {
              const disk = data.disks.find((d) => d.path === root)
              return disk?.exists && disk?.writable && disk?.free_bytes !== null
            })
            const scanReady = scanIsReady(data.library.status)
            const navidromeReady = data.navidrome ? data.navidrome.available : null
            const youtubeReady =
              data.sources.find((s) => s.source === 'youtube')?.status === 'healthy'
            const lastDownloadOk = !data.last_download || data.last_download.stage === 'done'
            const overallReady =
              rootsReady && scanReady && navidromeReady !== false && youtubeReady && lastDownloadOk

            return (
              <div className="health-strip">
                <span className="health-icon">
                  {overallReady ? <Check size={24} /> : <AlertCircle size={24} />}
                </span>
                <div>
                  <h2>Ready to download?</h2>
                  <p>{overallReady ? 'All systems ready.' : 'Some components need attention.'}</p>
                </div>
                <Tag className="ml-auto max-phone:hidden">v{data.health.version}</Tag>
              </div>
            )
          })()}
          <Panel className="readiness-panel">
            <div className="section-heading">
              <h2>System readiness</h2>
            </div>
            <div className="readiness-items">
              {data.library.roots.map((root: string) => {
                const disk = data.disks.find((d) => d.path === root)
                const ready = disk?.exists && disk?.writable && disk?.free_bytes !== null
                return (
                  <div key={root} className="readiness-item">
                    <span className={`readiness-badge ${ready ? 'ready' : 'not-ready'}`}>
                      {ready ? <Check size={14} /> : <X size={14} />}
                      {ready ? 'Ready' : 'Not ready'}
                    </span>
                    <div>
                      <strong>Library root</strong>
                      <code>{root}</code>
                      <small>
                        {disk?.exists
                          ? disk?.writable
                            ? `${gb(disk.free_bytes)} free`
                            : 'Not writable'
                          : 'Not mounted'}
                      </small>
                    </div>
                  </div>
                )
              })}
              {settings.data &&
                (() => {
                  const destPath = String(settings.data.destination.value)
                  const disk = data.disks.find((d) => d.path === destPath)
                  const ready = disk?.exists && disk?.writable
                  return (
                    <div className="readiness-item">
                      <span className={`readiness-badge ${ready ? 'ready' : 'not-ready'}`}>
                        {ready ? <Check size={14} /> : <X size={14} />}
                        {ready ? 'Ready' : 'Not ready'}
                      </span>
                      <div>
                        <strong>Download destination</strong>
                        <code>{destPath}</code>
                        <small>
                          {disk?.exists
                            ? disk?.writable
                              ? `${gb(disk.free_bytes)} free`
                              : 'Not writable'
                            : 'Not mounted'}
                        </small>
                      </div>
                      {ready && (
                        <Button
                          onClick={() => testDestination.mutate()}
                          disabled={testDestination.isPending}
                        >
                          {testDestination.isPending ? 'Testing…' : 'Test write'}
                        </Button>
                      )}
                    </div>
                  )
                })()}
              {testDestination.data && (
                <div
                  className={`readiness-feedback ${testDestination.data.success ? 'success' : 'error'}`}
                >
                  {testDestination.data.success
                    ? `Write test succeeded (${testDestination.data.elapsed_ms} ms)`
                    : `Write test failed: ${testDestination.data.error}`}
                </div>
              )}
              <div className="readiness-item">
                <span
                  className={`readiness-badge ${scanIsReady(data.library.status) ? 'ready' : 'not-ready'}`}
                >
                  {scanIsReady(data.library.status) ? <Check size={14} /> : <X size={14} />}
                  {scanIsReady(data.library.status) ? 'Ready' : 'Not ready'}
                </span>
                <div>
                  <strong>Library scan</strong>
                  <p>
                    {data.library.status === 'idle'
                      ? `${data.library.total_files} files indexed`
                      : data.library.status === 'scanning'
                        ? `Scanning (${data.library.indexed} files)`
                        : data.library.detail}
                  </p>
                </div>
              </div>
              {data.navidrome && settings.data && (
                <div className="readiness-item">
                  <span
                    className={`readiness-badge ${data.navidrome.available ? 'ready' : data.navidrome.configured ? 'not-ready' : 'not-tested'}`}
                  >
                    {data.navidrome.available ? (
                      <>
                        <Check size={14} />
                        Ready
                      </>
                    ) : data.navidrome.configured ? (
                      <>
                        <X size={14} />
                        Not ready
                      </>
                    ) : (
                      <>
                        <Minus size={14} />
                        Not configured
                      </>
                    )}
                  </span>
                  <div>
                    <strong>Navidrome</strong>
                    <p>
                      {data.navidrome.available
                        ? `${data.navidrome.version} · ${String(settings.data.navidrome_mode.value)} mode`
                        : data.navidrome.detail}
                    </p>
                  </div>
                </div>
              )}
              {data.sources
                .filter((s) => s.source === 'youtube')
                .map((source) => (
                  <div key={source.source} className="readiness-item">
                    <span
                      className={`readiness-badge ${source.status === 'healthy' ? 'ready' : 'not-ready'}`}
                    >
                      {source.status === 'healthy' ? <Check size={14} /> : <X size={14} />}
                      {source.status === 'healthy' ? 'Ready' : 'Not ready'}
                    </span>
                    <div>
                      <strong>YouTube download helper</strong>
                      <p>
                        {source.detail}
                        {data.queue.source_paused && ' · Paused'}
                      </p>
                    </div>
                  </div>
                ))}
              {data.last_download && (
                <div className="readiness-item">
                  <span
                    className={`readiness-badge ${data.last_download.stage === 'done' ? 'ready' : 'not-ready'}`}
                  >
                    {data.last_download.stage === 'done' ? <Check size={14} /> : <X size={14} />}
                    {data.last_download.stage === 'done' ? 'Success' : 'Failed'}
                  </span>
                  <div>
                    <strong>Last download</strong>
                    <p>
                      {data.last_download.stage === 'done'
                        ? 'Completed successfully'
                        : data.last_download.stage === 'failed'
                          ? `Failed${data.last_download.error_code ? `: ${data.last_download.error_code}` : ''}`
                          : `Cancelled`}
                      {' · '}
                      {new Date(data.last_download.created_at * 1000).toLocaleString()}
                    </p>
                  </div>
                </div>
              )}
              {!data.last_download && (
                <div className="readiness-item">
                  <span className="readiness-badge not-tested">
                    <Minus size={14} />
                    Not tested
                  </span>
                  <div>
                    <strong>Last download</strong>
                    <p>No download attempted yet</p>
                  </div>
                </div>
              )}
            </div>
          </Panel>
          <div className="diagnostic-grid" id="sources">
            {data.sources.map((source) => (
              <Panel key={source.source}>
                <div className="section-heading">
                  <h2>{source.source === 'deezer' ? 'Catalog connection' : 'Download source'}</h2>
                  <StatusChip variant={source.status === 'healthy' ? 'good' : 'default'}>
                    {source.status}
                  </StatusChip>
                </div>
                <div className="source-summary">
                  <span className="source-logo">
                    {source.source === 'deezer' ? 'd.' : source.source.charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <h3>{source.source.charAt(0).toUpperCase() + source.source.slice(1)}</h3>
                    <p>{source.detail}</p>
                  </div>
                </div>
                <div className="probe-bottom">
                  <span>
                    {source.latency_ms !== null
                      ? `${source.latency_ms} ms · ${new Date(source.checked_at).toLocaleTimeString()}`
                      : 'Not tested recently'}
                  </span>
                  {source.source === 'deezer' && (
                    <Button onClick={() => probe.mutate(source.source)} disabled={probe.isPending}>
                      {probe.isPending ? 'Testing…' : 'Test now'}
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </div>
                {probe.isError && <ErrorBanner role="alert">{probe.error.message}</ErrorBanner>}
              </Panel>
            ))}
            <Panel id="disk">
              <div className="section-heading">
                <h2>Persistent storage</h2>
                <Folder size={18} />
              </div>
              {data.disks.map((disk) => (
                <div className="disk" key={disk.path}>
                  <div>
                    <code>{disk.path}</code>
                    <span>{disk.exists ? `${gb(disk.free_bytes)} free` : 'Not mounted'}</span>
                  </div>
                  <meter
                    aria-label={`Free space in ${disk.path}`}
                    min={0}
                    max={disk.total_bytes ?? 1}
                    value={disk.free_bytes ?? 0}
                  />
                  <small>
                    {disk.writable ? 'Write permission available' : 'Not writable'} · permission
                    check only
                  </small>
                </div>
              ))}
            </Panel>
          </div>
          <section className="versions-section">
            <div className="section-heading">
              <h2>Under the hood</h2>
              <span>INSTALLED IN THIS CONTAINER</span>
            </div>
            <dl className="versions">
              {Object.entries(data.versions).map(([name, version]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{version}</dd>
                </div>
              ))}
              <div>
                <dt>SQLite</dt>
                <dd>WAL · schema {data.database.schema}</dd>
              </div>
            </dl>
          </section>
          <RecentActivity />
        </>
      )}
    </>
  )
}

const rootRoute = createRootRoute({
  component: () => (
    <PlayerProvider>
      <PopoutProvider>
        <Shell />
      </PopoutProvider>
    </PlayerProvider>
  ),
  notFoundComponent: () => (
    <EmptyPanel>
      <h1>Page not found</h1>
      <Link to="/search">Back to Musimo</Link>
    </EmptyPanel>
  ),
})
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SearchPage,
})
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch,
  component: SearchPage,
})
const albumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/albums/$albumId',
  validateSearch: (search: Record<string, unknown>): { track?: number } => ({
    track:
      Number.isSafeInteger(Number(search.track)) && Number(search.track) > 0
        ? Number(search.track)
        : undefined,
  }),
  component: AlbumPage,
})
const artistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artists/$artistId',
  validateSearch: validateArtistSearch,
  component: ArtistPage,
})
const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/downloads',
  component: DownloadsPage,
})

function LibraryScreen({
  view,
  albumId,
  artistId,
  playlistId,
  parentArtistId,
  artistSection,
}: {
  view?: 'home' | 'albums' | 'artists' | 'tracks' | 'playlists'
  albumId?: string
  artistId?: string
  playlistId?: string
  parentArtistId?: string
  artistSection?: 'albums' | 'songs'
}) {
  return (
    <Suspense fallback={<p role="status">Opening your library…</p>}>
      <LibraryPage
        view={view}
        albumId={albumId}
        artistId={artistId}
        playlistId={playlistId}
        parentArtistId={parentArtistId}
        artistSection={artistSection}
      />
    </Suspense>
  )
}

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: () => <LibraryScreen />,
})
const libraryAlbumsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/albums',
  component: () => <LibraryScreen view="albums" />,
})
const libraryAlbumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/albums/$albumId',
  component: function LibraryAlbumRoute() {
    const { albumId } = useParams({ from: '/library/albums/$albumId' })
    return <LibraryScreen view="albums" albumId={albumId} />
  },
})
const libraryArtistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists',
  component: () => <LibraryScreen view="artists" />,
})
const libraryArtistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId',
  component: function LibraryArtistRoute() {
    const { artistId } = useParams({ from: '/library/artists/$artistId' })
    return <LibraryScreen view="artists" artistId={artistId} />
  },
})
const libraryArtistSongsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId/songs',
  component: function LibraryArtistSongsRoute() {
    const { artistId } = useParams({ from: '/library/artists/$artistId/songs' })
    return <LibraryScreen view="artists" artistId={artistId} artistSection="songs" />
  },
})
const libraryArtistAlbumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/artists/$artistId/albums/$albumId',
  component: function LibraryArtistAlbumRoute() {
    const { albumId, artistId } = useParams({
      from: '/library/artists/$artistId/albums/$albumId',
    })
    return <LibraryScreen view="artists" albumId={albumId} parentArtistId={artistId} />
  },
})
const libraryTracksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/tracks',
  component: () => <LibraryScreen view="tracks" />,
})
const libraryPlaylistsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/playlists',
  component: () => <LibraryScreen view="playlists" />,
})
const libraryPlaylistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/playlists/$playlistId',
  component: function LibraryPlaylistRoute() {
    const { playlistId } = useParams({ from: '/library/playlists/$playlistId' })
    return <LibraryScreen view="playlists" playlistId={playlistId} />
  },
})
const nowPlayingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/now-playing',
  component: () => (
    <Suspense fallback={<p role="status">Opening the player…</p>}>
      <NowPlayingPage />
    </Suspense>
  ),
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})
const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: DiagnosticsPage,
})
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    searchRoute,
    albumRoute,
    artistRoute,
    libraryRoute,
    libraryAlbumsRoute,
    libraryAlbumRoute,
    libraryArtistsRoute,
    libraryArtistRoute,
    libraryArtistSongsRoute,
    libraryArtistAlbumRoute,
    libraryTracksRoute,
    libraryPlaylistsRoute,
    libraryPlaylistRoute,
    nowPlayingRoute,
    downloadsRoute,
    settingsRoute,
    diagnosticsRoute,
  ]),
  defaultPreload: 'intent',
})
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing application root')
// Before the first render, so the tree never paints against the wrong palette. The boot script in
// <head> has already put a saved theme on <html>; this is what takes ownership of it.
startTheme()
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
