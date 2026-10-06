const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// Each unit and how many seconds it takes to be worth naming, largest first.
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "5 minutes ago", "yesterday". Under a minute, or a clock that ran backwards, is "just now". */
export function relativeTime(then: number, now: number) {
  const seconds = Math.round((now - then) / 1000)
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit)
  }
  return 'just now'
}
