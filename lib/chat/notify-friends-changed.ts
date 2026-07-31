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
//
// Общий бюджет прежний (3 с), но делим его на две попытки по 1.5 с. Смысл в
// том, что клиентский фолбэк помогает только когда у инициатора есть живой
// websocket — то есть ровно в том сценарии, от которого мы и уходили. Дешевле
// один раз перезапросить сервер, чем надеяться на сокет инициатора.
const ATTEMPT_TIMEOUT_MS = 1500
const ATTEMPTS = 2

/** Повторяем только сетевые сбои и 5xx: 4xx воспроизведётся один в один. */
function isRetriable(status: number | null): boolean {
  return status === null || status >= 500
}

let missingSecretWarned = false

function warnMissingSecretOnce(): void {
  if (missingSecretWarned) return
  missingSecretWarned = true
  console.warn(
    '[friends] INTERNAL_HOOK_SECRET не задан — серверный хук отключён. ' +
      'Realtime дружбы работает только через клиентский фолбэк: собеседник ' +
      'увидит изменение лишь при живом websocket у инициатора.',
  )
}

/**
 * Сообщить сокет-серверу, что связь между `userId` и `peerId` изменилась.
 * Сервер сам перечитает статус из БД и разошлёт `dm:friends:changed` обоим.
 *
 * Await-ить результат обязательно: «повесить» промис без await нельзя — в
 * serverless-окружении процесс может завершиться до отправки. Запрос локальный
 * и укладывается в миллисекунды.
 *
 * Возвращает `true`, если сокет-сервер принял уведомление и уже разослал
 * событие обоим участникам. При `false` роут отдаёт клиенту `notified: false`,
 * и тот включает фолбэк — emit `dm:friends:changed` со своего websocket.
 */
export async function notifyFriendsChanged(
  userId: string,
  peerId: string,
  reason: FriendsChangeReason,
): Promise<boolean> {
  const secret = process.env.INTERNAL_HOOK_SECRET
  // Без секрета внутренний хук выключен на обеих сторонах и всё держится на
  // клиентском фолбэке — то есть realtime работает через раз. Это не ошибка
  // запроса, но молчать нельзя: иначе деградацию легко не заметить. Логируем
  // один раз за жизнь процесса, чтобы не засорять логи на каждом действии.
  if (!secret) {
    warnMissingSecretOnce()
    return false
  }

  const url = `${serverBaseUrl()}/internal/friends/changed`
  const body = JSON.stringify({ userId, peerId, reason })

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let status: number | null = null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': secret,
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      if (res.ok) return true
      status = res.status
      console.error(
        `[friends] хук вернул ${status} (reason=${reason}, попытка ${attempt}/${ATTEMPTS})`,
      )
    } catch (e) {
      // Таймаут или сеть — повторяем: сокет-сервер мог перезапускаться.
      console.error(
        `[friends] хук недоступен (попытка ${attempt}/${ATTEMPTS}):`,
        (e as Error).message,
      )
    }

    // 401/400/404 повторять бессмысленно — ответ не изменится.
    if (!isRetriable(status)) return false
  }

  return false
}
