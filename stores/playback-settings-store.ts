"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

interface PlaybackSettings {
  volume: number
  muted: boolean
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = { volume: 0.6, muted: false }

interface PlaybackSettingsState {
  bySource: Partial<Record<string, PlaybackSettings>>
  setPlayback: (key: string, settings: PlaybackSettings) => void
}

export const usePlaybackSettingsStore = create<PlaybackSettingsState>()(
  persist(
    (set) => ({
      bySource: {},
      setPlayback: (key, settings) =>
        set((state) => ({ bySource: { ...state.bySource, [key]: settings } })),
    }),
    { name: "replixo:playback-settings" },
  ),
)
