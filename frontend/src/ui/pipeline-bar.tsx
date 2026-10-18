import { cx } from '../lib/cx'

export const PIPELINE_STEPS = ['match', 'download', 'convert', 'tag', 'move'] as const
export type PipelineStep = (typeof PIPELINE_STEPS)[number]

const stepNames: Record<PipelineStep, string> = {
  match: 'Match',
  download: 'Download',
  convert: 'Convert',
  tag: 'Tag',
  move: 'Move',
}

/** `good` is running normally, `warn` is held up (waiting, retrying), `danger` has failed. */
export type PipelineTone = 'good' | 'warn' | 'danger'

const toneWords: Record<PipelineTone, string> = {
  good: 'in progress',
  warn: 'held up',
  danger: 'failed',
}

const toneSwatch: Record<PipelineTone, string> = {
  good: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
}

export type PipelineState = 'done' | 'current' | 'pending'

/** Steps before the current one are done, the ones after it are pending. `done` finishes all five. */
export function pipelineStates(current: PipelineStep | 'done'): PipelineState[] {
  const at = current === 'done' ? PIPELINE_STEPS.length : PIPELINE_STEPS.indexOf(current)
  return PIPELINE_STEPS.map((_, index) =>
    index < at ? 'done' : index === at ? 'current' : 'pending',
  )
}

/** What the bar says in words, e.g. "Download, step 2 of 5, failed". */
export function pipelineText(current: PipelineStep | 'done', tone: PipelineTone) {
  if (current === 'done') return `All ${PIPELINE_STEPS.length} steps done`
  const step = PIPELINE_STEPS.indexOf(current) + 1
  return `${stepNames[current]}, step ${step} of ${PIPELINE_STEPS.length}, ${toneWords[tone]}`
}

export interface PipelineBarProps {
  /** The step a job is on, or `done` once it has moved into the library. */
  current: PipelineStep | 'done'
  tone?: PipelineTone
  className?: string
}

/**
 * A download job's five steps, Match, Download, Convert, Tag and Move, as five short segments.
 * Color alone never carries the state: the bar says where the job is in hidden text, and each
 * segment names its step on hover.
 */
export function PipelineBar({ current, tone = 'good', className }: PipelineBarProps) {
  const states = pipelineStates(current)

  return (
    <span data-ui="pipeline-bar" data-tone={tone} className={cx('flex gap-[3px]', className)}>
      <span className="sr-only">{pipelineText(current, tone)}</span>
      {PIPELINE_STEPS.map((step, index) => (
        <span
          key={step}
          aria-hidden="true"
          title={stepNames[step]}
          data-state={states[index]}
          className={cx(
            'h-[4px] flex-1 rounded-[2px]',
            states[index] === 'done'
              ? 'bg-accent'
              : states[index] === 'current'
                ? toneSwatch[tone]
                : 'bg-line',
          )}
        />
      ))}
    </span>
  )
}
