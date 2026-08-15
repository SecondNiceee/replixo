import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Эфемерное состояние личного чата: кто онлайн, кто печатает, до какого
// момента собеседник прочитал диалог.
//
// Почему стор, а не useState в компоненте: эти данные приходят одним потоком
// событий сокета, но нужны сразу в нескольких несвязанных местах (список
// диалогов, шапка диалога, лента сообщений). Постоянные данные (сами
// сообщения, список диалогов) здесь НЕ хранятся — они живут в SWR.
// ---------------------------------------------------------------------------

/**
 * Что видно про человека. Ровно два состояния:
 *   • online  — вкладка Riplexo открыта на экране либо идёт звонок;
 *   • offline — смотреть на Riplexo некому, показываем «был(а) N минут назад».
 *
 * Промежуточного «отошёл» нет намеренно: открытая на экране вкладка — это
 * присутствие, и молчание в ней ничего не доказывает (читают длинное сообщение,
 * смотрят видео, думают над ответом). Подробно — в шапке
 * server/src/dm/presence.ts.
 */
export type PresenceStatus = 'online' | 'offline'

/** Статусы в сторе без 'offline': отсутствие ключа и есть оффлайн. */
export type LivePresenceStatus = Exclude<PresenceStatus, 'offline'>

interface DmStore {
  /** userId → статус. Оффлайн-друзей здесь нет: пустой ключ дешевле явного. */
  statuses: Record<string, LivePresenceStatus>
  /** userId → когда его видели последний раз (мс). */
  lastSeenAt: Record<string, number>
  /**
   * Пришёл ли снапшот от сокета. Нужен, чтобы данные из HTTP-ответа не
   * «оживляли» человека, о котором сокет уже сказал, что он оффлайн: сокет
   * авторитетнее, а HTTP-ответ мог быть собран на полсекунды раньше.
   */
  snapshotApplied: boolean
  /** conversationId → userId → печатает ли. */
  typing: Record<string, Record<string, boolean>>
  /** conversationId → lastReadAt собеседника (мс), по нему рисуются галочки. */
  peerReadAt: Record<string, number>
  /**
   * Открытый сейчас диалог, либо null. Нужен глобальному уведомителю: звук
   * не должен играть по сообщению из диалога, который пользователь и так
   * видит на экране. Живёт в сторе, потому что уведомитель монтируется вне
   * страницы чата и о её локальном состоянии ничего не знает.
   */
  activeConversationId: string | null

  setActiveConversationId: (conversationId: string | null) => void
  applyPresenceSnapshot: (
    statuses: Record<string, LivePresenceStatus>,
    lastSeenAt: Record<string, number>,
  ) => void
  mergePresence: (
    statuses: Record<string, LivePresenceStatus>,
    lastSeenAt: Record<string, number>,
  ) => void
  setPresence: (userId: string, status: PresenceStatus, lastSeenAt?: number) => void
  setTyping: (conversationId: string, userId: string, typing: boolean) => void
  setPeerReadAt: (conversationId: string, ts: number) => void
  reset: () => void
}

/** Слить времена, оставив более свежее: события могут прийти не по порядку. */
function mergeLastSeen(
  current: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  const result = { ...current }
  for (const [id, ts] of Object.entries(incoming)) {
    if (!(id in result) || ts > result[id]) result[id] = ts
  }
  return result
}

export const useDmStore = create<DmStore>((set) => ({
  statuses: {},
  lastSeenAt: {},
  snapshotApplied: false,
  typing: {},
  peerReadAt: {},
  activeConversationId: null,

  setActiveConversationId: (conversationId) => set({ activeConversationId: conversationId }),

  // Снапшот от сокета — истина в последней инстанции: он перечисляет ВСЕХ, кто
  // сейчас в сети, поэтому статусы заменяем целиком. Времена сливаем: снапшот
  // мог не включать человека, о котором мы уже что-то знаем.
  applyPresenceSnapshot: (statuses, lastSeenAt) =>
    set((state) => ({
      statuses,
      lastSeenAt: mergeLastSeen(state.lastSeenAt, lastSeenAt),
      snapshotApplied: true,
    })),

  // Данные из HTTP-ответа (/api/friends) — только чтобы точки были на первом
  // кадре, до подключения сокета. Как только снапшот пришёл, статусы оттуда
  // игнорируем: HTTP-ответ мог быть собран раньше и «оживил» бы ушедшего.
  // Времена берём всегда — они из Postgres и от сокета не зависят.
  mergePresence: (statuses, lastSeenAt) =>
    set((state) => ({
      statuses: state.snapshotApplied ? state.statuses : { ...statuses, ...state.statuses },
      lastSeenAt: mergeLastSeen(state.lastSeenAt, lastSeenAt),
    })),

  setPresence: (userId, status, lastSeenAt) =>
    set((state) => {
      const statuses = { ...state.statuses }
      if (status === 'offline') delete statuses[userId]
      else statuses[userId] = status
      return {
        statuses,
        lastSeenAt:
          lastSeenAt !== undefined
            ? mergeLastSeen(state.lastSeenAt, { [userId]: lastSeenAt })
            : state.lastSeenAt,
      }
    }),

  setTyping: (conversationId, userId, typing) =>
    set((state) => {
      const forConversation = { ...(state.typing[conversationId] ?? {}) }
      if (typing) forConversation[userId] = true
      else delete forConversation[userId]
      return { typing: { ...state.typing, [conversationId]: forConversation } }
    }),

  setPeerReadAt: (conversationId, ts) =>
    set((state) => {
      // Маркер только растёт: события от разных устройств могут прийти
      // не по порядку, и откат назад снял бы уже показанные галочки.
      if ((state.peerReadAt[conversationId] ?? 0) >= ts) return state
      return { peerReadAt: { ...state.peerReadAt, [conversationId]: ts } }
    }),

  // Статусы достоверны только при живом соединении, поэтому после разрыва их
  // сбрасываем. lastSeenAt, наоборот, оставляем: это история из Postgres, она
  // не портится от того, что websocket отвалился, и «был(а) 5 минут назад»
  // лучше пустого «не в сети».
  reset: () =>
    set((state) => ({
      statuses: {},
      snapshotApplied: false,
      typing: {},
      peerReadAt: {},
      lastSeenAt: state.lastSeenAt,
    })),
}))

/**
 * Статус одного человека одним значением. Отдельный хук, потому что подписка на
 * весь объект statuses перерисовывала бы компонент на любое чужое изменение.
 */
export function usePresenceStatus(userId: string | null | undefined): PresenceStatus {
  return useDmStore((s) => (userId ? (s.statuses[userId] ?? 'offline') : 'offline'))
}

/** Когда человека видели последний раз (мс), либо undefined. */
export function usePresenceLastSeen(userId: string | null | undefined): number | undefined {
  return useDmStore((s) => (userId ? s.lastSeenAt[userId] : undefined))
}
