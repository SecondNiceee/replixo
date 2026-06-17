"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Persisted UI settings for the floating chat button.
 *
 * The button can be dragged around the room (position is stored as a ratio of
 * the viewport so it stays sensible across resizes), hidden entirely, and bound
 * to a custom keyboard shortcut. Everything here survives reloads via
 * localStorage.
 */
export interface ChatButtonState {
  /** Horizontal position as a 0..1 ratio of the viewport width. */
  xRatio: number
  /** Vertical position as a 0..1 ratio of the viewport height. */
  yRatio: number
  /** Whether the floating button is rendered at all. */
  visible: boolean
  /**
   * KeyboardEvent.code used to toggle the chat (e.g. "KeyC"). null disables the
   * shortcut. We store `code` rather than `key` so the binding is layout- and
   * modifier-independent.
   */
  hotkey: string | null

  setPosition: (xRatio: number, yRatio: number) => void
  setVisible: (visible: boolean) => void
  setHotkey: (hotkey: string | null) => void
  reset: () => void
}

const DEFAULTS = {
  // Bottom-right by default, comfortably inside the viewport.
  xRatio: 0.92,
  yRatio: 0.78,
  visible: true,
  hotkey: "KeyC",
} as const

export const useChatButtonStore = create<ChatButtonState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setPosition: (xRatio, yRatio) =>
        set({
          xRatio: clamp01(xRatio),
          yRatio: clamp01(yRatio),
        }),
      setVisible: (visible) => set({ visible }),
      setHotkey: (hotkey) => set({ hotkey }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: "replixo:chat-button",
      version: 1,
    },
  ),
)

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}
