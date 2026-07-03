import type { ChatAttachment } from "@/hooks/use-mediasoup"

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

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

export function isImageAttachment(a: ChatAttachment): boolean {
  return a.mime.startsWith("image/")
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
