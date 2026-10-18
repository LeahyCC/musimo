import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock,
  Cpu,
  Database,
  Folder,
  Globe,
  HardDrive,
  Play,
  Radio,
  RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import {
  api,
  commandSchema,
  destinationTestSchema,
  diagnosticsSchema,
  settingsSchema,
  sourceSchema,
} from '../../api'
import { PageTitle } from '../../components/page-title'
import { SourceMark } from '../../components/source-mark'
import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { useLayout } from '../../lib/layout'
import { relativeTime } from '../../lib/relative-time'
import {
  Button,
  buttonClassName,
  ErrorBanner,
  sectionCaptionClassName,
  sectionHeadingClassName,
  sectionTitleClassName,
  StatusChip,
} from '../../ui'
import { pausedSources } from '../downloads/download-target'
import { buildChecks, buildPipeline, checkSummary } from './checks'
import type { PipelineStep, ReadinessCheck, Tone } from './checks'
import { systemIsReady } from './readiness'
import { RecentActivity } from './recent-activity'

const versionRowClassName =
  'flex flex-col gap-[7px] border-t border-line py-[13px] [overflow-wrap:anywhere]'

/* The one place a tone becomes a color, so a row, a pill and a pipeline step cannot disagree. */
const toneClassNames: Record<Tone, { pill: string; text: string; border: string }> = {
  good: { pill: 'bg-good-bg text-good', text: 'text-good', border: 'border-line' },
  warn: { pill: 'bg-warn-bg text-warn', text: 'text-warn', border: 'border-warn-line' },
  danger: { pill: 'bg-danger-bg text-danger', text: 'text-danger', border: 'border-danger-line' },
  idle: { pill: 'bg-hover text-muted', text: 'text-faint', border: 'border-line' },
}

/** What a color alone would say, in words, for a pipeline step. */
const toneWords: Record<Tone, string> = {
  good: 'Ready',
  warn: 'Needs a look',
  danger: 'Not ready',
  idle: 'Not tested',
}

const checkIcons: Record<string, LucideIcon> = {
  scan: Database,
  player: Play,
  destination: ArrowDownToLine,
  root: Folder,
  last: Clock,
}

function iconFor(check: ReadinessCheck): LucideIcon {
  const key = check.id.split('-')[0] ?? ''

  return checkIcons[key] ?? Radio
}

const pipelineIcons: Record<PipelineStep['id'], LucideIcon> = {
  catalog: Globe,
  sources: Radio,
  worker: Cpu,
  library: HardDrive,
  player: Play,
}

function writeTestFeedback(success: boolean) {
  return cx(
    'rounded-md border p-[12px] text-tiny',
    success
      ? 'border-good-line bg-good-bg text-good'
      : 'border-danger-line bg-danger-bg text-danger',
  )
}

