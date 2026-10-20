import { afterEach, describe, expect, it, vi } from 'vitest'

import { readHistory, writeHistory } from '../player/play-history'
import {
  acceptListener,
  BOT_HISTORY_KEY,
  BOT_LOG_KEY,
  BOT_PREVIEW_KEY,
  BOT_PROPOSAL_KEY,
  clearBotSession,
  commitListener,
  DECK_KEY,
  followStoredListener,
  HISTORY_KEY,
  LISTENER_KEY,
  listenerId,
  nowPlayingLeftBehind,
  PLACE_ADOPTED,
  playlistLeftBehind,
  registerListenerPlace,
  resetListenerForTests,
  setListenerId,
} from './identity'
import { nameError } from './names'

function installStorage() {
  const local = new Map<string, string>()
  const session = new Map<string, string>()
  const box = (map: Map<string, string>) => ({
    getItem: (key: string) => (map.has(key) ? (map.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
  })
  vi.stubGlobal('localStorage', box(local))
  vi.stubGlobal('sessionStorage', box(session))
  return { local, session }
}

const entry = {
  id: 'tr-aaaaaaaaaaaaaaaa',
  title: 'Road',
  artist: 'Harbor',
  album: 'Clear',
  duration: 10,
  playedAt: 1,
}

afterEach(() => {
  resetListenerForTests()
  vi.unstubAllGlobals()
})

describe('nameError', () => {
  it('keeps a blank name on the sheet', () => {
    expect(nameError('   ', [])).toBe('Enter a name.')
  })

  it('refuses a name already in use, ignoring case', () => {
    expect(nameError(' sam ', ['Sam'])).toBe('That name is already in use.')
  })

  it('refuses a name past 40 characters', () => {
    expect(nameError('a'.repeat(41), [])).toBe('Use 40 characters or fewer.')
    expect(nameError('a'.repeat(40), [])).toBeNull()
  })
})

describe('play history', () => {
  it('gives the old list to the first name once, and the next name starts empty', () => {
    const { local } = installStorage()
    local.set(HISTORY_KEY, JSON.stringify([entry]))
    local.set(DECK_KEY, '{"seed":"s"}')

    setListenerId('ln-aaaaaaaaaaaaaaaa')
    expect(readHistory()).toEqual([entry])
    expect(local.get(PLACE_ADOPTED)).toBe('1')
    expect(local.get(`${HISTORY_KEY}.ln-aaaaaaaaaaaaaaaa`)).toBe(JSON.stringify([entry]))
    expect(local.get(`${DECK_KEY}.ln-aaaaaaaaaaaaaaaa`)).toBe('{"seed":"s"}')

    local.set(HISTORY_KEY, JSON.stringify([{ ...entry, id: 'tr-bbbbbbbbbbbbbbbb' }]))
    setListenerId('ln-bbbbbbbbbbbbbbbb')
    expect(readHistory()).toEqual([])
    expect(local.get(`${HISTORY_KEY}.ln-bbbbbbbbbbbbbbbb`)).toBeUndefined()

    setListenerId('ln-aaaaaaaaaaaaaaaa')
    expect(readHistory()).toEqual([entry])
  })

  it('reads nothing before a name is chosen, and writes under the current name', () => {
    const { local } = installStorage()
    local.set(HISTORY_KEY, JSON.stringify([entry]))
    expect(readHistory()).toEqual([])

    setListenerId('ln-aaaaaaaaaaaaaaaa')
    writeHistory([entry])
    expect(local.get(`${HISTORY_KEY}.ln-aaaaaaaaaaaaaaaa`)).toBe(JSON.stringify([entry]))
    expect(readHistory()).toEqual([entry])
  })
})

describe('a switch', () => {
  it('saves as the name being left, then clears the chat in this tab', async () => {
    const { session } = installStorage()
    session.set(BOT_HISTORY_KEY, '[{"role":"user"}]')
    session.set(BOT_PROPOSAL_KEY, '{}')
    session.set(BOT_LOG_KEY, '{"entries":[]}')
    session.set(BOT_PREVIEW_KEY, '{}')
    let seen = ''
    registerListenerPlace({
      leave: async () => {
        seen = listenerId()
      },
      arrive: async () => false,
    })
    setListenerId('ln-old')

    await commitListener('ln-new', 'Sam')

    expect(seen).toBe('ln-old')
    expect(listenerId()).toBe('ln-new')
    expect(session.get(BOT_HISTORY_KEY)).toBeUndefined()
    expect(session.get(BOT_PROPOSAL_KEY)).toBeUndefined()
    expect(session.get(BOT_LOG_KEY)).toBeUndefined()
    expect(session.get(BOT_PREVIEW_KEY)).toBeUndefined()
  })

  it('does not save over an empty browser when the first name is created', async () => {
    installStorage()
    let left = 0
    registerListenerPlace({
      leave: async () => {
        left += 1
      },
      arrive: async () => true,
    })

    expect(await commitListener('ln-first', 'Colin')).toBe(true)
    expect(left).toBe(0)
    expect(listenerId()).toBe('ln-first')
  })

  it('follows another tab without writing the id again', async () => {
    const { local } = installStorage()
    setListenerId('ln-old')
    local.set(LISTENER_KEY, 'ln-new')
    local.set('musimo.listener-name', 'Sam')
    const writes: string[] = []
    const storage = localStorage
    const setItem = storage.setItem.bind(storage)
    storage.setItem = (key: string, value: string) => {
      writes.push(key)
      setItem(key, value)
    }
    let seen = ''
    registerListenerPlace({
      leave: async () => {
        seen = listenerId()
      },
      arrive: async () => false,
    })

    await followStoredListener('ln-new')

    expect(seen).toBe('ln-old')
    expect(listenerId()).toBe('ln-new')
    expect(writes).not.toContain(LISTENER_KEY)
  })

  it('takes an id the other tab stored, and still adopts a legacy list once', () => {
    const { local } = installStorage()
    local.set(HISTORY_KEY, JSON.stringify([entry]))
    acceptListener('ln-aaaaaaaaaaaaaaaa')
    expect(listenerId()).toBe('ln-aaaaaaaaaaaaaaaa')
    expect(readHistory()).toEqual([entry])
    expect(local.get(LISTENER_KEY)).toBeUndefined()
  })
})

describe('clearBotSession', () => {
  it('removes the four chat keys and leaves the rest', () => {
    const { session } = installStorage()
    for (const key of [BOT_HISTORY_KEY, BOT_PROPOSAL_KEY, BOT_LOG_KEY, BOT_PREVIEW_KEY])
      session.set(key, 'x')
    session.set('musimo.music-bot.shown', 'stale')

    clearBotSession()

    expect(session.has(BOT_HISTORY_KEY)).toBe(false)
    expect(session.has(BOT_PROPOSAL_KEY)).toBe(false)
    expect(session.has(BOT_LOG_KEY)).toBe(false)
    expect(session.has(BOT_PREVIEW_KEY)).toBe(false)
    expect(session.get('musimo.music-bot.shown')).toBe('stale')
  })
})

describe('where a switch leaves the page', () => {
  it('sends a playlist detail back to the list, and Now Playing home when nothing is loaded', () => {
    expect(playlistLeftBehind('/library/playlists/pl-1')).toBe(true)
    expect(playlistLeftBehind('/library/playlists')).toBe(false)
    expect(playlistLeftBehind('/library/albums/al-1')).toBe(false)
    expect(nowPlayingLeftBehind('/now-playing', false)).toBe(true)
    expect(nowPlayingLeftBehind('/now-playing', true)).toBe(false)
    expect(nowPlayingLeftBehind('/search', false)).toBe(false)
  })
})
