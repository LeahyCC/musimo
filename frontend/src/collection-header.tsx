import type { ReactNode } from 'react'

import { cx } from './cx'

/**
 * The artwork square of a library detail page: one cover, a 2x2 mosaic when four different covers
 * are on hand, or the fallback icon. `round` is for an artist so it never reads as an album.
 */
export function CollectionCover({
  urls,
  round = false,
  fallback,
}: {
  urls: string[]
  round?: boolean
  fallback: ReactNode
}) {
  const mosaic = urls.length >= 4
  return (
    <span
      className={cx(
        'collection-cover grid aspect-square w-full place-items-center overflow-hidden border border-line bg-raised text-faint [&>svg]:h-[40%] [&>svg]:w-[40%]',
        round ? 'rounded-pill' : 'rounded-[10px]',
      )}
    >
      {mosaic ? (
        <span className="grid h-full w-full grid-cols-2 grid-rows-2">
          {urls.slice(0, 4).map((url) => (
            <img key={url} src={url} alt="" className="h-full w-full object-cover" />
          ))}
        </span>
      ) : urls[0] ? (
        <img src={urls[0]} alt="" className="h-full w-full object-cover" />
      ) : (
        fallback
      )}
    </span>
  )
}

/**
 * What an album, artist or playlist page opens with, matching the catalog album page: the cover,
 * a small eyebrow, the title, an optional byline and meta line, then the page's actions as
 * children. A long title stops at two lines. A phone puts a smaller cover beside the text and gives
 * the actions their own row underneath both, so the list below starts on the first screen.
 */
export function CollectionHeader({
  cover,
  eyebrow,
  title,
  titleIcon,
  byline,
  meta,
  className,
  children,
}: {
  cover: ReactNode
  eyebrow: string
  title: string
  titleIcon?: ReactNode
  byline?: ReactNode
  meta?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cx(
        'collection-header flex items-center gap-[28px]',
        'max-phone:grid max-phone:grid-cols-[104px_minmax(0,1fr)] max-phone:items-start max-phone:gap-x-[14px] max-phone:gap-y-[12px]',
        className,
      )}
    >
      <div className="w-[190px] flex-none max-phone:w-[104px]">{cover}</div>
      {/* On a phone this wrapper drops out, so its text and its actions become the header's own
          grid items: the text beside the cover, the actions across both columns below. */}
      <div className="grid min-w-0 flex-1 gap-[8px] max-phone:contents">
        <div className="grid min-w-0 gap-[8px] max-phone:gap-[4px]">
          <p className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
            {eyebrow}
          </p>
          <h1 className="flex items-center gap-[8px] text-display max-phone:text-[24px]">
            {titleIcon}
            <span className="line-clamp-2 min-w-0 break-words">{title}</span>
          </h1>
          {byline}
          {meta && <p className="library-count text-body text-muted">{meta}</p>}
        </div>
        <div className="mt-[8px] flex flex-wrap items-center gap-[16px] max-phone:col-span-2 max-phone:mt-0 max-phone:gap-[10px]">
          {children}
        </div>
      </div>
    </div>
  )
}
