/* Every read and write of browser storage goes through these. A private window throws on the first
   touch of localStorage, and a browser with storage turned off throws on every one, so storage is
   optional: a value that cannot be kept still holds until the page closes. */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** False when the browser refused: storage is off, or it is full. */
export function writeStored(key: string, value: string): boolean {
  try {
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)

    return true
  } catch {
    return false
  }
}

export function clearStored(key: string): boolean {
  try {
    localStorage.removeItem(key)

    return true
  } catch {
    return false
  }
}

/** The stored value read as JSON, or undefined when it is missing or is not JSON. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
