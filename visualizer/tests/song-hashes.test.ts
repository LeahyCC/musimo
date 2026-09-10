import assert from 'node:assert/strict'
import { test } from 'node:test'

import { songHashes } from '../src/song-hashes.ts'
import { preparedSongs } from '../src/songs.ts'

test('the hash list matches the prepared songs it stands in for', () => {
  assert.equal(songHashes.length, preparedSongs.length)
  for (const song of preparedSongs) {
    const hash = songHashes.find((entry) => entry.sha256 === song.sha256)
    assert.ok(hash, `no cheap hash entry for ${song.title}`)
    assert.equal(hash.duration, song.duration)
  }
})
