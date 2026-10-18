import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'

import { api, librarySchema } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, textLinkClassName } from '../../ui'
import { PetFace } from '../music-bot/pet-host'
import { useDiagnostics } from './use-home-data'
import { COMPOSE_SNIPPET, welcomeSteps } from './welcome-steps'
import type { StepState } from './welcome-steps'

const lineClassNames: Record<StepState, string> = {
  done: 'border-line',
  now: 'border-good-line bg-raised',
  next: 'border-line',
}
const dotClassNames: Record<StepState, string> = {
  done: 'bg-accent text-accent-ink',
  now: 'bg-active text-accent',
  next: 'bg-hover text-faint',
}

/** What Home shows instead of the dashboard while the library holds nothing. */
export function Welcome() {
  const client = useQueryClient()
  const diagnostics = useDiagnostics()
  const scan = useMutation({
    mutationFn: () => api('library/scan', librarySchema, { method: 'POST' }),
    onSuccess: (data) => {
      client.setQueryData(['library'], data)
      void client.invalidateQueries({ queryKey: ['diagnostics'] })
    },
  })
  const steps = welcomeSteps(diagnostics.data)
  const scanning = diagnostics.data?.library.status === 'scanning'
  const mounted = steps[0]?.state === 'done'

  return (
    <div className="mx-auto max-w-[760px] pt-[8px] pb-[24px]">
      <div className="mb-[28px] flex items-center gap-[16px]">
        <PetFace size={56} />
        <div>
          <h1 className="m-0">Let&rsquo;s find your music</h1>
          <p className="mt-[6px] text-lead text-muted">
            Musimo is running, but its library is empty. Three steps and Home fills in.
          </p>
        </div>
      </div>
      <ol className="m-0 grid list-none gap-[10px] p-0">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            className={cx(
              'grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-[14px] rounded-[14px] border px-[18px] py-[16px] max-phone:grid-cols-[32px_minmax(0,1fr)]',
              lineClassNames[step.state],
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                'grid size-[32px] place-items-center rounded-full font-bold',
                dotClassNames[step.state],
              )}
            >
              {step.state === 'done' ? <Check size={16} /> : index + 1}
            </span>
            <div className="min-w-0">
              <h2 className="m-0 text-strong">
                {step.title}
                <span className="sr-only">{step.state === 'done' ? ' (done)' : ''}</span>
              </h2>
              <p className="mt-[4px] text-body leading-[1.55] text-muted">{step.detail}</p>
              {step.id === 'collection' && (
                <pre
                  tabIndex={0}
                  aria-label="Compose example"
                  className="mt-[10px] mb-0 overflow-auto rounded-[8px] border border-line bg-sidebar px-[12px] py-[10px] font-mono text-small leading-[1.6] text-accent"
                >
                  {COMPOSE_SNIPPET}
                </pre>
              )}
            </div>
            {step.id === 'collection' && (
              <Button
                variant={step.state === 'now' ? 'primary' : 'default'}
                disabled={diagnostics.isFetching}
                onClick={() => void diagnostics.refetch()}
                className="max-phone:col-start-2 max-phone:justify-self-start"
              >
                Check again
              </Button>
            )}
            {step.id === 'scan' && (
              <Button
                variant={step.state === 'now' && mounted ? 'primary' : 'default'}
                disabled={!mounted || scanning || scan.isPending}
                onClick={() => scan.mutate()}
                className="max-phone:col-start-2 max-phone:justify-self-start"
              >
                {scanning ? 'Scanning…' : 'Start scan'}
              </Button>
            )}
          </li>
        ))}
      </ol>
      {(scan.isError || diagnostics.isError) && (
        <ErrorBanner role="alert" className="mt-[14px]">
          {scan.error?.message ?? diagnostics.error?.message}
        </ErrorBanner>
      )}
      <p className="mt-[24px] flex flex-wrap items-center gap-x-[12px] gap-y-[6px] border-t border-line pt-[18px] text-body text-muted">
        <span className="min-w-[240px] flex-1">
          Not ready to scan yet? You can still search the catalog and download.
        </span>
        <Link to="/search" className={textLinkClassName()}>
          Start by searching the catalog
        </Link>
      </p>
    </div>
  )
}
