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
 * Что видно про человека:
 *   • online  — вкладка Riplexo открыта на экране либо идёт звонок;
 *   • offline — смотреть на Riplexo некому, показываем «был(а) N минут назад»;
 *   • unknown — мы пока не знаем: ни снапшот сокета, ни HTTP-ответ ещё не
 *     доехали (или сокет-сервер молчит).
 *
 * Промежуточного «отошёл» нет намеренно: открытая на экране вкладка — это
 * присутствие, и молчание в ней ничего не доказывает (читают длинное сообщение,
 * смотрят видео, думают над ответом). Подробно — в шапке
 * server/src/dm/presence.ts.
 *
 * 'unknown' — про НАШЕ незнание, а не про человека. Без него любое «ещё не
 * знаю» выглядело как честный оффлайн, и на первом кадре /profile у всех
 * мигало «не в сети».
 */
export type PresenceStatus = 'online' | 'offline' | 'unknown'

/**
 * Статусы в сторе: только 'online'. Оффлайн — отсутствие ключа, а 'unknown'
 * сюда попасть не может: незнание описывается флагом presenceLoaded, а не
 * записью про конкретного человека.
 */
export type LivePresenceStatus = 'online'

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
  /**
   * Известно ли про presence хоть что-нибудь. Отличается от snapshotApplied:
   * тот про «сокет сказал своё слово», а этот — про любой достоверный источник,
   * включая HTTP-ответ. Пока флаг снят, отсутствие человека в statuses читается
   * как «не знаем» (подпись «Подключение…»), а не как оффлайн.
   */
  presenceLoaded: boolean
  /**
   * Приходили ли достоверные статусы хоть раз за жизнь страницы. В отличие от
   * presenceLoaded этот флаг НЕ сбрасывается при разрыве соединения, и нужен он
   * ровно для одного: чтобы серверный снапшот, снятый при рендере страницы,
   * перестал считаться знанием, как только его сменили живые данные. Иначе после
   * обрыва websocket подписи откатывались бы к статусам часовой давности и
   * уверенно показывали «в сети» человека, который давно ушёл.
   */
  presenceEverLoaded: boolean
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
  /**
   * @param ok Ответил ли сокет-сервер. При false статусы игнорируются как
   *   источник знания: пустой снапшот из-за недоступного сервера не должен
   *   означать «все оффлайн» (см. PresenceSnapshot.ok в lib/chat/presence).
   */
  mergePresence: (
    statuses: Record<string, LivePresenceStatus>,
    lastSeenAt: Record<string, number>,
    ok: boolean,
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
  presenceLoaded: false,
  presenceEverLoaded: false,
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
      presenceLoaded: true,
      presenceEverLoaded: true,
    })),

  // Данные из HTTP-ответа (/api/friends) — только чтобы точки были на первом
  // кадре, до подключения сокета. Как только снапшот пришёл, статусы оттуда
  // игнорируем: HTTP-ответ мог быть собран раньше и «оживил» бы ушедшего.
  // Времена берём всегда — они из Postgres и от сокета не зависят.
  mergePresence: (statuses, lastSeenAt, ok) =>
    set((state) => ({
      statuses: state.snapshotApplied ? state.statuses : { ...statuses, ...state.statuses },
      lastSeenAt: mergeLastSeen(state.lastSeenAt, lastSeenAt),
      // Флаг поднимаем только по достоверному ответу: иначе пустой presence от
      // упавшего сокет-сервера означал бы «все оффлайн».
      presenceLoaded: state.presenceLoaded || ok,
      presenceEverLoaded: state.presenceEverLoaded || ok,
    })),

  setPresence: (userId, status, lastSeenAt) =>
    set((state) => {
      const statuses = { ...state.statuses }
      // Пишем тол��ко 'online': и оффлайн, и (теоретический) 'unknown' в сторе
      // выражаются отсутствием ключа.
      if (status === 'online') statuses[userId] = status
      else delete statuses[userId]
      return {
        statuses,
        // Адресное событие — тоже доказательство связи с сокет-сервером.
        presenceLoaded: true,
        presenceEverLoaded: true,
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
  //
  // presenceLoaded тоже снимаем: без соединения мы про статусы не знаем ничего,
  // и «Подключение…» здесь честнее, чем утверждение об оффлайне.
  //
  // presenceEverLoaded, наоборот, не трогаем намеренно: он запрещает откатиться
  // к серверному снапшоту страницы после обрыва — тот снят при загрузке и к
  // этому моменту устарел ровно на всё время, что страница открыта.
  reset: () =>
    set((state) => ({
      statuses: {},
      snapshotApplied: false,
      presenceLoaded: false,
      typing: {},
      peerReadAt: {},
      lastSeenAt: state.lastSeenAt,
    })),
}))

// Хуки чтения статуса (usePresenceStatus / usePresenceLastSeen) живут в
// components/chat/presence-provider: кроме стора им нужен серверный снапшот,
// приходящий контекстом, — иначе первый кадр не знал бы статусов вовсе.
