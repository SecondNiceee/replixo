"use client"

import { create } from "zustand"

// --- Chat-button / room UI settings store ----------------------------------
// Хранит персональные настройки плавающей кнопки чата.
//   • Гость (нет аккаунта) — настройки живут в localStorage.
//   • Залогиненный пользователь — настройки в БД (/api/settings), localStorage
//     при этом используется как кэш и как «черновик гостя» для слияния.
//
// Слияние при регистрации: когда гость с локальными настройками логинится,
// мы один раз отправляем PUT с локальными значениями (read-your-writes на
// сервере объединит их с тем, что уже есть), затем подтягиваем результат.

export interface ChatSettings {
  showChatButton: boolean
  // Значение KeyboardEvent.key для горячей клавиши открытия чата.
  openChatKey: string
  // Позиция кнопки в долях окна от ПРАВОГО-НИЖНЕГО угла (0..1). null = по умолчанию.
  buttonX: number | null
  buttonY: number | null
}

export const DEFAULT_SETTINGS: ChatSettings = {
  showChatButton: true,
  openChatKey: "Tab",
  buttonX: null,
  buttonY: null,
}

const LS_KEY = "replixo_chat_settings"

function readLocal(): ChatSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ChatSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function writeLocal(s: ChatSettings) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

interface SettingsState {
  settings: ChatSettings
  // Привязан ли стор к серверному аккаунту (true после успешного hydrate с userId).
  remote: boolean
  hydrated: boolean
  // Подтягивает настройки: для гостя — из localStorage; для пользователя — из БД
  // (с предварительным слиянием локального черновика). Безопасно вызывать часто.
  hydrate: (isAuthed: boolean) => Promise<void>
  // Частичное обновление + персист (localStorage и/или БД).
  update: (patch: Partial<ChatSettings>) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persistRemote(settings: ChatSettings) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }).catch((err) => console.error("[settings] save failed:", err))
  }, 400)
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  remote: false,
  hydrated: false,

  hydrate: async (isAuthed: boolean) => {
    const local = readLocal()

    if (!isAuthed) {
      // Гость: только localStorage.
      set({ settings: local, remote: false, hydrated: true })
      return
    }

    // Залогинен: слить локальный черновик в БД, затем взять серверное состояние.
    try {
      // 1) merge — отправляем локальные значения; сервер объединит с имеющимися.
      const mergeRes = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      })
      let serverSettings: ChatSettings = local
      if (mergeRes.ok) {
        const data = await mergeRes.json()
        if (data?.settings) serverSettings = { ...DEFAULT_SETTINGS, ...data.settings }
      } else {
        // Не удалось слить — подтянем как есть.
        const getRes = await fetch("/api/settings")
        if (getRes.ok) {
          const data = await getRes.json()
          if (data?.settings) serverSettings = { ...DEFAULT_SETTINGS, ...data.settings }
        }
      }
      writeLocal(serverSettings)
      set({ settings: serverSettings, remote: true, hydrated: true })
    } catch (err) {
      console.error("[settings] hydrate failed, falling back to local:", err)
      set({ settings: local, remote: false, hydrated: true })
    }
  },

  update: (patch: Partial<ChatSettings>) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    writeLocal(next)
    if (get().remote) persistRemote(next)
  },
}))
