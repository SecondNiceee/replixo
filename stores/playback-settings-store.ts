"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

interface PlaybackSettings {
  volume: number
  muted: boolean
}

interface StoredPlaybackSettings extends PlaybackSettings {
  /** Когда настройку меняли последний раз — по нему вытесняем самые старые. */
  at?: number
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = { volume: 0.6, muted: false }

const STORAGE_NAME = "replixo:playback-settings"
// Каждый собеседник (и каждая комната для старых клиентов без playbackId)
// даёт свой ключ. Без потолка localStorage копил бы их бесконечно.
const MAX_ENTRIES = 300

interface PlaybackSettingsState {
  bySource: Partial<Record<string, StoredPlaybackSettings>>
  setPlayback: (key: string, settings: PlaybackSettings, keepDefault?: boolean) => void
}

function isDefault(s: PlaybackSettings): boolean {
  return !s.muted && s.volume === DEFAULT_PLAYBACK_SETTINGS.volume
}

export const usePlaybackSettingsStore = create<PlaybackSettingsState>()(
  persist(
    (set) => ({
      bySource: {},
      setPlayback: (key, settings, keepDefault = false) =>
        set((state) => {
          const bySource = { ...state.bySource }
          // An explicit account setting of 60% takes precedence over guest settings.
          if (!keepDefault && isDefault(settings)) {
            delete bySource[key]
          } else {
            bySource[key] = { volume: settings.volume, muted: settings.muted, at: Date.now() }
          }
          const keys = Object.keys(bySource)
          if (keys.length > MAX_ENTRIES) {
            keys
              .sort((a, b) => (bySource[a]?.at ?? 0) - (bySource[b]?.at ?? 0))
              .slice(0, keys.length - MAX_ENTRIES)
              .forEach((k) => delete bySource[k])
          }
          return { bySource }
        }),
    }),
    { name: STORAGE_NAME },
  ),
)

// persist не следит за другими вкладками: вкладка со старым состоянием при
// первой же записи затёрла бы всё, что сохранила соседняя. Подтягиваем
// изменения, как только их записала другая вкладка.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_NAME) void usePlaybackSettingsStore.persist.rehydrate()
  })
}
