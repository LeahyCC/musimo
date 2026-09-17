import { useSyncExternalStore } from 'react'

import {
  CUSTOM_THEMES_VERSION,
  customThemesSchema,
  HEX_COLOR,
  MAX_CUSTOM_THEMES,
  MAX_THEME_NAME,
  themeSchema,
} from './schema'
import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from './themes'
import type { ColorScheme, Theme } from './themes'
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
export type ThemeVars = { scheme: ColorScheme; vars: Record<string, string> }

export type ThemeError = 'invalid-json' | 'invalid-theme' | 'too-many'

export type ThemeResult =
  { ok: true; theme: Theme } | { ok: false; error: ThemeError; message: string }

type Snapshot = { theme: Theme; themes: readonly Theme[] }

let custom: readonly Theme[] = []
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

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* The theme still paints for this session; it just will not survive a reload. */
  }
}

function clearStored(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* Nothing was stored to begin with. */
  }
}

const allThemes = (): readonly Theme[] => [...BUILT_IN_THEMES, ...custom]

const findTheme = (id: string): Theme | undefined => allThemes().find((theme) => theme.id === id)

/** The properties the boot script writes, and what `musimo.theme-vars` holds. */
export function resolveVars(theme: Theme): ThemeVars {
  const vars: Record<string, string> = {}
  for (const token of COLOR_TOKENS) vars[token.name] = theme.colors[token.name]

  return { scheme: theme.scheme, vars }
}

/**
 * Paints `theme` onto a document: every `--color-*` property, `color-scheme`, and the browser
 * chrome colour. The popout window is the second target.
 */
export function applyTheme(theme: Theme, target: Document = document) {
  const root = target.documentElement
  // The default is already in the sheet's `@theme` block, so it is the absence of an inline value
  // rather than another one. That also keeps a rebuilt default from being shadowed by a stale copy.
  const inline = theme.id !== DEFAULT_THEME_ID
  for (const token of COLOR_TOKENS) {
    const value = theme.colors[token.name]
    // A half-typed hex in the editor falls back to the default shade instead of painting whatever
    // the string happens to mean, which is also what keeps `url(...)` out of a live preview.
    if (inline && HEX_COLOR.test(value)) root.style.setProperty(token.name, value)
    else root.style.removeProperty(token.name)
  }
  if (inline) root.style.setProperty('color-scheme', theme.scheme)
  else root.style.removeProperty('color-scheme')
  // `index.html` ships the tag. A popout document has none, and does not need one.
  const meta = target.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme.colors['--color-canvas'])
}

function commit() {
  snapshot = { theme: previewed ?? findTheme(activeId) ?? DEFAULT_THEME, themes: allThemes() }
  applyTheme(snapshot.theme)
  for (const listener of listeners) listener()
}

function persistCustom() {
  if (custom.length === 0) clearStored(CUSTOM_KEY)
  else writeStored(CUSTOM_KEY, JSON.stringify({ version: CUSTOM_THEMES_VERSION, themes: custom }))
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

function readCustom(): readonly Theme[] {
  const raw = readStored(CUSTOM_KEY)
  if (!raw) return []
  try {
    const parsed = customThemesSchema.safeParse(JSON.parse(raw))

    return parsed.success ? parsed.data.themes : []
  } catch {
    return []
  }
}

/** An id that no longer names a theme falls back to the default rather than leaving the app blank. */
function loadStored() {
  custom = readCustom()
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
  if (!known && custom.length >= MAX_CUSTOM_THEMES) {
    return fail('too-many', `Only ${MAX_CUSTOM_THEMES} themes can be kept. Delete one first.`)
  }
  custom = known
    ? custom.map((existing) => (existing.id === saved.id ? saved : existing))
    : [...custom, saved]
  previewed = null
  persistCustom()
  if (activeId === saved.id) persistActive()
  commit()

  return { ok: true, theme: saved }
}

/** Deleting the active theme puts the default back. */
export function deleteTheme(id: string) {
  custom = custom.filter((existing) => existing.id !== id)
  if (previewed?.id === id) previewed = null
  persistCustom()
  if (activeId === id) {
    activeId = DEFAULT_THEME_ID
    persistActive()
  }
  commit()
}

/** How a built-in becomes editable: a copy under a new id. */
export function duplicateTheme(theme: Theme, name = `${theme.name} copy`): ThemeResult {
  return saveTheme({
    id: newThemeId(),
    name: name.slice(0, MAX_THEME_NAME),
    scheme: theme.scheme,
    colors: { ...theme.colors },
  })
}

/**
 * Takes the contents of a file a person picked, as text or as already-parsed JSON, and returns
 * either the saved theme or a reason. It never throws, so a bad file is a message on the page.
 */
export function importTheme(raw: unknown): ThemeResult {
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
  return saveTheme({ ...parsed.data, id: newThemeId() })
}

export const exportTheme = (theme: Theme): string => JSON.stringify(theme, null, 2)

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

/** Called from `main.tsx` before the first render. Safe to call twice. */
export function startTheme() {
  if (started) return
  started = true
  loadStored()
  commit()
  window.addEventListener('storage', (event) => {
    // A null key means the whole store was cleared. An edit in progress in this tab is left alone:
    // another tab changing the saved theme should not throw away what is being typed here.
    if (event.key !== null && event.key !== ACTIVE_KEY && event.key !== CUSTOM_KEY) return
    loadStored()
    commit()
  })
}
