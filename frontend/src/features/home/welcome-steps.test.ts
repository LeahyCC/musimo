import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import type { diagnosticsSchema } from '../../api'
import { welcomeSteps } from './welcome-steps'

type Diagnostics = z.infer<typeof diagnosticsSchema>

const diagnostics = (
  status: string,
  disk: Partial<Diagnostics['disks'][number]> = {},
  roots = ['/music'],
) =>
  ({
    library: { status, walked: 12, indexed: 5, roots },
    disks: [
      {
        path: '/music',
        exists: true,
        writable: true,
        free_bytes: 5 * 1024 ** 3,
        total_bytes: 10 * 1024 ** 3,
        ...disk,
      },
    ],
  }) as unknown as Diagnostics

describe('welcomeSteps', () => {
  it('marks the folder step done when every root is ready, and points at the next two', () => {
    const steps = welcomeSteps(diagnostics('idle'))
    expect(steps.map((step) => step.state)).toEqual(['done', 'now', 'now'])
    expect(steps[0]?.detail).toContain('/music is readable and writable · 5.0 GB free')
  })

  it('holds the later steps back while a root is not writable', () => {
    const steps = welcomeSteps(diagnostics('idle', { writable: false }))
    expect(steps.map((step) => step.state)).toEqual(['now', 'next', 'next'])
    expect(steps[0]?.detail).toContain('could not be read or written')
  })

  it('says when no root is set', () => {
    const steps = welcomeSteps(diagnostics('idle', {}, []))
    expect(steps[0]?.state).toBe('now')
    expect(steps[0]?.detail).toContain('MUSIMO_LIBRARY_ROOTS')
  })

  it('reports scan progress, and an empty finished scan', () => {
    expect(welcomeSteps(diagnostics('scanning'))[2]?.detail).toContain('5 of 12 files')
    expect(welcomeSteps(diagnostics('done'))[2]?.detail).toContain('no audio files')
  })

  it('has nothing to go on before diagnostics load', () => {
    expect(welcomeSteps(undefined)[0]?.state).toBe('now')
  })
})
