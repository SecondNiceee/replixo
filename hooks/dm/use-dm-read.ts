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
//
// Канонический путь — ТОЛЬКО сокет: сервер в ответ на dm:read рассылает это
// событие всем участникам, и именно так у собеседника появляются вторые
// галочки. HTTP-роут /read такой рассылки сделать не может (у Next нет ручки
// на socket.io), поэтому он остаётся аварийным путём и его результат НЕ
// считается доставленным — после реконнекта эмит повторяется.
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
  // Что уже подтверждённо отправлено по сокету: conversationId → ts. Защита от
  // повторной отправки того же состояния на каждый ререндер.
  const sent = useRef(new Map<string, number>())

  // Счётчик подключений. Растёт на каждый (ре)коннект и заставляет эффект
  // ниже переотправить отметку: пока сокета не было, она могла уйти только по
  // HTTP, а значит собеседник о ней не узнал.
  const [socketEpoch, setSocketEpoch] = useState(0)
  useEffect(() => {
    if (!socket) return
    const onConnect = () => {
      // Отметки, сделанные до разрыва, могли не дойти до сервера — снимаем
      // защиту и позволяем эффекту отправить их заново. Сервер идемпотентен:
      // lastReadAt двигается через GREATEST.
      sent.current.clear()
      setSocketEpoch((n) => n + 1)
    }
    socket.on('connect', onConnect)
    return () => {
      socket.off('connect', onConnect)
    }
  }, [socket])

  useEffect(() => {
    if (!conversationId || !visible || !atBottom) return
    if (lastMessageAt === 0) return
    if ((sent.current.get(conversationId) ?? 0) >= lastMessageAt) return

    const timer = setTimeout(() => {
      if (socket?.connected) {
        socket.emit('dm:read', { conversationId, ts: lastMessageAt })
        // Записываем только успешный эмит по сокету.
        sent.current.set(conversationId, lastMessageAt)
      } else {
        // Аварийный путь: отметка сохранится в БД, но dm:read не разойдётся.
        // Намеренно НЕ пишем в `sent`, чтобы после реконнекта отправить эмит.
        onFallback?.(conversationId)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [socket, socketEpoch, conversationId, lastMessageAt, atBottom, visible, onFallback])
}
