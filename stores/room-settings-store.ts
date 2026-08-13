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
  /**
   * Microphone noise gate. While the mic level sits below an adaptive threshold
   * the published audio is muted outright, so keyboards, fans and breathing
   * never reach the room. On by default — see lib/mic-gate.ts.
   */
  noiseGate: boolean
  dirty: boolean

  setSoundVolume: (volume: number) => void
  setNoiseGate: (enabled: boolean) => void
  /** Apply settings coming from the server without marking the store dirty. */
  applyServer: (settings: RoomSettingsPayload) => void
  /** Clear the dirty flag after a successful sync to the DB. */
  clearDirty: () => void
  reset: () => void
}

export interface RoomSettingsPayload {
  soundVolume: number
  noiseGate: boolean
}

const DEFAULTS: RoomSettingsPayload = {
  soundVolume: 80,
  noiseGate: true,
}

export const useRoomSettingsStore = create<RoomSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      dirty: false,
      setSoundVolume: (volume) =>
        set({ soundVolume: clampVolume(volume), dirty: true }),
      setNoiseGate: (enabled) => set({ noiseGate: enabled, dirty: true }),
      applyServer: (settings) =>
        set({
          soundVolume: clampVolume(settings.soundVolume),
          noiseGate: settings.noiseGate !== false,
          dirty: false,
        }),
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
  const { soundVolume, noiseGate } = useRoomSettingsStore.getState()
  return { soundVolume, noiseGate }
}

function clampVolume(n: number) {
  if (Number.isNaN(n)) return DEFAULTS.soundVolume
  return Math.min(100, Math.max(0, Math.round(n)))
}
