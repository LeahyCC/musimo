import type { LibraryAlbum } from '../../api'
import { cx } from '../../lib/cx'

/** Play counts per release, oldest to newest, as a rough popularity trend. */
export function PopularityChart({ albums }: { albums: LibraryAlbum[] }) {
  const points = albums.filter((album) => album.year).sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  const peak = points.reduce((most, album) => Math.max(most, album.playCount), 0)
  if (points.length < 2 || peak === 0)
    return (
      <p className="text-small text-muted">
        Not enough plays are recorded for these releases to chart yet.
      </p>
    )
  const width = 620
  const height = 170
  const left = 44
  const right = 14
  const top = 16
  const bottom = 30
  const x = (index: number) => left + (index * (width - left - right)) / (points.length - 1)
  const y = (plays: number) => top + (1 - plays / peak) * (height - top - bottom)
  const line = points
    .map(
      (album, index) =>
        `${index ? 'L' : 'M'}${x(index).toFixed(1)} ${y(album.playCount).toFixed(1)}`,
    )
    .join(' ')
  const busiest = points.reduce((best, album) => (album.playCount > best.playCount ? album : best))
  const tickClass = 'fill-muted text-tiny'
  return (
    <div className="grid gap-[8px] overflow-x-auto rounded-[10px] border border-line bg-sunken p-[14px]">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        className="h-auto w-full min-w-[320px] max-w-[620px]"
        aria-label={`Play counts from ${points[0]?.year} to ${points[points.length - 1]?.year}. ${busiest.name} leads with ${busiest.playCount} plays.`}
      >
        <line x1={left} y1={y(0)} x2={width - right} y2={y(0)} className="stroke-line" />
        <line x1={left} y1={top} x2={left} y2={y(0)} className="stroke-line" />
        <text x={left - 8} y={top + 4} className={cx(tickClass, '[text-anchor:end]')}>
          {peak}
        </text>
        <text x={left - 8} y={y(0) + 4} className={cx(tickClass, '[text-anchor:end]')}>
          0
        </text>
        <path d={line} className="fill-none stroke-accent stroke-2 [stroke-linejoin:round]" />
        {points.map((album, index) => (
          <circle
            key={album.id}
            cx={x(index)}
            cy={y(album.playCount)}
            r={4}
            className="fill-accent"
          >
            <title>{`${album.name} (${album.year}) · ${album.playCount} plays`}</title>
          </circle>
        ))}
        {points.map((album, index) =>
          index === 0 || index === points.length - 1 ? (
            <text
              key={`${album.id}-label`}
              x={x(index)}
              y={height - 9}
              className={cx(tickClass, index === 0 ? '[text-anchor:start]' : '[text-anchor:end]')}
            >
              {album.year}
            </text>
          ) : null,
        )}
      </svg>
      <small className="text-small text-muted">
        {busiest.name} is the most played at {busiest.playCount.toLocaleString()} plays.
      </small>
    </div>
  )
}
