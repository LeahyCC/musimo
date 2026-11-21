// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MusicBotProvider, useBotChat } from './bot-chat'
import { DiscoveryBar, DiscoveryPick } from './chat-discovery'

// jsdom has no media queries, so the test says whether the window is a phone.
let onPhone = false
vi.mock('../../lib/use-phone', () => ({ usePhone: () => onPhone }))
vi.mock('../player/player', () => ({
  usePlayer: () => ({
    libraryTrack: null,
    track: null,
    queue: [],
    currentIndex: -1,
    playing: false,
    botStamp: () => 'stamp',
  }),
}))
vi.mock('./pet-settings', () => ({ usePetSettings: () => ({ name: 'Bot' }) }))
vi.mock('./use-pet', () => ({ usePetLook: () => ({ pixel: false }) }))

const song = 'tr-0000000000000001'
const setting = (value: unknown) => ({ value, origin: 'default', locked: false })

const plan = {
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: [],
  genres: ['Rock'],
  year_from: null,
  year_to: null,
  favourites: false,
  history: 'any',
  exclude_played_days: 0,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 3600,
  limit: 100,
  similar_to_current: false,
  explanation: '',
}

type Sent = { url: string; raw: string; body: Record<string, any> }
let sent: Sent[] = []

const json = (data: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }),
  )

/** The server, as far as the chat can tell: it stores whatever intent it is sent and echoes it. */
function server(url: string, init?: RequestInit) {
  const raw = typeof init?.body === 'string' ? init.body : ''
  const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
  sent.push({ url, raw, body })
  if (url === '/api/settings')
    return json({
      ollama_model: setting('m'),
      library_label: setting('Library'),
      output_format: setting('original'),
      concurrency: setting(1),
      max_attempts: setting(1),
      retry_base_seconds: setting(1),
      retry_cap_seconds: setting(1),
      destination: setting(''),
      naming_template: setting(''),
    })
  if (url === '/api/music-bot/models') return json({ models: ['m'], elapsed_ms: 1 })
  if (url === '/api/library')
    return json({
      status: 'idle',
      walked: 0,
      indexed: 0,
      errors: 0,
      elapsed: 0,
      detail: '',
      total_files: 0,
      roots: [],
    })
  if (url.startsWith('/api/music-bot/memory'))
    return json({ revision: 1, results: 1, songs: 1, recorded: true, reason: '' })
  if (url === '/api/music-bot/chat')
    return json({
      plan,
      tracks: [{ id: song, title: 'One', duration: 200 }],
      total_seconds: 200,
      shortfall_seconds: 0,
      summary: '1 song.',
      elapsed_ms: 1,
      generation_seed: 7,
    })
  const refine = url.endsWith('/revisions')
  return json({
    proposal: {
      id: 'p1',
      revision: refine ? 2 : 1,
      latest_revision: refine ? 2 : 1,
      intent: refine ? body.intent : body,
      seed: 7,
      ids: [song],
      total_seconds: 200,
      shortfall_seconds: 0,
      summary: '1 song.',
      overview: {
        measured: {
          track_count: 1,
          total_seconds: 200,
          artist_count: 1,
          genres: [],
          year_range: null,
          audio: null,
        },
        unknown: {
          duration_tracks: 0,
          year_tracks: 0,
          genre_tracks: 0,
          artist_tracks: 0,
          missing_tracks: 0,
        },
      },
      sample: { ids: [song], complete: true },
      snapshot: {},
    },
    tracks: [{ id: song, title: 'One', duration: 200 }],
    missing_ids: [],
  })
}

function Harness() {
  const chat = useBotChat()
  return (
    <>
      <DiscoveryBar />
      <DiscoveryPick />
      <button type="button" onClick={() => void chat.send('some rock')}>
        Ask
      </button>
      <button type="button" onClick={chat.clear}>
        Clear chat
      </button>
    </>
  )
}

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MusicBotProvider>
        <Harness />
      </MusicBotProvider>
    </QueryClientProvider>,
  )

  return userEvent.setup()
}

const stored = () => sent.filter((call) => /\/proposals(\/p1\/revisions)?$/.test(call.url))
const radio = (name: string) => screen.getByRole('radio', { name })

