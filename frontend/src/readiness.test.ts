import { describe, expect, it } from 'vitest'

import { diagnosticsSchema } from './api'
import { rootIsReady, scanIsReady, systemIsReady } from './readiness'

const disk = { path: '/music', free_bytes: 100, total_bytes: 200, exists: true, writable: true }
const youtube = {
  source: 'youtube',
  status: 'healthy',
  latency_ms: 10,
  detail: 'ok',
  checked_at: '2026-01-01T00:00:00Z',
}
const library = {
  status: 'idle',
  walked: 0,
  indexed: 0,
  errors: 0,
  elapsed: 0,
  detail: '',
  total_files: 5,
  roots: ['/music'],
}

/* A healthy system, parsed through the real schema so the fixture cannot drift from the API. Each
   test spoils one part of it by passing that part. */
const diagnostics = (patch: Record<string, unknown> = {}) =>
  diagnosticsSchema.parse({
    health: { status: 'ok', version: '1.0.0', uptime_seconds: 10, phase: 1 },
    versions: {},
    disks: [disk],
    sources: [youtube],
    events: [],
    database: { mode: 'wal', schema: 1, retained_events: 0 },
    library,
    queue: { paused: false, source_paused: false },
    capabilities: { settings: true, events: true, search: true, downloads: true },
    navidrome: null,
    last_download: null,
    ...patch,
  })

describe('scanIsReady', () => {
  it.each(['idle', 'scanning', 'done'])('counts %s as ready', (status) => {
    expect(scanIsReady(status)).toBe(true)
  })

  it.each(['failed', 'cancelled', 'interrupted'])('counts %s as not ready', (status) => {
    expect(scanIsReady(status)).toBe(false)
  })
})

describe('rootIsReady', () => {
  it('needs the root mounted, writable and reporting free space', () => {
    // Typed from the schema, where free space may be null, not from the healthy fixture above.
    const disks = (over: Partial<ReturnType<typeof diagnostics>['disks'][number]>) =>
      diagnostics({ disks: [{ ...disk, ...over }] }).disks
    expect(rootIsReady(disks({}), '/music')).toBe(true)
    expect(rootIsReady(disks({}), '/elsewhere')).toBe(false)
    expect(rootIsReady(disks({ writable: false }), '/music')).toBe(false)
    expect(rootIsReady(disks({ exists: false }), '/music')).toBe(false)
    expect(rootIsReady(disks({ free_bytes: null }), '/music')).toBe(false)
  })
})

describe('systemIsReady', () => {
  it('is ready when everything is healthy', () => {
    expect(systemIsReady(diagnostics())).toBe(true)
  })

  it('counts a finished library scan as ready', () => {
    expect(systemIsReady(diagnostics({ library: { ...library, status: 'done' } }))).toBe(true)
  })

  it('is not ready after a failed scan', () => {
    expect(systemIsReady(diagnostics({ library: { ...library, status: 'failed' } }))).toBe(false)
  })

  it('is not ready when a library root is not writable', () => {
    expect(systemIsReady(diagnostics({ disks: [{ ...disk, writable: false }] }))).toBe(false)
  })

  it('is not ready when the YouTube helper is unhealthy', () => {
    expect(systemIsReady(diagnostics({ sources: [{ ...youtube, status: 'down' }] }))).toBe(false)
  })

  it('is not ready when Navidrome is down, and ignores it when there is none', () => {
    const navidrome = { configured: true, available: true, version: '0.55', detail: '' }
    expect(systemIsReady(diagnostics({ navidrome }))).toBe(true)
    const down = { ...navidrome, available: false }
    expect(systemIsReady(diagnostics({ navidrome: down }))).toBe(false)
    expect(systemIsReady(diagnostics({ navidrome: null }))).toBe(true)
  })

  it('is not ready when the last download failed', () => {
    const last = { stage: 'failed', error_code: 'NO_MATCH', created_at: 1 }
    expect(systemIsReady(diagnostics({ last_download: last }))).toBe(false)
    expect(systemIsReady(diagnostics({ last_download: { ...last, stage: 'done' } }))).toBe(true)
  })
})
