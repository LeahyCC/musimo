const NAME_LIMIT = 40

/**
 * Why a typed name cannot be saved, or null when it can. Blank and a name already in use stay on
 * the sheet. The check is the same idea as the server: trimmed, 40 characters, unique ignoring case.
 */
export function nameError(name: string, taken: readonly string[]): string | null {
  const text = name.trim()
  if (!text) return 'Enter a name.'
  if ([...text].length > NAME_LIMIT) return 'Use 40 characters or fewer.'
  const key = text.toLocaleLowerCase()
  if (taken.some((item) => item.trim().toLocaleLowerCase() === key))
    return 'That name is already in use.'
  return null
}
