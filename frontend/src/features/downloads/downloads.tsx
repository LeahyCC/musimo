import { useState } from 'react'

import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine } from 'lucide-react'

import { api, historySchema } from '../../api'
import type { DownloadJob } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { PageTitle } from '../../components/page-title'
import { cx } from '../../lib/cx'
import { useDebounced } from '../../lib/use-debounced'
import { buttonClassName, EmptyPanel, ErrorBanner, errorBannerClassName, Field } from '../../ui'
import { batchName, BatchSummary, errorLink, JobList } from './job-list'
import { activeJob, errorJob, failureTallies, unmatchedJob, useJobs } from './jobs'
import { QueueControls } from './queue-controls'

function History() {
  const [q, setQ] = useState(''),
    [from, setFrom] = useState(''),
    [until, setUntil] = useState('')
  // The box stays immediate. The request waits for a pause in typing: a typed search reads the
  // text of every finished job while it holds the database, about a quarter second at 52k jobs.
  const deferredQ = useDebounced(q, 250)
  const query = useInfiniteQuery({
    queryKey: ['history', deferredQ, from, until],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(
        `history?${new URLSearchParams({ q: deferredQ, since: from ? String(new Date(from).getTime() / 1000) : '0', until: until ? String(new Date(until + 'T23:59:59').getTime() / 1000) : '1000000000000', offset: String(pageParam) })}`,
        historySchema,
        { signal },
      ),
    getNextPageParam: (page, pages) =>
      pages.reduce((count, item) => count + item.jobs.length, 0) < page.total
        ? pages.length * 100
        : undefined,
  })
  return (
    <>
      <div className="my-4 flex flex-wrap gap-3">
        <Field
          aria-label="Search download history"
          fullWidth={false}
          placeholder="Search history"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-2 text-small">
          From
          <Field
            type="date"
            fullWidth={false}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-small">
          To
          <Field
            type="date"
            fullWidth={false}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
      </div>
      {query.isPending && <p>Loading history…</p>}
      {query.isError && (
        <ErrorBanner>
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {!query.isPending && !query.isError && query.data?.pages[0]?.jobs.length === 0 && (
        <EmptyPanel>
          <h2>Nothing has finished yet.</h2>
        </EmptyPanel>
      )}
      <JobList jobs={query.data?.pages.flatMap((page) => page.jobs) ?? []} />
      {query.hasNextPage && (
        <InfiniteScroll
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
    </>
  )
}

export function DownloadsPage() {
  const queue = useJobs()
  const [tab, setTab] = useState('queue')
  // null shows every failure. Single-track failures have an empty batch, so they need
  // their own chip rather than sharing the unfiltered state.
  const [group, setGroup] = useState<string | null>(null)
  const all = (queue.data?.jobs ?? []).filter((job) => !job.hidden)
  const { unmatched, errors } = failureTallies(queue.data?.summary, all)
  const pile =
    tab === 'unmatched' ? all.filter(unmatchedJob) : tab === 'errors' ? all.filter(errorJob) : []
  // Album and artist downloads fail in clusters, so the batch is the useful unit to inspect.
  const failureGroups = [
    ...pile.reduce(
      (map, job) => map.set(job.batch_id, [...(map.get(job.batch_id) ?? []), job]),
      new Map<string, DownloadJob[]>(),
    ),
  ].sort(([left], [right]) => left.localeCompare(right))
  // Chips only appear above one group, so the filter has to read from the same condition or
  // the list could narrow by a control the user cannot see.
  const grouped = failureGroups.length > 1
  const selectedGroup =
    grouped && group !== null && failureGroups.some(([id]) => id === group) ? group : null
  const jobs = (
    tab === 'queue'
      ? all.filter(activeJob)
      : tab === 'done'
        ? all.filter((job) => job.stage === 'done')
        : pile.filter((job) => selectedGroup === null || job.batch_id === selectedGroup)
  ).sort((a, b) => (tab === 'queue' ? a.created_at - b.created_at : b.updated_at - a.updated_at))
  const counts = {
    queue: queue.data?.summary.active ?? all.filter(activeJob).length,
    done: all.filter((job) => job.stage === 'done').length,
    unmatched,
    errors,
  }
  const tabs = [
    ['queue', 'Queue', counts.queue],
    ['done', 'Done', counts.done],
    ['unmatched', 'No match', counts.unmatched],
    ['errors', 'Errors', counts.errors],
    ['history', 'History', null],
  ] as const
  const pileCount = tab === 'unmatched' ? counts.unmatched : counts.errors
  const reasons = (queue.data?.summary.failure_reasons ?? []).filter((reason) =>
    tab === 'unmatched' ? reason.code === 'NO_MATCH' : reason.code !== 'NO_MATCH',
  )
  return (
    <>
      <PageTitle eyebrow="YOUR COLLECTION, IN MOTION" title="Downloads">
        <Link data-ui="button" className={buttonClassName()} to="/settings">
          Download settings
        </Link>
      </PageTitle>
      <QueueControls />
      <BatchSummary jobs={queue.data?.jobs ?? []} />
      <div className="download-tabs mt-6 mb-4 flex flex-wrap gap-1.5 max-phone:flex-nowrap max-phone:gap-1">
        {tabs.map(([value, label, count]) => (
          <button
            key={value}
            data-ui="tab"
            className={cx(
              'rounded-pill border-0 px-[17px] py-[10px] whitespace-nowrap coarse:min-h-11',
              'max-phone:min-w-0 max-phone:flex-1 max-phone:px-[2px] max-phone:text-body max-phone:overflow-hidden max-phone:text-ellipsis',
              tab === value ? 'bg-accent text-accent-ink' : 'bg-transparent text-muted',
            )}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
            {count !== null && <span className="max-phone:sr-only"> ({count})</span>}
          </button>
        ))}
      </div>
      {queue.isError && (
        <ErrorBanner>
          {queue.error.message}
          <button onClick={() => void queue.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {(tab === 'unmatched' || tab === 'errors') && pileCount > 0 && (
        <section
          className={errorBannerClassName('list')}
          aria-label={tab === 'unmatched' ? 'No match summary' : 'Failure summary'}
        >
          <strong>
            {tab === 'unmatched'
              ? `${pileCount} ${pileCount === 1 ? 'track has' : 'tracks have'} no close match`
              : `${pileCount} ${pileCount === 1 ? 'download' : 'downloads'} failed`}
          </strong>
          {reasons.map((reason) => {
            const link = errorLink(reason.fix || '')
            return (
              <span key={[reason.code, reason.message, reason.hint, reason.fix].join('|')}>
                {reason.count} · {reason.hint || reason.message}{' '}
                {reason.code && <small>({reason.code})</small>}
                {link &&
                  (() => {
                    const [to, hash] = link.href.split('#')
                    return (
                      <>
                        {' '}
                        <Link to={to} hash={hash}>
                          {link.text}
                        </Link>
                      </>
                    )
                  })()}
              </span>
            )
          })}
          {selectedGroup === null && jobs.length < pileCount && (
            <small>Showing the latest {jobs.length} below.</small>
          )}
        </section>
      )}
      {(tab === 'unmatched' || tab === 'errors') && grouped && (
        <div
          className="my-[14px] flex flex-wrap gap-2"
          role="group"
          aria-label={
            tab === 'unmatched' ? 'No matches by download group' : 'Failures by download group'
          }
        >
          {failureGroups.map(([id, rows]) => (
            <button
              key={id}
              className={cx(
                'max-w-full truncate rounded-pill border px-3 py-[7px] text-small coarse:min-h-11',
                selectedGroup === id
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line bg-sunken text-muted',
              )}
              aria-pressed={selectedGroup === id}
              onClick={() => setGroup(selectedGroup === id ? null : id)}
            >
              {id === '' ? 'Single tracks' : batchName(rows)} ({rows.length})
            </button>
          ))}
        </div>
      )}
      {tab === 'history' ? (
        <History />
      ) : jobs.length ? (
        <JobList jobs={jobs} />
      ) : queue.isError ? null : (
        <EmptyPanel>
          <ArrowDownToLine size={36} />
          <h2>
            {queue.isPending
              ? 'Loading queue…'
              : tab === 'unmatched'
                ? 'No tracks are waiting for a match'
                : tab === 'errors'
                  ? 'No failed downloads'
                  : `No ${tab === 'queue' ? 'queued' : tab} downloads`}
          </h2>
          <Link to="/search" data-ui="button" className={buttonClassName('primary')}>
            Find a track
          </Link>
        </EmptyPanel>
      )}
    </>
  )
}
