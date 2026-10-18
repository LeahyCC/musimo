import type { ReactNode } from 'react'

import { cx } from '../lib/cx'

export type StatTileTone = 'muted' | 'good' | 'warn' | 'danger'

const deltaToneClassNames: Record<StatTileTone, string> = {
  muted: 'text-muted',
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-danger',
}

export interface StatTileProps {
  /** The small caps line on top, e.g. "LISTENED". */
  label: string
  value: ReactNode
  /** The line under the value, e.g. "+2h on last week". */
  delta?: ReactNode
  deltaTone?: StatTileTone
  className?: string
}

/** One number on the Home dashboard: a label, the value, and an optional line comparing it. */
export function StatTile({ label, value, delta, deltaTone = 'muted', className }: StatTileProps) {
  return (
    <div
      data-ui="stat-tile"
      className={cx(
        'flex min-h-[104px] flex-col justify-between gap-[6px] rounded-[18px] bg-raised p-[16px]',
        className,
      )}
    >
      <span className="font-mono text-[10.5px] tracking-[0.6px] text-faint uppercase">{label}</span>
      <span className="text-[26px] font-semibold tracking-[-0.8px]">{value}</span>
      {delta !== undefined && (
        <span className={cx('text-small', deltaToneClassNames[deltaTone])}>{delta}</span>
      )}
    </div>
  )
}
