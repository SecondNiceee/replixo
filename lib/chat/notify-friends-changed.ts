// ---------------------------------------------------------------------------
// Уведомление сокет-сервера об изменении дружбы (сервер → сервер).
//
// Модуль только для серверного кода: читает INTERNAL_HOOK_SECRET, который не
// имеет префикса NEXT_PUBLIC_ и в браузерный бандл попасть не должен. Импортить
// его из client-компонентов нельзя.
//
// Заявки в друзья пишет Next-API в Postgres, а сокет-сервер — отдельный
// процесс: про UPDATE в таблице friendship он узнать не может. Раньше об
// изменении сообщал браузер инициатора через socket-событие, из-за чего
// realtime у второго участника работал только когда у первого был живой
// websocket (открыт чат, соединение поднялось, вкладка активна).
//
// Теперь основной путь — этот вызов из самого роута сразу после успешной
// записи. Он не зависит ни от одного клиентского соединения.
//
// Провал вызова НЕ должен ломать сам запрос: данные в БД уже изменены, а
// realtime — улучшение. Поэтому все ошибки глотаются с логом, а у клиента
// остаётся фолбэк на socket-событии.
// ---------------------------------------------------------------------------

export type FriendsChangeReason =
  | 'requested'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'removed'

/**
 * Базовый адрес сокет-сервера для запроса «сервер → сервер».
 * MEDIASOUP_URL — приватная переменная (внутри VPS это может быть
 * localhost:3001); NEXT_PUBLIC_MEDIASOUP_URL — публичный фолбэк.
 */
function serverBaseUrl(): string {
  const raw =
    process.env.MEDIASOUP_URL ??
    process.env.NEXT_PUBLIC_MEDIASOUP_URL ??
    'http://localhost:3001'
  return raw.replace(/\/+$/, '')
}

// Realtime не стоит того, чтобы держать ответ API: если сокет-сервер тормозит,
// быстрее ответить пользователю и оставить обновление на фолбэк.
const TIMEOUT_MS = 3000

/**
 * Сообщить сокет-серверу, что связь между `userId` и `peerId` изменилась.
 * Сервер сам перечитает статус из БД и разошлёт `dm:friends:changed` обоим.
 *
 * Await-ить результат не обязательно, но и «повесить» промис без await нельзя:
 * в serverless-окружении процесс может завершиться до отправки. Поэтому роуты
 * ждут — запрос локальный и укладывается в миллисекунды.
 */
export async function notifyFriendsChanged(
  userId: string,
  peerId: string,
  reason: FriendsChangeReason,
): Promise<void> {
  const secret = process.env.INTERNAL_HOOK_SECRET
  // Без секрета внутренний хук выключен на обеих сторонах: работает фолбэк на
  // socket-событии, поэтому это не ошибка и шуметь в логах не нужно.
  if (!secret) return

  try {
    const res = await fetch(`${serverBaseUrl()}/internal/friends/changed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({ userId, peerId, reason }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[friends] хук вернул ${res.status} (reason=${reason})`)
    }
  } catch (e) {
    console.error('[friends] хук недоступен:', (e as Error).message)
  }
}
