import { describe, expect, it } from 'vitest'

import { diagnosticsSchema } from '../../api'
import { buildChecks, buildPipeline, checkSummary } from './checks'
import { systemIsReady } from './readiness'

const disk = { path: '/music', free_bytes: 100, total_bytes: 200, exists: true, writable: true }
const source = (name: string, status = 'healthy', latency: number | null = 10) => ({
  source: name,
  status,
  latency_ms: latency,
  detail: status === 'healthy' ? 'ok' : 'down',
  checked_at: '2026-01-01T00:00:00Z',
})
const library = {
  status: 'idle',
  walked: 0,
  indexed: 0,
  errors: 0,
  elapsed: 0,
  detail: 'Ready',
  total_files: 1234,
  roots: ['/music'],
}

/* Parsed through the real schema so the fixture cannot drift from the API. */
const diagnostics = (patch: Record<string, unknown> = {}) =>
  diagnosticsSchema.parse({
    health: { status: 'ok', version: '1.0.0', uptime_seconds: 10, phase: 1 },
    versions: {},
    disks: [disk],
    sources: [source('deezer'), source('youtube')],
    events: [],
    database: { mode: 'wal', schema: 1, retained_events: 0 },
    library,
    queue: { paused: false, source_paused: false },
    capabilities: { settings: true, events: true, search: true, downloads: true },
    download_sources: [
      { id: 'deezer', label: 'Deezer', kind: 'catalog', working: true, note: '' },
      { id: 'youtube', label: 'YouTube', kind: 'site', working: true, note: '' },
      { id: 'bandcamp', label: 'Bandcamp', kind: 'site', working: true, note: '' },
    ],
    player: null,
    last_download: null,
    ...patch,
  })

const size = (bytes: number | null) => (bytes === null ? 'Unknown' : `${bytes} B`)
const checksFor = (patch: Record<string, unknown> = {}, destination: string | null = '/music') => {
  const data = diagnostics(patch)

  return buildChecks(data, destination ?? undefined, [], size)
}

describe('buildChecks', () => {
  it('lists the root, destination, scan, helper and last download of a healthy install', () => {
    const checks = checksFor()

    expect(checks.map((check) => check.name)).toEqual([
      'Library root',
      'Download destination',
      'Library scan',
      'YouTube download helper',
      'Last download',
    ])
    expect(checks.map((check) => check.tone)).toEqual(['good', 'good', 'good', 'good', 'idle'])
  })

  it('leaves the destination out when Settings has not said where downloads go', () => {
    expect(checksFor({}, null).some((check) => check.id === 'destination')).toBe(false)
  })

  it('only offers a write test on a destination that can be written to', () => {
    const readOnly = { ...disk, writable: false }
    const spoiled = checksFor({ disks: [readOnly] }).find((check) => check.id === 'destination')

    expect(spoiled?.tone).toBe('danger')
    expect(spoiled?.action).toBeUndefined()
    expect(checksFor().find((check) => check.id === 'destination')?.action).toEqual({
      kind: 'test-write',
      label: 'Test write',
    })
  })

  it('counts a finished scan as ready and a failed one as not', () => {
    const scan = (status: string) =>
      checksFor({ library: { ...library, status, detail: 'Scan complete' } }).find(
        (check) => check.id === 'scan',
      )

    expect(scan('done')).toMatchObject({ state: 'Ready', tone: 'good', detail: 'Scan complete' })
    expect(scan('failed')).toMatchObject({ state: 'Not ready', tone: 'danger' })
  })

  it('draws an absent player as nothing, and one that is configured but down as a failure', () => {
    expect(checksFor().some((check) => check.id === 'player')).toBe(false)
    const player = (available: boolean, configured: boolean) =>
      checksFor({ player: { available, configured, version: '1.2', detail: 'offline' } }).find(
        (check) => check.id === 'player',
      )

    expect(player(true, true)).toMatchObject({ tone: 'good', detail: '1.2' })
    expect(player(false, true)).toMatchObject({ state: 'Not ready', tone: 'danger' })
    expect(player(false, false)).toMatchObject({ state: 'Not configured', tone: 'idle' })
  })

  it('gives a paused site its own row and a button to resume it', () => {
    const data = diagnostics()
    const paused = [{ source: 'bandcamp', label: 'Bandcamp' }]
    const row = buildChecks(data, '/music', paused, size).find(
      (check) => check.id === 'source-bandcamp',
    )

    expect(row).toMatchObject({ state: 'Paused', tone: 'danger' })
    expect(row?.action).toEqual({ kind: 'resume', label: 'Try Bandcamp again', source: 'bandcamp' })
  })

  it('says Paused on the YouTube row only when YouTube is the paused one', () => {
    const data = diagnostics()
    const helper = (paused: { source: string; label: string }[]) =>
      buildChecks(data, '/music', paused, size).find((check) => check.id === 'youtube')

    expect(helper([])?.detail).not.toContain('Paused')
    expect(helper([{ source: 'youtube', label: 'YouTube' }])?.detail).toContain('Paused')
  })

  it('agrees with systemIsReady about whether anything is wrong', () => {
    const cases = [
      {},
      { disks: [{ ...disk, exists: false }] },
      { library: { ...library, status: 'failed' } },
      { sources: [source('deezer'), source('youtube', 'blocked')] },
      { last_download: { stage: 'failed', error_code: 'SOMETHING_ELSE', created_at: 1 } },
      { last_download: { stage: 'failed', error_code: 'NO_MATCH', created_at: 1 } },
    ]
    for (const patch of cases) {
      const data = diagnostics(patch)
      const bad = buildChecks(data, '/music', [], size).some((check) => check.tone === 'danger')

      expect(bad, JSON.stringify(patch)).toBe(!systemIsReady(data))
    }
  })
})

