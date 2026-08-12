'use client'

import { useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { useCallStore } from '@/stores/call-store'
import { pushNotification } from '@/stores/notifications-store'
import { playCallEnded, startRingtone } from '@/lib/sounds'

// ---------------------------------------------------------------------------
// Звонки из личного чата.
//
// Хук разделён на две половины намеренно:
//   • useCallsRealtime — подписка на события, ровно ОДНА на приложение
//     (в DmNotifier). Иначе одно «нам звонят» обработалось бы несколько раз, и
//     рингтон заиграл бы в два голоса.
//   • useCallActions — действия (позвонить/принять/отклонить). Их можно
//     вызывать из любого числа компонентов: состояние живёт в сторе, а сокет
//     разделяется по refcount внутри useDmSocket.
//
// Переход в комнату делаем полной навигацией, а не router.push: комната
// поднимает собственное mediasoup-соединение и запрашивает камеру с
// микрофоном, и начинать это с чистой страницы надёжнее, чем поверх стейта
// профиля.
// ---------------------------------------------------------------------------

interface CallAck {
  ok?: boolean
  error?: string
  callId?: string
  roomId?: string
}

/** Текст для пользователя по коду ошибки сервера. */
function inviteErrorText(error: string | undefined): string {
  if (error === 'offline') return 'Пользователь не в сети'
  if (error === 'not_friends') return 'Звонить можно только друзьям'
  if (error === 'rate_limited') return 'Слишком часто — подождите немного'
  return 'Не удалось позвонить'
}

function goToRoom(roomId: string): void {
  window.location.assign(`/room/${roomId}`)
}

/**
 * Приём событий звонков и рингтон. Монтируется РОВНО ОДИН раз на приложение.
 */
export function useCallsRealtime(socket: Socket | null): void {
  const incoming = useCallStore((s) => s.incoming)

  useEffect(() => {
    if (!socket) return

    const { setIncoming, setOutgoing, clearIncoming, clearOutgoing } = useCallStore.getState()

    const onIncoming = (payload: unknown) => {
      const { callId, roomId, fromUserId, fromName } = (payload ?? {}) as Record<string, unknown>
      if (
        typeof callId !== 'string' ||
        typeof roomId !== 'string' ||
        typeof fromUserId !== 'string'
      ) {
        return
      }
      setIncoming({
        callId,
        roomId,
        fromUserId,
        fromName: typeof fromName === 'string' && fromName.trim() ? fromName : 'Пользователь',
      })
    }

    // Снапшот идущих звонков при подключении: обновили страницу, открыли
    // вторую вкладку или потеряли сеть посреди вызова — состояние догоняет нас
    // здесь, потому что `call:incoming` был разослан один раз и давно.
    const onSync = (payload: unknown) => {
      const { incoming: incomingList, outgoing: outgoingList } = (payload ?? {}) as Record<
        string,
        unknown
      >

      const first = (list: unknown): Record<string, unknown> | null =>
        Array.isArray(list) && list.length > 0 && typeof list[0] === 'object' && list[0] !== null
          ? (list[0] as Record<string, unknown>)
          : null

      // Локальное состояние приоритетнее снапшота: пока он летел, пользователь
      // мог успеть отклонить вызов, и возвращать его на экран нельзя.
      const { incoming: currentIn, outgoing: currentOut } = useCallStore.getState()

      const call = first(incomingList)
      if (call && !currentIn) {
        const { callId, roomId, fromUserId, fromName } = call
        if (
          typeof callId === 'string' &&
          typeof roomId === 'string' &&
          typeof fromUserId === 'string'
        ) {
          setIncoming({
            callId,
            roomId,
            fromUserId,
            fromName: typeof fromName === 'string' && fromName.trim() ? fromName : 'Пользователь',
          })
        }
      }

      const mine = first(outgoingList)
      if (mine && !currentOut) {
        const { callId, roomId, toUserId, toName } = mine
        if (
          typeof callId === 'string' &&
          typeof roomId === 'string' &&
          typeof toUserId === 'string'
        ) {
          setOutgoing({
            callId,
            roomId,
            toUserId,
            toName: typeof toName === 'string' && toName.trim() ? toName : 'Пользователь',
          })
        }
      }
    }

    const onAccepted = (payload: unknown) => {
      const { callId, roomId } = (payload ?? {}) as Record<string, unknown>
      if (typeof callId !== 'string' || typeof roomId !== 'string') return

      const { outgoing, incoming: current } = useCallStore.getState()

      // Экран с входящим вызовом гасим на всех устройствах: ответили на одном
      // из них, остальным звенеть уже незачем.
      if (current?.callId === callId) clearIncoming(callId)

      // Звонивший уходит в комнату сам: подтверждение пришло именно ему.
      if (outgoing?.callId === callId) {
        clearOutgoing(callId)
        goToRoom(roomId)
      }
    }

    const onEnded = (payload: unknown) => {
      const { callId, reason } = (payload ?? {}) as Record<string, unknown>
      if (typeof callId !== 'string') return

      const { outgoing, incoming: current } = useCallStore.getState()
      const wasCalling = outgoing?.callId === callId

      if (current?.callId === callId) clearIncoming(callId)
      if (wasCalling) clearOutgoing(callId)

      // Сообщаем только звонившему: он ждал ответа и должен понять, почему
      // ничего не произошло. Тому, кто сам отклонил вызов, объяснять нечего.
      if (!wasCalling) return

      playCallEnded()
      const who = outgoing?.toName?.trim() || 'Пользователь'
      pushNotification({
        kind: 'error',
        title: who,
        body:
          reason === 'declined'
            ? 'отклонил звонок'
            : reason === 'timeout'
              ? 'не ответил на звонок'
              : reason === 'gone'
                ? 'вышел из сети'
                : 'звонок завершён',
        duration: 5000,
        dedupeKey: `call:${callId}`,
      })
    }

    socket.on('call:incoming', onIncoming)
    socket.on('call:sync', onSync)
    socket.on('call:accepted', onAccepted)
    socket.on('call:ended', onEnded)

    return () => {
      socket.off('call:incoming', onIncoming)
      socket.off('call:sync', onSync)
      socket.off('call:accepted', onAccepted)
      socket.off('call:ended', onEnded)
    }
  }, [socket])

  // Соединение порвалось — принять или отменить звонок нам сейчас нечем, а
  // экраны остались бы висеть. Чистим; если звонок ещё жив, при переподключении
  // его вернёт `call:sync`.
  useEffect(() => {
    if (!socket) return
    const onDisconnect = () => useCallStore.getState().reset()
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('disconnect', onDisconnect)
    }
  }, [socket])

  // Рингтон живёт ровно столько, сколько на экране входящий вызов.
  useEffect(() => {
    if (!incoming) return
    return startRingtone()
  }, [incoming])
}

