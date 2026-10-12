/** "3:07", or "1:02:07" from an hour up. Seconds are dropped, never rounded up. */
export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** "1.4 GB", "34.2 MB" or "512 KB". Anything above nothing reads as at least 1 KB. */
export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`
}
