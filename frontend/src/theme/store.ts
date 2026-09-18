import { useSyncExternalStore } from 'react'

import {
  CUSTOM_THEMES_VERSION,
  HEX_COLOR,
  MAX_CUSTOM_THEMES,
  MAX_THEME_NAME,
  storedThemeSchema,
  storedThemesSchema,
  themeSchema,
} from './schema'
import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from './themes'
import type { ColorScheme, Skin, Theme } from './themes'
import { COLOR_TOKENS } from './tokens'

/* The theme service. It owns the three browser keys, the active theme, and the writes that repaint
   a document. Themes are a personal preference like volume, so nothing here talks to the server.

   `musimo.theme`         the active theme's id
   `musimo.custom-themes` the person's own themes, versioned
   `musimo.theme-vars`    the resolved properties, read by `public/theme-boot.js` before first paint
*/

const ACTIVE_KEY = 'musimo.theme'
const CUSTOM_KEY = 'musimo.custom-themes'
const VARS_KEY = 'musimo.theme-vars'

/** What the boot script reads. Its shape is duplicated there, in plain JavaScript, on purpose. */
export type ThemeVars = { scheme: ColorScheme; skin?: Skin; vars: Record<string, string> }

export type ThemeError = 'invalid-json' | 'invalid-theme' | 'too-many' | 'storage'

export type ThemeResult =
  { ok: true; theme: Theme } | { ok: false; error: ThemeError; message: string }

type Snapshot = { theme: Theme; themes: readonly Theme[] }

let custom: readonly Theme[] = []
/** Stored entries this build could not read. They are written back untouched, never dropped. */
let unreadable: readonly unknown[] = []
/** False when the stored list is in a shape this build does not know, so it must not be replaced. */
let writable = true
let themes: readonly Theme[] = BUILT_IN_THEMES
let activeId = DEFAULT_THEME_ID
/** An unsaved theme being edited. It paints, but it is never written to storage. */
let previewed: Theme | null = null
let snapshot: Snapshot = { theme: DEFAULT_THEME, themes: BUILT_IN_THEMES }
let started = false
const listeners = new Set<() => void>()

/* Every read and write goes through these three. A private window throws on the first touch of
   localStorage, and a browser with storage turned off throws on every one. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** False when the browser refused: storage is off, or it is full. */
function writeStored(key: string, value: string): boolean {
  try {
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)

    return true
  } catch {
    return false
  }
}

function clearStored(key: string): boolean {
  try {
    localStorage.removeItem(key)

    return true
  } catch {
    return false
  }
}

/* The list keeps its identity until a theme is added, changed or removed, so a picker subscribed
   to it does not re-render on every step of a color drag in the editor. */
function setCustom(next: readonly Theme[]) {
  custom = next
  themes = [...BUILT_IN_THEMES, ...custom]
}

const findTheme = (id: string): Theme | undefined => themes.find((theme) => theme.id === id)

/** The properties the boot script writes, and what `musimo.theme-vars` holds. */
export function resolveVars(theme: Theme): ThemeVars {
  const vars: Record<string, string> = {}
  for (const token of COLOR_TOKENS) vars[token.name] = theme.colors[token.name]

  return theme.skin
    ? { scheme: theme.scheme, skin: theme.skin, vars }
    : { scheme: theme.scheme, vars }
}

/**
 * Paints `theme` onto a document: every `--color-*` property, `color-scheme`, the skin, and the
 * browser chrome color. The popout window is the second target.
 */
export function applyTheme(theme: Theme, target: Document = document) {
  const root = target.documentElement
  // The default is already in the sheet's `@theme` block, so it is the absence of an inline value
  // rather than another one. That also keeps a rebuilt default from being shadowed by a stale copy.
  const inline = theme.id !== DEFAULT_THEME_ID
  for (const token of COLOR_TOKENS) {
    const value = theme.colors[token.name]
    // A half-typed hex in the editor leaves the last good value on screen instead of painting
    // whatever the string happens to mean, which is also what keeps `url(...)` out of a preview.
    if (!inline) root.style.removeProperty(token.name)
    else if (HEX_COLOR.test(value)) root.style.setProperty(token.name, value)
  }
  if (inline) root.style.setProperty('color-scheme', theme.scheme)
  else root.style.removeProperty('color-scheme')
  if (theme.skin) root.setAttribute('data-skin', theme.skin)
  else root.removeAttribute('data-skin')
  // `index.html` ships the tag. A popout document has none, and does not need one.
  const meta = target.querySelector('meta[name="theme-color"]')
  const canvas = theme.colors['--color-canvas']
  if (meta && HEX_COLOR.test(canvas)) meta.setAttribute('content', canvas)
}

