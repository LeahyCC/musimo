/** Deezer track ids resolved from Spotify rows during this visit. */

const matches = new Map<string, number>()

export function rememberDeezerMatch(spotifyId: string, trackId: number) {
  if (spotifyId && trackId > 0) matches.set(spotifyId, trackId)
}

/** The Deezer id a row downloads. A Spotify row stays 0 until a match is remembered. */
export function resolvedDeezerId(item: { id: number; spotify_id?: string }) {
  if (!item.spotify_id) return item.id
  return matches.get(item.spotify_id) ?? 0
}
