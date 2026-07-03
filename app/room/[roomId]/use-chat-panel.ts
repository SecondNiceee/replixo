"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { playMessageSound } from "@/lib/sounds"
import { useChatButtonStore } from "@/stores/chat-button-store"
import type { ChatMessage } from "@/hooks/use-mediasoup"

interface UseChatPanelArgs {
  messages: ChatMessage[]
  markChatRead: (ts: number) => void
}

interface UseChatPanelResult {
  chatOpen: boolean
  unreadCount: number
  unreadFromIndex: number | null
  toggleChat: () => void
  closeChat: () => void
}

/**
 * Encapsulates all chat-panel UI state for the room: open/close, the unread
 * badge counter, the "new messages" boundary, read receipts, the incoming
 * message chime and the global toggle hotkey.
 */
export function useChatPanel({ messages, markChatRead }: UseChatPanelArgs): UseChatPanelResult {
  // Chat panel open state + unread counter. We track how many messages had been
  // seen the last time the panel was open; anything beyond that is "unread".
  const [chatOpen, setChatOpen] = useState(false)
  const [seenCount, setSeenCount] = useState(0)
  // Index of the first unread message captured at the moment the panel opens.
  // Messages from this index onward get a subtle highlight inside the chat so
  // it's easy to spot what arrived while you were away. null = nothing unread.
  const [unreadFromIndex, setUnreadFromIndex] = useState<number | null>(null)
  const unreadCount = chatOpen ? 0 : Math.max(0, messages.length - seenCount)

  // While the chat is open, keep marking everything as seen so the badge stays
  // cleared as new messages stream in.
  useEffect(() => {
    if (chatOpen) setSeenCount(messages.length)
  }, [chatOpen, messages.length])

  // Persist a read receipt to the server (and DB) whenever the chat panel is
  // open and the tab is visible. We mark up to the newest message's timestamp,
  // which broadcasts to peers so their messages flip to "read". Re-runs when new
  // messages arrive while the panel is open, and when the tab becomes visible.
  useEffect(() => {
    if (!chatOpen || messages.length === 0) return
    const markLatest = () => {
      if (document.hidden) return
      const last = messages[messages.length - 1]
      if (last) markChatRead(last.timestamp)
    }
    markLatest()
    document.addEventListener("visibilitychange", markLatest)
    return () => document.removeEventListener("visibilitychange", markLatest)
  }, [chatOpen, messages, markChatRead])

  // Play a gentle chime for incoming messages when the user can't see them —
  // i.e. the chat panel is closed OR the browser tab is in the background.
  const prevMsgLenRef = useRef(messages.length)
  useEffect(() => {
    const prev = prevMsgLenRef.current
    if (messages.length > prev) {
      const arrived = messages.slice(prev)
      const hasIncoming = arrived.some((m) => !m.self)
      if (hasIncoming && (!chatOpen || document.hidden)) {
        playMessageSound()
      }
    }
    prevMsgLenRef.current = messages.length
  }, [messages, chatOpen])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      const next = !open
      if (next) {
        // Freeze the unread boundary so we can highlight what was missed.
        setUnreadFromIndex(seenCount < messages.length ? seenCount : null)
        setSeenCount(messages.length)
      }
      return next
    })
  }, [messages.length, seenCount])

  const closeChat = useCallback(() => setChatOpen(false), [])

  // Global hotkey to toggle the chat. The bound key (KeyboardEvent.code) lives
  // in the persisted chat-button store and can be rebound from its settings.
  // We ignore presses while typing in inputs/textareas/contenteditable so the
  // shortcut never hijacks normal text entry (e.g. the chat composer itself).
  const chatHotkey = useChatButtonStore((s) => s.hotkey)
  useEffect(() => {
    if (!chatHotkey) return
    const handler = (e: KeyboardEvent) => {
      if (e.code !== chatHotkey) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Only skip the hotkey for keys that actually type a character (e.key
      // of length 1, e.g. letters/digits) while focused in a text field, so
      // we never hijack normal text entry in the chat composer. Non-text keys
      // like Tab/Escape/F-keys (e.key.length > 1) must still toggle the chat
      // even when the composer is focused — otherwise it could never be closed.
      const isTypingKey = e.key.length === 1
      if (isTypingKey) {
        const t = e.target as HTMLElement | null
        if (
          t &&
          (t.isContentEditable ||
            t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT")
        ) {
          return
        }
      }
      e.preventDefault()
      toggleChat()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [chatHotkey, toggleChat])

  return { chatOpen, unreadCount, unreadFromIndex, toggleChat, closeChat }
}
