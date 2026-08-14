'use client'

import { useCallback, useEffect } from 'react'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useUnreadTotal } from '@/hooks/dm/use-unread-total'
import { useFriendsRealtime } from '@/hooks/dm/use-friends-realtime'
import { usePresenceHeartbeat } from '@/hooks/dm/use-presence-heartbeat'
import {
  useNotificationsRealtime,
  type StoredNotification,
} from '@/hooks/dm/use-notifications'
import { useDmStore } from '@/stores/dm-store'
import { playFriendEvent, playIncomingMessage } from '@/lib/sounds'
import { pushNotification } from '@/stores/notifications-store'
import { useCallsRealtime } from '@/hooks/dm/use-calls'
import { AppToasts } from '@/components/app-toasts'
import { CallOverlays } from '@/components/call-overlays'

// ---------------------------------------------------------------------------
// Глобальный уведомитель о личных сообщениях: звук и счётчик в заголовке
// вкладки. Монтируется РОВНО ОДИН раз на приложение (в корневом layout, и
// только для авторизованного пользователя), поэтому работает на любой
// странице — на лендинге, в профиле, внутри звонка.
//
// Почему отдельный компонент, а не часть страницы чата: находясь в комнате или
// в профиле, пользователь тоже должен узнать о новом сообщении. Раньше эта
// логика жила в ChatClient и оживала только на /chat — то есть ровно там, где
// уведомления и не нужны.
//
// Сокет здесь не свой: useDmSocket разделяет одно соединение между всеми
// подписчиками по refcount, так что второго websocket не появляется, а
// dm:message не обрабатывается дважды.
// ---------------------------------------------------------------------------

/** Тост по сохранённому уведомлению. Текст один и тот же и здесь, и в панели. */
function toastFor(n: StoredNotification): void {
  const who = n.actorName.trim() || 'Пользователь'

  if (n.kind === 'friend-request') {
    pushNotification({
      kind: 'friend-request',
      title: who,
      body: 'хочет добавить вас в друзья',
      href: '/profile',
      actionLabel: 'Открыть заявки',
      // Заявка требует действия — держим на экране дольше остальных.
      duration: 9000,
      dedupeKey: `friend:${n.actorId}`,
    })
    playFriendEvent()
    return
  }

  if (n.kind === 'friend-accepted') {
    pushNotification({
      kind: 'friend-accepted',
      title: who,
      body: 'принял вашу заявку в друзья',
      // Сразу даём написать: диалог создастся по ?u=<id>, если его ещё нет.
      href: `/profile?u=${encodeURIComponent(n.actorId)}`,
      actionLabel: 'Написать',
      dedupeKey: `friend:${n.actorId}`,
    })
    playFriendEvent()
    return
  }

  // Отказ: сообщить нужно, привлекать внимание звуком — нет.
  pushNotification({
    kind: 'friend-declined',
    title: who,
    body: 'отклонил вашу заявку в друзья',
    duration: 5000,
    dedupeKey: `friend:${n.actorId}`,
  })
}

