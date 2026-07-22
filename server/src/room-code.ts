const ROOM_CODE_RE = /^[A-Z0-9]{8}$/

export function canonicalRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return ROOM_CODE_RE.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null
}
