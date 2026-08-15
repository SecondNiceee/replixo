'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { ArrowLeft, Loader2, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCallActions } from '@/hooks/dm/use-calls'
import { useCallStore } from '@/stores/call-store'
import { useConversationMessages } from '@/hooks/dm/use-conversation-messages'
import { useDmRead } from '@/hooks/dm/use-dm-read'
import { useTyping } from '@/hooks/dm/use-typing'
import { useDmStore, usePresenceLastSeen, usePresenceStatus } from '@/stores/dm-store'
import { useNow } from '@/hooks/use-now'
import { useScrollbarAutohide } from '@/hooks/use-scrollbar-autohide'
import { PresenceDot } from '@/components/chat/presence-dot'
import { cn } from '@/lib/utils'
import { DmMessageList } from './dm-message-list'
import { DmComposer } from './dm-composer'
import { TypingIndicator } from './typing-indicator'
import { EmptyState } from './empty-state'
import {
  conversationTitle,
  presenceLabel,
  type DmAttachment,
  type DmConversation,
} from './types'

interface ConversationViewProps {
  conversation: DmConversation | null
  selfId: string
  socket: Socket | null
  connected: boolean
  onBack: () => void
  onReadFallback: (conversationId: string) => void
}

/** Порог «доскроллено до низа» — с запасом на подпиксельные значения. */
const BOTTOM_THRESHOLD_PX = 48

export function ConversationView({
  conversation,
  selfId,
  socket,
  connected,
  onBack,
  onReadFallback,
}: ConversationViewProps) {
  const conversationId = conversation?.id ?? null
  const { messages, loading, loadingMore, hasMore, error, send, retry, loadMore } =
    useConversationMessages(conversationId, socket, selfId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const lastMessageId = lastMessage?.id ?? null
  // Меняется только когда в начало ленты добавили порцию старых сообщений —
  // именно этот момент нужно скомпенсировать скроллом.
  const firstMessageId = messages.length > 0 ? messages[0].id : null

  const { notifyTyping, stopTyping } = useTyping(socket, conversationId)

  // Звонок собеседнику. Состояние вызова глобальное (экраны звонка живут в
  // корневом layout), здесь нужно только действие и признак «уже звоним» —
  // чтобы кнопка не позволила начать второй вызов поверх первого.
  const { invite } = useCallActions(socket)
  const calling = useCallStore((s) => s.outgoing !== null)

  // Живой маркер прочтения из сокета против пришедшего с HTTP: берём больший.
  // Иначе после перезагрузки страницы галочки на секунду откатывались бы.
  const livePeerReadAt = useDmStore((s) =>
    conversationId ? (s.peerReadAt[conversationId] ?? 0) : 0,
  )
  const httpPeerReadAt = conversation?.peerLastReadAt
    ? new Date(conversation.peerLastReadAt).getTime()
    : 0
  const peerReadAt = Math.max(livePeerReadAt, httpPeerReadAt)

  const peerTyping = useDmStore((s) =>
    conversationId ? Boolean(s.typing[conversationId]?.[conversation?.friendId ?? '']) : false,
  )
  const peerStatus = usePresenceStatus(conversation?.friendId)
  const peerLastSeen = usePresenceLastSeen(conversation?.friendId)
  // «был(а) N минут назад» должно стареть само: события об оффлайне больше не
  // будет, и без тика шапка часами показывала бы «только что». Пока собеседник
  // на связи, подписка не нужна — подпись там постоянная.
  const now = useNow(peerStatus === 'offline')
  const peerLabel = presenceLabel(peerStatus, peerLastSeen, now)

  // Отметка прочитанного: только когда вкладка видима и лента внизу.
  useDmRead({
    socket,
    conversationId,
    lastMessageAt: lastMessage?.createdAt ?? 0,
    atBottom,
    onFallback: onReadFallback,
  })

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX)
  }, [])

  // Полоса прокрутки ленты проявляется только на время скролла. Переподписка по
  // conversationId нужна потому, что без открытого диалога на этом месте стоит
  // EmptyState и ref пустой — иначе слушатель не навесился бы никогда.
  useScrollbarAutohide(scrollRef, [conversationId])

  // Автоскролл вниз при новом сообщении и при открытии диалога. Догрузка
  // старых сообщений сюда не попадает: последний id не меняется.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [lastMessageId, conversationId])

  // Якорь на время догрузки истории: высота и позиция ленты до вставки.
  const restoreRef = useRef<{ height: number; top: number } | null>(null)

  const handleLoadMore = useCallback(() => {
    const el = scrollRef.current
    if (el) restoreRef.current = { height: el.scrollHeight, top: el.scrollTop }
    void loadMore()
  }, [loadMore])

  // Вставка старых сообщений увеличивает scrollHeight сверху, и без правки
  // scrollTop лента визуально «улетает» вниз ровно на высоту вставленного
  // блока. Компенсируем до отрисовки — иначе будет заметный прыжок.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const saved = restoreRef.current
    if (!el || !saved) return
    restoreRef.current = null
    el.scrollTop = el.scrollHeight - saved.height + saved.top
  }, [firstMessageId])

  const handleSend = useCallback(
    (text: string, attachment: DmAttachment | null) => {
      // Сообщение ушло — индикатор набора у собеседника гасим сразу, не
      // дожидаясь таймаута молчания.
      stopTyping()
      send(text, attachment)
    },
    [send, stopTyping],
  )

  if (!conversation) {
    return <EmptyState />
  }

  const title = conversationTitle(conversation)

  return (
    <section className="chat-surface flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border/60 backdrop-blur-xl">
      {/* Шапка */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="size-8 md:hidden"
          aria-label="Назад к списку диалогов"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {/* Тот же плоский аватар, что в списке слева: это один и тот же человек,
            и разное оформление читалось бы как два разных компонента. */}
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-sm text-foreground ring-1 ring-inset ring-border">
          {title.charAt(0).toUpperCase()}
          {/* Статус тут же напис��н текстом, поэтому точка декоративна. */}
          <PresenceDot status={peerStatus} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          <span
            className={cn(
              'truncate text-[11px]',
              peerStatus === 'online' ? 'text-emerald-400' : 'text-muted-foreground',
            )}
          >
            {peerLabel}
          </span>
        </div>

        {/* Позвонить — единственное действие в шапке, поэтому оно и есть её
            акцент: сплошной кружок в фирменном цвете у правого края. */}
        <button
          type="button"
          onClick={() => invite(conversation.friendId, title)}
          disabled={!connected || calling}
          aria-label={`Позвонить ${title}`}
          title={`Позвонить ${title}`}
          className="ml-auto flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md shadow-primary/25 ring-1 ring-primary/40 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <Phone className="size-4.5" aria-hidden="true" />
        </button>
      </div>

      {/* Лента */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-canvas scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {hasMore && (
          <div className="flex justify-center pb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="text-xs"
            >
              {loadingMore ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                'Показать более ранние'
              )}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <DmMessageList
            messages={messages}
            selfId={selfId}
            peerReadAt={peerReadAt}
            onRetry={retry}
          />
        )}
      </div>

      {error && (
        <p className="shrink-0 border-t border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Место под индикатор зарезервировано всегда: его появление не должно
          дёргать ленту и композер вверх-вниз. */}
      <div className="flex h-5 shrink-0 items-center px-4">
        {peerTyping && <TypingIndicator name={title} />}
      </div>

      <DmComposer
        conversationId={conversation.id}
        onSend={handleSend}
        onTyping={notifyTyping}
        disabled={!connected}
      />
    </section>
  )
}
