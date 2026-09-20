import { describe, expect, it } from 'vitest'

import { groupRuns } from './activity-runs'

const at = (id: number, kind: string) => ({ id, kind })

describe('groupRuns', () => {
  it('folds neighbours of one kind into a single run', () => {
    const runs = groupRuns([
      at(5, 'library.updated'),
      at(4, 'library.updated'),
      at(3, 'library.updated'),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.events.map((event) => event.id)).toEqual([5, 4, 3])
  })

  it('keeps a lone event as a run of one', () => {
    expect(groupRuns([at(1, 'settings.updated')])).toEqual([
      { kind: 'settings.updated', events: [at(1, 'settings.updated')] },
    ])
  })

  it('keeps two stretches of a kind apart when something else sits between them', () => {
    const runs = groupRuns([
      at(4, 'library.updated'),
      at(3, 'settings.updated'),
      at(2, 'library.updated'),
      at(1, 'library.updated'),
    ])
    expect(runs.map((run) => [run.kind, run.events.length])).toEqual([
      ['library.updated', 1],
      ['settings.updated', 1],
      ['library.updated', 2],
    ])
  })

  it('returns nothing for an empty feed', () => {
    expect(groupRuns([])).toEqual([])
  })
})
