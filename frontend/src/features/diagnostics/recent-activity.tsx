import { useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Trash2 } from 'lucide-react'
import { z } from 'zod'

import { api } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner } from '../../ui'
import { groupRuns } from './activity-runs'
import { shortAge } from './short-age'

const activitySchema = z.object({
  events: z.array(z.object({ id: z.number(), kind: z.string(), created_at: z.string() })),
  count: z.number(),
  cursor: z.number(),
})
const labels: Record<string, string> = {
  'settings.updated': 'Settings saved',
  'library.updated': 'Library index updated',
  'source.updated': 'Source connection updated',
  'job.updated': 'Download updated',
  'job.created': 'Download queued',
  'queue.updated': 'Queue updated',
}

type ActivityEvent = z.infer<typeof activitySchema>['events'][number]

const eventName = (kind: string) => labels[kind] ?? kind.replaceAll('.', ' ')

function EventRow({ event, side }: { event: ActivityEvent; side: boolean }) {
  if (side) {
    return (
      <li className="grid grid-cols-[60px_minmax(0,1fr)] gap-[10px] py-[8px] text-[12.5px]">
        <time className="pt-[2px] font-mono text-[10.5px] text-faint" dateTime={event.created_at}>
          {shortAge(new Date(event.created_at), new Date())}
        </time>
        <span className="flex items-baseline gap-[8px]">
          <i className="size-[6px] flex-none -translate-y-px rounded-full bg-muted" />
          {eventName(event.kind)}
        </span>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 border-t border-line px-[16px] py-[11px] text-small first:border-t-0 max-phone:gap-2">
      <span className="size-[8px] flex-none rounded-full bg-muted" />
      <span>{eventName(event.kind)}</span>
      <time className="ml-auto text-caption text-faint" dateTime={event.created_at}>
        {new Date(event.created_at).toLocaleString()}
      </time>
      <code className="text-caption text-faint">#{event.id}</code>
    </li>
  )
}

/** "9/19/2026, 10:01 AM to 10:09 AM", naming the date again only when the run crosses midnight. */
function timeRange(from: string, to: string) {
  const start = new Date(from)
  const end = new Date(to)
  const sameDay = start.toDateString() === end.toDateString()
  const finish = sameDay ? end.toLocaleTimeString() : end.toLocaleString()
  return `${start.toLocaleString()} to ${finish}`
}

/**
 * The feed of what the server has done. On a page of its own it is a full-width list under the
 * checks. `side` is the Listening room's Diagnostics, where it is a narrow panel beside them, the
 * time in a mono column on the left.
 */
export function RecentActivity({ side = false }: { side?: boolean }) {
  const client = useQueryClient()
  // Runs are opened by the id of their oldest event, which stays put as newer events join the run.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: ({ signal }) => api('activity', activitySchema, { signal }),
  })
  const clear = useMutation({
    mutationFn: (through: number) =>
      api('activity', activitySchema, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ through }),
      }),
    onSuccess: (data) => {
      client.setQueryData(['activity'], data)
      void client.invalidateQueries({ queryKey: ['diagnostics'] })
    },
  })
  return (
    <section
      className={cx(side ? 'min-w-0 rounded-[18px] bg-sunken px-[18px] py-[16px]' : 'mt-8')}
      aria-labelledby="activity-heading"
    >
      <div
        className={cx('flex items-center justify-between gap-3', side ? 'mb-[10px]' : 'mb-[12px]')}
      >
        <h2 id="activity-heading" className="text-strong">
          Recent activity
        </h2>
        <Button
          disabled={!activity.data?.count || clear.isPending}
          onClick={() => activity.data && clear.mutate(activity.data.cursor)}
        >
          <Trash2 size={15} />
          {clear.isPending ? 'Clearing…' : 'Clear all'}
        </Button>
      </div>
      {activity.isPending && <p role="status">Loading activity…</p>}
      {activity.isError && (
        <ErrorBanner role="alert">
          {activity.error.message}{' '}
          <button type="button" onClick={() => void activity.refetch()}>
            Retry
          </button>
        </ErrorBanner>
      )}
      {clear.isError && <ErrorBanner role="alert">{clear.error.message}</ErrorBanner>}
      {activity.data &&
        (activity.data.count ? (
          <>
            <p className="mb-[8px] text-small text-muted">
              Showing the latest {activity.data.events.length} of {activity.data.count} entries.
            </p>
            <div
              className={cx(
                'max-h-[320px] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
                side ? 'pr-2' : 'rounded-[12px] border border-line',
              )}
              role="region"
              aria-label="Recent activity entries"
              tabIndex={0}
            >
              <ul className="m-0 list-none p-0">
                {groupRuns(activity.data.events).map((run) => {
                  const newest = run.events[0]
                  const oldest = run.events[run.events.length - 1]
                  if (!newest || !oldest) return null
                  if (run.events.length === 1) {
                    return <EventRow key={newest.id} event={newest} side={side} />
                  }
                  const open = expanded.has(oldest.id)
                  return (
                    <li
                      key={oldest.id}
                      className={cx('text-small', !side && 'border-t border-line first:border-t-0')}
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        className={cx(
                          'flex w-full items-center gap-3 border-0 bg-transparent text-left text-small text-text max-phone:gap-2 coarse:min-h-11',
                          side ? 'py-[8px]' : 'px-[16px] py-[11px]',
                        )}
                        onClick={() =>
                          setExpanded((set) => {
                            const next = new Set(set)
                            if (!next.delete(oldest.id)) next.add(oldest.id)
                            return next
                          })
                        }
                      >
                        <ChevronRight
                          size={14}
                          className={cx('flex-none text-muted', open && 'rotate-90')}
                        />
                        <span>{eventName(run.kind)}</span>
                        <span className="rounded-pill bg-raised px-[8px] py-[1px] text-caption text-muted">
                          ×{run.events.length}
                        </span>
                        <span
                          className={cx('ml-auto text-caption text-faint', side && 'font-mono')}
                        >
                          {side
                            ? shortAge(new Date(newest.created_at), new Date())
                            : timeRange(oldest.created_at, newest.created_at)}
                        </span>
                      </button>
                      {open && (
                        <ul className="m-0 list-none p-0 pl-[26px]">
                          {run.events.map((event) => (
                            <EventRow key={event.id} event={event} side={side} />
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        ) : (
          <p className="text-muted" role="status">
            No recent activity. New events will appear here.
          </p>
        ))}
      <p className="mt-[8px] text-small text-muted">
        Clears this activity feed. Download history and live update records are kept separately.
      </p>
    </section>
  )
}
