'use client'

import { useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { SERVER_URL } from '@/hooks/mediasoup/types'

// ---------------------------------------------------------------------------
// Подключение к namespace /dm mediasoup-сервера.
//
// Токен сессии получаем отдельным авторизованным запросом (cookie httpOnly и
// в JS недоступен), затем передаём его в handshake. Сервер валидирует токен
// прямо в таблице "session" и выставляет личность сокета — клиент никогда не
// сообщает, кем он является.
// ---------------------------------------------------------------------------

export interface DmSocketState {
  socket: Socket | null
  connected: boolean
  /** true, если сервер отверг handshake (сессия истекла) или чат недоступен. */
  unavailable: boolean
}

export function useDmSocket(): DmSocketState {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    let created: Socket | null = null

    const connect = async () => {
      try {
        const res = await fetch('/api/chat/socket-token', { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) setUnavailable(true)
          return
        }
        const { token } = (await res.json()) as { token?: string }
        if (cancelled || !token) {
          if (!cancelled) setUnavailable(true)
          return
        }

        created = io(`${SERVER_URL}/dm`, {
          auth: { token },
          withCredentials: true,
          // Тот же путь /socket.io/, что и у звонков: nginx уже проксирует его.
          transports: ['websocket', 'polling'],
        })

        created.on('connect', () => {
          setConnected(true)
          setUnavailable(false)
        })
        created.on('disconnect', () => setConnected(false))
        created.on('connect_error', (e) => {
          setConnected(false)
          // 'unauthorized' — сессия истекла: переподключение не поможет.
          if (e.message === 'unauthorized') setUnavailable(true)
        })

        if (cancelled) {
          created.disconnect()
          return
        }
        setSocket(created)
      } catch {
        if (!cancelled) setUnavailable(true)
      }
    }

    void connect()

    return () => {
      cancelled = true
      created?.disconnect()
      setSocket(null)
      setConnected(false)
    }
  }, [])

  return { socket, connected, unavailable }
}
