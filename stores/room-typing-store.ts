"use client"

import { create } from "zustand"

// Kept outside the main mediasoup reducer so "typing…" pings only re-render
// the small indicator that subscribes to it, not the whole room/chat tree.
interface RoomTypingState {
  // peerId -> displayName of remote peers currently typing.
  typingPeers: Record<string, string>
  setTyping: (peerId: string, displayName: string, typing: boolean) => void
  clearPeer: (peerId: string) => void
  reset: () => void
}

export const useRoomTypingStore = create<RoomTypingState>((set, get) => ({
  typingPeers: {},
  setTyping: (peerId, displayName, typing) => {
    const current = get().typingPeers
    if (typing) {
      if (current[peerId] === displayName) return
      set({ typingPeers: { ...current, [peerId]: displayName } })
      return
    }
    get().clearPeer(peerId)
  },
  clearPeer: (peerId) => {
    const current = get().typingPeers
    if (!(peerId in current)) return
    const next = { ...current }
    delete next[peerId]
    set({ typingPeers: next })
  },
  reset: () => {
    if (Object.keys(get().typingPeers).length === 0) return
    set({ typingPeers: {} })
  },
}))
