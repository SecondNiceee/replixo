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

import { after } from 'next/server'

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

// Realtime не стоит того, чтобы держать ответ API: в БД всё записано ещё до
// вызова хука, и клик «Принять» не должен ждать сокет-сервер.
//
// Поэтому ответ держит ровно ОДНА короткая попытка: её результат нужен в ответе
// как `notified`, иначе клиент не знает, включать ли фолбэк-emit. 700 мс — это
// с запасом на локальный HTTP-вызов, но уже не заметная пользователю пауза.
//
// Ретраи ушли в after(): они выполняются после отправки ответа, поэтому им
// можно оставить прежний щедрый таймаут. Их смысл — не `notified` (он уже
// уехал клиенту), а второй участник: клиентский фолбэк помогает только когда у
// инициатора живой websocket, то есть ровно в том сценарии, от которого мы
// уходили. Дешевле дозвониться до сервера в фоне.
const AWAITED_TIMEOUT_MS = 700
const RETRY_TIMEOUT_MS = 1500
const RETRIES = 2

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

/** Одна попытка вызова хука: `ok` — принято, `retriable` — стоит повторить. */
async function sendHook(
  url: string,
  secret: string,
  body: string,
  reason: FriendsChangeReason,
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; retriable: boolean }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) return { ok: true, retriable: false }
    console.error(`[friends] хук вернул ${res.status} (reason=${reason}, ${label})`)
    // 401/400/404 повторять бессмысленно — ответ не изменится.
    return { ok: false, retriable: isRetriable(res.status) }
  } catch (e) {
    // Таймаут или сеть — повторяем: сокет-сервер мог перезапускаться.
    console.error(`[friends] хук недоступен (${label}):`, (e as Error).message)
    return { ok: false, retriable: true }
  }
}

/**
 * Сообщить сокет-серверу, что связь между `userId` и `peerId` изменилась.
 * Сервер сам перечитает статус из БД и разошлёт `dm:friends:changed` обоим.
 *
 * Первую попытку await-им: без её результата нечего положить в `notified`.
 * Ретраи уходят в `after()` — Next держит процесс до их завершения, поэтому это
 * не «повешенный промис», который serverless может убить на полпути.
 *
 * Возвращает `true`, если сокет-сервер принял уведомление и уже разослал
 * событие обоим участникам. При `false` роут отдаёт клиенту `notified: false`,
 * и тот включает фолбэк — emit `dm:friends:changed` со своего websocket.
 */
export async function notifyFriendsChanged(
  userId: string,
  peerId: string,
  reason: FriendsChangeReason,
  notificationId?: string | null,
  originSocketId?: string | null,
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
  // notificationId — id УЖЕ сохранённой записи уведомления. Сервер по нему
  // перечитает запись из БД и запушит её получателю. Содержимое уведомления в
  // payload не передаём: сервер не должен верить тексту, пришедшему по HTTP.
  //
  // originSocketId — соединение, из которого пришло действие. Нужен, чтобы
  // сокет-сервер не отправлял эхо ровно в ту вкладку, которая уже обновила
  // списки по ответу этого запроса. Остальные соединения того же пользователя
  // (второй таб, другое устройство) событие получить ДОЛЖНЫ.
  const body = JSON.stringify({
    userId,
    peerId,
    reason,
    notificationId: notificationId ?? null,
    originSocketId: originSocketId ?? null,
  })

  const first = await sendHook(
    url,
    secret,
    body,
    reason,
    AWAITED_TIMEOUT_MS,
    'ответ ждёт',
  )
  if (first.ok || !first.retriable) return first.ok

  // Дальше — уже после отправки ответа клиенту.
  //
  // Повтор после таймаута может продублировать событие: первая попытка,
  // возможно, всё-таки дошла до сервера, просто ответ не успел вернуться. Это
  // безопасно — сервер не верит payload'у, а перечитывает статус из БД и
  // рассылает то же самое; на клиенте одинаковые события схлопываются окном
  // ревалидации.
  scheduleRetries(url, secret, body, reason)

  // Ответ уезжает с notified: false — клиент включит фолбэк-emit, не дожидаясь
  // фоновых попыток. Хуже от этого не станет: лишнее событие идемпотентно.
  return false
}

/**
 * Догнать сокет-сервер ретраями после ответа клиенту.
 *
 * Вне запроса (скрипт, тест) `after()` бросает — тогда просто дожидаемся
 * попыток здесь: держать нечего, ответа уже нет.
 */
function scheduleRetries(
  url: string,
  secret: string,
  body: string,
  reason: FriendsChangeReason,
): void {
  const run = async () => {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      const res = await sendHook(
        url,
        secret,
        body,
        reason,
        RETRY_TIMEOUT_MS,
        `фоновый повтор ${attempt}/${RETRIES}`,
      )
      if (res.ok || !res.retriable) return
    }
    console.error(
      `[friends] хук не доставлен после ${RETRIES} фоновых попыток (reason=${reason}) — ` +
        'realtime у второго участника зависит от клиентского фолбэка.',
    )
  }

  try {
    after(run)
  } catch {
    void run()
  }
}
