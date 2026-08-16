import { Suspense } from 'react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { listFriends } from '@/lib/chat/friends'
import { listConversations } from '@/lib/chat/conversations'
import { completePresence, fetchPresence } from '@/lib/chat/presence'
import { ProfileClient } from './profile-client'
import { ProfileBoot } from './profile-boot'

export const metadata: Metadata = {
  title: 'Кабинет — Replixo',
  description: 'Личные сообщения и друзья в Replixo.',
}

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  // Списки и статусы снимаем здесь, а не в браузере: пока запросы летели с
  // клиента, первый кадр рисовался без статусов вовсе, и у людей в сети на
  // долю секунды мигало «не в сети».
  //
  // Все три запроса идут ОДНОВРЕМЕННО. Раньше presence ждал список друзей, чтобы
  // передать их id, и задержки складывались; теперь список резолвит сам
  // сокет-сервер по одному userId (см. fetchPresence), и последовательной
  // цепочки здесь больше нет.
  //
  // fetchPresence не бросает и ограничен таймаутом 500 мс: недоступный
  // сокет-сервер не задержит страницу и не сломает её.
  const [friends, conversations, rawPresence] = await Promise.all([
    listFriends(session.user.id),
    listConversations(session.user.id),
    fetchPresence(session.user.id),
  ])

  // Собеседники диалогов — это друзья, поэтому один список id покрывает и чаты.
  //
  // completePresence дочитывает lastSeenAt из Postgres для тех, о ком сокет-сервер
  // не рассказал. Без этого шага незаданный INTERNAL_HOOK_SECRET (состояние по
  // умолчанию) означал пустой снапшот, и «Подключение…» висело на каждой строке
  // до подключения websocket — то самое мигание на секунду.
  const snapshot = await completePresence(rawPresence, friends.map((f) => f.friendId))

  // serverNow снимаем здесь, а не в браузере: относительные подписи («был(а)
  // только что» / «был(а) 1 минуту назад») считаются от «сейчас», и часы
  // сервера с часами клиента расходятся — посчитанные от разных времён строки
  // отличались бы текстом, то есть ошибкой гидрации.
  const presence = { ...snapshot, serverNow: Date.now() }

  return (
    // h-dvh + flex: переписка должна скроллиться внутри своей колонки, а не
    // растягивать страницу — иначе композер уезжает за нижний край экрана.
    // app-dark — тёмная палитра кабинета в оттенке лендинга; сам класс нужен и
    // для диалогов, которые рендерятся в портал вне <main>.
    <main className="app-dark app-shell-surface flex h-dvh flex-col overflow-hidden px-3 py-3 md:px-5 md:py-5">
      {/* ProfileClient читает ?c= и ?u= через useSearchParams — на сервере это
          требует Suspense. */}
      <Suspense fallback={null}>
        {/* ProfileBoot кладёт серверные данные туда, откуда их читают хуки
            внизу дерева: списки — в fallback SWR по ключам, presence — в
            контекст. Без него всё, что снято выше, до компонентов не доезжает,
            и первый кадр снова рисуется пустым. */}
        <ProfileBoot friends={friends} conversations={conversations} presence={presence}>
          <ProfileClient user={session.user} />
        </ProfileBoot>
      </Suspense>
    </main>
  )
}
