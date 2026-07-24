'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'

// ---------------------------------------------------------------------------
// Исходящее «печатает…».
//
// На каждое нажатие клавиши событие не отправляем: это десятки пакетов в
// секунду на пустом месте. Вместо этого typing:true уходит один раз и
// повторяется не чаще REPEAT_MS (чтобы у собеседника не сработал автосброс
// при длинном сообщении), а typing:false — через IDLE_MS молчания.
// ---------------------------------------------------------------------------

/** Реже автосброса на приёмной стороне (3 с), иначе индикатор будет мигать. */
const REPEAT_MS = 2000
/** Пауза в наборе, после которой считаем, что человек перестал печатать. */
const IDLE_MS = 2000

export function useTyping(socket: Socket | null, conversationId: string | null) {
  const lastSentAt = useRef(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTyping = useRef(false)

  const emit = useCallback(
    (typing: boolean) => {
      if (!socket || !conversationId) return
      socket.emit('dm:typing', { conversationId, typing })
    },
    [socket, conversationId],
  )

  const stop = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
    if (!isTyping.current) return
    isTyping.current = false
    lastSentAt.current = 0
    emit(false)
  }, [emit])

  const notify = useCallback(() => {
    if (!socket || !conversationId) return
    const now = Date.now()
    if (!isTyping.current || now - lastSentAt.current > REPEAT_MS) {
      isTyping.current = true
      lastSentAt.current = now
      emit(true)
    }
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(stop, IDLE_MS)
  }, [socket, conversationId, emit, stop])

  // Переключение диалога или уход со страницы: гасим индикатор у собеседника,
  // иначе он останется висеть в диалоге, который мы уже закрыли.
  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = null
      if (isTyping.current && socket && conversationId) {
        isTyping.current = false
        socket.emit('dm:typing', { conversationId, typing: false })
      }
    }
  }, [socket, conversationId])

  return { notifyTyping: notify, stopTyping: stop }
}
