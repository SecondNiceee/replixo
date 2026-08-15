'use client'

import { useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { SERVER_URL } from '@/hooks/mediasoup/types'
import { currentTabStatus } from '@/lib/chat/tab-status'

// ---------------------------------------------------------------------------
// Подключение к namespace /dm mediasoup-сервера.
//
// Токен сессии получаем отдельным авторизованным запросом (cookie httpOnly и
// в JS недоступен), затем передаём его в handshake. Сервер валидирует токен
// прямо в таблице "session" и выставляет личность сокета — клиент никогда не
// сообщает, кем он является.
//
// Соединение ОДНО на вкладку и разделяется всеми подписчиками (страница чата,
// бейдж в шапке, точки online в профиле). Иначе каждый вызов хука открывал бы
// свой websocket: сервер считал бы пользователя онлайн по нескольку раз, а
// одно и то же dm:message приходило бы в несколько слушателей — то есть звук
// уведомления играл бы дважды. Отсюда refcount вместо сокета на компонент.
// ---------------------------------------------------------------------------

export interface DmSocketState {
  socket: Socket | null
  connected: boolean
  /** true, если сервер отверг handshake (сессия истекла) или чат недоступен. */
  unavailable: boolean
}

type Listener = (state: DmSocketState) => void

let shared: Socket | null = null
let refCount = 0
let state: DmSocketState = { socket: null, connected: false, unavailable: false }
const listeners = new Set<Listener>()
// Отложенный разрыв: при переходе между страницами и при двойном монтировании
// в StrictMode счётчик на мгновение падает до нуля, и без отсрочки соединение
// рвалось бы и поднималось заново на каждой навигации.
let teardownTimer: ReturnType<typeof setTimeout> | null = null
const TEARDOWN_GRACE_MS = 1000

function publish(patch: Partial<DmSocketState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

async function openShared() {
  if (shared) return
  try {
    const res = await fetch('/api/chat/socket-token', { cache: 'no-store' })
    if (!res.ok) {
      publish({ unavailable: true })
      return
    }
    const { token } = (await res.json()) as { token?: string }
    if (!token) {
      publish({ unavailable: true })
      return
    }
    // Пока ждали токен, последний подписчик мог отмонтироваться.
    if (refCount === 0) return

    const socket = io(`${SERVER_URL}/dm`, {
      // Статус вкладки идёт вместе с токеном, а не первым событием после
      // подключения: без него сервер обязан был предполагать 'online', и
      // открытая в фоне вкладка (Ctrl+click, восстановление сессии, реконнект
      // свёрнутого браузера) давала у друзей вспышку зелёной точки, которая
      // через мгновение сменялась на «был(а) только что».
      //
      // auth здесь ФУНКЦИЯ, а не объект: объект socket.io запоминает один раз и
      // переиспользует при каждом реконнекте, поэтому статус приезжал бы
      // устаревшим — как раз в самом частом случае, когда браузер свёрнут и
      // соединение поднимается заново. Функция вызывается на каждую попытку.
      auth: (cb: (data: Record<string, unknown>) => void) => {
        cb({ token, status: currentTabStatus() })
      },
      withCredentials: true,
      // Тот же путь /socket.io/, что и у звонков: nginx уже проксирует его.
      transports: ['websocket', 'polling'],
    })
    shared = socket

    socket.on('connect', () => publish({ connected: true, unavailable: false }))
    socket.on('disconnect', () => publish({ connected: false }))
    socket.on('connect_error', (e) => {
      // Оба случая безнадёжны, реконнект не поможет:
      //   'unauthorized'      — сессия истекла;
      //   'Invalid namespace' — сервер поднят без DATABASE_URL, /dm нет.
      if (e.message === 'unauthorized' || e.message === 'Invalid namespace') {
        socket.disconnect()
        shared = null
        publish({ socket: null, connected: false, unavailable: true })
        return
      }
      publish({ connected: false })
    })

    publish({ socket, connected: socket.connected })
  } catch {
    publish({ unavailable: true })
  }
}

function closeShared() {
  shared?.disconnect()
  shared = null
  // unavailable не сбрасываем: если чат недоступен, это свойство сервера, а не
  // конкретного соединения — иначе следующий подписчик снова пойдёт за токеном.
  publish({ socket: null, connected: false })
}

export function useDmSocket(): DmSocketState {
  const [local, setLocal] = useState<DmSocketState>(state)

  useEffect(() => {
    listeners.add(setLocal)
    refCount += 1
    if (teardownTimer) {
      clearTimeout(teardownTimer)
      teardownTimer = null
    }
    // Синхронизируемся с текущим состоянием: соединение могло быть открыто
    // другим подписчиком ещё до нашего монтирования.
    setLocal(state)
    if (!shared && !state.unavailable) void openShared()

    return () => {
      listeners.delete(setLocal)
      refCount -= 1
      if (refCount === 0 && !teardownTimer) {
        teardownTimer = setTimeout(() => {
          teardownTimer = null
          if (refCount === 0) closeShared()
        }, TEARDOWN_GRACE_MS)
      }
    }
  }, [])

  return local
}
