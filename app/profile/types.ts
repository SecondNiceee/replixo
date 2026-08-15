export interface User {
  id: string
  name: string
  email: string
}

export interface Friend {
  id: string
  friendId: string
  friendName: string
  friendUsername: string | null
}

/**
 * Ответ GET /api/friends. Кроме самого списка роут отдаёт снапшот presence:
 * статусы нужны уже на первом кадре, а по websocket они приходят только после
 * подключения сокета.
 *
 * Форма описана здесь, а не взята из lib/chat/presence: тот модуль серверный
 * (читает INTERNAL_HOOK_SECRET), и импорт из client-компонента затянул бы его
 * в браузерный бандл. Поля опциональны — сокет-сервер мог быть недоступен, тогда
 * presence приезжает пустым.
 */
export interface FriendsResponse {
  friends: Friend[]
  presence?: {
    /**
     * Ответил ли сокет-сервер. Пустые статусы без этого флага не отличить от
     * «никого нет в сети», а разница принципиальна: во втором случае про людей
     * не известно ничего, и рисовать оффлайн нельзя.
     */
    ok?: boolean
    /**
     * Только 'online': оффлайн передаётся отсутствием ключа, а промежуточных
     * статусов у presence больше нет (см. stores/dm-store). Нормализацию делает
     * lib/chat/presence, поэтому старое 'idle' сюда уже не доезжает.
     */
    statuses?: Record<string, 'online'>
    lastSeenAt?: Record<string, number>
  }
}

export interface PendingRequest {
  id: string
  requesterId: string
  requesterName: string
  requesterUsername: string | null
}

export interface SentRequest {
  id: string
  addresseeId: string
  addresseeName: string
  addresseeUsername: string | null
  createdAt: string
}

export const fetcher = (url: string) => fetch(url).then((r) => r.json())
