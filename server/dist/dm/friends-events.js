"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastFriendsChanged = broadcastFriendsChanged;
const db_1 = require("./db");
const presence_1 = require("./presence");
const namespace_types_1 = require("./namespace-types");
/**
 * Принять `originSocketId` только если это соединение действительно принадлежит
 * инициатору действия.
 *
 * Значение приходит из браузера (заголовок `x-origin-socket-id`), а `.except()`
 * действует в комнатах ОБОИХ участников. Без этой проверки участник связи мог
 * подставить socket.id жертвы и погасить у неё обновление списков: формат id мы
 * валидируем, но формат ничего не говорит о владельце. Личность соединения
 * известна серверу из рукопожатия (`socket.data.userId`), ей и сверяем.
 *
 * Неизвестный сокет тоже отбрасываем: сегодня узел один, значит «нет в
 * nsp.sockets» = подделка или id уже отключённого соединения. Цена ошибки —
 * инициирующая вкладка получит эхо и перечитает списки второй раз, то есть
 * лишний запрос вместо потерянного обновления. Если появится
 * `@socket.io/redis-adapter`, сокет может жить на другом узле — тогда проверку
 * нужно делать через `nsp.fetchSockets()`, иначе дедупликация перестанет
 * срабатывать в кластере.
 */
function verifiedOriginSocketId(nsp, originSocketId, userId) {
    if (!originSocketId)
        return null;
    const socket = nsp.sockets.get(originSocketId);
    if (!socket)
        return null;
    return socket.data.userId === userId ? originSocketId : null;
}
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
async function broadcastFriendsChanged(nsp, userId, peerId, reason, notificationId, originSocketId) {
    // Имя инициатора нужно принимающей стороне для текста уведомления. Запрос
    // независим от статуса связи, поэтому идёт параллельно и не добавляет задержки.
    const [link, actorName] = await Promise.all([
        (0, db_1.friendLinkState)(userId, peerId),
        (0, db_1.userDisplayName)(userId),
    ]);
    // Дальше работаем только с подтверждённым id: и в `except()`, и в payload.
    // Разводить их нельзя — клиентская проверка по `originSocketId` подавляет
    // обработку так же, как `except` подавляет доставку, поэтому непроверенный id
    // в payload давал бы ту же самую атаку в обход `except`.
    const originId = verifiedOriginSocketId(nsp, originSocketId, userId);
    // Кэш друзей presence живёт 30 с. Без сброса новый друг всё это время не
    // получал бы online/offline, а удалённый продолжал бы получать.
    (0, presence_1.invalidateFriendsCache)(userId);
    (0, presence_1.invalidateFriendsCache)(peerId);
    const payload = {
        userId,
        peerId,
        reason,
        status: link.status,
        requesterId: link.requesterId,
        actorName,
        // Клиент сравнит с собственным socket.id. Именно socket, а не пользователь:
        // вторая вкладка инициатора — другой сокет, и ей событие нужно.
        originSocketId: originId,
    };
    for (const memberId of [userId, peerId]) {
        const target = nsp.to((0, namespace_types_1.userRoom)(memberId));
        // Исключаем только инициирующее соединение — остальные сокеты того же
        // пользователя (второй таб, телефон) событие получают и перечитывают списки.
        // socket.id сам по себе является комнатой, поэтому except им и оперирует.
        const scoped = originId ? target.except(originId) : target;
        scoped.emit('dm:friends:changed', payload);
    }
    // Снапшот presence оба получили ещё когда друзьями не были, поэтому точку
    // «в сети» после принятия заявки нужно объявить отдельно.
    if (link.status === 'accepted')
        (0, presence_1.announceMutualPresence)(nsp, userId, peerId);
    // Пуш сохранённого уведомления получателю. Именно ПОЛУЧАТЕЛЮ, а не обоим:
    // уведомление адресное, а инициатор и так видел результат своего действия.
    //
    // Запись уже лежит в БД (её создал Next-роут), поэтому этот emit — только
    // ускорение: без него получатель увидит то же самое при следующей загрузке
    // страницы, а не потеряет событие, как было до появления таблицы.
    if (notificationId) {
        const stored = await (0, db_1.notificationForPush)(notificationId, peerId);
        if (stored) {
            nsp.to((0, namespace_types_1.userRoom)(peerId)).emit('dm:notification', {
                notification: {
                    id: stored.id,
                    kind: stored.kind,
                    actorId: stored.actorId,
                    actorName: stored.actorName,
                    createdAt: stored.createdAt,
                    read: false,
                },
                unread: stored.unread,
            });
        }
    }
    return link;
}
