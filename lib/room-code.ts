const ROOM_CODE_LENGTH = 8
const ROOM_CODE_RE = /^[A-Z0-9]{8}$/

export function normalizeRoomCode(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH)
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

export function canonicalRoomCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return ROOM_CODE_RE.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null
}
