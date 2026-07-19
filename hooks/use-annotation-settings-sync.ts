"use client"

import { useEffect, useRef } from "react"
import { useSession } from "@/lib/auth-client"
import {
  getAnnotationSettings,
  useAnnotationSettingsStore,
  type AnnotationSettings,
} from "@/stores/annotation-settings-store"

const API = "/api/user/annotation-settings"
const AUTH_MODE_KEY = "replixo:annotation-auth-mode"

async function fetchSettings(): Promise<AnnotationSettings | null> {
  const response = await fetch(API, { credentials: "include" })
  if (!response.ok) return null
  const data = (await response.json()) as { settings: AnnotationSettings | null }
  return data.settings
}

async function saveSettings(settings: AnnotationSettings) {
  const response = await fetch(API, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
  if (!response.ok) throw new Error("Unable to save annotation settings")
}

export function useAnnotationSettingsSync() {
  const { data: session, isPending } = useSession()
  const userId = session?.user?.id ?? null
  const mergedForUser = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isPending) return
    if (!userId) {
      mergedForUser.current = null
      return
    }
    if (mergedForUser.current === userId) return
    mergedForUser.current = userId

    let cancelled = false
    void (async () => {
      const authMode = window.localStorage.getItem(AUTH_MODE_KEY)
      const local = getAnnotationSettings()
      const server = await fetchSettings()
      if (cancelled) return

      if (authMode === "sign-up" || !server) {
        await saveSettings(local)
        useAnnotationSettingsStore.getState().clearDirty()
      } else {
        useAnnotationSettingsStore.getState().applyServer(server)
      }
      window.localStorage.removeItem(AUTH_MODE_KEY)
    })()

    return () => { cancelled = true }
  }, [isPending, userId])

  useEffect(() => {
    if (!userId) return
    const unsubscribe = useAnnotationSettingsStore.subscribe((state, previous) => {
      if (!state.dirty) return
      const changed = state.activation !== previous.activation || state.hotkey !== previous.hotkey || state.hintSeen !== previous.hintSeen
      if (!changed) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void saveSettings(getAnnotationSettings()).then(() => useAnnotationSettingsStore.getState().clearDirty())
      }, 600)
    })
    return () => {
      unsubscribe()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [userId])
}
