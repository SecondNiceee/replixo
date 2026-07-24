'use client'

import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { useDmStore } from '@/stores/dm-store'

// ---------------------------------------------------------------------------
// Приём эфемерных событий: presence, «печатает…», прочитано.
//
// Один подписчик на всё приложение (вызывается в ChatClient) — иначе каждый
// компонент навешивал бы свои слушатели на один и тот же сокет.
//
// Индикатор «печатает» гасим по таймеру: событие typing:false может не
// прийти вовсе (собеседник закрыл вкладку, потерял сеть), и индикатор бы
// висел вечно. Сервер эти состояния не хранит, так что чинить это может
// только клиент.
// ---------------------------------------------------------------------------

const TYPING_TIMEOUT_MS = 3000

export function useDmPresence(socket: Socket | null, selfId: string): void {
  const applyPresenceSnapshot = useDmStore((s) => s.applyPresenceSnapshot)
  const setPresence = useDmStore((s) => s.setPresence)
  const setTyping = useDmStore((s) => s.setTyping)
  const setPeerReadAt = useDmStore((s) => s.setPeerReadAt)
  const reset = useDmStore((s) => s.reset)

  // `${conversationId}|${userId}` → таймер автосброса индикатора.
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    if (!socket) return
    const timers = typingTimers.current

    const clearTypingTimer = (key: string) => {
      const timer = timers.get(key)
      if (timer) {
        clearTimeout(timer)
        timers.delete(key)
      }
    }

    const onSnapshot = (payload: unknown) => {
      const { onlineUserIds, lastSeenAt } = (payload ?? {}) as {
        onlineUserIds?: string[]
        lastSeenAt?: Record<string, number>
      }
      applyPresenceSnapshot(onlineUserIds ?? [], lastSeenAt ?? {})
    }

    const onPresence = (payload: unknown) => {
      const { userId, online, lastSeenAt } = (payload ?? {}) as {
        userId?: string
        online?: boolean
        lastSeenAt?: number
      }
      if (!userId || typeof online !== 'boolean') return
      setPresence(userId, online, lastSeenAt)
    }

    const onTyping = (payload: unknown) => {
      const { conversationId, userId, typing } = (payload ?? {}) as {
        conversationId?: string
        userId?: string
        typing?: boolean
      }
      if (!conversationId || !userId || typeof typing !== 'boolean') return
      if (userId === selfId) return

      const key = `${conversationId}|${userId}`
      clearTypingTimer(key)
      setTyping(conversationId, userId, typing)
      if (typing) {
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key)
            setTyping(conversationId, userId, false)
          }, TYPING_TIMEOUT_MS),
        )
      }
    }

    const onRead = (payload: unknown) => {
      const { conversationId, userId, ts } = (payload ?? {}) as {
        conversationId?: string
        userId?: string
        ts?: number
      }
      if (!conversationId || !userId || typeof ts !== 'number') return
      // Своё прочтение галочек не рисует — оно про счётчики, а их
      // пересчитывает ChatClient по тому же событию.
      if (userId === selfId) return
      setPeerReadAt(conversationId, ts)
    }

    socket.on('dm:presence:snapshot', onSnapshot)
    socket.on('dm:presence', onPresence)
    socket.on('dm:typing', onTyping)
    socket.on('dm:read', onRead)

    return () => {
      socket.off('dm:presence:snapshot', onSnapshot)
      socket.off('dm:presence', onPresence)
      socket.off('dm:typing', onTyping)
      socket.off('dm:read', onRead)
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      // Состояние presence достоверно только при живом соединении: после
      // разрыва «онлайн»-точки надо погасить, а не показывать устаревшие.
      reset()
    }
  }, [socket, selfId, applyPresenceSnapshot, setPresence, setTyping, setPeerReadAt, reset])
}
