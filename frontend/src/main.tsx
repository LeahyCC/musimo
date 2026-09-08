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
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Coffee,
  Folder,
  Heart,
  Library,
  LockKeyhole,
  Radio,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
} from 'lucide-react'

import { api, diagnosticsSchema, settingsSchema, snapshotSchema, sourceSchema } from './api'
import type { SettingKey } from './api'
import { librarySchema } from './api'
import { namingSchema } from './api'
import { controlsSchema, jobSchema } from './api'
import type { DownloadJob } from './api'
import { DownloadsPage, QueueDock, updateJob } from './downloads'
import { LibraryPanel } from './library-panel'
import { CommandPalette } from './palette'
import { PlayerProvider } from './player'
import { RecentActivity } from './recent-activity'
import { AlbumPage, ArtistPage, SearchPage, validateSearch } from './search'

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
        client.setQueryData(['jobs'], { jobs: snapshot.jobs, controls: snapshot.controls })
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
              client.setQueryData(['jobs'], (old: { jobs: DownloadJob[] } | undefined) => ({
                jobs: old?.jobs ?? [],
                controls: parsed.data,
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
    <div className="app">
      <CommandPalette />
      <QueueDock />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/search" className="brand">
          musimo<span className="brand-dot">.</span>
        </Link>
        <div className="nav-caption">YOUR MUSIC, AT HOME</div>
        <nav aria-label="Main navigation">
          {navItems.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="nav-link"
              activeProps={{
                'className': 'nav-link active',
                'aria-current': 'page',
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {to === '/search' && <kbd>/</kbd>}
            </Link>
          ))}
        </nav>
        <footer className="sidebar-bottom">
          <div className="sidebar-note">
            <Radio size={18} />
            <div>
              Made for your library<small>Self-hosted music</small>
            </div>
          </div>
          <div className="sidebar-actions">
            <a
              href="https://www.musicares.org/donations/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Heart size={14} fill="#ef4444" stroke="#ef4444" />
              Donate
            </a>
            <a href="https://ko-fi.com/colinleahy" target="_blank" rel="noopener noreferrer">
              <Coffee size={14} />
              Buy me a coffee
            </a>
            <a href="https://github.com/LeahyCC/musimo" target="_blank" rel="noopener noreferrer">
              <Star size={14} />
              Star on GitHub
            </a>
          </div>
        </footer>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <form
            className="search-input"
            onSubmit={(e) => {
              e.preventDefault()
              clearTimeout(debounce.current)
              void navigate({ to: '/search', search: { q: text } })
            }}
          >
            <Search size={20} />
            <input
              ref={input}
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
            <kbd>/</kbd>
          </form>
          <span className={`connection ${status === 'Live' ? 'online' : ''}`} role="status">
            <i />
            {status}
          </span>
        </header>
        {status !== 'Live' && (
          <div className="connection-banner" role="status">
            {status === 'Offline'
              ? 'Cannot reach Musimo. Reconnecting automatically.'
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
  const [saved, setSaved] = useState(false)
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
      setSaved(true)
    },
  })
  return (
    <>
      <PageTitle eyebrow="SET IT UP YOUR WAY" title="Settings">
        <span className="tag">SAVED IN YOUR DATABASE</span>
      </PageTitle>
      <p className="page-intro">
        Preferences save without a restart. Download defaults apply to newly queued tracks.
      </p>
      {settings.isError && (
        <div className="error" role="alert">
          {settings.error.message}
          <button onClick={() => void settings.refetch()}>Retry</button>
        </div>
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
                          <select
                            id={key}
                            value={value}
                            disabled={setting.locked || save.isPending}
                            onChange={(e) => {
                              setDraft({ ...draft, [key]: e.target.value })
                              setSaved(false)
                            }}
                          >
                            {key === 'destination'
                              ? diagnostics.data?.disks.slice(1).map((disk) => (
                                  <option key={disk.path} value={disk.path}>
                                    {disk.path}
                                    {disk.writable ? '' : ' (read-only)'}
                                  </option>
                                ))
                              : ['off', 'watcher', 'api'].map((mode) => (
                                  <option key={mode} value={mode}>
                                    {mode}
                                  </option>
                                ))}
                          </select>
                        ) : key === 'output_format' ? (
                          <select
                            id={key}
                            value={value}
                            disabled={setting.locked || save.isPending}
                            onChange={(e) => {
                              setDraft({ ...draft, [key]: e.target.value })
                              setSaved(false)
                            }}
                          >
                            <option value="original">Original · no re-encoding</option>
                            <option value="m4a">M4A / AAC</option>
                            <option value="opus">Opus</option>
                            <option value="mp3">MP3 · lossy conversion</option>
                          </select>
                        ) : (
                          <input
                            id={key}
                            type={min === undefined ? 'text' : 'number'}
                            min={min}
                            max={max}
                            maxLength={min === undefined ? 400 : undefined}
                            required={key !== 'navidrome_url'}
                            disabled={setting.locked || save.isPending}
                            value={value}
                            onChange={(e) => {
                              setDraft({
                                ...draft,
                                [key]: min === undefined ? e.target.value : Number(e.target.value),
                              })
                              setSaved(false)
                            }}
                          />
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
              <Link to="/diagnostics" className="text-link">
                Test connection
                <ArrowRight size={15} />
              </Link>
            </div>
            <p className="muted small">
              YouTube supplies audio through yt-dlp. Original preserves source quality. Paid sources
              are not enabled.
            </p>
          </section>
          <div className="save-bar">
            <span role="status">
              {save.isError
                ? save.error.message
                : saved
                  ? 'Saved. You can safely refresh.'
                  : Object.keys(draft).length
                    ? 'You have unsaved changes.'
                    : 'Settings are up to date.'}
            </span>
            <button
              className="button primary"
              type="submit"
              disabled={!Object.keys(draft).length || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
              {saved ? <Check size={16} /> : <ArrowRight size={16} />}
            </button>
          </div>
        </form>
      </div>
      <RecentActivity />
    </>
  )
}

function DiagnosticsPage() {
  const client = useQueryClient()
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
  })
  const probe = useMutation({
    mutationFn: () => api('diagnostics/test/deezer', sourceSchema, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['diagnostics'] }),
  })
  const data = diagnostics.data
  const source = data?.sources.find((s) => s.source === 'deezer')
  const gb = (bytes: number | null) =>
    bytes === null ? 'Unknown' : `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return (
    <>
      <PageTitle eyebrow="KNOW WHAT IS HAPPENING" title="Diagnostics">
        <div className="button-row">
          <button
            className="button"
            onClick={() => void diagnostics.refetch()}
            disabled={diagnostics.isFetching}
          >
            <RefreshCw size={15} className={diagnostics.isFetching ? 'spin' : ''} />
            Refresh
          </button>
          <a className="button" href="/api/diagnostics/export" download>
            <ArrowDownToLine size={15} />
            Export
          </a>
        </div>
      </PageTitle>
      {diagnostics.isError && (
        <div className="error" role="alert">
          {diagnostics.error.message}
        </div>
      )}
      {!data && !diagnostics.isError && <p role="status">Checking your container…</p>}
      {data && (
        <>
          <div className="health-strip">
            <span className="health-icon">
              <Check size={24} />
            </span>
            <div>
              <h2>Musimo is ready.</h2>
              <p>The application and database are responding.</p>
            </div>
            <span className="tag">v{data.health.version}</span>
          </div>
          <div className="diagnostic-grid">
            <section className="panel">
              <div className="section-heading">
                <h2>Catalog connection</h2>
                <span className={`status-chip ${source?.status === 'healthy' ? 'good' : ''}`}>
                  {source?.status ?? 'Not tested'}
                </span>
              </div>
              <div className="source-summary">
                <span className="source-logo">d.</span>
                <div>
                  <h3>Deezer</h3>
                  <p>{source?.detail ?? 'Run a live request to the keyless catalog.'}</p>
                </div>
              </div>
              <div className="probe-bottom">
                <span>
                  {source?.latency_ms !== null && source?.latency_ms !== undefined
                    ? `${source.latency_ms} ms · ${new Date(source.checked_at).toLocaleTimeString()}`
                    : 'No credentials needed'}
                </span>
                <button
                  className="button"
                  onClick={() => probe.mutate()}
                  disabled={probe.isPending}
                >
                  {probe.isPending ? 'Testing…' : 'Test now'}
                  <ArrowRight size={14} />
                </button>
              </div>
              {probe.isError && (
                <p className="error" role="alert">
                  {probe.error.message}
                </p>
              )}
            </section>
            <section className="panel">
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
            </section>
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
      <Shell />
    </PlayerProvider>
  ),
  notFoundComponent: () => (
    <section className="empty-panel">
      <h1>Page not found</h1>
      <Link to="/search">Back to Musimo</Link>
    </section>
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
  component: ArtistPage,
})
const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/downloads',
  component: DownloadsPage,
})
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: () => (
    <Suspense fallback={<p role="status">Opening your library…</p>}>
      <LibraryPage />
    </Suspense>
  ),
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
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
