"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Persisted app-level settings for the room experience.
 *
 * Sync model — identical to chat-button-store:
 * - Anonymous users: localStorage only.
 * - Signed-in users: mirrored to the DB (see use-room-settings-sync).
 * - `dirty` drives the login merge strategy.
 */
export interface RoomSettingsState {
  /**
   * Master volume for in-app notification sounds (join, leave, message, screen
   * share). Range 0..100 (integer). 0 = muted, 100 = full gain.
   */
  soundVolume: number
  dirty: boolean

  setSoundVolume: (volume: number) => void
  /** Apply settings coming from the server without marking the store dirty. */
  applyServer: (settings: RoomSettingsPayload) => void
  /** Clear the dirty flag after a successful sync to the DB. */
  clearDirty: () => void
  reset: () => void
}

export interface RoomSettingsPayload {
  soundVolume: number
}

const DEFAULTS: RoomSettingsPayload = {
  soundVolume: 80,
}

export const useRoomSettingsStore = create<RoomSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      dirty: false,
      setSoundVolume: (volume) =>
        set({ soundVolume: clampVolume(volume), dirty: true }),
      applyServer: (settings) =>
        set({ soundVolume: clampVolume(settings.soundVolume), dirty: false }),
      clearDirty: () => set({ dirty: false }),
      reset: () => set({ ...DEFAULTS, dirty: true }),
    }),
    {
      name: "replixo:room-settings",
      version: 1,
    },
  ),
)

export function getRoomSettings(): RoomSettingsPayload {
  const { soundVolume } = useRoomSettingsStore.getState()
  return { soundVolume }
}

function clampVolume(n: number) {
  if (Number.isNaN(n)) return DEFAULTS.soundVolume
  return Math.min(100, Math.max(0, Math.round(n)))
}
