'use client'

import { useMemo, type ReactNode } from 'react'
import { SWRConfig } from 'swr'
import { CONVERSATIONS_KEY } from '@/hooks/dm/use-conversations'
import { PresenceProvider, type PresenceFallback } from '@/components/chat/presence-provider'
import type { DmConversation } from '@/app/chat/types'
import type { Friend } from './types'

// ---------------------------------------------------------------------------
// Мост между серверным рендером /profile и клиентскими хуками.
//
// Данные (друзья, диалоги, presence) снимает страница на сервере, а читают их
// useSWR и usePresenceStatus далеко внизу дерева. Прокидывать всё пропсами
// пришлось бы через каждый промежуточный компонент, поэтому кладём в те же
// каналы, откуда хуки и так читают.
//
// Списки идут через SWR-fallback ПО КЛЮЧУ, а не через fallbackData в каждом
// хуке: ключ диалогов общий на приложение (CONVERSATIONS_KEY, его читают ещё и
// бейджи вне страницы), и менять сигнатуру useConversations ради одной страницы
// незачем. Побочная польза — isLoading у обоих списков сразу false, то есть
// спиннеры при открытии кабинета тоже пропадают.
// ---------------------------------------------------------------------------

interface ProfileBootProps {
  friends: Friend[]
  conversations: DmConversation[]
  presence: PresenceFallback
  children: ReactNode
}

export function ProfileBoot({ friends, conversations, presence, children }: ProfileBootProps) {
  const swrValue = useMemo(
    () => ({
      fallback: {
        '/api/friends': { friends, presence },
        [CONVERSATIONS_KEY]: { conversations },
      },
      // Данные сняты при рендере страницы и к моменту гидрации могли устареть —
      // особенно статусы, которые живут секунды. Ревалидация обязательна, а
      // fallback нужен только чтобы первый кадр не был пустым.
      revalidateOnMount: true,
    }),
    [friends, conversations, presence],
  )

  return (
    <SWRConfig value={swrValue}>
      <PresenceProvider value={presence}>{children}</PresenceProvider>
    </SWRConfig>
  )
}