export function DmNotifier({ selfId }: { selfId: string }) {
  const { socket } = useDmSocket()
  const totalUnread = useUnreadTotal()

  // Наша половина presence: heartbeat, «отошёл» по скрытой вкладке и
  // бездействию, уход по закрытию вкладки. Живёт здесь по той же причине, что и
  // остальные подписки: соединение одно на вкладку, и второй экземпляр слал бы
  // те же события дважды. Заодно статус поддерживается на любой странице —
  // человек в звонке или на лендинге тоже «в сети».
  usePresenceHeartbeat(socket)

  // Тост теперь производная от СОХРАНЁННОГО уведомления, а не от события
  // дружбы: раз запись уже в БД, тост можно спокойно потерять — центр
  // уведомлений её сохранит. useCallback нужен, чтобы подписка на сокет не
  // пересоздавалась на каждый ререндер.
  const onIncoming = useCallback((n: StoredNotification) => toastFor(n), [])

  useNotificationsRealtime(socket, onIncoming)

  // Заявки в друзья и их принятие должны быть видны без перезагрузки страницы.
  // Подписка живёт здесь, а не в профиле: ключи SWR глобальные, поэтому списки
  // обновятся на любой открытой странице, включая профиль.
  // Эхо собственного действия гасится по СОЕДИНЕНИЮ, а не по пользователю:
  // иначе вторая вкладка и телефон того же пользователя выбрасывали бы событие,
  // ничего не перечитав. Поэтому id пользователя хуку не нужен.
  useFriendsRealtime(socket)

  // Звонки: подписка живёт здесь по той же причине, что и остальные — вызов
  // должен дойти до пользователя на любой странице, а обработчик события
  // «нам звонят» обязан быть единственным, иначе рингтон заиграет в два голоса.
  useCallsRealtime(socket)

  // Звук нового сообщения.
  useEffect(() => {
    if (!socket) return

    const onMessage = (payload: unknown) => {
      const { conversationId, message } = (payload ?? {}) as {
        conversationId?: string
        message?: {
          senderId?: string
          senderName?: string
          text?: string
          attachment?: { name?: string } | null
        }
      }
      // Своё же сообщение (эхо с другого устройства) не озвучиваем.
      if (!message?.senderId || message.senderId === selfId) return

      // Активный диалог читаем из стора через getState, а не через подписку:
      // иначе слушатель пересоздавался бы на каждое переключение диалога, и
      // между отпиской и подпиской можно было бы потерять событие.
      const active = useDmStore.getState().activeConversationId
      const visible = document.visibilityState === 'visible'
      const isActive = !!conversationId && conversationId === active

      // Тоста по открытому диалогу не показываем НИКОГДА, даже если вкладка
      // сейчас в фоне. Сообщение уже отрисовано в самой переписке, поэтому,
      // вернувшись во вкладку, пользователь увидел бы поверх неё тост с тем же
      // текстом, что и в последнем баббле, — дублирование без пользы.
      //
      // Звук — отдельное решение: он привлекает внимание к скрытой вкладке, и
      // там открытый диалог как раз ничего не сообщает. Поэтому его глушим
      // только когда переписка действительно на экране.
      if (isActive && visible) return

      playIncomingMessage()

      if (isActive) return

      // Текст письма может быть пустым — тогда это вложение, и показать нужно
      // хотя бы его имя, иначе тост выйдет без содержания.
      const text = message.text?.trim()
      const body = text || (message.attachment?.name ? `Вложение: ${message.attachment.name}` : 'Новое сообщение')

      pushNotification({
        kind: 'message',
        title: message.senderName?.trim() || 'Новое сообщение',
        body,
        href: conversationId ? `/profile?c=${encodeURIComponent(conversationId)}` : undefined,
        actionLabel: conversationId ? 'Открыть чат' : undefined,
        duration: 5000,
        // Поток сообщений из одного диалога сворачиваем в один тост, иначе три
        // реплики подряд вытеснят с экрана всё остальное.
        dedupeKey: conversationId ? `dm:${conversationId}` : undefined,
      })
    }

    socket.on('dm:message', onMessage)
    return () => {
      socket.off('dm:message', onMessage)
    }
  }, [socket, selfId])

  // Непрочитанные в заголовке вкладки: «(3) Replixo».
  //
  // Заголовок нам не принадлежит: при переходе между страницами Next
  // переписывает <title> из metadata и стирает наш префикс. Поэтому не просто
  // выставляем значение один раз, а следим за элементом и возвращаем префикс после каждой перезаписи. Чтобы не зациклиться, сравниваем желаемое
  // после каждой чужой записи. Собственная запись повторного прохода не
  // вызывает — desired совпадёт с текущим значением, и цикл обрывается.
  useEffect(() => {
    const stripBadge = (title: string) => title.replace(/^\(\d+\)\s*/, '')

    const apply = () => {
      const base = stripBadge(document.title)
      const desired = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${base}` : base
      if (document.title !== desired) document.title = desired
    }

    apply()

    const titleEl = document.querySelector('title')
    if (!titleEl) return

    const observer = new MutationObserver(apply)
    observer.observe(titleEl, { childList: true })

    return () => {
      observer.disconnect()
      document.title = stripBadge(document.title)
    }
  }, [totalUnread])

  // Стопка тостов живёт здесь же: компонент уже смонтирован ровно один раз на
  // приложение и только для авторизованного пользователя — именно те условия,
  // которые нужны уведомлениям.
  return (
    <>
      <AppToasts />
      <CallOverlays socket={socket} />
    </>
  )
}
