import { describe, expect, it } from 'vitest'

import type { LibraryPlaylist } from '../../api'
import { pickSidebarPlaylists } from './shell-data'

const playlist = (id: string, changed: string): LibraryPlaylist => ({
  id,
  name: id,
  public: false,
  owner: '',
  changed,
})

describe('pickSidebarPlaylists', () => {
  const all = [
    playlist('old', '2026-01-01T00:00:00Z'),
    playlist('liked', '2025-01-01T00:00:00Z'),
    playlist('newest', '2026-09-01T00:00:00Z'),
    playlist('middle', '2026-05-01T00:00:00Z'),
  ]

  it('puts Liked first and fills the rest with the most recently changed', () => {
    expect(pickSidebarPlaylists(all, 'liked').map((p) => p.id)).toEqual([
      'liked',
      'newest',
      'middle',
    ])
  })

  it('takes three recent playlists when there is no Liked one', () => {
    expect(pickSidebarPlaylists(all, '').map((p) => p.id)).toEqual(['newest', 'middle', 'old'])
  })

  it('does not reorder the list it was given', () => {
    const copy = [...all]
    pickSidebarPlaylists(copy, 'liked')
    expect(copy).toEqual(all)
  })
})
