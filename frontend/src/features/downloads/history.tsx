import { Fragment, useState } from 'react'

import { useInfiniteQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'

import { api, historySchema } from '../../api'
import type { DownloadJob } from '../../api'
import { InfiniteScroll } from '../../components/infinite-scroll'
import { cx } from '../../lib/cx'
import { useDebounced } from '../../lib/use-debounced'
import { EmptyPanel, ErrorBanner, Field } from '../../ui'
import { JobDetails, useJobActions } from './job-list'
import { matchConfidence, reasonName, withDays } from './job-steps'

/** The outcome words and dot color for one finished job. */
function outcome(job: DownloadJob): { text: string; tone: string } {
  if (job.stage === 'done') {
    const confidence = matchConfidence(job)
    return {
      text:
        confidence?.tone === 'warn'
          ? `Downloaded · ${confidence.text.toLowerCase()}`
          : 'Downloaded',
      tone: confidence?.tone === 'warn' ? 'warn' : 'good',
    }
  }
  if (job.stage === 'failed' && job.error_code === 'NO_MATCH')
    return { text: 'No match', tone: 'muted' }
  if (job.stage === 'failed')
    return { text: `Failed · ${reasonName(job.error_code, job.error)}`, tone: 'danger' }
  if (job.stage === 'cancelled') return { text: 'Cancelled', tone: 'muted' }
  return { text: job.stage.replaceAll('_', ' '), tone: 'muted' }
}

const toneText: Record<string, string> = {
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-muted',
}
const toneDot: Record<string, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-muted',
}

/** One finished job. It opens to the same details a card has: the path, matches and tool output. */
function HistoryRow({ job }: { job: DownloadJob }) {
  const actions = useJobActions(job)
  const result = outcome(job)
  const time = new Date(job.created_at * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return (
    <div
      className="job-card border-t border-line px-[14px] py-[9px] text-body"
      id={`job-${job.id}`}
    >
      <div className="grid grid-cols-[52px_10px_minmax(0,1fr)_auto] items-center gap-[12px] max-phone:grid-cols-[44px_10px_minmax(0,1fr)] max-phone:gap-[8px]">
        <span className="font-mono text-tiny text-faint">{time}</span>
        <i
          aria-hidden="true"
          className={cx('h-[8px] w-[8px] rounded-full', toneDot[result.tone])}
        />
        <span className="min-w-0 truncate">
          <strong className="font-medium">{job.meta.title}</strong>
          {job.meta.artist && <span className="text-muted"> · {job.meta.artist}</span>}
        </span>
        <span
          className={cx(
            'text-small whitespace-nowrap max-phone:col-start-3 max-phone:-mt-[6px]',
            toneText[result.tone],
          )}
        >
          {result.text}
        </span>
      </div>
      <JobDetails job={job} actions={actions} className="ml-[74px] max-phone:ml-[62px]" />
    </div>
  )
}

/**
 * Every job that has left the queue, newest first, from the server a hundred at a time. The search
 * and dates are the server's; it has no filter by outcome, so the page offers none.
 */
export function History() {
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
  const jobs = query.data?.pages.flatMap((page) => page.jobs) ?? []
  return (
    <>
      <div className="mb-[14px] flex flex-wrap items-center gap-[8px]">
        <label className="flex h-[36px] max-w-[320px] flex-[1_1_220px] items-center gap-[8px] rounded-[8px] border border-line bg-sunken px-[11px] text-faint coarse:min-h-11">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search download history"
            placeholder="Search history"
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-text outline-0 coarse:text-base"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-small text-muted">
          From
          <Field
            type="date"
            fullWidth={false}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-small text-muted">
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
      {!query.isPending && !query.isError && jobs.length === 0 && (
        <EmptyPanel>
          <h2>Nothing has finished yet.</h2>
        </EmptyPanel>
      )}
      {jobs.length > 0 && (
        <div className="overflow-hidden rounded-[12px] border border-line [&>*:first-child]:border-t-0">
          {withDays(jobs, Date.now()).map(({ row, heading }) => (
            <Fragment key={row.id}>
              {heading && (
                <h3 className="border-t border-line bg-sunken px-[14px] py-[8px] font-mono text-[10.5px] font-normal tracking-[0.6px] text-faint">
                  {heading}
                </h3>
              )}
              <HistoryRow job={row} />
            </Fragment>
          ))}
        </div>
      )}
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
