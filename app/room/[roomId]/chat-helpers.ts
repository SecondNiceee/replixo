// Room-specific chat helpers. Formatting shared with direct messages
// (time, file size, image detection) lives in lib/chat-format.ts.

// Stable per-name color so each participant's name reads consistently.
export const NAME_COLORS = [
  "text-sky-400",
  "text-emerald-400",
  "text-amber-400",
  "text-rose-400",
  "text-violet-400",
  "text-teal-400",
]

export function colorForPeer(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0
  }
  return NAME_COLORS[hash % NAME_COLORS.length]
}

// A message is "read" once every currently-connected peer has a read marker at
// or beyond its timestamp. With no other peers in the room it stays "delivered".
export function isReadByEveryone(
  messageTs: number,
  peerIds: string[],
  readMarkers: Record<string, number>,
): boolean {
  if (peerIds.length === 0) return false
  return peerIds.every((id) => (readMarkers[id] ?? 0) >= messageTs)
}
