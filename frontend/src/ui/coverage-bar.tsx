import { cx } from '../lib/cx'

export interface CoverageCounts {
  /** In the library as this exact release. */
  owned: number
  /** In the library, but from another edition of the release. */
  otherEdition: number
  /** Waiting in the download queue. */
  queued: number
  missing: number
}

type CoveragePart = { key: keyof CoverageCounts; count: number; label: string; swatch: string }

/** The parts worth drawing, in bar order, each with its legend text. Empty parts are left out. */
export function coverageParts(counts: CoverageCounts): CoveragePart[] {
  const total = counts.owned + counts.otherEdition + counts.queued + counts.missing
  const parts: CoveragePart[] = [
    { key: 'owned', count: counts.owned, label: `${counts.owned} in library`, swatch: 'bg-accent' },
    {
      key: 'otherEdition',
      count: counts.otherEdition,
      label: `${counts.otherEdition} other edition`,
      swatch: 'bg-partial',
    },
    { key: 'queued', count: counts.queued, label: `${counts.queued} queued`, swatch: 'bg-muted' },
    {
      key: 'missing',
      count: counts.missing,
      label: `${counts.missing} missing of ${total}`,
      swatch: 'bg-line',
    },
  ]
  return parts.filter((part) => part.count > 0)
}

export interface CoverageBarProps extends CoverageCounts {
  className?: string
}

/**
 * How much of a catalog album, artist or podcast is already here: a stacked bar of owned, other
 * edition, queued and missing, with a legend that says the same in words. The bar is decoration;
 * the legend is what a screen reader reads.
 */
export function CoverageBar({ className, ...counts }: CoverageBarProps) {
  const parts = coverageParts(counts)

  return (
    <div data-ui="coverage-bar" className={cx('max-w-[440px]', className)}>
      <div aria-hidden="true" className="flex h-[6px] gap-[2px] overflow-hidden rounded-[6px]">
        {parts.map((part) => (
          <span key={part.key} className={part.swatch} style={{ flexGrow: part.count }} />
        ))}
      </div>
      <ul className="m-0 mt-[7px] flex list-none flex-wrap gap-x-[14px] gap-y-[4px] p-0 text-small text-muted">
        {parts.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-[6px]">
            <i aria-hidden="true" className={cx('size-[7px] rounded-[2px]', part.swatch)} />
            {part.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
