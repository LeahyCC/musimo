import dive from '../songs/dive-extended-mix.analysis.json' with { type: 'json' }
import song from '../songs/dive-extended-mix.song.json' with { type: 'json' }
import type { JourneyScore } from './journey.ts'

export type PreparedSong = {
  title: string
  artist: string
  sha256: string
  duration: number
  score: () => JourneyScore
}

// Prepared songs are keyed by the SHA-256 of the exact library recording they
// were analysed from. Another edit of the same track needs its own analysis.
export const preparedSongs: readonly PreparedSong[] = [
  {
    title: dive.recording.title,
    artist: dive.recording.artist,
    sha256: dive.recording.sha256,
    duration: dive.recording.duration,
    score: () => ({
      ...(song as JourneyScore),
      analysis: {
        hopSeconds: dive.analysis.hopSamples / dive.analysis.sampleRate,
        columns: dive.analysis.featureColumns,
        frames: dive.features,
      },
    }),
  },
]

// The journey score for a recording, or nothing when the hash is not one of
// the prepared songs. The caller still checks the decoded duration.
export function journeyFor(sha256: string): JourneyScore | undefined {
  return preparedSongs.find((entry) => entry.sha256 === sha256.toLowerCase())?.score()
}
