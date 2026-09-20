/**
 * Groups the editions of one album (the original, its Deluxe and its Remastered) so an artist
 * page can show them as a single card. Two titles group when they are the same after case,
 * punctuation and trailing edition words in brackets or after a dash are removed. Titles that
 * only look alike ("Blue" and "Blue Moon") stay apart.
 */

// Words that say "this is a re-release", not "this is another album".
const EDITION_WORDS = new Set([
  'anniversary',
  'bonus',
  'clean',
  'collectors',
  'complete',
  'deluxe',
  'digital',
  'edition',
  'expanded',
  'explicit',
  'extended',
  'international',
  'legacy',
  'limited',
  'platinum',
  'reissue',
  'reissued',
  'remaster',
  'remastered',
  'remasters',
  'special',
  'standard',
  'super',
  'ultimate',
  'version',
])
// Allowed beside an edition word ("2011 Remaster", "Deluxe with Bonus Tracks") but never enough
// on their own, so a bracketed year or "(Live)" is not mistaken for an edition.
const EDITION_FILLER = new Set([
  'a',
  'and',
  'cd',
  'disc',
  'discs',
  'of',
  'plus',
  'the',
  'track',
  'tracks',
  'with',
])
const NUMBERING = /^\d+(st|nd|rd|th|cd|lp|discs?)?$/

// A trailing "(...)" or "[...]", or a trailing " - ..." with spaces so "Half-Life" is left alone.
const BRACKETED = /\s*[([]([^()[\]]*)[)\]]\s*$/
const DASHED = /\s+[-–—]\s+([^-–—]*)$/

function isEditionSegment(segment: string) {
  const tokens = segment
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return (
    tokens.some((token) => EDITION_WORDS.has(token)) &&
    tokens.every(
      (token) => EDITION_WORDS.has(token) || EDITION_FILLER.has(token) || NUMBERING.test(token),
    )
  )
}

/** Splits a title into the album's own name and the edition words that trail it. */
export function parseAlbumTitle(title: string): { base: string; edition: string } {
  let base = title.trim()
  const segments: string[] = []
  for (;;) {
    const match = BRACKETED.exec(base) ?? DASHED.exec(base)
    const segment = match?.[1]
    if (!match || segment === undefined || !isEditionSegment(segment)) break
    const rest = base.slice(0, match.index).trim()
    // A title that is nothing but edition words keeps them; it has no other name to fall back on.
    if (!rest) break
    segments.unshift(segment.trim())
    base = rest
  }
  return { base, edition: segments.join(', ') }
}

/** Two titles with the same key are the same album. */
export function albumKey(base: string) {
  const key = base
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  // A title made only of punctuation would otherwise share the empty key with every other one.
  return key || base.trim().toLowerCase()
}

export type AlbumGroup<T> = {
  key: string
  /** The album's own name; an ungrouped album keeps its title exactly as it is. */
  name: string
  /** The edition to play and show the cover of: the plain one when there is one. */
  lead: T
  /** Each album with its edition words, which are empty for the plain one. */
  editions: { album: T; edition: string }[]
}

/** Gathers albums into groups in the order each group is first seen. */
export function groupAlbumEditions<T extends { name: string }>(albums: T[]): AlbumGroup<T>[] {
  const groups = new Map<string, { base: string; editions: AlbumGroup<T>['editions'] }>()
  for (const album of albums) {
    const { base, edition } = parseAlbumTitle(album.name)
    const key = albumKey(base)
    const group = groups.get(key)
    if (group) group.editions.push({ album, edition })
    else groups.set(key, { base, editions: [{ album, edition }] })
  }
  return [...groups].flatMap(([key, { base, editions }]) => {
    const lead = editions.find((item) => !item.edition) ?? editions[0]
    // A group is only ever made with its first edition in it, so this is for the type alone.
    if (!lead) return []
    return [
      {
        key,
        name: editions.length === 1 ? lead.album.name : base,
        lead: lead.album,
        editions,
      },
    ]
  })
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** "48 albums, 56 editions", or plain "48 albums" when every album has just one. */
export function albumCountLabel(albums: number, editions: number) {
  return albums === editions
    ? plural(albums, 'album')
    : `${plural(albums, 'album')}, ${plural(editions, 'edition')}`
}

/**
 * The years a group of editions spans: "2015" for one year, "2015–2025" for several, and empty
 * when no edition has one. A group sorts by its newest or oldest edition, so a card that showed
 * only its lead's year would look out of place in the list.
 */
export function yearSpan(years: readonly (number | undefined)[]) {
  const known = years.filter((year): year is number => typeof year === 'number' && year > 0)
  if (!known.length) return ''
  const first = Math.min(...known)
  const last = Math.max(...known)
  return first === last ? String(first) : `${first}–${last}`
}
