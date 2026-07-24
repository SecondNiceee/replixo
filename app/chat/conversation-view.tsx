'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { ArrowLeft, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConversationMessages } from '@/hooks/dm/use-conversation-messages'
import { useDmRead } from '@/hooks/dm/use-dm-read'
import { useTyping } from '@/hooks/dm/use-typing'
import { useDmStore } from '@/stores/dm-store'
import { DmMessageList } from './dm-message-list'
import { DmComposer } from './dm-composer'
import { TypingIndicator } from './typing-indicator'
import {
  conversationTitle,
  formatLastSeen,
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

  const { notifyTyping, stopTyping } = useTyping(socket, conversationId)

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
  const peerOnline = useDmStore((s) =>
    conversation ? s.onlineIds.has(conversation.friendId) : false,
  )
  const peerLastSeen = useDmStore((s) =>
    conversation ? s.lastSeenAt[conversation.friendId] : undefined,
  )

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

  // Автоскролл вниз при новом сообщении и при открытии диалога. Догрузка
  // старых сообщений сюда не попадает: последний id не меняется.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [lastMessageId, conversationId])

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
    return (
      <section className="flex min-h-0 w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card px-6 text-center">
        <MessageSquare className="size-10 text-muted-foreground/30" />
        <p className="text-pretty text-sm text-muted-foreground">
          Выберите диалог, чтобы начать переписку
        </p>
      </section>
    )
  }

  const title = conversationTitle(conversation)

  return (
    <section className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
      {/* Шапка */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="size-8 md:hidden"
          aria-label="Назад к списку диалогов"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
          {title.charAt(0).toUpperCase()}
          {peerOnline && (
            <span
              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500"
              aria-hidden="true"
            />
          )}
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          <span className="truncate text-[11px] text-muted-foreground">
            {peerOnline ? 'в сети' : formatLastSeen(peerLastSeen)}
          </span>
        </div>
      </div>

      {/* Лента */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {hasMore && (
          <div className="flex justify-center pb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadMore()}
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
