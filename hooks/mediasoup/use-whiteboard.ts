"use client"

import { useCallback, useRef } from "react"
import type { Socket } from "socket.io-client"
import type { Action } from "./reducer"

interface UseWhiteboardParams {
  roomId: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  dispatch: (action: Action) => void
}

export function useWhiteboard({
  roomId,
  peerIdRef,
  socketRef,
  dispatch,
}: UseWhiteboardParams) {
  const whiteboardListenersRef = useRef<Set<(changes: unknown) => void>>(new Set())
  const annotationStrokeListenersRef = useRef<Set<(stroke: unknown) => void>>(new Set())
  const annotationClearListenersRef = useRef<Set<() => void>>(new Set())

  // ---------------------------------------------------------------------------
  // Whiteboard open/close/sync
  // ---------------------------------------------------------------------------
  const openWhiteboard = useCallback(() => {
    socketRef.current?.emit("whiteboardOpen", { roomId, peerId: peerIdRef.current })
    dispatch({ type: "SET_WHITEBOARD", open: true })
  }, [roomId, peerIdRef, socketRef, dispatch])

  const closeWhiteboard = useCallback(() => {
    socketRef.current?.emit("whiteboardClose", { roomId, peerId: peerIdRef.current })
    dispatch({ type: "SET_WHITEBOARD", open: false })
  }, [roomId, peerIdRef, socketRef, dispatch])

  const sendWhiteboardChange = useCallback((changes: unknown) => {
    if (changes == null) return
    socketRef.current?.emit("whiteboardChange", { roomId, peerId: peerIdRef.current, changes })
  }, [roomId, peerIdRef, socketRef])

  const sendWhiteboardSnapshot = useCallback((snapshot: string) => {
    if (typeof snapshot !== "string") return
    socketRef.current?.emit("whiteboardSnapshot", { roomId, peerId: peerIdRef.current, snapshot })
  }, [roomId, peerIdRef, socketRef])

  const subscribeWhiteboardChange = useCallback((fn: (changes: unknown) => void) => {
    whiteboardListenersRef.current.add(fn)
    return () => { whiteboardListenersRef.current.delete(fn) }
  }, [])

  // ---------------------------------------------------------------------------
  // Screen-share annotations
  // ---------------------------------------------------------------------------
  const sendAnnotationStroke = useCallback((stroke: unknown) => {
    if (stroke == null) return
    socketRef.current?.emit("annotationStroke", { roomId, peerId: peerIdRef.current, stroke })
  }, [roomId, peerIdRef, socketRef])

  const sendAnnotationClear = useCallback(() => {
    socketRef.current?.emit("annotationClear", { roomId, peerId: peerIdRef.current })
  }, [roomId, peerIdRef, socketRef])

  const subscribeAnnotationStroke = useCallback((fn: (stroke: unknown) => void) => {
    annotationStrokeListenersRef.current.add(fn)
    return () => { annotationStrokeListenersRef.current.delete(fn) }
  }, [])

  const subscribeAnnotationClear = useCallback((fn: () => void) => {
    annotationClearListenersRef.current.add(fn)
    return () => { annotationClearListenersRef.current.delete(fn) }
  }, [])

  return {
    whiteboardListenersRef,
    annotationStrokeListenersRef,
    annotationClearListenersRef,
    openWhiteboard,
    closeWhiteboard,
    sendWhiteboardChange,
    sendWhiteboardSnapshot,
    subscribeWhiteboardChange,
    sendAnnotationStroke,
    sendAnnotationClear,
    subscribeAnnotationStroke,
    subscribeAnnotationClear,
  }
}
