'use client'

import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { computeTabStatus, subscribeInCall, type TabStatus } from '@/lib/chat/tab-status'

// ---------------------------------------------------------------------------
// Своя половина presence на клиенте: heartbeat, статус вкладки и уход по
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
//  2. dm:status online/hidden/call. Живой websocket ещё не значит «человек за
//     компьютером»: вкладку свернули, ноутбук закрыли, ушли пить чай. Без этого
//     зелёная точка врала бы сутками — по ней нельзя было понять, ответят ли.
//     Уход в фон (hidden) сервер трактует как оффлайн, поэтому переключение на
//     другую вкладку сразу превращается у друзей в «был(а) в сети только что».
//
//     Сам расчёт статуса живёт в lib/chat/tab-status: тот же ответ нужен в
//     handshake нового соединения, где этого хука ещё нет. Здесь остаётся только
//     история (фокус, активность), доставка и подписки.
//
//  3. sendBeacon при выгрузке страницы. socket.emit в этот момент доставить
//     нельзя (браузер убивает соединения не дожидаясь отправки), а движок
//     заметит разрыв только через свой pingTimeout — все 30 секунд собеседник
//     видел бы «в сети» у человека, который уже закрыл вкладку.
// ---------------------------------------------------------------------------

/** Интервал heartbeat. С запасом меньше PING_TIMEOUT_MS на сервере (15 с). */
const PING_INTERVAL_MS = 7_000

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
  const sentStatus = useRef<TabStatus | null>(null)

  useEffect(() => {
    if (!socket) return

    let lastActivityAt = Date.now()
    // Есть ли у окна фокус. Держим в переменной, а не спрашиваем hasFocus()
    // каждый раз: нужно ещё и ВРЕМЯ потери фокуса, чтобы отличить мгновенный
    // клик в адресную строку от ухода в другое приложение.
    let focused = document.hasFocus()
    let focusLostAt = focused ? 0 : Date.now()

    // Само решение живёт в lib/chat/tab-status: тот же ответ нужен в handshake
    // сокета, где этого хука ещё нет. Здесь остаётся только история — фокус и
    // активность, которых у handshake быть не может.
    const desiredStatus = (): TabStatus =>
      computeTabStatus({ focused, focusLostAt, lastActivityAt })

    const syncStatus = () => {
      if (!socket.connected) return
      const status = desiredStatus()
      if (status === sentStatus.current) return
      sentStatus.current = status
      socket.emit('dm:status', { status })
    }

    const onActivity = () => {
      lastActivityAt = Date.now()
      // Действие в окне означает, что фокус вернулся: событие focus могло не
      // прийти (например, окно активировали кликом по самой странице), и без
      // этого человек остался бы «ушедшим», активно печатая.
      if (!focused && document.hasFocus()) focused = true
      // Возврат к активности показываем сразу: собеседник должен видеть, что
      // человек вернулся, не дожидаясь следующей проверки.
      if (sentStatus.current !== 'online') syncStatus()
    }

    // Ушли в другое приложение или окно. Само по себе это ещё не оффлайн —
    // порог BLUR_AWAY_MS отсеивает клик в адресную строку и devtools.
    const onBlur = () => {
      if (!focused) return
      focused = false
      focusLostAt = Date.now()
      syncStatus()
    }

    // Вернулись в окно — это и есть присутствие, зачитываем как активность,
    // иначе после пяти минут в игре человек вернулся бы сразу в idle.
    const onFocus = () => {
      focused = true
      lastActivityAt = Date.now()
      // Возврат отправляем ПРИНУДИТЕЛЬНО: пока нас не было, сервер мог сам
      // понизить статус (свипер видит, что пинги из фоновой вкладки идут реже —
      // браузер душит там таймеры). Наша память об отправленном статусе об этом
      // не знает, и без сброса «я снова здесь» не ушло бы вовсе.
      sentStatus.current = null
      syncStatus()
    }

    const onVisibility = () => {
      // Вернулись во вкладку — это тоже действие: без этого сразу после
      // переключения статус остался бы idle до первого движения мыши.
      if (document.visibilityState === 'visible') {
        lastActivityAt = Date.now()
        // Та же причина, что в onFocus: состояние на сервере могло разойтись с
        // нашим представлением о нём, пока вкладка была в фоне.
        sentStatus.current = null
      }
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

    // Heartbeat НЕСЁТ СТАТУС, а не только факт «я жив».
    //
    // Так presence перестаёт зависеть от того, дошло ли когда-то отдельное
    // событие dm:status: каждый пинг — это полное состояние вкладки, поэтому
    // любое расхождение между клиентом и сервером само лечится за один интервал
    // (потерянное событие, реконнект, перезапуск сокет-сервера, эвристика
    // свипера на той стороне). dm:status остаётся для МГНОВЕННОЙ реакции на
    // переключение вкладки — ждать пинга там нельзя.
    const pingTimer = setInterval(() => {
      if (!socket.connected) return
      const status = desiredStatus()
      // Раз состояние уже ушло вместе с пингом, помечаем его отправленным —
      // иначе следующий syncStatus продублировал бы то же самое через dm:status.
      sentStatus.current = status
      socket.emit('dm:ping', { status })
    }, PING_INTERVAL_MS)

    // Уход в idle по бездействию наступает молча, без всякого события, поэтому
    // его можно заметить только опросом.
    const idleTimer = setInterval(syncStatus, IDLE_CHECK_MS)

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, onActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Вход в звонок и выход из него не порождают ни одного браузерного события,
    // поэтому единственный способ отреагировать мгновенно — подписка. Иначе
    // «уже говорю» и «разговор закончился» доезжали бы только со следующим
    // опросом, до пяти секунд показывая собеседнику неправду.
    const unsubscribeCall = subscribeInCall(syncStatus)
    // Фокус слушаем на window: у document эти события не всплывают так же
    // предсказуемо во всех браузерах.
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
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
      unsubscribeCall()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      sentStatus.current = null
    }
  }, [socket])

  // --- Уход по закрытию вкладки -------------------------------------------
  //
  // Отдельный эффект: слушател�� тут ставятся на window и не должны
  // переустанавливаться вместе с таймерами heartbeat.
  useEffect(() => {
    if (!socket) return

    let sent = false

    const leave = () => {
      // pagehide может прийти и при уходе страницы в фоновый кэш, и следом
      // beforeunload — вто��ой запрос ничего не добавит.
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
