import type { Namespace } from 'socket.io'
import { friendLinkState, notificationForPush, userDisplayName } from './db'
import { announceMutualPresence, invalidateFriendsCache } from './presence'
import { userRoom } from './namespace-types'

// ---------------------------------------------------------------------------
// Рассылка «связь двух пользователей изменилась».
//
// Заявки в друзья живут в Next-API (Postgres), а сокет-сервер — отдельный
// процесс: он не видит UPDATE в таблице friendship. Единственная функция
// рассылки вынесена сюда, потому что вызывают её из двух мест:
//
//   1) /internal/friends/changed — основной путь. Next-роут дёргает его
//      сервер-к-серверу сразу после успешной записи в БД, поэтому realtime не
//      зависит от того, есть ли у инициатора живой websocket;
//   2) socket-событие `dm:friends:changed` — фолбэк для случая, когда
//      внутренний хук не настроен (нет INTERNAL_HOOK_SECRET) или недоступен.
//
// Статус связи ВСЕГДА перечитывается из БД: ни клиент, ни вызывающий роут не
// могут навязать серверу состояние дружбы.
// ---------------------------------------------------------------------------

export type FriendsChangeReason =
  | 'requested'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'removed'

/**
 * Разослать `dm:friends:changed` обоим участникам и синхронизировать presence.
 *
 * `originSocketId` — id ИМЕННО ТОГО соединения, из которого пришло действие
 * (браузер передаёт его в заголовке при вызове Next-роута, а на фолбэк-пути это
 * socket.id самого сокета). Комната адресуется по пользователю, а не по сокету,
 * поэтому у инициатора событие получают ВСЕ его вкладки и устройства. Гасить
 * эхо по userId нельзя: списки перечитала только та вкладка, где кликнули, а
 * остальные так и оставались бы со старыми данными. Поэтому:
 *
 *   • инициирующее соединение исключаем из рассылки через `.except()` —
 *     оно уже обновилось по ответу API;
 *   • тот же id уезжает в payload, чтобы клиент мог продублировать проверку
 *     (например, когда рассылку сделал другой узел и `except` не сработал).
 *
 * Возвращает фактический статус связи, прочитанный из БД, — вызывающая сторона
 * может его залогировать, но полагаться на него для доступа не должна.
 */
export async function broadcastFriendsChanged(
  nsp: Namespace,
  userId: string,
  peerId: string,
  reason: FriendsChangeReason,
  notificationId?: string | null,
  originSocketId?: string | null,
): Promise<{ status: string; requesterId: string | null }> {
  // Имя инициатора нужно принимающей стороне для текста уведомления. Запрос
  // независим от статуса связи, поэтому идёт параллельно и не добавляет задержки.
  const [link, actorName] = await Promise.all([
    friendLinkState(userId, peerId),
    userDisplayName(userId),
  ])

  // Кэш друзей presence живёт 30 с. Без сброса новый друг всё это время не
  // получал бы online/offline, а удалённый продолжал бы получать.
  invalidateFriendsCache(userId)
  invalidateFriendsCache(peerId)

  const payload = {
    userId,
    peerId,
    reason,
    status: link.status,
    requesterId: link.requesterId,
    actorName,
    // Клиент сравнит с собственным socket.id. Именно socket, а не пользователь:
    // вторая вкладка инициатора — другой сокет, и ей событие нужно.
    originSocketId: originSocketId ?? null,
  }

  for (const memberId of [userId, peerId]) {
    const target = nsp.to(userRoom(memberId))
    // Исключаем только инициирующее соединение — остальные сокеты того же
    // пользователя (второй таб, телефон) событие получают и перечитывают списки.
    // socket.id сам по себе является комнатой, поэтому except им и оперирует.
    const scoped = originSocketId ? target.except(originSocketId) : target
    scoped.emit('dm:friends:changed', payload)
  }

  // Снапшот presence оба получили ещё когда друзьями не были, поэтому точку
  // «в сети» после принятия заявки нужно объявить отдельно.
  if (link.status === 'accepted') announceMutualPresence(nsp, userId, peerId)

  // Пуш сохранённого уведомления получателю. Именно ПОЛУЧАТЕЛЮ, а не обоим:
  // уведомление адресное, а инициатор и так видел результат своего действия.
  //
  // Запись уже лежит в БД (её создал Next-роут), поэтому этот emit — только
  // ускорение: без него получатель увидит то же самое при следующей загрузке
  // страницы, а не потеряет событие, как было до появления таблицы.
  if (notificationId) {
    const stored = await notificationForPush(notificationId, peerId)
    if (stored) {
      nsp.to(userRoom(peerId)).emit('dm:notification', {
        notification: {
          id: stored.id,
          kind: stored.kind,
          actorId: stored.actorId,
          actorName: stored.actorName,
          createdAt: stored.createdAt,
          read: false,
        },
        unread: stored.unread,
      })
    }
  }

  return link
}
