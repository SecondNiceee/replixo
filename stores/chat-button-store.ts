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
 *
 * Sync model:
 * - Anonymous users keep settings only in localStorage.
 * - Signed-in users mirror them to the DB (see use-chat-button-sync).
 * - `dirty` tracks whether the user has actually changed anything locally.
 *   On login we merge: if the user customized settings (dirty), the local
 *   values win and are pushed to the DB; otherwise the DB values win.
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
  /**
   * True once the user changes any setting. Drives the login merge strategy and
   * tells the sync layer there are local edits worth persisting to the DB.
   */
  dirty: boolean

  setPosition: (xRatio: number, yRatio: number) => void
  setVisible: (visible: boolean) => void
  setHotkey: (hotkey: string | null) => void
  /** Apply settings coming from the server without marking the store dirty. */
  applyServer: (settings: ChatButtonSettings) => void
  /** Clear the dirty flag after a successful sync to the DB. */
  clearDirty: () => void
  reset: () => void
}

export interface ChatButtonSettings {
  xRatio: number
  yRatio: number
  visible: boolean
  hotkey: string | null
}

const DEFAULTS = {
  // Bottom-right by default, comfortably inside the viewport.
  xRatio: 0.92,
  yRatio: 0.78,
  visible: true,
  hotkey: "Tab",
} as const

export const useChatButtonStore = create<ChatButtonState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      dirty: false,
      setPosition: (xRatio, yRatio) =>
        set({
          xRatio: clamp01(xRatio),
          yRatio: clamp01(yRatio),
          dirty: true,
        }),
      setVisible: (visible) => set({ visible, dirty: true }),
      setHotkey: (hotkey) => set({ hotkey, dirty: true }),
      applyServer: (settings) =>
        set({
          xRatio: clamp01(settings.xRatio),
          yRatio: clamp01(settings.yRatio),
          visible: settings.visible,
          hotkey: settings.hotkey,
          dirty: false,
        }),
      clearDirty: () => set({ dirty: false }),
      reset: () => set({ ...DEFAULTS, dirty: true }),
    }),
    {
      name: "replixo:chat-button",
      version: 1,
      // `dirty` is intentionally persisted so a customization made while logged
      // out is still recognized as a real edit after the user signs in.
    },
  ),
)

/** Read the current settings as a plain payload (for sending to the API). */
export function getChatButtonSettings(): ChatButtonSettings {
  const { xRatio, yRatio, visible, hotkey } = useChatButtonStore.getState()
  return { xRatio, yRatio, visible, hotkey }
}

function clamp01(n: number) {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}
