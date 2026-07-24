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

interface DmStore {
  /** Друзья, у которых сейчас есть хотя бы одно живое соединение. */
  onlineIds: Set<string>
  /** userId → когда его видели последний раз (мс). Только для оффлайн-друзей. */
  lastSeenAt: Record<string, number>
  /** conversationId → userId → печатает ли. */
  typing: Record<string, Record<string, boolean>>
  /** conversationId → lastReadAt собеседника (мс), по нему рисуются галочки. */
  peerReadAt: Record<string, number>

  applyPresenceSnapshot: (onlineUserIds: string[], lastSeenAt: Record<string, number>) => void
  setPresence: (userId: string, online: boolean, lastSeenAt?: number) => void
  setTyping: (conversationId: string, userId: string, typing: boolean) => void
  setPeerReadAt: (conversationId: string, ts: number) => void
  reset: () => void
}

export const useDmStore = create<DmStore>((set) => ({
  onlineIds: new Set<string>(),
  lastSeenAt: {},
  typing: {},
  peerReadAt: {},

  applyPresenceSnapshot: (onlineUserIds, lastSeenAt) =>
    set({ onlineIds: new Set(onlineUserIds), lastSeenAt }),

  setPresence: (userId, online, lastSeenAt) =>
    set((state) => {
      // Set пересоздаём: zustand сравнивает по ссылке, мутация не вызвала бы
      // перерисовку подписчиков.
      const onlineIds = new Set(state.onlineIds)
      if (online) onlineIds.add(userId)
      else onlineIds.delete(userId)
      return {
        onlineIds,
        lastSeenAt:
          !online && lastSeenAt !== undefined
            ? { ...state.lastSeenAt, [userId]: lastSeenAt }
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

  reset: () =>
    set({ onlineIds: new Set<string>(), lastSeenAt: {}, typing: {}, peerReadAt: {} }),
}))
