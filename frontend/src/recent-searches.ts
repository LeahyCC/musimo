export const SEARCHES_KEY = 'musimo.recent-searches'
export const SEARCHES_LIMIT = 8
/** Shorter than this is a keystroke on the way to a search, not a search. */
const MIN_LENGTH = 2

/** Whatever was stored, or nothing when it is missing, unreadable or not a list of text. */
export function readSearches(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEARCHES_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const texts = parsed.filter((item): item is string => typeof item === 'string')
    return texts.slice(0, SEARCHES_LIMIT)
  } catch {
    return []
  }
}

export function writeSearches(searches: readonly string[]) {
  try {
    localStorage.setItem(SEARCHES_KEY, JSON.stringify(searches))
  } catch {
    /* Browser storage is optional. */
  }
}

/**
 * The list with `query` searched just now: newest first, capped, and free of repeats. The search
 * box searches as a person types, so a query that only extends the newest one ("dat", then "daft")
 * replaces it rather than stacking up half-typed words.
 */
export function addSearch(searches: readonly string[], query: string): string[] {
  const text = query.trim().replace(/\s+/g, ' ')
  if (text.length < MIN_LENGTH) return [...searches]
  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()
  const [newest, ...older] = searches
  const extendsNewest =
    newest !== undefined && text.toLocaleLowerCase().startsWith(newest.toLocaleLowerCase())
  const rest = extendsNewest ? older : searches
  return [text, ...rest.filter((item) => !same(item, text))].slice(0, SEARCHES_LIMIT)
}
