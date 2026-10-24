import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual'

import { cx } from '../../lib/cx'
import { usePhone } from '../../lib/use-phone'
import { revealBrowseItem } from './browse-anchor'
import type { ViewMode } from './collection-items'

/**
 * The virtualizer for a browse list, on whichever scroller the shell uses: the
 * Listening room's `#main` pane on a wide window, the window everywhere else.
 * Returns the container ref to attach, the measured width, and how far the
 * container sits from the top of its scroller (the window virtualizer's margin).
 */
export function useBrowseVirtual({
  countFor,
  estimate,
  estimateFor,
  overscan = 4,
  room,
  enabled = true,
}: {
  /** Row count for a measured container width (grids learn their column count from it). */
  countFor: (width: number) => number
  estimate: number
  /** Row height for a measured width, when it depends on the column width (grids). */
  estimateFor?: (width: number) => number
  overscan?: number
  room: boolean
  enabled?: boolean
}) {
  const phone = usePhone()
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [scrollMargin, setScrollMargin] = useState(0)
  const useElement = room && !phone

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      setWidth(element.clientWidth)
      setScrollMargin(element.getBoundingClientRect().top + window.scrollY)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [useElement])

  const count = countFor(width)
  const rowEstimate = estimateFor ? estimateFor(width) : estimate
  const elementVirtual = useVirtualizer({
    count,
    getScrollElement: () => document.querySelector('#main'),
    estimateSize: () => rowEstimate,
    overscan,
    enabled: enabled && useElement,
  })
  const windowVirtual = useWindowVirtualizer({
    count,
    estimateSize: () => rowEstimate,
    overscan,
    scrollMargin,
    enabled: enabled && !useElement,
  })
  return {
    container,
    width,
    useElement,
    scrollMargin,
    virtual: useElement ? elementVirtual : windowVirtual,
  }
}

/**
 * A windowed browse grid (or list) for Albums and Artists.
 *
 * Only the rows near the scroll position are in the DOM, so a library of thousands
 * costs the same as a library of dozens. The scroller is the one the shell already
 * uses — the Listening room's `#main` pane on a wide window, the window everywhere
 * else — so the page keeps its one natural scroll and the router's scroll
 * restoration keeps working on it.
 *
 * `revealId` asks for one item to be brought on screen and focused: the row is
 * scrolled to first, then the card itself is focused once it has rendered.
 */
export function VirtualBrowse<T extends { id: string }>({
  items,
  kind,
  layout,
  room,
  revealId,
  onRevealDone,
  onNearEnd,
  cacheKey = '',
  renderItem,
}: {
  items: T[]
  kind: 'album' | 'artist'
  layout: ViewMode
  room: boolean
  revealId: string
  onRevealDone: (id: string) => void
  /** Called while the rendered range is within a few rows of the loaded end, so the
   * next page is fetched ahead of the scroll instead of at the bottom of it. */
  onNearEnd?: () => void
  /** What besides the items themselves the cards depend on; a change rebuilds them. */
  cacheKey?: string
  renderItem: (item: T) => ReactNode
}) {
  const gap = layout === 'list' ? (room ? 2 : 0) : room ? 14 : 18
  const minColumn = kind === 'album' ? (room ? 150 : 156) : room ? 130 : 140
  // A first pass at the column count, before the container has been measured.
  const columnsFor = (measured: number) =>
    layout === 'list' ? 1 : Math.max(1, Math.floor(((measured || 1024) + gap) / (minColumn + gap)))
  const { container, width, useElement, scrollMargin, virtual } = useBrowseVirtual({
    countFor: (measured) => Math.ceil(items.length / columnsFor(measured)),
    estimate: 200,
    // A row is a square cover, its two lines of copy and the gap under it, so the first
    // layout is already the right height and rows do not jump as they are measured.
    estimateFor: (measured) => {
      if (layout === 'list') return 56 + gap
      const cols = columnsFor(measured)
      const itemWidth = measured ? (measured - (cols - 1) * gap) / cols : minColumn
      return itemWidth + 54 + (room ? 22 : 24)
    },
    overscan: 3,
    room,
  })
  const columns = columnsFor(width)
  const rows = Math.ceil(items.length / columns)

  // Scrolling re-renders the window on every frame. A card that is already on screen
  // gets its previous element back, so React leaves its subtree (and its images) alone
  // and only the rows entering the window are real work. An entry is only reused while
  // it still stands for the same item object, so a refetch that changes a card rebuilds
  // just that card; a signature change (layout, busy state) drops the whole cache
  // during render, before anything stale can be handed out.
  const cacheSignature = `${cacheKey}:${kind}:${layout}`
  const [heldSignature, setHeldSignature] = useState(cacheSignature)
  const elementCache = useRef(new Map<string, { item: T; element: ReactNode }>())
  if (heldSignature !== cacheSignature) {
    setHeldSignature(cacheSignature)
    elementCache.current.clear()
  }

  const renderCached = (item: T) => {
    const cached = elementCache.current.get(item.id)
    if (cached && cached.item === item) return cached.element
    const element = renderItem(item)
    elementCache.current.set(item.id, { item, element })
    return element
  }

  const rangeEnd = virtual.range?.endIndex ?? -1
  useEffect(() => {
    if (onNearEnd && rangeEnd >= rows - 3) onNearEnd()
  }, [onNearEnd, rangeEnd, rows])

  useEffect(() => {
    if (!revealId) return
    const index = items.findIndex((item) => item.id === revealId)
    if (index < 0) return
    virtual.scrollToIndex(Math.floor(index / columns), { align: 'center' })
    // The row may need a few frames to mount and measure after a long jump; keep
    // asking for about a second rather than giving up after one frame.
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const revealed = revealBrowseItem(revealId)
      if (revealed || attempts >= 10) {
        clearInterval(timer)
        // Done either way: after ~1s the row is not coming, and leaving the request
        // open would re-yank the scroll on every later render.
        onRevealDone(revealId)
      }
    }, 100)
    return () => clearInterval(timer)
    // `virtual` is a new object on every render, so it stays out of the dependencies.
  }, [columns, items, onRevealDone, revealId])

  return (
    <div
      ref={container}
      className={cx(
        'relative w-full',
        layout === 'list' && !room && 'overflow-hidden rounded-[12px] border border-line',
      )}
      style={{ height: virtual.getTotalSize() - (useElement ? 0 : scrollMargin) }}
    >
      {virtual.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtual.measureElement}
          className={cx(
            'absolute top-0 left-0 grid w-full',
            layout === 'grid' && (room ? 'gap-x-[14px]' : 'gap-x-[18px]'),
            layout === 'list' && !room && row.index > 0 && 'border-t border-line',
          )}
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            paddingBottom: layout === 'list' ? gap : room ? 22 : 24,
            transform: `translateY(${row.start - (useElement ? 0 : scrollMargin)}px)`,
          }}
        >
          {items.slice(row.index * columns, row.index * columns + columns).map(renderCached)}
        </div>
      ))}
    </div>
  )
}
