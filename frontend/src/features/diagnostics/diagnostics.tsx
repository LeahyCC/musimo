import { useEffect } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Folder,
  Minus,
  RefreshCw,
  X,
} from 'lucide-react'

import {
  api,
  destinationTestSchema,
  diagnosticsSchema,
  settingsSchema,
  sourceSchema,
} from '../../api'
import { PageTitle } from '../../components/page-title'
import { SourceMark } from '../../components/source-mark'
import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import {
  Button,
  buttonClassName,
  ErrorBanner,
  Panel,
  sectionCaptionClassName,
  sectionHeadingClassName,
  sectionTitleClassName,
  StatusChip,
  Tag,
} from '../../ui'
import type { StatusChipVariant } from '../../ui'
import { pausedSources } from '../downloads/download-target'
import { scanIsReady, systemIsReady } from './readiness'
import { RecentActivity } from './recent-activity'

const sourceSummaryClassName = 'my-[20px] flex items-center gap-[15px]'

const versionRowClassName =
  'flex flex-col gap-[7px] border-t border-line py-[13px] [overflow-wrap:anywhere]'

type ReadinessState = 'ready' | 'not-ready' | 'not-tested'
const readinessChip: Record<ReadinessState, StatusChipVariant> = {
  'ready': 'good',
  'not-ready': 'danger',
  'not-tested': 'default',
}

/* `readiness-panel`, `readiness-item` and `readiness-badge` are bare hooks: `e2e/app.spec.ts`
   finds the panel, its rows and their badges by class. */
const readinessItemClassName =
  'readiness-item flex items-start gap-[14px] border-b border-line pb-[16px] last:border-b-0 last:pb-0'

function readinessFeedbackClassName(success: boolean) {
  return cx(
    '-mt-[8px] rounded-md border p-[12px] text-tiny',
    success
      ? 'border-good-line bg-good-bg text-good'
      : 'border-danger-line bg-danger-bg text-danger',
  )
}

