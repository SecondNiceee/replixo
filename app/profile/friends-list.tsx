'use client'

import { useState } from 'react'
import { UserMinus, Loader2 } from 'lucide-react'
import { usePresenceLastSeen, usePresenceStatus } from '@/stores/dm-store'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useNow } from '@/hooks/use-now'
import { ListSearch } from '@/components/chat/list-search'
import { PresenceDot } from '@/components/chat/presence-dot'
import { presenceLabel } from '@/app/chat/types'
import {
  friendsAction,
  notifyFriendsChanged,
  reportFriendsActionError,
} from '@/hooks/dm/use-friends-realtime'
import { cn } from '@/lib/utils'
import type { Friend } from './types'

interface FriendsListProps {
  friends: Friend[]
  isLoading: boolean
  /**
   * Открыть переписку с другом. Раньше кнопка «Написать» уводила на отдельную
   * страницу /chat; теперь список чатов и переписка живут на одном экране, и
   * навигация здесь только сбрасывала бы состояние открытого диалога.
   */
  onMessage: (friendId: string) => void
}

export function FriendsList({ friends, isLoading, onMessage }: FriendsListProps) {
  const { socket } = useDmSocket()
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const handleRemove = async (friendshipId: string, friendId: string) => {
    // Состояния занятости здесь не было вовсе: до ответа сервера кнопка выглядела
    // нетронутой, и её успевали нажать несколько раз — каждый клик уходил в
    // отдельный запрос и жёг лимит.
    setRemovingId(friendshipId)
    const result = await friendsAction(socket, '/api/friends/remove', 'DELETE', {
      friendshipId,
    })
    setRemovingId(null)

    if (!result.ok) {
      reportFriendsActionError(result)
      return
    }

    // Второй участник тоже должен увидеть, что дружбы больше нет.
    notifyFriendsChanged(socket, friendId, 'removed', result.data?.notified === true)
  }

  const search = query.trim().toLowerCase()
  const visible = search
    ? friends.filter((f) => (f.friendUsername ?? f.friendName).toLowerCase().includes(search))
    : friends

  return (
    // Контейнер без рамки и фона: их даёт левая панель кабинета, а вложенная
    // карточка внутри панели читалась бы как вторая рамка.
    <div className="flex min-h-0 w-full flex-col overflow-hidden">
      {/* Поле поиска здесь ровно такое же, как над списком чатов. Без него
          список друзей начинался на 52px выше, и при переключении табов вся
          колонка аватаров подпрыгивала. */}
      <div className="shrink-0 p-2">
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder="Поиск по друзьям"
          label="Поиск по друзьям"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          // Текстом по левому краю, без иконки-призрака — как и в списке чатов.
          <div className="flex flex-col gap-1 px-4 py-8">
            {search ? (
              <>
                <p className="text-sm font-medium text-foreground">Никого не нашлось</p>
                <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
                  Среди друзей нет никого с «{query.trim()}» в имени.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">Друзей пока нет</p>
                <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
                  Найдите человека по username кнопкой «Добавить в друзья» в шапке — после
                  подтверждения он появится здесь.
                </p>
              </>
            )}
          </div>
        ) : (
          // Без gap: отбивку строк задаёт их собственный вертикальный паддинг —
          // ровно как в списке диалогов, где gap не было. С gap-1 шаг строк в
          // двух табах отличался на 4px, и список заметно дёргался.
          <ul className="flex flex-col px-2 pb-2">
            {visible.map((f) => (
              <FriendRow
                key={f.id}
                friend={f}
                removing={removingId === f.id}
                onMessage={onMessage}
                onRemove={handleRemove}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface FriendRowProps {
  friend: Friend
  removing: boolean
  onMessage: (friendId: string) => void
  onRemove: (friendshipId: string, friendId: string) => void
}

/**
 * Строка списка — отдельный компонент, а не разметка внутри map: статус и время
 * читаются хуками, а хук нельзя вызвать в цикле. Плюс подписка получается точной
 * — перерисуется только та строка, чей друг сменил статус, а не весь список.
 */
function FriendRow({ friend, removing, onMessage, onRemove }: FriendRowProps) {
  const name = friend.friendUsername ?? friend.friendName
  const status = usePresenceStatus(friend.friendId)
  const lastSeenAt = usePresenceLastSeen(friend.friendId)
  // Тикающее «сейчас» нужно только оффлайн-строкам: у остальных подпись
  // постоянная («в сети»), и обновлять её незачем.
  const now = useNow(status === 'offline')
  const label = presenceLabel(status, lastSeenAt, now)

  return (
    // Геометрия строки та же, что у списка чатов (gap-3, аватар size-10,
    // rounded-xl, px-2 py-2): панель одна, и при переключении табов колонка
    // аватаров не должна прыгать влево-вправо.
    //
    // Открывает переписку вся строка, как в списке диалогов, а не иконка справа.
    // Иконка «написать» стояла в каждой строке и превращала правый край списка в
    // частокол одинаковых значков — при этом строка, которая выглядит абсолютно
    // так же, как строка чата, на клик не отвечала.
    <li className="group relative">
      <button
        type="button"
        onClick={() => onMessage(friend.friendId)}
        // pr-10 — место под кнопку удаления: она лежит поверх строки (иначе
        // кнопка в кнопке), и текст не должен уходить под неё.
        className="flex w-full items-center gap-3 rounded-xl py-2 pl-2 pr-10 text-left transition-colors group-hover:bg-foreground/5"
        aria-label={`Написать ${name}`}
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-sm text-foreground ring-1 ring-inset ring-border">
          {name.charAt(0).toUpperCase()}
          {/* label пустой: статус уже написан текстом ниже, и озвучивать его
              скринридеру дважды не нужно. */}
          <PresenceDot status={status} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{name}</span>
          {/* Подпись всегда приглушённая. Зелёное «в сети» повторяло цвет точки
              на аватаре тем же смыслом — два носителя одного сигнала, и в списке
              из семи строк это рассыпалось цветными пятнами по всей колонке. */}
          <span className="truncate text-[11px] text-muted-foreground">{label}</span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => onRemove(friend.id, friend.friendId)}
        disabled={removing}
        // Пока запрос летит, кнопку показываем и без ховера: иначе спиннер
        // прячется, стоит увести курсор со строки.
        //
        // Прячем прозрачностью, а не display: на hidden кнопка выпадала из
        // потока. pointer-events снимаем, чтобы невидимая кнопка не ловила
        // клики по строке.
        //
        // Условие — наличие ховера, а не ширина экрана: на планшете шириной
        // 1024px ховера нет, и кнопка, спрятанная по breakpoint'у, осталась бы
        // невидимой навсегда — удалить друга было бы нечем. media(hover:none)
        // и стандартный hover-вариант Tailwind взаимно исключают друг друга,
        // поэтому спорить за приоритет им не приходится.
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-[color,opacity] hover:text-destructive disabled:opacity-60',
          removing
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
        )}
        aria-label={`Удалить ${name} из друзей`}
      >
        {removing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <UserMinus className="size-4" />
        )}
      </button>
    </li>
  )
}
