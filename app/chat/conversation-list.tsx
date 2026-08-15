'use client'

import { useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScrollbarAutohide } from '@/hooks/use-scrollbar-autohide'
import { usePresenceStatus } from '@/components/chat/presence-provider'
import { ListSearch } from '@/components/chat/list-search'
import { PresenceDot } from '@/components/chat/presence-dot'
import type { Friend } from '@/app/profile/types'
import { conversationTitle, normalizeAttachment, type DmConversation } from './types'

interface ConversationListProps {
  conversations: DmConversation[]
  friends: Friend[]
  activeId: string | null
  isLoading: boolean
  selfId: string
  onSelect: (conversationId: string) => void
  onStartWithFriend: (friendId: string) => void
}

/**
 * Точка статуса одной строки списка.
 *
 * Обёртка нужна из-за правил хуков: подписаться на статус конкретного друга
 * внутри map нельзя, а подписка на весь объект statuses перерисовывала бы список
 * целиком при каждом чужом заходе-уходе.
 *
 * Подписи для скринридера нет намеренно: в списке статус текстом не написан, но
 * строка и без него читается («Иван, 2 непрочитанных»), а «в сети» у каждой из
 * десятков строк превратил бы обход списка в шум. Статус озвучивается в шапке
 * диалога и в списке друзей, где он есть текстом.
 */
function FriendPresenceDot({
  friendId,
  ringClassName,
}: {
  friendId: string
  ringClassName?: string
}) {
  const status = usePresenceStatus(friendId)
  return <PresenceDot status={status} ringClassName={ringClassName} />
}

function formatListTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

/**
 * Превью последнего сообщения. Сообщение может быть без текста (только файл) —
 * тогда показываем имя вложения, иначе строка выглядела бы как пустой диалог.
 */
function formatPreview(c: DmConversation, selfId: string): string {
  const attachment = normalizeAttachment(c.lastMessageAttachment)
  const body = c.lastMessageText || (attachment ? `Файл: ${attachment.name}` : '')
  if (!body) return 'Нет сообщений'
  return `${c.lastMessageSenderId === selfId ? 'Вы: ' : ''}${body}`
}

