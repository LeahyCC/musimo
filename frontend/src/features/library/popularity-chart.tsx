import type { LibraryAlbum } from '../../api'
import { cx } from '../../lib/cx'

/**
 * Play counts per release, oldest to newest, as bars: the most played is picked out in the
 * accent and the rest sit back. The card carries its own title so it can sit beside the top songs.
 */
export function PopularityChart({ albums }: { albums: LibraryAlbum[] }) {
  const points = albums.filter((album) => album.year).sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  const busiest = points.reduce<LibraryAlbum | undefined>(
    (best, album) => (!best || album.playCount > best.playCount ? album : best),
    undefined,
  )
  const peak = busiest?.playCount ?? 0
  return (
    <section className="popularity-chart w-full min-w-0 max-w-full overflow-hidden rounded-[14px] border border-line bg-raised px-[18px] py-[16px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[8px] gap-y-[2px]">
        <h2 className="text-strong">Popularity</h2>
        <span className="text-tiny text-faint">Plays by release year</span>
      </div>
      {busiest && points.length >= 2 && peak > 0 ? (
        <>
          <div
            role="img"
            className="mt-[16px] flex h-[150px] items-end gap-[8px] overflow-x-auto"
            aria-label={`Play counts from ${points[0]?.year} to ${points[points.length - 1]?.year}. ${busiest.name} leads with ${busiest.playCount} plays.`}
          >
            {points.map((album) => (
              <div
                key={album.id}
                title={`${album.name} (${album.year}) · ${album.playCount} plays`}
                className="flex h-full min-w-[28px] flex-1 flex-col items-center justify-end gap-[6px]"
              >
                <span className="font-mono text-caption text-muted">{album.playCount}</span>
                <div
                  className={cx(
                    'w-full rounded-t-[4px] rounded-b-[2px]',
                    album === busiest ? 'bg-accent' : 'bg-chart-idle',
                  )}
                  style={{ height: `${Math.max(2, Math.round((album.playCount / peak) * 78))}%` }}
                />
                <span className="font-mono text-caption text-faint">{album.year}</span>
              </div>
            ))}
          </div>
          <small className="mt-[10px] block text-small text-muted">
            {busiest.name} is the most played at {busiest.playCount.toLocaleString()} plays.
          </small>
        </>
      ) : (
        <p className="mt-[10px] text-small text-muted">
          Not enough plays are recorded for these releases to chart yet.
        </p>
      )}
    </section>
  )
}