export interface CallActions {
  invite: (peerId: string, peerName: string) => void
  accept: () => void
  decline: () => void
  cancel: () => void
}

/** Действия со звонками. Можно вызывать из любого компонента. */
export function useCallActions(socket: Socket | null): CallActions {
  const invite = useCallback(
    (peerId: string, peerName: string) => {
      if (!socket) {
        pushNotification({ kind: 'error', title: 'Нет связи', body: 'Соединение с сервером не установлено' })
        return
      }
      // Второй звонок поверх первого не начинаем: сервер всё равно вернёт
      // существующий, а на экране был бы мигающий «звоним…».
      if (useCallStore.getState().outgoing) return

      socket.emit('call:invite', { peerId }, (res: CallAck) => {
        if (!res?.ok || !res.callId || !res.roomId) {
          pushNotification({
            kind: 'error',
            title: 'Звонок не начат',
            body: inviteErrorText(res?.error),
            duration: 5000,
          })
          return
        }
        useCallStore.getState().setOutgoing({
          callId: res.callId,
          roomId: res.roomId,
          toUserId: peerId,
          toName: peerName,
        })
      })
    },
    [socket],
  )

  const accept = useCallback(() => {
    const call = useCallStore.getState().incoming
    if (!socket || !call) return

    socket.emit('call:accept', { callId: call.callId }, (res: CallAck) => {
      useCallStore.getState().clearIncoming(call.callId)
      if (!res?.ok || !res.roomId) {
        // Звонок уже не существует: отменили или истёк, пока мы тянулись к
        // кнопке. Комнаты нет — идти некуда.
        pushNotification({
          kind: 'error',
          title: 'Звонок недоступен',
          body: 'Вызов уже завершён',
          duration: 4000,
        })
        return
      }
      goToRoom(res.roomId)
    })
  }, [socket])

  const decline = useCallback(() => {
    const call = useCallStore.getState().incoming
    if (!call) return
    // Гасим экран сразу, не дожидаясь ответа сервера: нажатие «отклонить»
    // должно срабатывать мгновенно, а рассылка — уже его дело.
    useCallStore.getState().clearIncoming(call.callId)
    socket?.emit('call:hangup', { callId: call.callId })
  }, [socket])

  const cancel = useCallback(() => {
    const call = useCallStore.getState().outgoing
    if (!call) return
    useCallStore.getState().clearOutgoing(call.callId)
    socket?.emit('call:hangup', { callId: call.callId })
  }, [socket])

  return { invite, accept, decline, cancel }
}