export function ConversationList({
  conversations,
  friends,
  activeId,
  isLoading,
  selfId,
  onSelect,
  onStartWithFriend,
}: ConversationListProps) {
  const [query, setQuery] = useState('')

  // Полоса прокрутки списка проявляется только на время скролла (.scroll-slim).
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollbarAutohide(scrollRef)

  const search = query.trim().toLowerCase()

  // Фильтрация по имени собеседника. Отдельного поиска по сообщениям нет: в
  // сторе лежит только последняя реплика каждого диалога, поэтому «поиск» по
  // ней находил бы случайные совпадения и молчал бы по остальной истории.
  const visibleConversations = useMemo(
    () =>
      search
        ? conversations.filter((c) => conversationTitle(c).toLowerCase().includes(search))
        : conversations,
    [conversations, search],
  )

  // Друзья, с которыми переписки ещё нет — быстрый старт нового диалога.
  const withoutConversation = useMemo(() => {
    const rest = friends.filter((f) => !conversations.some((c) => c.friendId === f.friendId))
    return search
      ? rest.filter((f) => (f.friendUsername ?? f.friendName).toLowerCase().includes(search))
      : rest
  }, [friends, conversations, search])

  const nothingFound =
    visibleConversations.length === 0 && withoutConversation.length === 0

  return (
    // Ни рамки, ни своего заголовка: список вложен в левую панель кабинета,
    // которая даёт и то, и другое, а переключатель «Чаты / Друзья» над ним уже
    // подписывает раздел.
    <div className="flex min-h-0 w-full flex-col overflow-hidden">
      <div className="shrink-0 p-2">
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder="Поиск по диалогам"
          label="Поиск по диалогам"
        />
      </div>

      <div ref={scrollRef} className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <ul className="flex flex-col px-2 pb-2">
              {visibleConversations.map((c) => {
                const title = conversationTitle(c)
                const isActive = c.id === activeId
                const preview = formatPreview(c, selfId)
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors',
                        // Активный диалог красим акцентом, как в Telegram: в
                        // раскладке «список слева, переписка справа» иначе не
                        // видно, какой из них открыт справа.
                        isActive
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-foreground/5',
                      )}
                    >
                      {/* Аватары плоские, буква моноширинная. Градиент на
                          каждой строке спорил с акцентом активного диалога и
                          бейджем непрочитанных — теперь синий в панели значит
                          ровно одно: «здесь есть на что смотреть». */}
                      <span
                        className={cn(
                          'relative flex size-10 shrink-0 items-center justify-center rounded-full font-mono text-sm',
                          isActive
                            ? 'bg-primary-foreground/15 text-primary-foreground'
                            : 'bg-secondary text-foreground ring-1 ring-inset ring-border',
                        )}
                      >
                        {title.charAt(0).toUpperCase()}
                        {/* Обводка под подложку строки: у активной она красится
                            акцентом, и border-card на нём был бы виден рамкой. */}
                        <FriendPresenceDot
                          friendId={c.friendId}
                          ringClassName={isActive ? 'border-primary' : 'border-card'}
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium">{title}</span>
                          {/* tabular-nums: пропорциональные цифры дают «09:05»
                              и «12:34» разной ширины, и время в столбце справа
                              переставало выстраиваться по правому краю. */}
                          <span
                            className={cn(
                              'ml-auto shrink-0 text-[11px] tabular-nums',
                              isActive ? 'text-primary-foreground/70' : 'text-muted-foreground',
                            )}
                          >
                            {formatListTime(c.lastMessageAt)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'truncate text-xs',
                            isActive ? 'text-primary-foreground/80' : 'text-muted-foreground',
                          )}
                        >
                          {preview}
                        </span>
                      </span>
                      {c.unreadCount > 0 && !isActive && (
                        // grid place-items-center вместо leading-none + py:
                        // выключной интерлиньяж с асимметричными паддингами
                        // ставил цифру примерно на пиксель выше центра кружка.
                        // Фиксированные h-5/min-w-5 дают ровный круг на одной
                        // цифре и капсулу на двух.
                        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>

            {withoutConversation.length > 0 && (
              // Раньше зону отбивала линия на всю ширину панели — третья
              // горизонтальная полоса в колонке, вплотную к рельсу табов. Теперь
              // это подпись с волоском вправо: она и отделяет, и объясняет
              // пустое место над собой, а не оставляет его случайным зазором.
              <div className="px-2 pb-2">
                <div className="flex items-center gap-2.5 py-2 pl-2">
                  <span className="shrink-0 text-[11px] font-medium tracking-tight text-muted-foreground">
                    Начать диалог
                  </span>
                  <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
                </div>
                <ul className="flex flex-col">
                  {withoutConversation.map((f) => {
                    const name = f.friendUsername ?? f.friendName
                    return (
                      <li key={f.id}>
                        {/* Строка легче строки диалога намеренно: аватар 32
                            вместо 40, подпись приглушена. Одинаковые по весу
                            строки в двух разных по смыслу зонах и читались как
                            один список с провалом посередине. */}
                        <button
                          type="button"
                          onClick={() => onStartWithFriend(f.friendId)}
                          className="group flex w-full items-center gap-3 rounded-xl py-1.5 pl-2 pr-2 text-left transition-colors hover:bg-foreground/5"
                        >
                          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs text-muted-foreground ring-1 ring-inset ring-border">
                            {name.charAt(0).toUpperCase()}
                            <FriendPresenceDot friendId={f.friendId} />
                          </span>
                          <span className="truncate text-[13px] text-muted-foreground transition-colors group-hover:text-foreground">
                            {name}
                          </span>
                          {/* Иконка проявляется под курсором: постоянный плюс в
                              каждой строке превращал зону в частокол значков. */}
                          <MessageSquarePlus
                            className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* Пусто по двум разным причинам: либо друзей ещё нет, либо ничего
                не нашлось по запросу. Один текст на оба случая сбивал бы с
                толку — при активном поиске он советовал бы добавить друзей. */}
            {nothingFound && (
              // Крупной иконки-призрака больше нет: полупрозрачный значок на
              // 32px в центре пустой колонки — самая узнаваемая заглушка «ни о
              // чём». Осталась пара строк текстом по левому краю, на той же
              // сетке, что и строки списка, — пусто, но не выглядит поломкой.
              <div className="flex flex-col gap-1 px-4 py-8">
                {search ? (
                  <>
                    <p className="text-sm font-medium text-foreground">Ничего не найдено</p>
                    <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
                      По запросу «{query.trim()}» нет ни диалогов, ни друзей.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">Здесь пока пусто</p>
                    <p className="text-pretty text-xs leading-relaxed text-muted-foreground">
                      Добавьте друга по username — кнопка «Добавить в друзья» в шапке, — и диалог
                      появится в этом списке.
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
