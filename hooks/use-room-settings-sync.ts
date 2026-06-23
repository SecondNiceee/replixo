"use client"

import { useEffect, useRef } from "react"
import { useSession } from "@/lib/auth-client"
import {
  getRoomSettings,
  useRoomSettingsStore,
  type RoomSettingsPayload,
} from "@/stores/room-settings-store"

const API = "/api/user/room-settings"

async function fetchServerSettings(): Promise<RoomSettingsPayload | null> {
  const res = await fetch(API, { credentials: "include" })
  if (!res.ok) return null
  const data = (await res.json()) as { settings: RoomSettingsPayload | null }
  return data.settings
}

async function pushServerSettings(payload: RoomSettingsPayload): Promise<void> {
  await fetch(API, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

/**
 * Keeps the room-settings store in sync with the database for signed-in users.
 * Behaviour is identical to useChatButtonSync — merge on login, debounced
 * autosave for subsequent changes.
 */
export function useRoomSettingsSync() {
  const { data: session, isPending } = useSession()
  const userId = session?.user?.id ?? null

  const mergedForUser = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // One-time merge on login
  useEffect(() => {
    if (isPending) return
    if (!userId) {
      mergedForUser.current = null
      return
    }
    if (mergedForUser.current === userId) return
    mergedForUser.current = userId

    let cancelled = false
    ;(async () => {
      const store = useRoomSettingsStore.getState()
      const local = getRoomSettings()
      const server = await fetchServerSettings()
      if (cancelled) return

      if (!server) {
        // New account — seed from local
        await pushServerSettings(local)
        useRoomSettingsStore.getState().clearDirty()
        return
      }

      if (store.dirty) {
        // Local customizations win
        await pushServerSettings(local)
        useRoomSettingsStore.getState().clearDirty()
      } else {
        // DB wins
        useRoomSettingsStore.getState().applyServer(server)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId, isPending])

  // Debounced autosave while signed in
  useEffect(() => {
    if (!userId) return

    const unsubscribe = useRoomSettingsStore.subscribe((state, prev) => {
      if (!state.dirty) return
      if (state.soundVolume === prev.soundVolume) return

      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        await pushServerSettings(getRoomSettings())
        useRoomSettingsStore.getState().clearDirty()
      }, 600)
    })

    return () => {
      unsubscribe()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [userId])
}
