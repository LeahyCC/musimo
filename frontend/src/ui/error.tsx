import type { HTMLAttributes } from 'react'

import { cx } from '../cx'
import type { ClassName } from '../cx'

/** The `.error` look as a class string, for an element the component can't wrap (e.g. `<section>`). */
export function errorBannerClassName(layout: 'block' | 'list' = 'block', className?: ClassName) {
  return cx(
    'rounded-[5px] bg-danger-bg px-[13px] py-[13px] text-small leading-[1.6] text-danger',
    '[&_small]:text-tiny [&>button]:ml-[15px] [&>button]:underline',
    'coarse:[&>button]:min-h-11 coarse:[&>button]:px-[6px]',
    layout === 'list' ? 'my-[12px] grid gap-[5px]' : undefined,
    className,
  )
}

export interface ErrorBannerProps extends HTMLAttributes<HTMLDivElement> {
  /** `list` stacks a heading and one line per reason, e.g. the download failure summary. */
  layout?: 'block' | 'list'
}

/** A danger-colored message box. A bare `<button>` child (e.g. "Retry") gets its own spacing. */
export function ErrorBanner({ layout = 'block', className, ...props }: ErrorBannerProps) {
  return (
    <div data-ui="error-banner" className={errorBannerClassName(layout, className)} {...props} />
  )
}

/** A danger-colored message and its action (e.g. Retry) sharing one wrapping row. */
export function InlineError({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-ui="inline-error"
      className={cx(
        'my-[8px] mb-[18px] flex flex-wrap items-center gap-x-[14px] gap-y-[10px] rounded-md bg-danger-bg px-[13px] py-[13px] text-body text-danger',
        '[&>span]:min-w-0 [&>span]:flex-[1_1_200px] [&>span]:[overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    />
  )
}
