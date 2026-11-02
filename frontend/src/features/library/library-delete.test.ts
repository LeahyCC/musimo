import { describe, expect, it } from 'vitest'

import { deleteQuestion, deleteSummary } from './library-delete'

describe('library delete', () => {
  it('says what goes and that it goes to the trash', () => {
    expect(deleteQuestion('track', 'Song')).toMatch(/^Delete “Song”\? The files move to the trash/)
    expect(deleteQuestion('album', 'Blue')).toMatch(/^Delete the album “Blue”\?/)
    expect(deleteQuestion('album', 'Blue', 3)).toMatch(
      /^Delete the album “Blue” \(all 3 editions\)\?/,
    )
    expect(deleteQuestion('artist', 'Joni')).toMatch(/^Delete “Joni” and all their albums\?/)
  })

  it('counts what moved and what was left', () => {
    expect(deleteSummary(1, 0)).toBe('Moved 1 song to the trash.')
    expect(deleteSummary(3, 2)).toBe(
      'Moved 3 songs to the trash. 2 songs could not be moved (read-only or already gone).',
    )
  })
})
