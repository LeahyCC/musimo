import { describe, expect, it } from 'vitest'

import { coverageParts } from './coverage-bar'
import { pipelineStates, pipelineText } from './pipeline-bar'

describe('coverageParts', () => {
  it('lists the parts in bar order with their legend text', () => {
    expect(
      coverageParts({ owned: 6, otherEdition: 1, queued: 1, missing: 2 }).map((part) => part.label),
    ).toEqual(['6 in library', '1 other edition', '1 queued', '2 missing of 10'])
  })

  it('leaves out the parts with nothing in them', () => {
    expect(
      coverageParts({ owned: 4, otherEdition: 0, queued: 1, missing: 0 }).map((part) => part.key),
    ).toEqual(['owned', 'queued'])
  })
})

describe('pipelineStates', () => {
  it('marks the steps before the current one done and the rest pending', () => {
    expect(pipelineStates('convert')).toEqual(['done', 'done', 'current', 'pending', 'pending'])
    expect(pipelineStates('match')).toEqual(['current', 'pending', 'pending', 'pending', 'pending'])
  })

  it('marks every step done once the job has finished', () => {
    expect(pipelineStates('done')).toEqual(['done', 'done', 'done', 'done', 'done'])
  })
})

describe('pipelineText', () => {
  it('says where the job is and how it is going, not only in color', () => {
    expect(pipelineText('download', 'danger')).toBe('Download, step 2 of 5, failed')
    expect(pipelineText('tag', 'warn')).toBe('Tag, step 4 of 5, held up')
    expect(pipelineText('done', 'good')).toBe('All 5 steps done')
  })
})
