import { useState } from 'react'

import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, History as HistoryIcon, Settings2 } from 'lucide-react'

import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import {
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  iconButtonClassName,
  tabId,
  TabList,
  tabPanelId,
} from '../../ui'
import { BatchQueue, BatchSummaries } from './batch-queue'
import { DonePanel, ErrorsPanel, NoMatchPanel } from './finished-panels'
import { History } from './history'
import { JobList } from './job-list'
import { finishedToday } from './job-steps'
import { activeJob, errorJob, failureTallies, unmatchedJob, useJobs } from './jobs'
import {
  CancelQueuedButton,
  ParallelChip,
  PauseAllButton,
  QueueAlerts,
  SaveTarget,
  useSettings,
} from './queue-controls'

type Tab = 'queue' | 'done' | 'unmatched' | 'errors' | 'history'
const TAB_IDS = 'downloads'

const EMPTY: Record<Tab, string> = {
  queue: 'No queued downloads',
  done: 'No done downloads',
  unmatched: 'No tracks are waiting for a match',
  errors: 'No failed downloads',
  history: '',
}

/** The queue as the page needs it: each tab's jobs and its count, from one read of the cache. */
function useDownloadTabs() {
  const queue = useJobs()
  const all = (queue.data?.jobs ?? []).filter((job) => !job.hidden)
  const { unmatched, errors } = failureTallies(queue.data?.summary, all)
  const reasons = queue.data?.summary.failure_reasons ?? []
  const newest = (a: { updated_at: number }, b: { updated_at: number }) =>
    b.updated_at - a.updated_at
  const active = all.filter(activeJob).sort((a, b) => a.created_at - b.created_at)
  const done = all.filter((job) => job.stage === 'done').sort(newest)
  return {
    queue,
    all,
    lists: {
      queue: active,
      done,
      unmatched: all.filter(unmatchedJob).sort(newest),
      errors: all.filter(errorJob).sort(newest),
    },
    counts: {
      queue: queue.data?.summary.active ?? active.length,
      done: done.length,
      unmatched,
      errors,
    },
    doneToday: done.filter((job) => finishedToday(job, Date.now())).length,
    reasons: {
      unmatched: reasons.filter((reason) => reason.code === 'NO_MATCH'),
      errors: reasons.filter((reason) => reason.code !== 'NO_MATCH'),
    },
  }
}

type DownloadTabs = ReturnType<typeof useDownloadTabs>

/** "3 downloading · 11 queued", counted from the jobs the page holds. */
function queueLine(jobs: DownloadTabs['lists']['queue']) {
  const moving = jobs.filter((job) => !['queued', 'retry_wait', 'paused'].includes(job.stage))
  const waiting = jobs.length - moving.length
  return `${moving.length} downloading · ${waiting} queued`
}

function TabContent({ tab, data }: { tab: Tab; data: DownloadTabs }) {
  const layout = useLayout()
  if (tab === 'history') return <History />
  const jobs = data.lists[tab]
  const body =
    tab === 'unmatched' ? (
      <NoMatchPanel jobs={jobs} count={data.counts.unmatched} reasons={data.reasons.unmatched} />
    ) : tab === 'errors' ? (
      <ErrorsPanel jobs={jobs} count={data.counts.errors} reasons={data.reasons.errors} />
    ) : !jobs.length ? null : tab === 'done' ? (
      <DonePanel jobs={jobs} />
    ) : layout === 'room' ? (
      <BatchQueue jobs={data.all} />
    ) : (
      <>
        <BatchSummaries jobs={data.all} />
        <JobList jobs={jobs} />
      </>
    )
  return (
    <>
      {body}
      {!jobs.length && !data.queue.isError && (
        <EmptyPanel>
          <ArrowDownToLine size={36} />
          <h2>{data.queue.isPending ? 'Loading queue…' : EMPTY[tab]}</h2>
          <Link to="/search" data-ui="button" className={buttonClassName('primary')}>
            Find a track
          </Link>
        </EmptyPanel>
      )}
    </>
  )
}

function ClassicHeader({ data }: { data: DownloadTabs }) {
  return (
    <header className="mb-[20px] flex flex-wrap items-end justify-between gap-[16px]">
      <div className="min-w-0">
        <h1 className="text-display font-semibold tracking-[-0.7px]">Downloads</h1>
        <p className="mt-[6px] text-body text-muted">
          {queueLine(data.lists.queue)} <SaveTarget lead="· saving to" />
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-[8px]">
        <ParallelChip />
        <PauseAllButton />
        <CancelQueuedButton />
        <Link
          to="/settings"
          aria-label="Download settings"
          title="Download settings"
          className={iconButtonClassName(false, 'h-[36px] w-[36px] bg-hover', 'box', 'outlined')}
        >
          <Settings2 size={16} />
        </Link>
      </div>
    </header>
  )
}