beforeEach(() => {
  sent = []
  onPhone = false
  sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => server(url, init)),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function ask(user: ReturnType<typeof open>, count: number) {
  await user.click(screen.getByRole('button', { name: 'Ask' }))
  await waitFor(() => expect(stored()).toHaveLength(count))
  // The control is held while a request is out, and free again once the card is shown. On a phone
  // it is the select beside the box, not the radio group.
  const control = () =>
    screen.queryByRole('radio', { name: 'Balanced' }) ??
    screen.getByRole('combobox', { name: 'Discovery' })
  await waitFor(() =>
    expect((control() as HTMLButtonElement | HTMLSelectElement).disabled).toBe(false),
  )
}

describe('the discovery control', () => {
  it('is a labelled radio group that starts on Balanced', async () => {
    open()
    const group = await screen.findByRole('radiogroup', { name: 'Discovery' })
    expect(group).toBeTruthy()
    expect(radio('Balanced').getAttribute('aria-checked')).toBe('true')
    expect(radio('Stay close').getAttribute('aria-checked')).toBe('false')
    expect(radio('Explore').getAttribute('aria-checked')).toBe('false')
  })

  it('can be moved with the arrow keys', async () => {
    const user = open()
    radio('Balanced').focus()
    await user.keyboard('{ArrowRight}')
    expect(radio('Explore').getAttribute('aria-checked')).toBe('true')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(radio('Stay close').getAttribute('aria-checked')).toBe('true')
  })
})

describe('on a phone', () => {
  it('has no row of its own, only a labelled select beside the box', async () => {
    onPhone = true
    const user = open()
    const pick = await screen.findByRole('combobox', { name: 'Discovery' })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Stay close',
      'Balanced',
      'Explore',
    ])
    await user.selectOptions(pick, 'Explore')
    await ask(user, 1)
    expect(stored()[0]?.body.contract_version).toBe(6)
    expect(stored()[0]?.body.filters.discovery).toBe('explore')
  })

  it('is not shown beside the box on a wide screen', () => {
    open()
    expect(screen.queryByRole('combobox', { name: 'Discovery' })).toBeNull()
  })
})

describe('what a search stores', () => {
  it('sends today’s request when it is left on Balanced: version 5, no discovery field', async () => {
    const user = open()
    await ask(user, 1)
    const [call] = stored()
    expect(call?.body.contract_version).toBe(5)
    expect(call?.raw).not.toContain('discovery')
  })

  it.each([
    ['Explore', 'explore'],
    ['Stay close', 'close'],
  ])('sends %s with the version that knows it', async (label, value) => {
    const user = open()
    await user.click(radio(label))
    await ask(user, 1)
    const [call] = stored()
    expect(call?.body.contract_version).toBe(6)
    expect(call?.body.filters.discovery).toBe(value)
  })

  it('keeps it on a follow-up, and says Balanced out loud to end it', async () => {
    const user = open()
    await user.click(radio('Explore'))
    await ask(user, 1)

    // A follow-up of the stored proposal leaves it as it was.
    await ask(user, 2)
    const followUp = stored()[1]
    expect(followUp?.url).toBe('/api/music-bot/proposals/p1/revisions')
    expect(followUp?.body.intent.contract_version).toBe(6)
    expect(followUp?.body.intent.filters.discovery).toBe('explore')

    // Back on Balanced the server would keep the old lean unless told, so it is sent.
    await user.click(radio('Balanced'))
    await ask(user, 3)
    const reset = stored()[2]
    expect(reset?.body.intent.contract_version).toBe(6)
    expect(reset?.body.intent.filters.discovery).toBe('balanced')

    // And once the open proposal holds no lean, Balanced is the plain request again.
    await ask(user, 4)
    const plain = stored()[3]
    expect(plain?.body.intent.contract_version).toBe(5)
    expect(plain?.raw).not.toContain('discovery')
  })

  it('goes back to Balanced when the chat is cleared', async () => {
    const user = open()
    await user.click(radio('Explore'))
    expect(radio('Explore').getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Clear chat' }))
    expect(radio('Balanced').getAttribute('aria-checked')).toBe('true')
    await ask(user, 1)
    expect(stored()[0]?.raw).not.toContain('discovery')
  })

  it('is not written to settings', async () => {
    const user = open()
    await user.click(radio('Explore'))
    expect(sent.some((call) => call.url === '/api/settings' && call.raw !== '')).toBe(false)
  })
})