describe('checkSummary', () => {
  it('counts the rows that pass', () => {
    expect(checkSummary(checksFor())).toBe('4 of 5 checks pass')
  })
})

describe('buildPipeline', () => {
  const step = (id: string, patch: Record<string, unknown> = {}, paused = []) =>
    buildPipeline(diagnostics(patch), paused).find((row) => row.id === id)

  it('has the five steps in the order a song passes them', () => {
    expect(buildPipeline(diagnostics(), []).map((row) => row.name)).toEqual([
      'Catalog',
      'Sources',
      'Worker',
      'Library',
      'Player',
    ])
  })

  it('reads the catalog from the Deezer probe', () => {
    expect(step('catalog')).toMatchObject({ tone: 'good', detail: 'Deezer · 10 ms' })
    expect(step('catalog', { sources: [source('deezer', 'blocked')] })).toMatchObject({
      tone: 'danger',
      detail: 'down',
    })
    expect(step('catalog', { sources: [] })).toMatchObject({ tone: 'idle', detail: 'Not reported' })
  })

  it('counts the sources the server lists, and flags the ones with a problem', () => {
    expect(step('sources')).toMatchObject({ tone: 'good', detail: '3 of 3 ready' })
    expect(step('sources', {}, [{ source: 'bandcamp', label: 'Bandcamp' }] as never)).toMatchObject(
      {
        tone: 'warn',
        detail: '2 of 3 ready',
      },
    )
    expect(step('sources', { download_sources: [] })).toMatchObject({ tone: 'idle' })
  })

  it('shows a paused queue as something to look at', () => {
    expect(step('worker')).toMatchObject({ tone: 'good', detail: 'queue running' })
    expect(step('worker', { queue: { paused: true, source_paused: false } })).toMatchObject({
      tone: 'warn',
      detail: 'queue paused',
    })
  })

  it('reads the library from the folders and the scan together', () => {
    expect(step('library')).toMatchObject({ tone: 'good', detail: '1,234 files' })
    expect(step('library', { library: { ...library, status: 'failed' } })).toMatchObject({
      tone: 'danger',
    })

    expect(step('library', { disks: [{ ...disk, writable: false }] })).toMatchObject({
      tone: 'danger',
      detail: 'folder not ready',
    })
  })

  it('leaves the player idle until the server reports one', () => {
    expect(step('player')).toMatchObject({ tone: 'idle', detail: 'Not reported' })
    expect(
      step('player', { player: { available: true, configured: true, version: '1', detail: '' } }),
    ).toMatchObject({ tone: 'good' })
  })
})
