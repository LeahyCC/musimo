import { useEffect, useRef } from 'react'

export function InfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
}) {
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || loading) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore()
      },
      // A page and a half of runway: fetching starts well before the bottom is
      // reached, so the scroll rarely has to wait on the next page.
      { rootMargin: '1000px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  return (
    <div className="flex min-h-[42px] items-center justify-center text-muted" ref={sentinel}>
      {loading && <small role="status">Loading more…</small>}
    </div>
  )
}