const roomTiles = [
  { tab: 'queue', label: 'Active' },
  { tab: 'unmatched', label: 'No match' },
  { tab: 'done', label: 'Done today' },
  { tab: 'errors', label: 'Needs you' },
] as const

/**
 * The Listening room's four numbers double as the tabs, and History is a toggle beside them. They
 * are pressed buttons, not ARIA tabs: History sits apart from the row, so no tab row would hold all
 * five.
 */
function RoomHeader({
  data,
  tab,
  setTab,
}: {
  data: DownloadTabs
  tab: Tab
  setTab: (tab: Tab) => void
}) {
  const settings = useSettings()
  const values: Record<(typeof roomTiles)[number]['tab'], number> = {
    queue: data.counts.queue,
    unmatched: data.counts.unmatched,
    done: data.doneToday,
    errors: data.counts.errors,
  }
  const parallel = settings.data?.concurrency.value
  return (
    <>
      {/* The room header already names the page; the heading stays for screen readers. */}
      <h1 className="sr-only">Downloads</h1>
      <div
        role="group"
        aria-label="Download views"
        className="download-tabs mb-[18px] grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-[10px] max-phone:grid-cols-2"
      >
        {roomTiles.map((tile) => {
          const pressed = tab === tile.tab
          const alarm = tile.tab === 'errors' && values.errors > 0
          return (
            <button
              key={tile.tab}
              aria-pressed={pressed}
              onClick={() => setTab(tile.tab)}
              className={cx(
                'rounded-[16px] border px-[16px] py-[14px] text-left text-text',
                alarm ? 'bg-danger-bg' : pressed ? 'bg-active' : 'bg-raised',
                pressed
                  ? alarm
                    ? 'border-danger'
                    : 'border-accent'
                  : alarm
                    ? 'border-danger-line'
                    : 'border-transparent',
              )}
            >
              <span
                className={cx(
                  'block font-mono text-[10.5px] tracking-[0.6px] uppercase',
                  tile.tab === 'queue' ? 'text-accent' : alarm ? 'text-danger' : 'text-muted',
                )}
              >
                {tile.label}
              </span>
              <span className="mt-[8px] block text-[26px] font-semibold tracking-[-0.8px]">
                {values[tile.tab]}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mb-[14px] flex flex-wrap items-center gap-[8px]">
        <span className="text-small text-muted">
          <SaveTarget lead="Saving to" />
          {parallel !== undefined && ` · ${parallel} at a time`}
        </span>
        <span className="flex-1" />
        <PauseAllButton className="rounded-[10px] border-0" />
        <CancelQueuedButton className="rounded-[10px] border-0" />
        <button
          aria-pressed={tab === 'history'}
          onClick={() => setTab(tab === 'history' ? 'queue' : 'history')}
          className={buttonClassName(
            'default',
            cx('min-h-[36px] rounded-[10px] border-0 py-0', tab === 'history' && 'bg-active'),
          )}
        >
          <HistoryIcon size={14} aria-hidden="true" />
          History
        </button>
      </div>
    </>
  )
}

export function DownloadsPage() {
  const layout = useLayout()
  const data = useDownloadTabs()
  const [tab, setTab] = useState<Tab>('queue')
  const tabs = [
    { id: 'queue', label: 'Queue', count: data.counts.queue },
    { id: 'done', label: 'Done', count: data.counts.done },
    { id: 'unmatched', label: 'No match', count: data.counts.unmatched },
    { id: 'errors', label: 'Errors', count: data.counts.errors },
    { id: 'history', label: 'History' },
  ] as const
  const error = data.queue.isError && (
    <ErrorBanner>
      {data.queue.error.message}
      <button onClick={() => void data.queue.refetch()}>Retry</button>
    </ErrorBanner>
  )
  if (layout === 'room')
    return (
      <>
        <RoomHeader data={data} tab={tab} setTab={setTab} />
        <QueueAlerts />
        {error}
        <TabContent tab={tab} data={data} />
      </>
    )
  return (
    <>
      <ClassicHeader data={data} />
      <QueueAlerts />
      <TabList
        label="Downloads"
        idBase={TAB_IDS}
        tabs={tabs}
        value={tab}
        onChange={setTab}
        className="download-tabs mb-[16px] overflow-x-auto overflow-y-hidden [scrollbar-width:none] max-phone:gap-[14px]"
      />
      <div role="tabpanel" id={tabPanelId(TAB_IDS, tab)} aria-labelledby={tabId(TAB_IDS, tab)}>
        {error}
        <TabContent tab={tab} data={data} />
      </div>
    </>
  )
}
