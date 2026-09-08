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
      { rootMargin: '600px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  return (
    <div className="infinite-sentinel" ref={sentinel}>
      {loading && <small role="status">Loading more…</small>}
    </div>
  )
}
