'use client'

import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'

// ---------------------------------------------------------------------------
// Своя половина presence на клиенте: heartbeat, статус «отошёл» и уход по
// закрытию вкладки.
//
// Монтируется РОВНО ОДИН раз на приложение (в DmNotifier), потому что соединение
// одно на вкладку: второй экземпляр слал бы те же события дважды.
//
// Три отдельные задачи, и каждая закрывает свою дыру:
//
//  1. dm:ping каждые PING_INTERVAL_MS. У Socket.IO есть свой ping, но его
//     pingTimeout — 30 секунд, и понижать его нельзя: на нём держится
//     устойчивость звонков к мигнувшей сети. Presence же должен реагировать за
//     секунды, поэтому у него отдельный, более чуткий таймер (см.
//     PING_TIMEOUT_MS в server/src/dm/presence.ts).
//
//  2. dm:status online/idle. Живой websocket ещё не значит «человек за
//     компьютером»: вкладку свернули, ноутбук закрыли, ушли пить чай. Без этого
//     зелёная точка врала бы сутками — по ней нельзя было понять, ответят ли.
//
//  3. sendBeacon при выгрузке страницы. socket.emit в этот момент доставить
//     нельзя (браузер убивает соединения не дожидаясь отправки), а движок
//     заметит разрыв только через свой pingTimeout — все 30 секунд собеседник
//     видел бы «в сети» у человека, который уже закрыл вкладку.
// ---------------------------------------------------------------------------

/** Интервал heartbeat. С запасом меньше PING_TIMEOUT_MS на сервере (15 с). */
const PING_INTERVAL_MS = 7_000

/**
 * Сколько тишины считаем «отошёл» при открытой и видимой вкладке.
 *
 * Минута — компромисс: читающий длинное сообщение человек не должен желтеть на
 * глазах у собеседника, но и ушедший из-за стола не должен полчаса выглядеть
 * доступным. Скрытая вкладка в это окно не попадает: там idle ставится сразу,
 * ждать нечего.
 */
const IDLE_AFTER_MS = 60_000

/** Как часто проверяем бездействие. Точность до 5 секунд здесь достаточна. */
const IDLE_CHECK_MS = 5_000

/**
 * События, считающиеся признаком жизни. Только passive-слушатели на document:
 * их частота высокая, а обработчик обязан быть дешёвым — он лишь пишет число в
 * ref, поэтому ререндера не вызывает.
 */
const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
] as const

export function usePresenceHeartbeat(socket: Socket | null): void {
  // Последний отправленный статус: dm:status шлём только на изменении, иначе на
  // каждое движение мыши уходило бы событие, а сервер рассылал бы его друзьям.
  const sentStatus = useRef<'online' | 'idle' | null>(null)

  useEffect(() => {
    if (!socket) return

    let lastActivityAt = Date.now()

    const desiredStatus = (): 'online' | 'idle' =>
      // Скрытая вкладка — сразу idle: ждать бездействия незачем, пользователь
      // смотрит куда-то ещё. Иначе решает время с последнего действия.
      document.visibilityState === 'hidden' || Date.now() - lastActivityAt >= IDLE_AFTER_MS
        ? 'idle'
        : 'online'

    const syncStatus = () => {
      if (!socket.connected) return
      const status = desiredStatus()
      if (status === sentStatus.current) return
      sentStatus.current = status
      socket.emit('dm:status', { status })
    }

    const onActivity = () => {
      lastActivityAt = Date.now()
      // Возврат к активности показываем сразу: собеседник должен видеть, что
      // человек вернулся, не дожидаясь следующей проверки.
      if (sentStatus.current === 'idle') syncStatus()
    }

    const onVisibility = () => {
      // Вернулись во вкладку — это тоже действие: без этого сразу после
      // переключения статус остался бы idle до первого движения мыши.
      if (document.visibilityState === 'visible') lastActivityAt = Date.now()
      syncStatus()
    }

    // Соединение могло установиться раньше монтирования этого хука, а могло и
    // позже: статус выставляем и сейчас, и на каждом connect. Реконнект тоже
    // сюда попадает — после него сервер о статусе вкладки ничего не знает,
    // поэтому запомненное значение сбрасываем, чтобы событие ушло заново.
    const onConnect = () => {
      sentStatus.current = null
      syncStatus()
    }

    const onDisconnect = () => {
      // Сервер забыл всё об этом соединении. Не сбросив память, после
      // реконнекта мы бы решили, что статус уже отправлен, и не отправили его.
      sentStatus.current = null
    }

    const pingTimer = setInterval(() => {
      if (socket.connected) socket.emit('dm:ping')
    }, PING_INTERVAL_MS)

    // Уход в idle по бездействию наступает молча, без всякого события, поэтому
    // его можно заметить только опросом.
    const idleTimer = setInterval(syncStatus, IDLE_CHECK_MS)

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, onActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)

    syncStatus()

    return () => {
      clearInterval(pingTimer)
      clearInterval(idleTimer)
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, onActivity)
      }
      document.removeEventListener('visibilitychange', onVisibility)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      sentStatus.current = null
    }
  }, [socket])

  // --- Уход по закрытию вкладки -------------------------------------------
  //
  // Отдельный эффект: слушатели тут ставятся на window и не должны
  // переустанавливаться вместе с таймерами heartbeat.
  useEffect(() => {
    if (!socket) return

    let sent = false

    const leave = () => {
      // pagehide может прийти и при уходе страницы в фоновый кэш, и следом
      // beforeunload — второй запрос ничего не добавит.
      if (sent) return
      const socketId = socket.id
      if (!socketId) return
      sent = true
      // Beacon идёт в Next, а не на сокет-сервер напрямую: там из сессии
      // достаётся личность (браузеру этот путь доверять нельзя) и запрос уходит
      // дальше по внутреннему секрету. Плюс свой origin nginx проксирует всегда,
      // а /dm/ на порт 3001 — нет.
      const url = `/api/chat/presence/leave?socketId=${encodeURIComponent(socketId)}`
      // Тело не нужно: всё, что требуется, есть в query и в cookie сессии.
      const ok = navigator.sendBeacon?.(url)
      // Единственный шанс на старом браузере без sendBeacon. keepalive
      // переживает выгрузку страницы, обычный fetch — нет.
      if (!ok) void fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
    }

    // pagehide, а не только beforeunload: в Safari (в том числе на iOS)
    // beforeunload при закрытии вкладки не срабатывает вовсе.
    window.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', leave)

    return () => {
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('beforeunload', leave)
    }
  }, [socket])
}