function commit() {
  snapshot = { theme: previewed ?? findTheme(activeId) ?? DEFAULT_THEME, themes }
  applyTheme(snapshot.theme)
  for (const listener of listeners) listener()
}

function persistCustom(): boolean {
  if (!writable) return false
  const stored = [...custom, ...unreadable]
  if (stored.length === 0) return clearStored(CUSTOM_KEY)

  return writeStored(CUSTOM_KEY, JSON.stringify({ version: CUSTOM_THEMES_VERSION, themes: stored }))
}

/* The default is stored as the absence of a key, so a person who never picked a theme, and one who
   went back to the default, leave the same clean slate for the boot script. */
function persistActive() {
  const theme = findTheme(activeId)
  if (!theme || theme.id === DEFAULT_THEME_ID) {
    clearStored(ACTIVE_KEY)
    clearStored(VARS_KEY)

    return
  }
  writeStored(ACTIVE_KEY, theme.id)
  writeStored(VARS_KEY, JSON.stringify(resolveVars(theme)))
}

/*
 * Each stored theme is read on its own. One bad entry, or a list written by a newer Musimo, used to
 * come back as an empty list, and the next save then replaced a person's whole collection with a
 * single theme. An entry that does not read is kept aside and written back as it was. A list whose
 * envelope does not read at all is left alone: nothing is saved over it.
 */
function readCustom() {
  unreadable = []
  writable = true
  const raw = readStored(CUSTOM_KEY)
  if (!raw) return setCustom([])
  let envelope
  try {
    envelope = storedThemesSchema.safeParse(JSON.parse(raw))
  } catch {
    envelope = null
  }

  if (!envelope?.success) {
    writable = false

    return setCustom([])
  }
  const readable: Theme[] = []
  const rest: unknown[] = []
  for (const entry of envelope.data.themes) {
    const parsed = storedThemeSchema.safeParse(entry)
    if (parsed.success && !readable.some((theme) => theme.id === parsed.data.id)) {
      readable.push(parsed.data)
    } else rest.push(entry)
  }
  unreadable = rest
  setCustom(readable)
}

/** An id that no longer names a theme falls back to the default rather than leaving the app blank. */
function loadStored() {
  readCustom()
  const saved = readStored(ACTIVE_KEY)
  activeId = saved && findTheme(saved) ? saved : DEFAULT_THEME_ID
}

/*
 * `crypto.randomUUID` is only there in a secure context, and Musimo is usually reached over plain
 * http on a home network, so there has to be a second way to get an id at all. Uniqueness within
 * one browser's fifty themes is all that is being asked of it.
 */
function newThemeId(): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  return `custom-${unique}`
}

const fail = (error: ThemeError, message: string): ThemeResult => ({ ok: false, error, message })

export function listThemes(): readonly Theme[] {
  return snapshot.themes
}

export function getTheme(id: string): Theme | undefined {
  return findTheme(id)
}

export function activeTheme(): Theme {
  return snapshot.theme
}

export function setActiveTheme(id: string) {
  activeId = findTheme(id) ? id : DEFAULT_THEME_ID
  previewed = null
  persistActive()
  commit()
}

export function saveTheme(theme: Theme): ThemeResult {
  const parsed = themeSchema.safeParse(theme)
  if (!parsed.success) return fail('invalid-theme', 'That theme could not be read.')
  const saved = parsed.data
  if (BUILT_IN_THEMES.some((built) => built.id === saved.id)) {
    return fail('invalid-theme', 'A built-in theme cannot be changed. Duplicate it instead.')
  }
  const known = custom.some((existing) => existing.id === saved.id)
  if (!known && custom.length + unreadable.length >= MAX_CUSTOM_THEMES) {
    return fail('too-many', `Only ${MAX_CUSTOM_THEMES} themes can be kept. Delete one first.`)
  }
  const before = custom
  setCustom(
    known
      ? custom.map((existing) => (existing.id === saved.id ? saved : existing))
      : [...custom, saved],
  )
  if (!persistCustom()) {
    // Saying "saved" about a theme that is gone after a reload is worse than saying no.
    setCustom(before)

    return fail(
      'storage',
      writable
        ? 'This browser would not save the theme. Its storage is full or turned off.'
        : 'Your saved themes were written by a newer Musimo, so this one cannot change them.',
    )
  }
  // Only the draft that was just saved is finished. An import or a duplicate made while another
  // theme is being edited must not throw that edit's preview away.
  if (previewed?.id === saved.id) previewed = null
  if (activeId === saved.id) persistActive()
  commit()

  return { ok: true, theme: saved }
}

