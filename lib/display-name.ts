const KEY = "replixo_display_name"
const DEFAULT_NAME = "Гость"

/** Read only a name explicitly saved by this browser. */
export function getSavedDisplayName(): string | null {
  if (typeof window === "undefined") return null

  try {
    const name = window.localStorage.getItem(KEY)?.trim()
    return name && name.length > 0 ? name : null
  } catch {
    return null
  }
}

/** Read the saved display name (legacy callers still fall back to "Гость"). */
export function getDisplayName(): string {
  return getSavedDisplayName() ?? DEFAULT_NAME
}

/** Persist the display name to localStorage. Empty values are ignored. */
export function setDisplayName(name: string): boolean {
  if (typeof window === "undefined") return false
  const trimmed = name.trim()
  if (!trimmed) return false

  try {
    window.localStorage.setItem(KEY, trimmed)
    return true
  } catch {
    return false
  }
}

export { KEY as DISPLAY_NAME_KEY, DEFAULT_NAME }
