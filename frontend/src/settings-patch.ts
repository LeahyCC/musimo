import type { Settings } from './api'

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
): Record<string, unknown> {
  const { deezer_arl: typed, ...rest } = draft
  if (removeArl) return { ...rest, deezer_arl: '' }
  return typeof typed === 'string' && cleanArl(typed) !== ''
    ? { ...rest, deezer_arl: cleanArl(typed) }
    : rest
}

/**
 * Cached settings once the YouTube cookies file has been saved or removed. That call goes before
 * the settings save, so the page has to know about it even when the second call fails.
 */
export function withYoutubeCookies(settings: Settings, saved: boolean): Settings {
  return { ...settings, youtube_cookies: { ...settings.youtube_cookies, value: saved } }
}