/** Deleting the active theme puts the default back. */
export function deleteTheme(id: string) {
  setCustom(custom.filter((existing) => existing.id !== id))
  if (previewed?.id === id) previewed = null
  persistCustom()
  if (activeId === id) {
    activeId = DEFAULT_THEME_ID
    persistActive()
  }
  commit()
}

/**
 * An unsaved copy under a new id, for "Duplicate and edit": it can be previewed and thrown away, and
 * nothing is kept until `saveTheme`.
 */
export function draftTheme(theme: Theme, name = `${theme.name} copy`): Theme {
  return {
    id: newThemeId(),
    name: name.slice(0, MAX_THEME_NAME),
    scheme: theme.scheme,
    colors: { ...theme.colors },
  }
}

/**
 * What Save and Import mean on the settings page: keep the theme and turn it on. One call, so the
 * rule lives here and a caller cannot do half of it.
 */
export function saveAndActivate(theme: Theme): ThemeResult {
  const result = saveTheme(theme)
  if (result.ok) setActiveTheme(result.theme.id)

  return result
}

export const isBuiltInTheme = (id: string): boolean =>
  BUILT_IN_THEMES.some((built) => built.id === id)

/** False at the cap, or when the stored list cannot be written, so the page can say so up front. */
export const hasRoomForTheme = (): boolean =>
  writable && custom.length + unreadable.length < MAX_CUSTOM_THEMES

/** How a built-in becomes editable in one step: a saved copy under a new id. */
export function duplicateTheme(theme: Theme, name?: string): ThemeResult {
  return saveTheme(draftTheme(theme, name))
}

/** Theme files are a few kilobytes. Anything far past that is not one, and is not worth parsing. */
export const MAX_THEME_FILE_BYTES = 256 * 1024

/**
 * Takes the contents of a file a person picked, as text or as already-parsed JSON, and returns
 * either the saved and active theme or a reason. It never throws, so a bad file is a message on
 * the page.
 */
export function importTheme(raw: unknown): ThemeResult {
  if (typeof raw === 'string' && raw.length > MAX_THEME_FILE_BYTES) {
    return fail('invalid-theme', 'That file is too big to be a Musimo theme.')
  }
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return fail('invalid-json', 'That file is not JSON.')
    }
  }
  const parsed = themeSchema.safeParse(value)
  if (!parsed.success) return fail('invalid-theme', 'That file is not a Musimo theme.')

  // An import is always a new theme, so it cannot overwrite a built-in or quietly replace one
  // already saved under the same id.
  return saveAndActivate({ ...parsed.data, id: newThemeId() })
}

export const exportTheme = (theme: Theme): string => JSON.stringify(theme, null, 2)

/** A name a person typed is not a safe file name as it stands. */
export const themeFileName = (theme: Theme): string =>
  `${theme.name.replace(/[^\p{L}\p{N} ._-]+/gu, '-').trim() || 'theme'}.musimo-theme.json`

/** Paints an unsaved theme. `cancelPreview` puts the saved one back. */
export function previewTheme(theme: Theme) {
  previewed = theme
  commit()
}

export function cancelPreview() {
  previewed = null
  commit()
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): Snapshot => snapshot

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot).theme
}

const getThemes = (): readonly Theme[] => themes

/** Every theme, built-ins first. Re-renders when one is added, changed or removed. */
export function useThemes(): readonly Theme[] {
  return useSyncExternalStore(subscribeTheme, getThemes, getThemes)
}

/** Called from `main.tsx` before the first render. Safe to call twice. */
export function startTheme() {
  if (started) return
  started = true
  loadStored()
  // Brings the boot script's copy back in line with what was just resolved: a theme that no longer
  // exists, colors a release has since changed, or keys written by hand without the third one.
  // Without this the boot script paints the stale copy first on every load. A list this build
  // cannot read is left alone, keys and all, for the build that can.
  if (writable) persistActive()
  commit()
  window.addEventListener('storage', (event) => {
    // A null key means the whole store was cleared. An edit in progress in this tab is left alone:
    // another tab changing the saved theme should not throw away what is being typed here.
    if (event.key !== null && event.key !== ACTIVE_KEY && event.key !== CUSTOM_KEY) return
    loadStored()
    commit()
  })
}
