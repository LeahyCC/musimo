import { useDeferredValue, useEffect, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useBlocker } from '@tanstack/react-router'
import { AlertCircle, ArrowRight, Check, Folder, LockKeyhole } from 'lucide-react'

import {
  api,
  botModelsSchema,
  diagnosticsSchema,
  namingSchema,
  settingsSchema,
  youtubeCookiesSchema,
} from '../../api'
import type { SettingKey, Settings } from '../../api'
import { PageTitle } from '../../components/page-title'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, Field, FieldSelect, Tag } from '../../ui'
import { systemIsReady } from '../diagnostics/readiness'
import { RecentActivity } from '../diagnostics/recent-activity'
import { orderTrouble, sourceProblems } from '../diagnostics/source-status'
import { pausedSources } from '../downloads/download-target'
import { LibraryPanel } from './library-panel'
import { cleanArl, settingsPatch, withYoutubeCookies } from './settings-patch'
import { CatalogOrder, SourceRow } from './source-controls'
import { SettingsSwitch } from './user-settings'

const sectionIndexLinkClassName =
  'hover:text-accent coarse:inline-flex coarse:min-h-11 coarse:items-center'
const settingsSectionClassName = 'scroll-mt-[115px] mb-[31px]'
const settingsSectionHeadingClassName = 'border-b border-line pb-[17px] text-section'

const controls: {
  key: SettingKey
  label: string
  help: string
  min?: number
  max?: number
  section: string
  /** The field may be saved empty. */
  optional?: boolean
}[] = [
  {
    key: 'ollama_url',
    label: 'Ollama server address',
    help: 'Address reachable from the Musimo server, for example http://127.0.0.1:11434.',
    section: 'music-bot',
  },
  {
    key: 'music_timezone',
    label: 'Music time zone',
    help: 'Used for played today. For example Pacific/Honolulu or Europe/London.',
    section: 'music-bot',
  },
  {
    key: 'audio_scalar_recipe',
    label: 'Tempo and energy recipe',
    help: 'Empty means audio analysis is off and the bot answers from tags alone. After the listening check, the analysis recipe id goes here.',
    section: 'music-bot',
    optional: true,
  },
  {
    key: 'audio_embedding_recipe',
    label: 'Sound similarity recipe',
    help: 'Empty means audio analysis is off. No sound similarity recipe has passed its listening check yet.',
    section: 'music-bot',
    optional: true,
  },
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
  {
    key: 'pace_tracks',
    label: 'Tracks before a pause',
    help: 'How many tracks to finish, then wait. A failed track does not count. 0 keeps going.',
    min: 0,
    max: 500,
    section: 'queue',
  },
  {
    key: 'pace_minutes',
    label: 'Minutes to wait',
    help: 'How long to wait after those tracks finish, before the next ones. 0 on either number keeps going.',
    min: 0,
    max: 1440,
    section: 'queue',
  },
]

/** A settings value as the form holds it: text, a number, a switch, or a list of turned-off sources. */
type SettingValue = string | number | boolean | string[]

/** One value as a person reads it, so a switch reads on or off rather than true or false. */
function settingText(value: SettingValue | undefined): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)
}

function sameSetting(left: SettingValue | undefined, right: SettingValue | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return JSON.stringify(left) === JSON.stringify(right)
  return left === right
}

function NamingPreview({ template }: { template: string }) {
  const value = useDeferredValue(template)
  const result = useQuery({
    queryKey: ['naming-preview', value],
    queryFn: ({ signal }) =>
      api(`naming-preview?template=${encodeURIComponent(value)}`, namingSchema, { signal }),
    retry: false,
  })
  return (
    <p className="text-small [overflow-wrap:anywhere]">
      {result.isError ? (
        result.error.message
      ) : (
        <code>{result.data?.path ?? 'Checking template…'}</code>
      )}
    </p>
  )
}

