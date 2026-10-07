import { describe, expect, it } from 'vitest'

import { orderTrouble, sourceProblems } from './source-status'

const listed = [
  { id: 'deezer', label: 'Deezer', kind: 'catalog' },
  { id: 'youtube', label: 'YouTube', kind: 'music' },
  { id: 'soundcloud', label: 'SoundCloud', kind: 'music' },
  { id: 'bandcamp', label: 'Bandcamp', kind: 'music' },
  { id: 'deezer_audio', label: 'Deezer account', kind: 'account' },
]

describe('sourceProblems', () => {
  it('leaves a healthy source out', () => {
    expect(
      sourceProblems(
        [{ source: 'youtube', status: 'healthy', detail: 'Last YouTube download completed' }],
        [],
        listed,
      ),
    ).toEqual([])
  })

  it('names a blocked or failing source that is not paused', () => {
    expect(
      sourceProblems(
        [
          { source: 'youtube', status: 'healthy', detail: 'ok' },
          {
            source: 'soundcloud',
            status: 'error',
            detail: 'The connection dropped before the site answered.',
          },
          { source: 'bandcamp', status: 'blocked', detail: 'Bandcamp is blocking requests.' },
        ],
        [],
        listed,
      ),
    ).toEqual([
      {
        id: 'soundcloud',
        label: 'SoundCloud',
        title: 'SoundCloud downloads',
        mark: 'Error',
        detail: 'The connection dropped before the site answered.',
        paused: false,
      },
      {
        id: 'bandcamp',
        label: 'Bandcamp',
        title: 'Bandcamp downloads',
        mark: 'Blocked',
        detail: 'Bandcamp is blocking requests.',
        paused: false,
      },
    ])
  })

  it('keeps the pause line, and adds the stored detail when the source is also unhealthy', () => {
    expect(
      sourceProblems(
        [{ source: 'bandcamp', status: 'blocked', detail: 'Bandcamp is blocking requests.' }],
        [{ source: 'bandcamp', label: 'Bandcamp' }],
        [],
      ),
    ).toEqual([
      {
        id: 'bandcamp',
        label: 'Bandcamp',
        title: 'Bandcamp downloads',
        mark: 'Paused',
        detail: 'Paused after repeated blocking errors. Bandcamp is blocking requests.',
        paused: true,
      },
    ])
  })

  it('does not repeat a success line on a source that is only paused', () => {
    const [problem] = sourceProblems(
      [{ source: 'soundcloud', status: 'healthy', detail: 'Last SoundCloud download completed' }],
      [{ source: 'soundcloud', label: 'SoundCloud' }],
      listed,
    )
    expect(problem?.detail).toBe('Paused after repeated blocking errors.')
    expect(problem?.mark).toBe('Paused')
  })

  it('calls the catalog connection by its name', () => {
    const [problem] = sourceProblems(
      [
        {
          source: 'deezer',
          status: 'error',
          detail: 'Catalog request failed or timed out; try again',
        },
      ],
      [],
      listed,
    )
    expect(problem?.title).toBe('Deezer')
  })

  it('keeps a Deezer account problem off the catalog row', () => {
    const problems = sourceProblems(
      [
        { source: 'deezer', status: 'healthy', detail: 'Keyless catalog responded' },
        {
          source: 'deezer_audio',
          status: 'error',
          detail: 'The connection dropped before the site answered.',
        },
      ],
      [{ source: 'deezer', label: 'Deezer' }],
      listed,
    )
    expect(problems.map((problem) => problem.id)).toEqual(['deezer_audio'])
    expect(problems[0]).toMatchObject({
      label: 'Deezer account',
      title: 'Deezer account',
      mark: 'Paused',
      paused: true,
    })
    expect(orderTrouble(problems)).toEqual({})
  })

  it('marks the order list from the account row, not the catalog probe', () => {
    const problems = sourceProblems(
      [
        { source: 'deezer', status: 'error', detail: 'Catalog request failed or timed out' },
        { source: 'deezer_audio', status: 'blocked', detail: 'Deezer is blocking requests.' },
      ],
      [],
      listed,
    )
    expect(problems.map((problem) => [problem.id, problem.title])).toEqual([
      ['deezer', 'Deezer'],
      ['deezer_audio', 'Deezer account'],
    ])
    expect(orderTrouble(problems)).toEqual({ deezer: 'Blocked' })
  })
})
