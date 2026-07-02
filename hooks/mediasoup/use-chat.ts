"use client"

import { useCallback } from "react"
import type { Socket } from "socket.io-client"
import type { ChatAttachment } from "./types"
import { SERVER_URL } from "./types"
import type { Action } from "./reducer"

interface UseChatParams {
  roomId: string
  displayName: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  dispatch: (action: Action) => void
}

export function useChat({
  roomId,
  displayName,
  peerIdRef,
  socketRef,
  dispatch,
}: UseChatParams) {
  const sendChatMessage = useCallback((text: string, attachment?: ChatAttachment | null) => {
    const trimmed = text.trim().slice(0, 2000)
    if (!trimmed && !attachment) return
    const socket = socketRef.current
    if (!socket) return

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    socket.emit("chatMessage", {
      roomId,
      peerId: peerIdRef.current,
      text: trimmed,
      id,
      ...(attachment ? { attachment } : {}),
    })
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        id,
        peerId: peerIdRef.current,
        displayName,
        text: trimmed,
        timestamp: Date.now(),
        self: true,
        attachment: attachment ?? null,
      },
    })
  }, [roomId, displayName, peerIdRef, socketRef, dispatch])

  const uploadChatFile = useCallback(async (file: File): Promise<ChatAttachment> => {
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/upload`, {
      method: "POST",
      body: form,
    })
    if (!res.ok) {
      let message = "Не удалось загрузить файл"
      try {
        const data = await res.json()
        if (data?.error) message = data.error
      } catch { /* use default message */ }
      throw new Error(message)
    }
    return (await res.json()) as ChatAttachment
  }, [roomId])

  const markChatRead = useCallback((ts: number) => {
    if (!Number.isFinite(ts) || ts <= 0) return
    const socket = socketRef.current
    if (!socket) return
    socket.emit("chatRead", { roomId, peerId: peerIdRef.current, ts })
    dispatch({ type: "SET_READ_MARKER", peerId: peerIdRef.current, ts })
  }, [roomId, peerIdRef, socketRef, dispatch])

  return { sendChatMessage, uploadChatFile, markChatRead }
}
