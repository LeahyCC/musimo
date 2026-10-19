import type { Settings } from '../../api'

/**
 * The arl as the server wants it. A paste copied from a cookie list often still starts with
 * `arl=`, so that goes along with the spaces around it; the server checks the rest.
 */
export function cleanArl(value: string): string {
  return value.trim().replace(/^arl\s*=\s*/i, '')
}

/**
 * The body of a settings save. An empty `deezer_arl` removes the saved cookie, so it goes out only
 * when Remove cookie was pressed, never because the box was left empty.
 */
export function settingsPatch<T extends Record<string, unknown>>(
  draft: T,
  removeArl: boolean,
  removeSpotify = false,
): Record<string, unknown> {
  const {
    deezer_arl: typed,
    spotify_client_id: clientId,
    spotify_client_secret: clientSecret,
    ...rest
  } = draft
  const body: Record<string, unknown> = removeArl
    ? { ...rest, deezer_arl: '' }
    : typeof typed === 'string' && cleanArl(typed) !== ''
      ? { ...rest, deezer_arl: cleanArl(typed) }
      : { ...rest }
  if (removeSpotify) {
    body.spotify_client_id = ''
    body.spotify_client_secret = ''
    return body
  }
  const id = typeof clientId === 'string' ? clientId.trim() : ''
  const secret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
  // One of the two is still a change. The server refuses a half pair.
  if (id || secret) {
    body.spotify_client_id = id
    body.spotify_client_secret = secret
  }
  return body
}

/**
 * Cached settings once the YouTube cookies file has been saved or removed. That call goes before
 * the settings save, so the page has to know about it even when the second call fails.
 */
export function withYoutubeCookies(settings: Settings, saved: boolean): Settings {
  return { ...settings, youtube_cookies: { ...settings.youtube_cookies, value: saved } }
}