export function DiagnosticsPage() {
  const client = useQueryClient()
  const room = useLayout() === 'room'
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
  const resumeSource = useMutation({
    mutationFn: (sourceName: string) =>
      api(`queue/resume-source?source=${encodeURIComponent(sourceName)}`, commandSchema, {
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['diagnostics'] })
      void client.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const data = diagnostics.data
  const size = (bytes: number | null) => (bytes === null ? 'Unknown' : formatBytes(bytes))
  useEffect(() => {
    if (diagnostics.isSuccess && window.location.hash) {
      const sectionId = window.location.hash.slice(1)
      const section = document.getElementById(sectionId)
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }, [diagnostics.isSuccess])

  const paused = pausedSources(data?.queue)
  const checks = data
    ? buildChecks(
        data,
        settings.data ? String(settings.data.destination.value) : undefined,
        paused,
        size,
      )
    : []
  const overallReady = data ? systemIsReady(data) : false

  const recheck = (
    <Button onClick={() => void diagnostics.refetch()} disabled={diagnostics.isFetching}>
      <RefreshCw size={15} className={cx(diagnostics.isFetching && 'animate-spin')} />
      Recheck
    </Button>
  )
  const exportLink = (
    <a data-ui="button" className={buttonClassName()} href="/api/diagnostics/export" download>
      <ArrowDownToLine size={15} />
      Export
    </a>
  )

  const cardClassName = cx(
    'bg-raised p-[18px]',
    room ? 'rounded-[18px]' : 'rounded-[12px] border border-line',
  )

  /** The "Test write" button and the line it leaves behind, or the resume button for a pause. */
  const actionFor = (check: ReadinessCheck): ReactNode => {
    const { action } = check
    if (!action) return null
    if (action.kind === 'test-write') {
      return (
        <Button onClick={() => testDestination.mutate()} disabled={testDestination.isPending}>
          {testDestination.isPending ? 'Testing…' : action.label}
        </Button>
      )
    }

    return (
      <Button onClick={() => resumeSource.mutate(action.source)} disabled={resumeSource.isPending}>
        {action.label}
      </Button>
    )
  }

  const feedbackFor = (check: ReadinessCheck): ReactNode =>
    check.action?.kind === 'test-write' && testDestination.data ? (
      <div className={writeTestFeedback(testDestination.data.success)}>
        {testDestination.data.success
          ? `Write test succeeded (${testDestination.data.elapsed_ms} ms)`
          : `Write test failed: ${testDestination.data.error}`}
      </div>
    ) : null

  /* `readiness-panel`, `readiness-item` and `readiness-badge` are bare hooks: `e2e/app.spec.ts`
     finds the panel, its rows and their badges by class. */
  const classicCheck = (check: ReadinessCheck) => {
    const Icon = iconFor(check)
    const { disk } = check

    return (
      <div
        key={check.id}
        data-ui="card"
        className="readiness-item flex flex-col gap-[10px] rounded-[12px] border border-line bg-raised px-[18px] py-[16px]"
      >
        <div className="flex items-center gap-[10px]">
          <Icon size={17} className="shrink-0 text-muted" aria-hidden="true" />
          <strong className="min-w-0 flex-1 font-semibold">{check.name}</strong>
          <span
            className={cx(
              'readiness-badge inline-flex shrink-0 items-center gap-[5px] rounded-pill px-[8px] py-[3px] text-tiny font-semibold',
              toneClassNames[check.tone].pill,
            )}
          >
            <i aria-hidden="true" className="size-[6px] rounded-full bg-current" />
            {check.state}
          </span>
        </div>
        {check.path && (
          <code className="text-tiny text-muted [overflow-wrap:anywhere]">{check.path}</code>
        )}
        <p className="text-small leading-[1.5] text-muted">{check.detail}</p>
        {disk?.total_bytes ? (
          <meter
            aria-label={`Free space on ${disk.path}`}
            min={0}
            max={disk.total_bytes}
            value={disk.free_bytes ?? 0}
          />
        ) : null}
        {actionFor(check) && <div className="flex">{actionFor(check)}</div>}
        {feedbackFor(check)}
      </div>
    )
  }

  const roomCheck = (check: ReadinessCheck) => (
    <li
      key={check.id}
      className="readiness-item flex flex-wrap items-center gap-x-[14px] gap-y-[8px] border-t border-line px-[18px] py-[12px] first:border-t-0"
    >
      <span
        className={cx(
          'readiness-badge min-w-[84px] rounded-[5px] px-[7px] py-[3px] text-center font-mono text-caption tracking-[0.5px] uppercase',
          toneClassNames[check.tone].pill,
        )}
      >
        {check.state}
      </span>
      <span className="min-w-[180px] flex-1">
        <strong className="block font-medium">{check.name}</strong>
        {check.path && (
          <code className="mt-[2px] block text-tiny text-muted [overflow-wrap:anywhere]">
            {check.path}
          </code>
        )}
        <span className="mt-[2px] block text-small text-muted">{check.detail}</span>
        {feedbackFor(check) && <span className="mt-[8px] block">{feedbackFor(check)}</span>}
      </span>
      {actionFor(check)}
    </li>
  )

  const banner = (ready: boolean) => (
    <div>
      <h2 className="text-strong">Ready to download?</h2>
      <p className={cx('mt-[3px] text-small', ready ? 'text-good' : 'text-danger')}>
        {!ready
          ? `Some components need attention. ${checkSummary(checks)}.`
          : checks.every((check) => check.tone === 'good')
            ? `All systems ready. ${checkSummary(checks)}.`
            : `Ready to download. ${checkSummary(checks)}; the rest are notes, not faults.`}
      </p>
    </div>
  )

  return (
    <>
      <PageTitle eyebrow="KNOW WHAT IS HAPPENING" title="Diagnostics">
        {!room && (
          <div className="flex flex-wrap items-center gap-[16px]">
            {recheck}
            {exportLink}
          </div>
        )}
      </PageTitle>
      {data && (
        <p className="-mt-[8px] mb-[20px] text-small text-muted">
          Checked {relativeTime(diagnostics.dataUpdatedAt, Date.now())} · v{data.health.version} ·
          database v{data.database.schema}
        </p>
      )}
      {diagnostics.isError && <ErrorBanner role="alert">{diagnostics.error.message}</ErrorBanner>}
      {!data && !diagnostics.isError && <p role="status">Checking your container…</p>}
      {data && (
        <>
          {room ? (
            <>
              {/* `health-strip` is a bare hook: `e2e/app.spec.ts` reads the strip by class. */}
              <section
                data-ui="card"
                className={cx(
                  'health-strip mb-[16px] rounded-[18px] bg-raised p-[20px]',
                  !overallReady && 'border border-danger-line',
                )}
              >
                <div className="mb-[18px] flex flex-wrap items-center gap-[10px]">
                  {banner(overallReady)}
                  <div className="flex-1" />
                  {recheck}
                  {exportLink}
                </div>
                <ol
                  aria-label="Pipeline"
                  className="m-0 flex list-none flex-wrap items-stretch gap-[8px] p-0"
                >
                  {buildPipeline(data, paused).map((step) => {
                    const Icon = pipelineIcons[step.id]
                    const tone = toneClassNames[step.tone]

                    return (
                      <li
                        key={step.id}
                        className={cx(
                          'min-w-0 flex-[1_1_120px] rounded-[14px] border bg-canvas p-[12px]',
                          tone.border,
                        )}
                      >
                        <div className={cx('flex items-center gap-[8px]', tone.text)}>
                          <Icon size={16} aria-hidden="true" />
                          <i
                            aria-hidden="true"
                            className="ml-auto size-[8px] rounded-full bg-current"
                          />
                        </div>
                        <div className="mt-[10px] font-semibold">{step.name}</div>
                        <div className="mt-[2px] font-mono text-[10.5px] text-muted">
                          {step.detail}
                        </div>
                        <span className="sr-only">{toneWords[step.tone]}</span>
                      </li>
                    )
                  })}
                </ol>
              </section>
              <div className="flex flex-wrap gap-[16px]">
                <section className="readiness-panel min-w-0 flex-[3_1_400px] self-start rounded-[18px] bg-raised py-[6px]">
                  <h2 className="sr-only">System readiness</h2>
                  <ul className="m-0 list-none p-0">{checks.map(roomCheck)}</ul>
                </section>
                <div className="min-w-0 flex-[2_1_300px]">
                  <RecentActivity side />
                </div>
              </div>
            </>
          ) : (
            <>
              <div
                className={cx(
                  'health-strip mb-[20px] flex flex-wrap items-center gap-[16px] rounded-[14px] border px-[20px] py-[18px] max-phone:p-[16px]',
                  overallReady
                    ? 'border-good-line bg-good-bg'
                    : 'border-danger-line bg-danger-bg text-danger',
                )}
              >
                <span
                  className={cx(
                    'grid size-[40px] flex-none place-items-center rounded-full',
                    overallReady ? 'bg-accent text-accent-ink' : 'bg-danger text-danger-bg',
                  )}
                >
                  {overallReady ? (
                    <Check size={20} aria-hidden="true" />
                  ) : (
                    <AlertCircle size={20} aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-[200px] flex-1">{banner(overallReady)}</div>
              </div>
              <section className="readiness-panel">
                <div className={sectionHeadingClassName}>
                  <h2 className={sectionTitleClassName}>System readiness</h2>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[12px] max-phone:grid-cols-1">
                  {checks.map(classicCheck)}
                </div>
              </section>
            </>
          )}
          <div
            className="mt-[28px] grid grid-cols-2 gap-[22px] max-tablet:gap-[15px] max-phone:grid-cols-1"
            id="sources"
          >
            {data.sources.map((source) => (
              <section key={source.source} data-ui="card" className={cardClassName}>
                <div className={sectionHeadingClassName}>
                  <h2 className={sectionTitleClassName}>
                    {source.source === 'deezer' ? 'Catalog connection' : 'Download source'}
                  </h2>
                  <StatusChip variant={source.status === 'healthy' ? 'good' : 'default'}>
                    {source.status}
                  </StatusChip>
                </div>
                <div className="my-[20px] flex items-center gap-[15px]">
                  <SourceMark>
                    {source.source === 'deezer' ? 'd.' : source.source.charAt(0).toUpperCase()}
                  </SourceMark>
                  <div>
                    <h3 className="mb-[4px]">
                      {source.source.charAt(0).toUpperCase() + source.source.slice(1)}
                    </h3>
                    <p className="text-small">{source.detail}</p>
                    {source.source === 'deezer' && (
                      <p className="text-tiny text-muted">
                        {data.deezer_audio
                          ? 'Account audio is on. Catalog tracks save from Deezer, then use your folder names.'
                          : 'Account audio is off.'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-[27px] flex items-center justify-between gap-[10px]">
                  <span className="text-caption text-muted">
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
              </section>
            ))}
            <section id="disk" data-ui="card" className={cx(cardClassName, 'col-span-full')}>
              <div className={sectionHeadingClassName}>
                <h2 className={sectionTitleClassName}>Persistent storage</h2>
                <Folder size={18} />
              </div>
              {data.disks.map((disk) => (
                <div className="mt-[26px] first:mt-0" key={disk.path}>
                  <div className="mb-[7px] flex justify-between gap-[12px] text-tiny">
                    <code>{disk.path}</code>
                    <span className="text-muted">
                      {disk.exists ? `${size(disk.free_bytes)} free` : 'Not mounted'}
                    </span>
                  </div>
                  <meter
                    aria-label={`Free space in ${disk.path}`}
                    min={0}
                    max={disk.total_bytes ?? 1}
                    value={disk.free_bytes ?? 0}
                  />
                  <small className="text-micro text-faint max-phone:text-caption">
                    {disk.writable ? 'Write permission available' : 'Not writable'} · permission
                    check only
                  </small>
                </div>
              ))}
            </section>
          </div>
          <section className="mt-[32px]">
            <div className={sectionHeadingClassName}>
              <h2 className={sectionTitleClassName}>Under the hood</h2>
              <span className={sectionCaptionClassName}>INSTALLED IN THIS CONTAINER</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-[33px] max-phone:grid-cols-1 max-phone:gap-x-[20px]">
              {Object.entries(data.versions).map(([name, version]) => (
                <div key={name} className={versionRowClassName}>
                  <dt className="text-tiny text-muted">{name}</dt>
                  <dd className="m-0 font-mono text-small text-text">{version}</dd>
                </div>
              ))}
              <div className={versionRowClassName}>
                <dt className="text-tiny text-muted">SQLite</dt>
                <dd className="m-0 font-mono text-small text-text">
                  WAL · schema {data.database.schema}
                </dd>
              </div>
            </dl>
          </section>
          {!room && <RecentActivity />}
        </>
      )}
    </>
  )
}
