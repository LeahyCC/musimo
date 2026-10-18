const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * How long ago, in the fewest characters: "NOW", "5M", "2H", "3D", then the date once it is a week
 * old ("OCT 12"). The Listening room's activity column is narrow and set in capitals. A clock that
 * ran backwards reads as now.
 */
export function shortAge(then: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000)
  if (seconds < 60) return 'NOW'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}M`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}H`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}D`

  return `${MONTHS[then.getMonth()]} ${then.getDate()}`
}
