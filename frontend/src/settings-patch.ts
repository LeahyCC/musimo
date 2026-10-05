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
  return typeof typed === 'string' && typed.trim() !== ''
    ? { ...rest, deezer_arl: typed.trim() }
    : rest
}
