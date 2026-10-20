import { queryClient } from '../../lib/query-client'
import { clearStored, readStored, writeStored } from '../../lib/storage'

/** The id this browser last picked. The phone keeps its own copy. */
export const LISTENER_KEY = 'musimo.listener'
/** The display name beside that id, so the sidebar can paint before the list returns. */
export const LISTENER_NAME_KEY = 'musimo.listener-name'
/**
 * Set once the legacy play history, shuffle deck and queue-chosen list have been given to a name.
 * They are not read again after that.
 */
export const PLACE_ADOPTED = 'musimo.place-adopted'

export const HISTORY_KEY = 'musimo.play-history'
export const DECK_KEY = 'musimo.shuffle-deck'
export const CHOSEN_KEY = 'musimo.queue-chosen'

/** This tab's Octive chat. A switch clears it. Shown songs live on the server, not here. */
export const BOT_HISTORY_KEY = 'musimo.music-bot.history'
export const BOT_PROPOSAL_KEY = 'musimo.music-bot.proposal'
export const BOT_LOG_KEY = 'musimo.music-bot.log'
export const BOT_PREVIEW_KEY = 'musimo.music-bot.preview'

export const BOT_RESET = 'musimo-listener-bot-reset'
export const LISTENER_CHANGED = 'musimo-listener-changed'

const HEADER = 'X-Musimo-Listener'
const LEGACY_KEYS = [HISTORY_KEY, DECK_KEY, CHOSEN_KEY] as const
const BOT_KEYS = [BOT_HISTORY_KEY, BOT_PROPOSAL_KEY, BOT_LOG_KEY, BOT_PREVIEW_KEY] as const

/**
 * The id the next request uses. It is memory, not a live read of local storage: the other tab's
 * storage event must not point a queue save at the new name before the old save has finished.
 */
let activeId = ''
let activeName = ''

type Place = {
  leave: () => Promise<void>
  arrive: () => Promise<boolean>
}

let place: Place = {
  leave: async () => undefined,
  arrive: async () => false,
}

let chain: Promise<void> = Promise.resolve()

function boot() {
  activeId = readStored(LISTENER_KEY)?.trim() ?? ''
  activeName = readStored(LISTENER_NAME_KEY)?.trim() ?? ''
  if (activeId) adoptPlace(activeId)
}

function adoptPlace(id: string) {
  if (!id || readStored(PLACE_ADOPTED) !== null) return
  for (const base of LEGACY_KEYS) {
    const legacy = readStored(base)
    const dest = `${base}.${id}`
    if (legacy !== null && readStored(dest) === null) writeStored(dest, legacy)
  }
  writeStored(PLACE_ADOPTED, '1')
}

function rememberName(name: string) {
  activeName = name.trim()
  if (activeName) writeStored(LISTENER_NAME_KEY, activeName)
  else clearStored(LISTENER_NAME_KEY)
}

function emit(event: Event) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(event)
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

export function listenerId(): string {
  return activeId
}

export function listenerName(): string {
  return activeName
}

/** The list came back with a display name. Keep it for the next paint. */
export function rememberListenerName(name: string) {
  rememberName(name)
}

/** Headers for a request that belongs to the current name. Empty when no name is chosen. */
export function listenerHeaders(): Record<string, string> {
  return activeId ? { [HEADER]: activeId } : {}
}

/** Adds a name to a fetch. Defaults to the current one. House routes ignore the header. */
export function withListener(init?: RequestInit, listener = activeId): RequestInit {
  const headers = new Headers(init?.headers)
  if (listener) headers.set(HEADER, listener)
  return { ...init, headers }
}

/** The storage key for this name's copy of a browser place. The legacy key when no name is set. */
export function placeKey(base: string): string {
  return activeId ? `${base}.${activeId}` : base
}

export function setListenerId(id: string) {
  activeId = id.trim()
  if (activeId) {
    adoptPlace(activeId)
    writeStored(LISTENER_KEY, activeId)
  } else clearStored(LISTENER_KEY)
}

/** The other tab already wrote local storage. Take the id without writing it again. */
export function acceptListener(id: string) {
  activeId = id.trim()
  if (activeId) adoptPlace(activeId)
  activeName = readStored(LISTENER_NAME_KEY)?.trim() ?? ''
}

export function clearBotSession() {
  if (typeof sessionStorage === 'undefined') return
  for (const key of BOT_KEYS) {
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* Chat still works without storage. */
    }
  }
}

/** A playlist address belongs to one name. Any other detail page is not the name we just opened. */
export function playlistLeftBehind(path: string): boolean {
  return path.startsWith('/library/playlists/')
}

export function nowPlayingLeftBehind(path: string, loaded: boolean): boolean {
  return !loaded && path === '/now-playing'
}

/**
 * The player registers how to leave a name and how to open the next one. The wrappers stay put so
 * a render can replace the bodies without a gap where a switch would save nothing.
 */
export function registerListenerPlace(next: Place): () => void {
  place = next
  return () => {
    if (place === next) {
      place = { leave: async () => undefined, arrive: async () => false }
    }
  }
}

async function useName(id: string, name: string | undefined, write: boolean): Promise<boolean> {
  if (!id || id === activeId) return false
  // Save while the header is still the name being left. The first name skips this: there is no
  // one to leave, and a save with no header would be refused once a name exists.
  if (activeId) await place.leave()
  if (name !== undefined) rememberName(name)
  if (write) setListenerId(id)
  else acceptListener(id)
  clearBotSession()
  emit(new Event(BOT_RESET))
  const loaded = await place.arrive()
  queryClient.clear()
  emit(new CustomEvent(LISTENER_CHANGED, { detail: { loaded } }))
  return loaded
}

/** Pause, finish the old queue save, then open `id`. `name` is what the sidebar shows. */
export function commitListener(id: string, name?: string): Promise<boolean> {
  return enqueue(() => useName(id, name, true))
}

/** Another tab picked `id`. The browser has already stored it. */
export function followStoredListener(id: string): Promise<boolean> {
  return enqueue(() => useName(id, undefined, false))
}

/** The stored id is not on the server. Stop playback and ask for a name. */
export function dropListener(): Promise<void> {
  return enqueue(async () => {
    if (activeId) await place.leave()
    setListenerId('')
    rememberName('')
    clearBotSession()
    emit(new Event(BOT_RESET))
    await place.arrive()
    queryClient.clear()
    emit(new CustomEvent(LISTENER_CHANGED, { detail: { loaded: false } }))
  })
}

function onStorage(event: StorageEvent) {
  if (event.key !== LISTENER_KEY) return
  const next = event.newValue?.trim() ?? ''
  if (!next || next === activeId) return
  void followStoredListener(next)
}

if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

/** Puts the module back to no name. Tests call it. The page itself does not. */
export function resetListenerForTests() {
  activeId = ''
  activeName = ''
  chain = Promise.resolve()
  place = { leave: async () => undefined, arrive: async () => false }
}

boot()
