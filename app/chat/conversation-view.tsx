'use client'

import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { ArrowLeft, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConversationMessages } from '@/hooks/dm/use-conversation-messages'
import { DmMessageList } from './dm-message-list'
import { DmComposer } from './dm-composer'
import { conversationTitle, type DmConversation } from './types'

interface ConversationViewProps {
  conversation: DmConversation | null
  selfId: string
  socket: Socket | null
  connected: boolean
  onBack: () => void
}

export function ConversationView({
  conversation,
  selfId,
  socket,
  connected,
  onBack,
}: ConversationViewProps) {
  const conversationId = conversation?.id ?? null
  const { messages, loading, loadingMore, hasMore, error, send, retry, loadMore } =
    useConversationMessages(conversationId, socket, selfId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null

  // Автоскролл вниз при новом сообщении и при открытии диалога. Догрузка
  // старых сообщений сюда не попадает: последний id не меняется.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastMessageId, conversationId])

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
        <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
          {title.charAt(0).toUpperCase()}
        </span>
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
      </div>

      {/* Лента */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
          <DmMessageList messages={messages} selfId={selfId} onRetry={retry} />
        )}
      </div>

      {error && (
        <p className="shrink-0 border-t border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <DmComposer onSend={send} disabled={!connected} />
    </section>
  )
}
