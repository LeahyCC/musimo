import type { ReactNode } from 'react'

import { Folder } from 'lucide-react'

import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { CoverageBar } from '../../ui'
import type { CoverageCounts } from '../../ui'

/** Where the download goes, drawn the same under every catalog hero. */
export function HeroDestination({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[6px] text-small text-faint">
      <Folder size={13} aria-hidden="true" />
      {children}
    </span>
  )
}

/**
 * The top of a catalog album, artist or podcast page, the same in both layouts: the cover, what it
 * is and where it came from, how much of it the library already has, and what to do about the rest.
 * The page passes the pieces; this only arranges them.
 */
export function CatalogHero({
  cover,
  eyebrow,
  source,
  title,
  byline,
  meta,
  coverage,
  actions,
  className,
}: {
  /** The cover or portrait, sized by the page (it is told to fill a square of the right width). */
  cover: ReactNode
  /** "ALBUM · 2018": what this is. */
  eyebrow: string
  /** Which catalog the page came from, in a small outlined chip. */
  source: string
  title: string
  /** The artist link or author, ahead of the meta line. */
  byline?: ReactNode
  /** "10 tracks · 39 min". */
  meta?: ReactNode
  /** Leave out when the page has nothing to count. */
  coverage?: CoverageCounts
  /** The primary action, a secondary one, and the destination. */
  actions: ReactNode
  className?: string
}) {
  const room = useLayout() === 'room'
  return (
    <div
      data-ui="catalog-hero"
      className={cx(
        'mb-[26px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-[28px] gap-y-[14px] max-phone:gap-x-[16px]',
        className,
      )}
    >
      <div className="row-span-2 w-[clamp(120px,22cqi,210px)] self-end max-phone:row-span-1 max-phone:w-[110px] max-phone:self-start">
        {cover}
      </div>
      <div className="min-w-0 self-end max-phone:self-start">
        <div
          className={cx(
            'flex flex-wrap items-center gap-[8px] text-tiny tracking-[0.8px] text-faint',
            room && 'font-mono',
          )}
        >
          {eyebrow.toUpperCase()}
          <span className="rounded-[4px] border border-line-strong px-[6px] py-[2px] tracking-[0.4px] text-muted">
            {source.toUpperCase()}
          </span>
        </div>
        <h1 className="mt-[8px] text-[clamp(26px,4.4cqi,40px)] leading-[1.08] font-semibold tracking-[-1px] [overflow-wrap:anywhere] max-phone:text-[24px]">
          {title}
        </h1>
        {(byline || meta) && (
          <div className="mt-[8px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px] text-lead">
            {byline}
            {byline && meta && (
              <span aria-hidden="true" className="text-line-strong max-phone:hidden">
                ·
              </span>
            )}
            {meta && <span className="text-muted">{meta}</span>}
          </div>
        )}
      </div>
      {/* On a phone the bar and actions take the full width, under the cover. */}
      <div className="min-w-0 max-phone:col-span-2">
        {coverage && <CoverageBar {...coverage} />}
        <div className="album-actions mt-[18px] flex flex-wrap items-center gap-[8px]">
          {actions}
        </div>
      </div>
    </div>
  )
}
