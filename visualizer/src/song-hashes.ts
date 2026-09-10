import song from '../songs/dive-extended-mix.song.json' with { type: 'json' }

export type SongHash = { sha256: string; duration: number }

// The recording hash and duration for every prepared song, without the
// analysis JSON behind it (hundreds of KB). A caller checks a decoded track
// against this list before paying for the dynamic import of `./songs`.
export const songHashes: readonly SongHash[] = [
  { sha256: song.recording.sha256.toLowerCase(), duration: song.recording.duration },
]
