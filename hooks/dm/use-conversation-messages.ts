'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import {
  normalizeMessage,
  type DmMessage,
  type RawDmMessage,
} from '@/app/chat/types'

// ---------------------------------------------------------------------------
// История одного диалога + отправка через сокет.
//
// История приходит по HTTP (курсорная пагинация), новые сообщения — событием
// dm:message. Отправка оптимистичная: сообщение появляется сразу со статусом
// 'sending', ack переводит его в 'sent'. Повтор использует тот же id, поэтому
// сервер не создаёт дубликат.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50
const ACK_TIMEOUT_MS = 10_000

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface MessagesResponse {
  messages: RawDmMessage[]
  hasMore: boolean
}

export function useConversationMessages(
  conversationId: string | null,
  socket: Socket | null,
  selfId: string,
) {
  const [messages, setMessages] = useState<DmMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Актуальный id диалога для асинхронных ответов: пока грузилась история,
  // пользователь мог переключиться на другой диалог.
  const activeIdRef = useRef<string | null>(conversationId)
  activeIdRef.current = conversationId

  // --- Первая загрузка истории при смене диалога -------------------------
  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setHasMore(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=${PAGE_SIZE}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Не удалось загрузить историю')
        return (await res.json()) as MessagesResponse
      })
      .then((data) => {
        if (cancelled) return
        setMessages(data.messages.map(normalizeMessage))
        setHasMore(data.hasMore)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [conversationId])

  // --- Входящие сообщения -------------------------------------------------
  useEffect(() => {
    if (!socket || !conversationId) return

    const onMessage = (payload: unknown) => {
      const { conversationId: cid, message } = (payload ?? {}) as {
        conversationId?: string
        message?: RawDmMessage
      }
      if (cid !== conversationId || !message) return

      setMessages((prev) => {
        // Дедуп по id: своё же сообщение вернулось с сервера — фиксируем
        // канонические время и статус вместо добавления копии.
        const existing = prev.findIndex((m) => m.id === message.id)
        const normalized = normalizeMessage(message)
        if (existing !== -1) {
          const next = [...prev]
          next[existing] = { ...normalized, status: 'sent' }
          return next
        }
        return [...prev, normalized]
      })
    }

    socket.on('dm:message', onMessage)
    return () => {
      socket.off('dm:message', onMessage)
    }
  }, [socket, conversationId])

  // --- Отправка -----------------------------------------------------------
  const emit = useCallback(
    (id: string, cid: string, text: string) => {
      if (!socket) {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, status: 'failed' } : m)),
        )
        return
      }

      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit('dm:send', { conversationId: cid, id, text }, (err: unknown, res: unknown) => {
          if (activeIdRef.current !== cid) return
          const ok = !err && (res as { ok?: boolean } | undefined)?.ok === true
          const createdAt = (res as { createdAt?: number } | undefined)?.createdAt
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? {
                    ...m,
                    status: ok ? 'sent' : 'failed',
                    createdAt: ok && createdAt ? createdAt : m.createdAt,
                  }
                : m,
            ),
          )
        })
    },
    [socket],
  )

  const send = useCallback(
    (text: string) => {
      const cid = conversationId
      const trimmed = text.trim().slice(0, 4000)
      if (!cid || !trimmed) return

      const id = createMessageId()
      const selfMessage: DmMessage = {
        id,
        senderId: selfId,
        text: trimmed,
        createdAt: Date.now(),
        status: 'sending',
      }
      setMessages((prev) => [...prev, selfMessage])
      emit(id, cid, trimmed)
    },
    [conversationId, emit, selfId],
  )

  const retry = useCallback(
    (id: string) => {
      const cid = conversationId
      if (!cid) return
      const target = messages.find((m) => m.id === id)
      if (!target) return
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, status: 'sending' } : m)),
      )
      emit(id, cid, target.text)
    },
    [conversationId, messages, emit],
  )

  // --- Догрузка старых сообщений -----------------------------------------
  const loadMore = useCallback(async () => {
    const cid = conversationId
    if (!cid || loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = messages[0]
      const before = new Date(oldest.createdAt).toISOString()
      const res = await fetch(
        `/api/chat/conversations/${encodeURIComponent(cid)}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(before)}`,
      )
      if (!res.ok) throw new Error('Не удалось загрузить сообщения')
      const data = (await res.json()) as MessagesResponse
      if (activeIdRef.current !== cid) return
      setMessages((prev) => [...data.messages.map(normalizeMessage), ...prev])
      setHasMore(data.hasMore)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }, [conversationId, loadingMore, hasMore, messages])

  return { messages, loading, loadingMore, hasMore, error, send, retry, loadMore }
}
