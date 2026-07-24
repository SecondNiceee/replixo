'use client'

import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'

// ---------------------------------------------------------------------------
// Отметка «прочитано».
//
// Условия честности: диалог открыт, вкладка видима И лента доскроллена вниз.
// Иначе получалось бы, что сообщение «прочитано», пока пользователь читает
// старую переписку выше или вообще держит вкладку в фоне.
//
// Дебаунс 500 мс: при быстрой серии входящих сообщений уходит одно событие.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500

interface UseDmReadOptions {
  socket: Socket | null
  conversationId: string | null
  /** Время последнего сообщения в ленте (мс). 0 — сообщений нет. */
  lastMessageAt: number
  atBottom: boolean
  /** Фолбэк, когда сокета нет: HTTP-роут отметки прочтения. */
  onFallback?: (conversationId: string) => void
}

/** Видима ли вкладка сейчас (реактивно). */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

export function useDmRead({
  socket,
  conversationId,
  lastMessageAt,
  atBottom,
  onFallback,
}: UseDmReadOptions): void {
  const visible = useDocumentVisible()
  // Что уже отмечено: `${conversationId}` → ts. Защита от повторной отправки
  // того же состояния на каждый ререндер.
  const sent = useRef(new Map<string, number>())

  useEffect(() => {
    if (!conversationId || !visible || !atBottom) return
    if (lastMessageAt === 0) return
    if ((sent.current.get(conversationId) ?? 0) >= lastMessageAt) return

    const timer = setTimeout(() => {
      sent.current.set(conversationId, lastMessageAt)
      if (socket?.connected) {
        socket.emit('dm:read', { conversationId, ts: lastMessageAt })
      } else {
        onFallback?.(conversationId)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [socket, conversationId, lastMessageAt, atBottom, visible, onFallback])
}
