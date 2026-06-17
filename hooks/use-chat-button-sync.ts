"use client"

import { useEffect, useRef } from "react"
import { useSession } from "@/lib/auth-client"
import {
  getChatButtonSettings,
  useChatButtonStore,
  type ChatButtonSettings,
} from "@/stores/chat-button-store"

const API = "/api/user/chat-button-settings"

async function fetchServerSettings(): Promise<ChatButtonSettings | null> {
  const res = await fetch(API, { credentials: "include" })
  if (!res.ok) return null
  const data = (await res.json()) as { settings: ChatButtonSettings | null }
  return data.settings
}

async function pushServerSettings(payload: ChatButtonSettings): Promise<void> {
  await fetch(API, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

/**
 * Keeps the chat-button store in sync with the database for signed-in users.
 *
 * Anonymous users: nothing happens here — the store already persists to
 * localStorage on its own.
 *
 * On login we run a one-time merge:
 *   - If the user has locally customized settings (`dirty`), local wins: we
 *     push them to the DB. This covers "configured while logged out, then
 *     registered" — the local choices are carried into the account.
 *   - Otherwise the DB values win and are applied locally.
 *   - If the DB has no row yet (brand-new user), we seed it from local.
 *
 * After the merge, any further local change is debounced and pushed to the DB
 * so the account stays the source of truth across devices.
 */
export function useChatButtonSync() {
  const { data: session, isPending } = useSession()
  const userId = session?.user?.id ?? null

  // Guards so the merge runs once per signed-in user, and so the DB write that
  // the merge itself performs doesn't immediately re-trigger the autosave.
  const mergedForUser = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- One-time merge on login ---------------------------------------------
  useEffect(() => {
    if (isPending) return
    if (!userId) {
      // Logged out: allow the merge to run again on the next login.
      mergedForUser.current = null
      return
    }
    if (mergedForUser.current === userId) return
    mergedForUser.current = userId

    let cancelled = false
    ;(async () => {
      const store = useChatButtonStore.getState()
      const local = getChatButtonSettings()
      const server = await fetchServerSettings()
      if (cancelled) return

      if (!server) {
        // New account with no saved settings: seed from local.
        await pushServerSettings(local)
        useChatButtonStore.getState().clearDirty()
        return
      }

      if (store.dirty) {
        // User customized settings locally -> local wins, persist to DB.
        await pushServerSettings(local)
        useChatButtonStore.getState().clearDirty()
      } else {
        // No local edits -> DB wins.
        useChatButtonStore.getState().applyServer(server)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId, isPending])

  // --- Debounced autosave of local changes while signed in -----------------
  useEffect(() => {
    if (!userId) return

    const unsubscribe = useChatButtonStore.subscribe((state, prev) => {
      // Only react to actual setting changes flagged as dirty.
      if (!state.dirty) return
      const changed =
        state.xRatio !== prev.xRatio ||
        state.yRatio !== prev.yRatio ||
        state.visible !== prev.visible ||
        state.hotkey !== prev.hotkey
      if (!changed) return

      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        await pushServerSettings(getChatButtonSettings())
        useChatButtonStore.getState().clearDirty()
      }, 600)
    })

    return () => {
      unsubscribe()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [userId])
}
