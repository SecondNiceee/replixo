const KEY = "riplexo_display_name"
const DEFAULT_NAME = "Гость"

/** Read the saved display name from localStorage (falls back to "Гость"). */
export function getDisplayName(): string {
  if (typeof window === "undefined") return DEFAULT_NAME
  const name = localStorage.getItem(KEY)?.trim()
  return name && name.length > 0 ? name : DEFAULT_NAME
}

/** Persist the display name to localStorage. Empty values are ignored. */
export function setDisplayName(name: string): void {
  if (typeof window === "undefined") return
  const trimmed = name.trim()
  if (trimmed.length > 0) localStorage.setItem(KEY, trimmed)
}

export { KEY as DISPLAY_NAME_KEY, DEFAULT_NAME }
