"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

export type AnnotationActivation = "double-click" | "hotkey"

export interface AnnotationSettings {
  activation: AnnotationActivation
  hotkey: string | null
  hintSeen: boolean
}

interface AnnotationSettingsState extends AnnotationSettings {
  dirty: boolean
  setActivation: (activation: AnnotationActivation) => void
  setHotkey: (hotkey: string | null) => void
  markHintSeen: () => void
  applyServer: (settings: AnnotationSettings) => void
  clearDirty: () => void
  reset: () => void
}

const DEFAULTS: AnnotationSettings = {
  activation: "double-click",
  hotkey: null,
  hintSeen: false,
}

export const useAnnotationSettingsStore = create<AnnotationSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      dirty: false,
      setActivation: (activation) => set({ activation, dirty: true }),
      setHotkey: (hotkey) => set({ hotkey, dirty: true }),
      markHintSeen: () => set({ hintSeen: true, dirty: true }),
      applyServer: (settings) => set({ ...settings, dirty: false }),
      clearDirty: () => set({ dirty: false }),
      reset: () => set({ ...DEFAULTS, dirty: true }),
    }),
    { name: "replixo:annotation-settings", version: 1 },
  ),
)

export function getAnnotationSettings(): AnnotationSettings {
  const { activation, hotkey, hintSeen } = useAnnotationSettingsStore.getState()
  return { activation, hotkey, hintSeen }
}
