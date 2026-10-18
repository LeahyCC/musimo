import type { ReactNode } from 'react'

import { Heart } from 'lucide-react'

import { cx } from '../../lib/cx'

/**
 * The artwork square of a library detail page: one cover, a 2x2 mosaic when four different covers
 * are on hand, or the fallback icon. `round` is for an artist so it never reads as an album.
 * `liked` is the Liked playlist's own gradient with a heart, whatever its songs' covers are.
 */
export function CollectionCover({
  urls,
  round = false,
  liked = false,
  fallback,
}: {
  urls: string[]
  round?: boolean
  liked?: boolean
  fallback: ReactNode
}) {
  const mosaic = urls.length >= 4
  return (
    <span
      className={cx(
        'collection-cover grid aspect-square w-full place-items-center overflow-hidden border border-line bg-raised shadow-[0_24px_50px_-24px_var(--color-shadow)] [&>svg]:h-[40%] [&>svg]:w-[40%]',
        round ? 'rounded-pill' : 'rounded-[14px]',
        !liked && 'text-faint',
        liked &&
          'border-transparent bg-[linear-gradient(160deg,var(--color-accent),color-mix(in_oklab,var(--color-accent)_50%,var(--color-good-line)))] text-accent-ink',
      )}
    >
      {liked ? (
        <Heart fill="currentColor" />
      ) : mosaic ? (
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
 * a mono eyebrow, the title (with an optional action beside it, such as a rename button), an
 * optional byline and meta line, then the page's actions as children. A long title stops at two lines. A phone puts a smaller cover beside the text and gives
 * the actions their own row underneath both, so the list below starts on the first screen.
 */
export function CollectionHeader({
  cover,
  eyebrow,
  title,
  titleAction,
  byline,
  meta,
  className,
  children,
}: {
  cover: ReactNode
  eyebrow: string
  title: string
  titleAction?: ReactNode
  byline?: ReactNode
  meta?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cx(
        'collection-header mb-[12px] flex items-end gap-[28px]',
        'max-phone:grid max-phone:grid-cols-[104px_minmax(0,1fr)] max-phone:items-start max-phone:gap-x-[14px] max-phone:gap-y-[12px]',
        className,
      )}
    >
      <div className="w-[clamp(120px,22%,220px)] min-w-[150px] flex-none max-phone:w-[104px] max-phone:min-w-0">
        {cover}
      </div>
      {/* On a phone this wrapper drops out, so its text and its actions become the header's own
          grid items: the text beside the cover, the actions across both columns below. */}
      <div className="grid min-w-0 flex-1 gap-[8px] max-phone:contents">
        <div className="grid min-w-0 gap-[8px] max-phone:gap-[4px]">
          <p className="font-mono text-tiny tracking-[0.8px] text-faint">{eyebrow}</p>
          <h1 className="flex items-center gap-[10px] text-[clamp(26px,3.4vw,40px)] leading-[1.08] font-semibold tracking-[-1px] max-phone:text-[24px]">
            <span className="line-clamp-2 min-w-0 break-words">{title}</span>
            {titleAction}
          </h1>
          {byline}
          {meta && <p className="library-count text-body text-muted">{meta}</p>}
        </div>
        <div className="mt-[10px] flex flex-wrap items-center gap-[8px] max-phone:col-span-2 max-phone:mt-0 [&_[data-ui=button]]:rounded-[10px]">
          {children}
        </div>
      </div>
    </div>
  )
}
