'use client'

import { useEffect } from 'react'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useUnreadTotal } from '@/hooks/dm/use-unread-total'
import { useFriendsRealtime } from '@/hooks/dm/use-friends-realtime'
import { useDmStore } from '@/stores/dm-store'
import { playIncomingMessage } from '@/lib/sounds'

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

export function DmNotifier({ selfId }: { selfId: string }) {
  const { socket } = useDmSocket()
  const totalUnread = useUnreadTotal()

  // Заявки в друзья и их принятие должны быть видны без перезагрузки страницы.
  // Подписка живёт здесь, а не в профиле: ключи SWR глобальные, поэтому списки
  // обновятся на любой открытой странице, включая профиль.
  useFriendsRealtime(socket)

  // Звук нового сообщения.
  useEffect(() => {
    if (!socket) return

    const onMessage = (payload: unknown) => {
      const { conversationId, message } = (payload ?? {}) as {
        conversationId?: string
        message?: { senderId?: string }
      }
      // Своё же сообщение (эхо с другого устройства) не озвучиваем.
      if (!message?.senderId || message.senderId === selfId) return

      // Активный диалог читаем из стора через getState, а не через подписку:
      // иначе слушатель пересоздавался бы на каждое переключение диалога, и
      // между отпиской и подпиской можно было бы потерять событие.
      const active = useDmStore.getState().activeConversationId
      const visible = document.visibilityState === 'visible'

      // Молчим только если пользователь прямо сейчас смотрит в этот диалог.
      if (visible && conversationId && conversationId === active) return

      playIncomingMessage()
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
  // выставляем значение один раз, а следим за элементом и возвращаем префикс
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

  return null
}