export function DiagnosticsPage() {
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

  return (
    <>
      <PageTitle eyebrow="KNOW WHAT IS HAPPENING" title="Diagnostics">
        <div className="flex flex-wrap items-center gap-[16px]">
          <Button onClick={() => void diagnostics.refetch()} disabled={diagnostics.isFetching}>
            <RefreshCw size={15} className={cx(diagnostics.isFetching && 'animate-spin')} />
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
            const overallReady = systemIsReady(data)

            // `health-strip` is a bare hook: `e2e/app.spec.ts` reads the strip by class.
            return (
              <div className="health-strip my-[28px] flex items-center gap-[17px] rounded-[8px] border border-good-line bg-good-bg px-[25px] py-[22px] max-phone:p-[19px]">
                <span className="flex rounded-full border border-good-line p-[7px] text-accent">
                  {overallReady ? <Check size={24} /> : <AlertCircle size={24} />}
                </span>
                <div>
                  <h2 className="mb-[4px] text-section max-phone:text-strong">
                    Ready to download?
                  </h2>
                  <p className="text-small max-phone:text-tiny">
                    {overallReady ? 'All systems ready.' : 'Some components need attention.'}
                  </p>
                </div>
                <Tag className="ml-auto max-phone:hidden">v{data.health.version}</Tag>
              </div>
            )
          })()}
          <Panel className="readiness-panel">
            <div className={sectionHeadingClassName}>
              <h2 className={sectionTitleClassName}>System readiness</h2>
            </div>
            <div className="flex flex-col gap-[16px]">
              {data.library.roots.map((root: string) => {
                const disk = data.disks.find((d) => d.path === root)
                const ready = disk?.exists && disk?.writable && disk?.free_bytes !== null
                return (
                  <div key={root} className={readinessItemClassName}>
                    <StatusChip
                      emphasis
                      className="readiness-badge"
                      variant={readinessChip[ready ? 'ready' : 'not-ready']}
                    >
                      {ready ? <Check size={14} /> : <X size={14} />}
                      {ready ? 'Ready' : 'Not ready'}
                    </StatusChip>
                    <div className="flex-1">
                      <strong className="mb-[4px] block text-small text-text">Library root</strong>
                      <code className="mb-[4px] block text-tiny text-muted">{root}</code>
                      <small className="mt-[4px] block text-tiny text-faint">
                        {disk?.exists
                          ? disk?.writable
                            ? `${size(disk.free_bytes)} free`
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
                    <div className={readinessItemClassName}>
                      <StatusChip
                        emphasis
                        className="readiness-badge"
                        variant={readinessChip[ready ? 'ready' : 'not-ready']}
                      >
                        {ready ? <Check size={14} /> : <X size={14} />}
                        {ready ? 'Ready' : 'Not ready'}
                      </StatusChip>
                      <div className="flex-1">
                        <strong className="mb-[4px] block text-small text-text">
                          Download destination
                        </strong>
                        <code className="mb-[4px] block text-tiny text-muted">{destPath}</code>
                        <small className="mt-[4px] block text-tiny text-faint">
                          {disk?.exists
                            ? disk?.writable
                              ? `${size(disk.free_bytes)} free`
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
                <div className={readinessFeedbackClassName(testDestination.data.success)}>
                  {testDestination.data.success
                    ? `Write test succeeded (${testDestination.data.elapsed_ms} ms)`
                    : `Write test failed: ${testDestination.data.error}`}
                </div>
              )}
              <div className={readinessItemClassName}>
                <StatusChip
                  emphasis
                  className="readiness-badge"
                  variant={readinessChip[scanIsReady(data.library.status) ? 'ready' : 'not-ready']}
                >
                  {scanIsReady(data.library.status) ? <Check size={14} /> : <X size={14} />}
                  {scanIsReady(data.library.status) ? 'Ready' : 'Not ready'}
                </StatusChip>
                <div className="flex-1">
                  <strong className="mb-[4px] block text-small text-text">Library scan</strong>
                  <p className="text-tiny text-muted">
                    {data.library.status === 'idle'
                      ? `${data.library.total_files} files indexed`
                      : data.library.status === 'scanning'
                        ? `Scanning (${data.library.indexed} files)`
                        : data.library.detail}
                  </p>
                </div>
              </div>
              {data.navidrome && settings.data && (
                <div className={readinessItemClassName}>
                  <StatusChip
                    emphasis
                    className="readiness-badge"
                    variant={
                      readinessChip[
                        data.navidrome.available
                          ? 'ready'
                          : data.navidrome.configured
                            ? 'not-ready'
                            : 'not-tested'
                      ]
                    }
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
                  </StatusChip>
                  <div className="flex-1">
                    <strong className="mb-[4px] block text-small text-text">Navidrome</strong>
                    <p className="text-tiny text-muted">
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
                  <div key={source.source} className={readinessItemClassName}>
                    <StatusChip
                      emphasis
                      className="readiness-badge"
                      variant={readinessChip[source.status === 'healthy' ? 'ready' : 'not-ready']}
                    >
                      {source.status === 'healthy' ? <Check size={14} /> : <X size={14} />}
                      {source.status === 'healthy' ? 'Ready' : 'Not ready'}
                    </StatusChip>
                    <div className="flex-1">
                      <strong className="mb-[4px] block text-small text-text">
                        YouTube download helper
                      </strong>
                      <p className="text-tiny text-muted">
                        {source.detail}
                        {pausedSources(data.queue).some((p) => p.source === 'youtube') &&
                          ' · Paused'}
                      </p>
                    </div>
                  </div>
                ))}
              {pausedSources(data.queue)
                .filter((p) => p.source !== 'youtube')
                .map((p) => (
                  <div key={p.source} className={readinessItemClassName}>
                    <StatusChip
                      emphasis
                      className="readiness-badge"
                      variant={readinessChip['not-ready']}
                    >
                      <X size={14} />
                      Paused
                    </StatusChip>
                    <div className="flex-1">
                      <strong className="mb-[4px] block text-small text-text">
                        {p.label} downloads
                      </strong>
                      <p className="text-tiny text-muted">Paused after repeated blocking errors.</p>
                    </div>
                  </div>
                ))}
              {data.last_download && (
                <div className={readinessItemClassName}>
                  <StatusChip
                    emphasis
                    className="readiness-badge"
                    variant={
                      readinessChip[data.last_download.stage === 'done' ? 'ready' : 'not-ready']
                    }
                  >
                    {data.last_download.stage === 'done' ? <Check size={14} /> : <X size={14} />}
                    {data.last_download.stage === 'done' ? 'Success' : 'Failed'}
                  </StatusChip>
                  <div className="flex-1">
                    <strong className="mb-[4px] block text-small text-text">Last download</strong>
                    <p className="text-tiny text-muted">
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
                <div className={readinessItemClassName}>
                  <StatusChip
                    emphasis
                    className="readiness-badge"
                    variant={readinessChip['not-tested']}
                  >
                    <Minus size={14} />
                    Not tested
                  </StatusChip>
                  <div className="flex-1">
                    <strong className="mb-[4px] block text-small text-text">Last download</strong>
                    <p className="text-tiny text-muted">No download attempted yet</p>
                  </div>
                </div>
              )}
            </div>
          </Panel>
          <div
            className="grid grid-cols-2 gap-[22px] max-tablet:gap-[15px] max-phone:grid-cols-1"
            id="sources"
          >
            {data.sources.map((source) => (
              <Panel key={source.source}>
                <div className={sectionHeadingClassName}>
                  <h2 className={sectionTitleClassName}>
                    {source.source === 'deezer' ? 'Catalog connection' : 'Download source'}
                  </h2>
                  <StatusChip variant={source.status === 'healthy' ? 'good' : 'default'}>
                    {source.status}
                  </StatusChip>
                </div>
                <div className={sourceSummaryClassName}>
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
              </Panel>
            ))}
            <Panel id="disk">
              <div className={sectionHeadingClassName}>
                <h2 className={sectionTitleClassName}>Persistent storage</h2>
                <Folder size={18} />
              </div>
              {data.disks.map((disk) => (
                <div className="mt-[18px] first:mt-0" key={disk.path}>
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
            </Panel>
          </div>
          <section className="mt-[32px]">
            <div className={sectionHeadingClassName}>
              <h2 className={sectionTitleClassName}>Under the hood</h2>
              <span className={sectionCaptionClassName}>INSTALLED IN THIS CONTAINER</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-[33px] max-phone:gap-x-[20px] max-phone:grid-cols-1">
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
          <RecentActivity />
        </>
      )}
    </>
  )
}