export function SettingsPage() {
  const connection = useMutation({ mutationFn: () => api('music-bot/models', botModelsSchema) })
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
  })
  const [draft, setDraft] = useState<Partial<Record<SettingKey, SettingValue>>>({})
  const [originalValues, setOriginalValues] = useState<Partial<Record<SettingKey, SettingValue>>>(
    {},
  )
  const [conflicts, setConflicts] = useState<Partial<Record<SettingKey, SettingValue>>>({})
  const [saved, setSaved] = useState(false)
  const [cookieText, setCookieText] = useState('')
  const [removeCookies, setRemoveCookies] = useState(false)
  const [removeArl, setRemoveArl] = useState(false)
  const cookieSaved = settings.data?.youtube_cookies.value === true
  const cookiePending = cookieText.trim().length > 0 || removeCookies
  const arlSaved = settings.data?.deezer_cookie.value === true
  const typedArl = typeof draft.deezer_arl === 'string' ? cleanArl(draft.deezer_arl) : ''
  // What the source list should assume once this page is saved.
  const arlAfterSave = typedArl !== '' || (arlSaved && !removeArl)
  const problems = sourceProblems(
    diagnostics.data?.sources ?? [],
    pausedSources(diagnostics.data?.queue),
    diagnostics.data?.download_sources ?? [],
  )
  const problemFor = (id: string) => problems.find((problem) => problem.id === id)

  const isDirty = Object.keys(draft).length > 0 || cookiePending || removeArl

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
    const newConflicts: Partial<Record<SettingKey, SettingValue>> = {}
    for (const key of Object.keys(draft) as SettingKey[]) {
      const original = originalValues[key]
      const current = settings.data[key]?.value
      if (
        original !== undefined &&
        !sameSetting(current, original) &&
        !sameSetting(current, draft[key])
      ) {
        newConflicts[key] = current
      }
    }
    setConflicts(newConflicts)
    if (Object.keys(newConflicts).length > 0) {
      setSaved(false)
    }
  }, [settings.data, draft, originalValues])

  function edit(key: SettingKey, value: SettingValue) {
    const current = settings.data?.[key]?.value
    if (!(key in draft)) {
      setOriginalValues({ ...originalValues, [key]: current })
    }
    setDraft({ ...draft, [key]: value })
    setSaved(false)
  }

  /** Drop one key from the draft, so saving leaves that setting as it is. */
  function unedit(key: SettingKey) {
    const { [key]: _dropped, ...rest } = draft
    setDraft(rest)
  }

  const save = useMutation({
    mutationFn: async () => {
      let cookies: { saved: boolean } | undefined
      if (removeCookies && cookieText.trim().length === 0) {
        cookies = await api('youtube-cookies', youtubeCookiesSchema, { method: 'DELETE' })
      } else if (cookieText.trim()) {
        cookies = await api('youtube-cookies', youtubeCookiesSchema, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cookieText }),
        })
      }

      // The cookie file has changed whatever the settings save below does, so the page says so
      // now rather than still offering to save or remove it.
      if (cookies) {
        const saved = cookies.saved
        client.setQueryData<Settings>(['settings'], (old) => old && withYoutubeCookies(old, saved))
        setCookieText('')
        setRemoveCookies(false)
      }

      const changes = settingsPatch(draft, removeArl)
      if (Object.keys(changes).length === 0) {
        return api('settings', settingsSchema)
      }
      return api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
    },
    onSuccess: (data) => {
      client.setQueryData(['settings'], data)
      setDraft({})
      setOriginalValues({})
      setConflicts({})
      setCookieText('')
      setRemoveCookies(false)
      setRemoveArl(false)
      setSaved(true)
    },
    // A failed save may still have changed something on the server, so read back what is there.
    onError: () => client.invalidateQueries({ queryKey: ['settings'] }),
  })
  // The confirmation is for the moment after a save. Left up, the bar would be back to saying
  // nothing while still taking room at the foot of the page.
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 6000)
    return () => clearTimeout(timer)
  }, [saved])

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
      <SettingsSwitch />
      <p className="-mt-[8px] mb-[32px] max-w-[650px] text-lead">
        Preferences save without a restart. Download defaults apply to newly queued tracks.
      </p>
      {/* Until diagnostics answer, the banner's own markup holds its place unseen, with the longer
          of its two messages so the space is right at every width. */}
      {!diagnostics.data && (
        <div
          className="invisible my-[16px] flex items-center gap-[10px] rounded-md border px-[16px] py-[12px] text-small"
          aria-hidden="true"
        >
          <AlertCircle size={16} />
          Some components need attention.
          <span className="ml-auto underline coarse:inline-flex coarse:min-h-11 coarse:items-center">
            View diagnostics
          </span>
        </div>
      )}
      {diagnostics.data &&
        (() => {
          const overallReady = systemIsReady(diagnostics.data)

          return (
            <div
              className={cx(
                'my-[16px] flex items-center gap-[10px] rounded-md px-[16px] py-[12px] text-small',
                overallReady
                  ? 'border border-good-line bg-good-bg text-good'
                  : 'border border-danger-line bg-danger-bg text-danger',
              )}
            >
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
              <Link
                to="/diagnostics"
                className="ml-auto underline coarse:inline-flex coarse:min-h-11 coarse:items-center"
              >
                View diagnostics
              </Link>
            </div>
          )
        })()}
      {/* The banner shows on any failure, but the form stays as long as there is data behind it:
          a refetch that fails after a live update must not take a person's draft off the screen. */}
      {settings.isError && (
        <ErrorBanner role="alert">
          {settings.error.message}
          <button onClick={() => void settings.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {!settings.data ? (
        !settings.isError && <p role="status">Loading settings…</p>
      ) : (
        <div className="grid grid-cols-[145px_1fr] gap-[30px] max-tablet:grid-cols-1 max-phone:gap-[26px]">
          <nav
            className="sticky top-[119px] flex flex-col gap-[19px] self-start border-l border-line-strong px-[17px] text-small text-muted max-tablet:static max-tablet:flex-row max-phone:gap-[18px] max-phone:px-[12px] max-phone:text-tiny"
            aria-label="Settings sections"
          >
            <a href="#library" className={sectionIndexLinkClassName}>
              Library
            </a>
            <a href="#audio" className={sectionIndexLinkClassName}>
              Audio quality
            </a>
            <a href="#queue" className={sectionIndexLinkClassName}>
              Queue & retries
            </a>
            <a href="#sources" className={sectionIndexLinkClassName}>
              Sources
            </a>
          </nav>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            {['library', 'audio', 'queue', 'music-bot'].map((section) => (
              <section id={section} className={settingsSectionClassName} key={section}>
                <h2 className={settingsSectionHeadingClassName}>
                  {section === 'library'
                    ? 'Your library'
                    : section === 'audio'
                      ? 'Audio quality'
                      : section === 'music-bot'
                        ? 'Music bot'
                        : 'Queue & retries'}
                </h2>
                {section === 'music-bot' && (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      disabled={connection.isPending || 'ollama_url' in draft}
                      onClick={() => connection.mutate()}
                    >
                      Test Ollama connection
                    </Button>
                    <Link
                      to="/music-bot"
                      className="underline coarse:min-h-11 coarse:content-center"
                    >
                      Open music bot
                    </Link>
                    <p role="status">
                      {'ollama_url' in draft
                        ? 'Save the address before testing.'
                        : connection.isPending
                          ? 'Connecting…'
                          : connection.isError
                            ? connection.error.message
                            : connection.data
                              ? `Connected. ${connection.data.models.length} installed models (${connection.data.elapsed_ms} ms).`
                              : ''}
                    </p>
                  </div>
                )}
                {section === 'queue' && (
                  <p className="mt-[14px] max-w-[520px] text-small text-muted">
                    How many times a song walks the source list is under Sources.
                  </p>
                )}
                {controls
                  .filter((control) => control.section === section)
                  .map(({ key, label, help, min, max, optional }) => {
                    const setting = settings.data?.[key]
                    if (!setting) return null
                    const value = draft[key] ?? setting.value
                    // The switch below is the only boolean; the text and select fields never
                    // hold one.
                    const entered = typeof value === 'boolean' ? '' : value
                    return (
                      <div
                        className="grid grid-cols-[1fr_220px] items-center gap-[28px] border-b border-line py-[19px] max-tablet:grid-cols-[1fr_200px] max-phone:grid-cols-1 max-phone:gap-[13px]"
                        key={key}
                      >
                        <div>
                          <label htmlFor={key} className="text-body">
                            {label}
                          </label>
                          <p className="mt-[7px] max-w-[380px] text-tiny">{help}</p>
                          {setting.locked && (
                            <small className="mt-[8px] flex items-center gap-[5px] text-caption text-warn">
                              <LockKeyhole size={12} />
                              Locked by {setting.origin}
                            </small>
                          )}
                        </div>
                        <div>
                          {typeof setting.value === 'boolean' ? (
                            <input
                              id={key}
                              type="checkbox"
                              className="h-[18px] w-[18px] accent-accent coarse:h-[22px] coarse:w-[22px]"
                              checked={value === true}
                              disabled={setting.locked || save.isPending}
                              onChange={(e) => {
                                if (!(key in draft)) {
                                  setOriginalValues({ ...originalValues, [key]: setting.value })
                                }
                                setDraft({ ...draft, [key]: e.target.checked })
                                setSaved(false)
                              }}
                            />
                          ) : key === 'destination' ? (
                            <FieldSelect
                              id={key}
                              value={entered}
                              disabled={setting.locked || save.isPending}
                              onChange={(e) => {
                                if (!(key in draft)) {
                                  setOriginalValues({ ...originalValues, [key]: setting.value })
                                }
                                setDraft({ ...draft, [key]: e.target.value })
                                setSaved(false)
                              }}
                            >
                              {diagnostics.data?.disks.slice(1).map((disk) => (
                                <option key={disk.path} value={disk.path} disabled={!disk.writable}>
                                  {disk.path}
                                  {disk.writable ? '' : ' (read-only)'}
                                </option>
                              ))}
                            </FieldSelect>
                          ) : key === 'output_format' ? (
                            <FieldSelect
                              id={key}
                              value={entered}
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
                              required={!optional}
                              disabled={setting.locked || save.isPending}
                              value={entered}
                              onChange={(e) => {
                                if (!(key in draft)) {
                                  setOriginalValues({ ...originalValues, [key]: setting.value })
                                }
                                setDraft({
                                  ...draft,
                                  [key]:
                                    min === undefined ? e.target.value : Number(e.target.value),
                                })
                                setSaved(false)
                              }}
                            />
                          )}
                          {conflicts[key] !== undefined && (
                            <small className="mt-[6px] block text-tiny text-warn">
                              Changed elsewhere to {settingText(conflicts[key])}
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
                  <div className="mt-[19px] flex gap-[12px] rounded-md bg-raised p-[15px] text-small">
                    <Folder size={17} />
                    <div>
                      Mounted folders
                      {diagnostics.data?.disks.slice(1).map((disk) => (
                        <code key={disk.path} className="mt-[8px] block text-accent">
                          {disk.path} · {disk.exists ? 'available' : 'missing'}
                        </code>
                      ))}
                      <small className="mt-[8px] block leading-[1.6] text-muted">
                        Mount additional folders in Compose before choosing them here.
                      </small>
                    </div>
                  </div>
                )}
              </section>
            ))}
            <section id="sources" className={settingsSectionClassName}>
              <h2 className={settingsSectionHeadingClassName}>Sources</h2>
              <p className="mt-[14px] max-w-[520px] text-small text-muted">
                Turn a source off to stop using it. Paste a new Deezer cookie here when the old one
                stops working.
              </p>
              <CatalogOrder
                order={
                  (draft.source_order as string[] | undefined) ?? settings.data.source_order.value
                }
                tries={Number(draft.tries_per_source ?? settings.data.tries_per_source.value)}
                triesLocked={settings.data.tries_per_source.locked}
                triesOrigin={settings.data.tries_per_source.origin}
                laps={Number(draft.max_attempts ?? settings.data.max_attempts.value)}
                lapsLocked={settings.data.max_attempts.locked}
                lapsOrigin={settings.data.max_attempts.origin}
                orderLocked={settings.data.source_order.locked}
                orderOrigin={settings.data.source_order.origin}
                changedElsewhere={(
                  [
                    ['source_order', 'the source list'],
                    ['tries_per_source', 'tries'],
                    ['max_attempts', 'times around the list'],
                    ['deezer_catalog', 'Deezer'],
                    ['deezer_audio', 'Deezer account'],
                    ['disabled_sources', 'the source switches'],
                  ] as const
                )
                  .filter(([key]) => conflicts[key] !== undefined)
                  .map(([, name]) => name)}
                deezerOn={(draft.deezer_audio ?? settings.data.deezer_audio.value) === true}
                hasCookie={arlAfterSave}
                disabledSources={
                  (draft.disabled_sources as string[] | undefined) ??
                  settings.data.disabled_sources.value
                }
                paused={diagnostics.data?.queue.paused_sources ?? []}
                trouble={orderTrouble(problems)}
                disabled={save.isPending}
                onOrder={(next) => edit('source_order', next)}
                onTries={(next) => edit('tries_per_source', next)}
                onLaps={(next) => edit('max_attempts', next)}
              />
              <SourceRow
                id="deezer"
                mark="d."
                label="Deezer"
                note={
                  problemFor('deezer')?.detail ??
                  'Search. Album pages and catalog downloads still use the Deezer catalog.'
                }
                warn={problemFor('deezer') !== undefined}
                on={(draft.deezer_catalog ?? settings.data.deezer_catalog.value) === true}
                disabled={save.isPending}
                lockedBy={
                  settings.data.deezer_catalog.locked ? settings.data.deezer_catalog.origin : ''
                }
                onChange={(on) => edit('deezer_catalog', on)}
              />
              <SourceRow
                id="deezer_audio"
                mark="a."
                label="Deezer account"
                note={
                  problemFor('deezer_audio')?.detail ??
                  'Turn this off to skip the Deezer account row. The other rows still run.'
                }
                warn={problemFor('deezer_audio') !== undefined}
                on={(draft.deezer_audio ?? settings.data.deezer_audio.value) === true}
                disabled={save.isPending}
                lockedBy={
                  settings.data.deezer_audio.locked ? settings.data.deezer_audio.origin : ''
                }
                onChange={(on) => edit('deezer_audio', on)}
              />
              <div className="grid grid-cols-[1fr_280px] items-center gap-[28px] border-b border-line py-[16px] max-phone:grid-cols-1 max-phone:gap-[10px]">
                <div>
                  <label htmlFor="deezer_arl" className="text-body">
                    Deezer cookie
                  </label>
                  <p className="mt-[7px] max-w-[420px] text-tiny">
                    In the browser, open DevTools, then Storage, then Cookies, and copy arl. Paste a
                    new one here when it changes. The cookie stays on this server and is not shown
                    again.
                  </p>
                  <p className="mt-[7px] text-tiny text-muted" aria-live="polite">
                    {removeArl
                      ? 'The cookie will be removed when you save.'
                      : arlSaved
                        ? 'A cookie is saved.'
                        : 'No Deezer cookie yet.'}
                  </p>
                  {arlSaved && (
                    <button
                      type="button"
                      className="mt-[8px] text-small text-muted underline disabled:opacity-40 coarse:inline-flex coarse:min-h-11 coarse:items-center"
                      disabled={save.isPending}
                      onClick={() => {
                        unedit('deezer_arl')
                        setRemoveArl(!removeArl)
                        setSaved(false)
                      }}
                    >
                      {removeArl ? 'Keep cookie' : 'Remove cookie'}
                    </button>
                  )}
                </div>
                <Field
                  id="deezer_arl"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={save.isPending}
                  placeholder={
                    arlSaved ? 'Paste a new cookie to replace it' : 'Paste the arl cookie'
                  }
                  value={typeof draft.deezer_arl === 'string' ? draft.deezer_arl : ''}
                  onChange={(e) => {
                    // An empty box means no change. Removing the cookie is its own button.
                    if (e.target.value.trim() === '') unedit('deezer_arl')
                    else edit('deezer_arl', e.target.value.trim())
                    setRemoveArl(false)
                  }}
                />
              </div>
              <div className="grid grid-cols-[1fr_280px] items-start gap-[28px] border-b border-line py-[16px] max-phone:grid-cols-1 max-phone:gap-[10px]">
                <div>
                  <label htmlFor="youtube_cookies" className="text-body">
                    YouTube cookies
                  </label>
                  <p className="mt-[7px] max-w-[420px] text-tiny">
                    Paste a Netscape cookies.txt exported while signed in at youtube.com. An
                    age-restricted video needs it. The file stays on this server and is not shown
                    again.
                  </p>
                  <p className="mt-[7px] text-tiny text-muted" aria-live="polite">
                    {removeCookies
                      ? 'The cookie file will be removed when you save.'
                      : cookieSaved
                        ? 'A cookie file is saved.'
                        : 'No YouTube cookie yet.'}
                  </p>
                  {cookieSaved && (
                    <button
                      type="button"
                      className="mt-[8px] text-small text-muted underline disabled:opacity-40 coarse:inline-flex coarse:min-h-11 coarse:items-center"
                      disabled={save.isPending}
                      onClick={() => {
                        setCookieText('')
                        setRemoveCookies(true)
                        setSaved(false)
                      }}
                    >
                      Remove cookie
                    </button>
                  )}
                </div>
                <textarea
                  id="youtube_cookies"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={save.isPending}
                  value={cookieText}
                  placeholder={
                    cookieSaved ? 'Paste a new file to replace the saved one' : 'Paste cookies.txt'
                  }
                  onChange={(event) => {
                    setCookieText(event.target.value)
                    setRemoveCookies(false)
                    setSaved(false)
                  }}
                  className="w-full rounded-[5px] border border-line-strong bg-raised px-[11px] py-[10px] text-small text-text"
                />
              </div>
              {(diagnostics.data?.download_sources ?? [])
                .filter((source) => source.id !== 'deezer' && source.id !== 'deezer_audio')
                .map((source) => {
                  const turnedOff = (
                    (draft.disabled_sources as string[] | undefined) ??
                    settings.data.disabled_sources.value
                  ).includes(source.id)
                  const problem = problemFor(source.id)
                  return (
                    <div key={source.id}>
                      <SourceRow
                        id={source.id}
                        mark={source.label.slice(0, 1)}
                        label={source.label}
                        note={
                          source.working
                            ? (problem?.detail ?? source.note)
                            : `${source.label} does not work right now.`
                        }
                        warn={!source.working || problem !== undefined}
                        on={source.working && !turnedOff}
                        disabled={!source.working || save.isPending}
                        lockedBy={
                          settings.data.disabled_sources.locked
                            ? settings.data.disabled_sources.origin
                            : ''
                        }
                        onChange={(on) => {
                          const current =
                            (draft.disabled_sources as string[] | undefined) ??
                            settings.data.disabled_sources.value
                          edit(
                            'disabled_sources',
                            on
                              ? current.filter((item) => item !== source.id)
                              : [...current, source.id],
                          )
                        }}
                      />
                    </div>
                  )
                })}
            </section>
            {/* `save-bar` is the hook `e2e/phone.spec.ts` measures against the bottom bar. The
                offset keeps it clear of the player, and on a phone the bar and home indicator. */}
            {/* With nothing to save there is nothing to say, so the bar comes only with an edit, a
                failed save, or the confirmation that follows a save. */}
            {(isDirty || saved || save.isError) && (
              <div
                className={cx(
                  'save-bar sticky bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+8px)] z-sticky flex items-center justify-between gap-[15px] rounded-[7px] border px-[17px] py-[13px] max-phone:p-[12px]',
                  save.isError
                    ? 'border-danger-line bg-danger-bg text-danger'
                    : 'border-good-line bg-good-bg',
                )}
              >
                {save.isError ? (
                  <span className="text-small" role="alert">
                    {save.error.message}
                  </span>
                ) : (
                  <span className="text-small" role="status">
                    {saved ? 'Saved. You can safely refresh.' : 'You have unsaved changes.'}
                  </span>
                )}
                <Button
                  variant="primary"
                  type="submit"
                  className="max-phone:whitespace-nowrap"
                  disabled={!isDirty || save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save changes'}
                  {saved ? <Check size={16} /> : <ArrowRight size={16} />}
                </Button>
              </div>
            )}
          </form>
        </div>
      )}
      <RecentActivity />
    </>
  )
}
