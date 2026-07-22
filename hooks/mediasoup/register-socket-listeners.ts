import type { Socket } from "socket.io-client"
import { playJoinSound, playLeaveSound } from "@/lib/sounds"
import { normalizeSource } from "./types"
import type { Consumer, MediaSource, Transport, ChatAttachment } from "./types"
import type { Action } from "./reducer"

type Ref<T> = React.MutableRefObject<T>

export interface RoomSocketListenerDeps {
  dispatch: (action: Action) => void
  peerIdRef: Ref<string>
  consumersRef: Ref<Map<string, Consumer>>
  pendingClosedProducersRef: Ref<Set<string>>
  kickedRef: Ref<boolean>
  hasJoinedRef: Ref<boolean>
  sendTransportRef: Ref<Transport | null>
  recvTransportRef: Ref<Transport | null>
  consumeProducer: (
    remotePeerId: string,
    displayName: string,
    producerId: string,
    kind: "audio" | "video",
    appData?: Record<string, unknown>,
  ) => Promise<void>
  whiteboardListenersRef: Ref<Set<(changes: unknown) => void>>
  annotationStrokeListenersRef: Ref<Set<(stroke: unknown) => void>>
  annotationClearListenersRef: Ref<Set<() => void>>
}

/**
 * Registers all domain socket.io event listeners for a room session (peers,
 * producers, chat, whiteboard and annotations). The connect / connect_error
 * handlers stay in `useMediasoup` because they drive the join/rejoin sequence.
 */
export function registerRoomSocketListeners(socket: Socket, deps: RoomSocketListenerDeps) {
  const {
    dispatch,
    peerIdRef,
    consumersRef,
    pendingClosedProducersRef,
    kickedRef,
    hasJoinedRef,
    sendTransportRef,
    recvTransportRef,
    consumeProducer,
    whiteboardListenersRef,
    annotationStrokeListenersRef,
    annotationClearListenersRef,
  } = deps

  socket.on("kicked", () => {
    kickedRef.current = true
    hasJoinedRef.current = false
    socket.io.opts.reconnection = false
    socket.disconnect()
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    consumersRef.current.clear()
    dispatch({
      type: "ERROR",
      error: "Вы открыли эту комнату в другой вкладке или на другом устройстве. Здесь сеанс завершён.",
    })
  })

  socket.on("peerJoined", ({ peerId: joinedId, displayName: joinedName }) => {
    if (joinedId === peerIdRef.current) return
    dispatch({ type: "PEER_JOINED", peerId: joinedId, displayName: joinedName })
    playJoinSound()
  })

  socket.on("newProducer", async ({ peerId: remotePeerId, displayName: remoteName, producerId, kind, appData }) => {
    const waitForTransport = (): Promise<boolean> =>
      new Promise((resolve) => {
        if (recvTransportRef.current) { resolve(true); return }
        let attempts = 0
        const id = setInterval(() => {
          if (recvTransportRef.current) { clearInterval(id); resolve(true); return }
          if (++attempts >= 60) { clearInterval(id); resolve(false) }
        }, 250)
      })
    const ready = await waitForTransport()
    if (!ready) return
    await consumeProducer(remotePeerId, remoteName, producerId, kind as "audio" | "video", appData)
  })

  socket.on("peerLeft", ({ peerId: leftId }) => {
    if (leftId === peerIdRef.current) return
    dispatch({ type: "PEER_LEFT", peerId: leftId })
    playLeaveSound()
  })

  socket.on("producerClosed", ({ peerId: remotePeerId, producerId }) => {
    let target: Consumer | undefined
    for (const c of consumersRef.current.values()) {
      if (c.producerId === producerId) { target = c; break }
    }
    if (!target) {
      pendingClosedProducersRef.current.add(producerId)
      return
    }
    const source: MediaSource = normalizeSource((target.appData as Record<string, unknown>)?.source)
    target.close()
    consumersRef.current.delete(target.id)
    dispatch({ type: "PEER_PRODUCER_CLOSED", peerId: remotePeerId, source, kind: target.kind })
  })

  socket.on("producerPaused", ({ peerId: remotePeerId, producerId, paused }: { peerId: string; producerId: string; paused: boolean }) => {
    if (typeof remotePeerId !== "string") return
    let target: Consumer | undefined
    for (const c of consumersRef.current.values()) {
      if (c.producerId === producerId) { target = c; break }
    }
    if (!target || target.kind !== "audio") return
    if ((target.appData as Record<string, unknown>)?.source === "screen") return
    dispatch({ type: "PEER_AUDIO_MUTED", peerId: remotePeerId, muted: !!paused })
  })

  socket.on("chatMessage", (msg: { id: string; peerId: string; displayName: string; text: string; timestamp: number; attachment?: ChatAttachment | null }) => {
    if (!msg || typeof msg.id !== "string") return
    dispatch({ type: "ADD_MESSAGE", message: { ...msg, self: false, attachment: msg.attachment ?? null } })
  })

  socket.on("chatRead", (payload: { peerId: string; ts: number }) => {
    if (!payload || typeof payload.peerId !== "string" || typeof payload.ts !== "number") return
    dispatch({ type: "SET_READ_MARKER", peerId: payload.peerId, ts: payload.ts })
  })

  socket.on("whiteboardOpened", (payload: { peerId: string; snapshot: string | null }) => {
    dispatch({ type: "SET_WHITEBOARD", open: true, snapshot: payload?.snapshot ?? null })
  })
  socket.on("whiteboardClosed", () => {
    dispatch({ type: "SET_WHITEBOARD", open: false })
  })
  socket.on("whiteboardChange", (payload: { peerId: string; changes: unknown }) => {
    if (!payload || payload.changes == null) return
    whiteboardListenersRef.current.forEach((fn) => fn(payload.changes))
  })
  socket.on("annotationStroke", (payload: { peerId: string; stroke: unknown }) => {
    if (!payload || payload.stroke == null) return
    annotationStrokeListenersRef.current.forEach((fn) => fn(payload.stroke))
  })
  socket.on("annotationClear", () => {
    annotationClearListenersRef.current.forEach((fn) => fn())
  })
}
