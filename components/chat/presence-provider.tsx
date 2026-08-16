'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useDmStore, type PresenceStatus } from '@/stores/dm-store'
import { LAST_SEEN_PROVES_OFFLINE_MS } from '@/app/chat/types'

// ---------------------------------------------------------------------------
// Серверный снапшот presence + единственная точка чтения статуса.
//
// Зачем контекст, а если уже есть стор: стор наполняется только в браузере
// (события сокета, ответ /api/friends), поэтому первый кадр про статусы не знал
// ничего и рисовал всех «не в сети» — заметная вспышка при каждом открытии
// кабинета. Снапшот, снятый при серверном рендере, кладётся сюда и участвует в
// первом же кадре — и в HTML, и после гидрации.
//
// Почему не seed стора значениями с сервера: стор — модульный синглтон, на
// сервере он один на процесс. Запись в него во время рендера утекала бы между
// запросами разных пользователей. Контекст же создаётся на каждый рендер.
//
// Приоритет всегда у стора: websocket свежее любого HTTP-снапшота.
// ---------------------------------------------------------------------------

export interface PresenceFallback {
  /**
   * Удалось ли снять снапшот. При false он не отличим от «никого нет в сети»,
   * поэтому такие данные не считаются знанием (см. PresenceSnapshot.ok).
   */
  ok: boolean
  /** userId → 'online'. Оффлайн передаётся отсутствием ключа. */
  statuses: Record<string, 'online'>
  /** userId → когда человека видели последний раз (мс). */
  lastSeenAt: Record<string, number>
  /**
   * Date.now() на сервере. Нужен как стабильное «сейчас» для первого кадра:
   * относительное время («был(а) только что» / «был(а) 1 минуту назад»),
   * посчитанное от разных часов, дало бы разный текст на сервере и на клиенте —
   * то есть ошибку гидрации.
   */
  serverNow: number
}

const EMPTY_FALLBACK: PresenceFallback = {
  ok: false,
  statuses: {},
  lastSeenAt: {},
  serverNow: 0,
}

const PresenceContext = createContext<PresenceFallback>(EMPTY_FALLBACK)

export function PresenceProvider({
  value,
  children,
}: {
  value: PresenceFallback
  children: ReactNode
}) {
  const { ok, statuses, lastSeenAt, serverNow } = value
  // Объект приходит из серверных пропсов новой ссылкой на каждый рендер, а
  // контекст на смену ссылки перерисовывает всех потребителей — то есть каждую
  // строку списков.
  const memo = useMemo(
    () => ({ ok, statuses, lastSeenAt, serverNow }),
    [ok, statuses, lastSeenAt, serverNow],
  )

  return <PresenceContext.Provider value={memo}>{children}</PresenceContext.Provider>
}

/**
 * Статус одного человека одним значением. Отдельный хук, потому что подписка на
 * весь объект statuses перерисовывала бы компонент на любое чужое изменение.
 *
 * Порядок источников: живой стор → серверный снапшот → «не знаем».
 */
export function usePresenceStatus(userId: string | null | undefined): PresenceStatus {
  const fallback = useContext(PresenceContext)

  return useDmStore((s) => {
    if (!userId) return 'unknown'
    if (s.statuses[userId]) return 'online'
    // Живые данные есть, человека в них нет — значит он честно оффлайн.
    if (s.presenceLoaded) return 'offline'
    // Давнее lastSeenAt само по себе доказывает оффлайн даже после разрыва
    // websocket. Проверяем его ДО presenceEverLoaded: иначе reset скрывал уже
    // известное «был(а) час назад» за «Подключение…» до нового снапшота.
    const lastSeenAt = s.lastSeenAt[userId] ?? fallback.lastSeenAt[userId]
    if (lastSeenAt !== undefined) {
      // Отсчёт от серверного «сейчас», как и подписи: часы клиента могут
      // расходиться, а решение должно совпасть с тем, что отрисовано в HTML,
      // иначе первый кадр после гидрации сменит текст — то самое мигание.
      const now = fallback.serverNow || Date.now()
      if (now - lastSeenAt > LAST_SEEN_PROVES_OFFLINE_MS) return 'offline'
    }

    // Живые данные были и пропали (обрыв соединения): не используем серверный
    // online-снапшот повторно — он уже устарел. Для свежего lastSeenAt статус
    // остаётся неизвестным, пока websocket не подключится снова.
    if (s.presenceEverLoaded) return 'unknown'
    if (fallback.ok) return fallback.statuses[userId] ? 'online' : 'offline'

    return 'unknown'
  })
}

/** Когда человека видели последний раз (мс), либо undefined. */
export function usePresenceLastSeen(userId: string | null | undefined): number | undefined {
  const fallback = useContext(PresenceContext)
  return useDmStore((s) =>
    userId ? (s.lastSeenAt[userId] ?? fallback.lastSeenAt[userId]) : undefined,
  )
}

/**
 * Серверное «сейчас» для useNow. Ноль означает «страница не отдавала снапшот» —
 * useNow в этом случае берёт время клиента, как и раньше.
 */
export function usePresenceServerNow(): number {
  return useContext(PresenceContext).serverNow
}
