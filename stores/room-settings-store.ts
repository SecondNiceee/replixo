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
  /**
   * Strength of the gate, 0..100 (integer). Interpolates the open threshold and
   * the margin above the measured noise floor inside the worklet:
   * 0 = cuts only true silence, 50 = default, 100 = only loud speech passes.
   */
  noiseGateStrength: number
  dirty: boolean

  setSoundVolume: (volume: number) => void
  setNoiseGate: (enabled: boolean) => void
  setNoiseGateStrength: (strength: number) => void
  /** Apply settings coming from the server without marking the store dirty. */
  applyServer: (settings: RoomSettingsPayload) => void
  /** Clear the dirty flag after a successful sync to the DB. */
  clearDirty: () => void
  reset: () => void
}

export interface RoomSettingsPayload {
  soundVolume: number
  noiseGate: boolean
  noiseGateStrength: number
}

const DEFAULTS: RoomSettingsPayload = {
  soundVolume: 80,
  noiseGate: true,
  noiseGateStrength: 50,
}

export const useRoomSettingsStore = create<RoomSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      dirty: false,
      setSoundVolume: (volume) =>
        set({ soundVolume: clampVolume(volume), dirty: true }),
      setNoiseGate: (enabled) => set({ noiseGate: enabled, dirty: true }),
      setNoiseGateStrength: (strength) =>
        set({ noiseGateStrength: clampStrength(strength), dirty: true }),
      applyServer: (settings) =>
        set({
          soundVolume: clampVolume(settings.soundVolume),
          noiseGate: settings.noiseGate !== false,
          noiseGateStrength: clampStrength(settings.noiseGateStrength),
          dirty: false,
        }),
      clearDirty: () => set({ dirty: false }),
      reset: () => set({ ...DEFAULTS, dirty: true }),
    }),
    {
      name: "replixo:room-settings",
      // v2 introduced noiseGateStrength. Older persisted state simply lacks the
      // key, so merge it in from the defaults instead of leaving it undefined.
      version: 2,
      migrate: (persisted) => ({
        ...(persisted as Partial<RoomSettingsState>),
        noiseGateStrength:
          typeof (persisted as Partial<RoomSettingsState>)?.noiseGateStrength === "number"
            ? (persisted as RoomSettingsState).noiseGateStrength
            : DEFAULTS.noiseGateStrength,
      }) as RoomSettingsState,
    },
  ),
)

export function getRoomSettings(): RoomSettingsPayload {
  const { soundVolume, noiseGate, noiseGateStrength } = useRoomSettingsStore.getState()
  return { soundVolume, noiseGate, noiseGateStrength }
}

function clampVolume(n: number) {
  if (Number.isNaN(n)) return DEFAULTS.soundVolume
  return Math.min(100, Math.max(0, Math.round(n)))
}

function clampStrength(n: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return DEFAULTS.noiseGateStrength
  return Math.min(100, Math.max(0, Math.round(n)))
}
