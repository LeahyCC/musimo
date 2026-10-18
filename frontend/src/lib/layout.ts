import { clearStored, readStored, readStoredJson, writeStored } from './storage'
import { storedValue } from './stored-value'

/* Two browser-wide choices from Settings › Yours: which of the two layouts draws the app, and which
   sections the Home dashboard shows. Both live in localStorage through `storedValue`, so a change
   in one tab reaches every other tab without a reload. */

export const LAYOUT_KEY = 'musimo.layout'
export const HOME_SECTIONS_KEY = 'musimo.home-sections'

export const LAYOUTS = ['classic', 'room'] as const
export type Layout = (typeof LAYOUTS)[number]
export const DEFAULT_LAYOUT: Layout = 'classic'

export const HOME_SECTIONS = ['continue', 'stats', 'jump', 'fresh', 'mostPlayed', 'octive'] as const
export type HomeSection = (typeof HOME_SECTIONS)[number]
export type HomeSections = Record<HomeSection, boolean>

/** Anything other than a known layout name, including nothing stored, is the default. */
export function parseLayout(raw: string | null): Layout {
  return LAYOUTS.find((layout) => layout === raw) ?? DEFAULT_LAYOUT
}

/**
 * Every section is shown unless the stored map says `false` for it. A missing key, a value that is
 * not a boolean, or a stored value that is not a map at all leaves the section shown, so a new
 * section added later appears for everyone until they turn it off.
 */
export function parseHomeSections(raw: unknown): HomeSections {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const entries = HOME_SECTIONS.map((key) => [key, Reflect.get(stored, key) !== false] as const)
  return Object.fromEntries(entries) as HomeSections
}

const sameSections = (a: HomeSections, b: HomeSections) =>
  HOME_SECTIONS.every((key) => a[key] === b[key])

const layout = storedValue(() => parseLayout(readStored(LAYOUT_KEY)))
const homeSections = storedValue(
  () => parseHomeSections(readStoredJson(HOME_SECTIONS_KEY)),
  sameSections,
)

export const useLayout = layout.use
export const getLayout = layout.get

export function setLayout(next: Layout) {
  writeStored(LAYOUT_KEY, next)
  layout.set(next)
}

export const useHomeSections = homeSections.use

export function setHomeSection(key: HomeSection, shown: boolean) {
  const next = { ...homeSections.get(), [key]: shown }
  writeStored(HOME_SECTIONS_KEY, JSON.stringify(next))
  homeSections.set(next)
}

/** Back to every section shown, which is the same as having nothing stored. */
export function resetHomeSections() {
  clearStored(HOME_SECTIONS_KEY)
  homeSections.set(parseHomeSections(undefined))
}
