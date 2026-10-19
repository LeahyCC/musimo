/** A stable key for a search row. A Spotify id is not a Deezer track id. */
export function resultKey(item: { id: number; spotify_id?: string }) {
  return item.spotify_id ? `spotify:${item.spotify_id}` : String(item.id)
}
