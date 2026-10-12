import { useRef } from 'react'

import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, ChevronUp, X } from 'lucide-react'

import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { IconButton } from '../../ui'
import { JobList } from './job-list'
import { activeJob, useJobs } from './jobs'
import { QueueControls } from './queue-controls'

export function QueueDock() {
  const dialog = useRef<HTMLDialogElement>(null)
  const queue = useJobs()
  const active = (queue.data?.jobs ?? []).filter(activeJob)
  const speed = active.reduce((total, job) => total + job.speed, 0)
  // A floating dock advertising an empty queue has nothing to offer over the Downloads nav
  // link, and on short pages (e.g. the search-empty home) it has nowhere to float without
  // sitting on top of other content, since there's no space reserved for it.
  if (!active.length) return null
  return (
    <>
      {/* The dock floats above the footer player, and on a phone it would land on the Save
          button or the last row's controls, so there the count moves into the bottom bar. */}
      <button
        className="fixed right-[calc(24px+var(--safe-right))] bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+12px)] z-dock flex items-center gap-[8px] rounded-pill border-0 bg-accent-hot px-[15px] py-[11px] text-small font-bold text-accent-ink shadow-[0_4px_24px_color-mix(in_oklab,var(--color-shadow)_33%,transparent)] max-phone:hidden"
        onClick={() => dialog.current?.showModal()}
        aria-label={`Open queue, ${active.length} active downloads`}
      >
        <ArrowDownToLine size={16} />
        {active.length} · {speed ? `${formatBytes(speed)}/s` : 'Queue'}
        <ChevronUp size={14} />
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {active.length} active download{active.length === 1 ? '' : 's'}
      </span>
      <dialog
        className={cx(
          'queue-sheet',
          'fixed inset-x-0 top-auto bottom-0 mx-auto w-[min(1100px,100%)] max-h-[78dvh] overflow-auto overscroll-contain rounded-t-[20px] border border-line-strong bg-raised px-6 pt-6 text-text',
          'pb-[calc(24px+var(--safe-bottom))] max-phone:px-4 max-phone:pt-4 max-phone:pb-[calc(16px+var(--safe-bottom))]',
        )}
        ref={dialog}
        aria-label="Download queue"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <header className="mb-[18px] flex items-center gap-6">
          <h2 className="flex-1">Download queue</h2>
          <Link
            className="coarse:inline-flex coarse:min-h-11 coarse:items-center"
            to="/downloads"
            onClick={() => dialog.current?.close()}
          >
            Full page
          </Link>
          <IconButton
            variant="outlined"
            aria-label="Close queue"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </IconButton>
        </header>
        <QueueControls />
        {active.length ? (
          <JobList jobs={active} />
        ) : (
          <p className="py-[30px]">Nothing queued. Add a track from search.</p>
        )}
      </dialog>
    </>
  )
}
