'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { ArrowLeft, Bookmark, Loader2, Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCallActions } from '@/hooks/dm/use-calls'
import { useCallStore } from '@/stores/call-store'
import { useConversationMessages } from '@/hooks/dm/use-conversation-messages'
import { useDmRead } from '@/hooks/dm/use-dm-read'
import { useTyping } from '@/hooks/dm/use-typing'
import { useDmStore } from '@/stores/dm-store'
import {
  usePresenceLastSeen,
  usePresenceServerNow,
  usePresenceStatus,
} from '@/components/chat/presence-provider'
import { useNow } from '@/hooks/use-now'
import { useScrollbarAutohide } from '@/hooks/use-scrollbar-autohide'
import { PresenceDot } from '@/components/chat/presence-dot'
import { cn } from '@/lib/utils'
import { useSession } from '@/lib/auth-client'
import { noteAttachment } from '@/lib/chat/note-attachment'
import { MessageContextMenu } from '@/components/chat/message-context-menu'
import { buildReply, type ReplyRef } from '@/lib/chat/reply'
import { DmMessageList } from './dm-message-list'
import { DmComposer } from './dm-composer'
import { TypingIndicator } from './typing-indicator'
import { EmptyState } from './empty-state'
import {
  FAVORITES_HINT,
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
  // «Избранное»: собеседника нет, поэтому всё, что описывает второго человека
  // (звонок, presence, «печатает…», ожидание его галочек), здесь не просто
  // лишнее — оно врало бы про несуществующего участника.
  const isSelfChat = conversation?.isSelf === true
  const { messages, loading, loadingMore, hasMore, error, send, retry, loadMore } =
    useConversationMessages(conversationId, socket, selfId)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const lastMessageId = lastMessage?.id ?? null
  // Меняется только когда в начало ленты добавили порцию старых сообщений —
  // именно этот момент нужно скомпенсировать скроллом.
  const firstMessageId = messages.length > 0 ? messages[0].id : null

  // Своё «печатает…» в «Избранном» не рассылаем: сервер разослал бы событие
  // всем участникам, а участник там ровно один — я сам. Индикатор загорелся бы
  // в собственной шапке от собственного набора.
  const { notifyTyping, stopTyping } = useTyping(socket, isSelfChat ? null : conversationId)

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
  // В «Избранном» ждать чужого прочтения не от кого, а одинарная галочка читалась
  // бы как «не доставлено». Infinity даёт двойную всегда: любое сообщение
  // оказывается созданным раньше маркера.
  const peerReadAt = isSelfChat
    ? Number.POSITIVE_INFINITY
    : Math.max(livePeerReadAt, httpPeerReadAt)

  const peerTyping = useDmStore((s) =>
    conversationId && !isSelfChat
      ? Boolean(s.typing[conversationId]?.[conversation?.friendId ?? ''])
      : false,
  )
  // В «Избранном» friendId — это сам владелец, и подписка на него дала бы в
  // шапке собственный статус («в сети» самому себе). Поэтому там id не
  // передаём: хуки на undefined возвращают 'unknown', а подпись мы и так
  // заменяем на FAVORITES_HINT.
  const peerId = isSelfChat ? undefined : conversation?.friendId
  const peerStatus = usePresenceStatus(peerId)
  const peerLastSeen = usePresenceLastSeen(peerId)
  // «был(а) N минут назад» должно стареть само: события об оффлайне больше не
  // будет, и без тика шапка часами показывала бы «только что». Пока собеседник
  // на связи, подписка не нужна — подпись там постоянная.
  // Серверное «сейчас» для первого кадра — по той же причине, что и в списке
  // друзей: шапка открытого по ссылке диалога рендерится на сервере, и подпись,
  // посчитанная от часов клиента, разошлась бы с HTML.
  const serverNow = usePresenceServerNow()
  const now = useNow(peerStatus === 'offline', serverNow)
  const peerLabel = presenceLabel(peerStatus, peerLastSeen, now)

  // Отметка прочитанного: только когда вкладка видима и лента внизу.
  useDmRead({
    socket,
    conversationId,
    lastMessageAt: lastMessage?.createdAt ?? 0,
    atBottom,
    onFallback: onReadFallback,
  })

  const contentRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  // «Держаться у низа»: true, пока человек сам не отлистал ленту вверх.
  // Ref, а не state — читается в ResizeObserver без переподписки.
  const stickToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX
    stickToBottomRef.current = bottom
    setAtBottom(bottom)
  }, [])

  // Полоса прокрутки ленты проявляется только на время скролла. Переподписка по
  // conversationId нужна потому, что без открытого диалога на этом месте стоит
  // EmptyState и ref пустой — иначе слушатель не навесился бы никогда.
  useScrollbarAutohide(scrollRef, [conversationId])

  // Автоскролл вниз при новом сообщении и при открытии диалога. Догрузка
  // старых сообщений сюда не попадает: последний id не меняется. Layout-эффект —
  // чтобы первый кадр открытого диалога сразу был внизу, без мелькания сверху.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    stickToBottomRef.current = true
    setAtBottom(true)
  }, [lastMessageId, conversationId, loading])

  // Фото в ленте не знают своей высоты, пока не загрузятся, и догружаются уже
  // после прокрутки вниз: каждое раздвигало ленту, и диалог открывался «чуть
  // выше конца». Пока человек внизу, любой рост контента снова прижимает низ.
  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [conversationId, loading])

  // Якорь на время догрузки истории: высота и позиция ленты до вставки.
  const restoreRef = useRef<{ height: number; top: number } | null>(null)

  const handleLoadMore = useCallback(() => {
    const el = scrollRef.current
    if (el) restoreRef.current = { height: el.scrollHeight, top: el.scrollTop }
    void loadMore()
  }, [loadMore])

  // Пагинация вверх: более ранние сообщения грузятся, только когда человек
  // долистал до верха ленты (с запасом в 200px, чтобы порция успела прийти
  // до упора). Наблюдатель пересоздаётся после каждой порции: если её не
  // хватило, чтобы заполнить экран, он сразу сработает ещё раз.
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = topSentinelRef.current
    if (!root || !sentinel || loading || !hasMore || loadingMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handleLoadMore()
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loading, hasMore, loadingMore, handleLoadMore, messages.length])

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

  // Сообщение, на которое сейчас отвечаем. В другом диалоге оно чужое — сброс.
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null)
  useEffect(() => {
    setReplyTo(null)
  }, [conversationId])
  const cancelReply = useCallback(() => setReplyTo(null), [])

  const handleSend = useCallback(
    (text: string, attachments: DmAttachment[]) => {
      // Сообщение ушло — индикатор набора у собеседника гасим сразу, не
      // дожидаясь таймаута молчания.
      stopTyping()
      setReplyTo(null)
      if (attachments.length === 0) {
        send(text, null, replyTo)
        return
      }
      // Несколько файлов — несколько отдельных сообщений, лента раскладывает
      // их как обычную переписку. Текст из поля уходит только с последним:
      // так подпись явно относится к конкретной фотографии, а не «висит»
      // отдельно от всех вложений. Цитата — тоже к последнему, вместе с текстом.
      attachments.forEach((attachment, i) => {
        const isLast = i === attachments.length - 1
        send(isLast ? text : '', attachment, isLast ? replyTo : null)
      })
    },
    [send, stopTyping, replyTo],
  )

  const { data: session } = useSession()
  const isTeacher = session?.user.role === 'teacher'
  const friendId = conversation?.friendId
  const sessionUser = session?.user as { name?: string; username?: string | null } | undefined
  const selfName = sessionUser?.username || sessionUser?.name || ''
  const peerName = conversation ? conversationTitle(conversation) : ''

  // Отвечать можно только на уже сохранённое сообщение: оригинал ищет сервер,
  // а неотправленного в базе ещё нет.
  const canReply = useCallback(
    (id: string) => {
      const m = messages.find((x) => x.id === id)
      return !!m && m.status !== 'sending' && m.status !== 'failed'
    },
    [messages],
  )
  const getMessageText = useCallback(
    (id: string) => messages.find((x) => x.id === id)?.text ?? '',
    [messages],
  )
  const startReply = useCallback(
    (id: string) => {
      const m = messages.find((x) => x.id === id)
      if (!m) return
      setReplyTo(
        buildReply({
          id: m.id,
          authorId: m.senderId,
          author: m.senderId === selfId ? selfName : peerName,
          text: m.text,
          attachment: m.attachment,
        }),
      )
    },
    [messages, selfId, selfName, peerName],
  )

  // Сначала выдаём собеседнику доступ (иначе ссылка на конспект откроется у
  // него с 404), потом шлём карточку обычным путём — с оптимистичным показом.
  const handleSendNote = useCallback(
    async (note: { id: string; title: string }) => {
      if (!isSelfChat && friendId) {
        const res = await fetch(`/api/notes/${note.id}/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: [friendId] }),
        })
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(json.error || 'Не удалось отправить конспект')
        }
      }
      handleSend('', [noteAttachment(note.id, note.title) as DmAttachment])
    },
    [isSelfChat, friendId, handleSend],
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
          aria-label="Назад к списк�� диалогов"
        >
          <ArrowLeft className="size-4" />
        </Button>
        {/* Тот же плоский аватар, что в списке слева: это один и тот же человек,
            и разное оформление читалось бы как два разных компонента. */}
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-sm text-foreground ring-1 ring-inset ring-border md:text-base">
          {/* Та же закладка, что в строке списка: открытый диалог обязан
              выглядеть продолжением строки, по которой в него вошли. */}
          {isSelfChat ? (
            <Bookmark className="size-4.5 md:size-5" aria-hidden="true" />
          ) : (
            <>
              {title.charAt(0).toUpperCase()}
              {/* Статус тут же написан текстом, поэтому точка декоративна. */}
              <PresenceDot status={peerStatus} />
            </>
          )}
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
          <span
            className={cn(
              'truncate text-xs',
              !isSelfChat && peerStatus === 'online'
                ? 'text-emerald-400'
                : 'text-muted-foreground',
            )}
          >
            {/* Место подписи не пустует: вм��сто статуса, которого у заметок нет,
                она объясняет сам чат — «Заметки только для вас». */}
            {isSelfChat ? FAVORITES_HINT : peerLabel}
          </span>
        </div>

        {/* Позвонить — единственное действие в шапке, поэтому оно и есть её
            акцент: сплошной кружок в фирменном цвете у правого края. В
            «Избранном» кнопки нет вовсе: звонить самому себе некуда, а
            выключенная кнопка обещала бы действие, которого не существует. */}
        {!isSelfChat && (
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
        )}
      </div>

      {/* Лента */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-canvas scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div ref={contentRef}>
            {hasMore && <div ref={topSentinelRef} aria-hidden="true" className="h-px" />}
            {loadingMore && (
              <div className="flex justify-center pb-3" role="status">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                <span className="sr-only">Загружаем более ранние сообщения</span>
              </div>
            )}
            <MessageContextMenu canReply={canReply} getText={getMessageText} onReply={startReply}>
              <DmMessageList
                messages={messages}
                selfId={selfId}
                peerReadAt={peerReadAt}
                isSelfChat={isSelfChat}
                onRetry={retry}
              />
            </MessageContextMenu>
          </div>
        )}
      </div>

      {error && (
        <p className="shrink-0 border-t border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Место под индикатор зарезервировано всегда: его появление не должно
          дёргать ленту и композер вверх-вниз. В «Избранном» полосы нет совсем —
          там индикатор не загорится никогда, и пустые 20px просто отодвигали бы
          композер от ленты без причины. */}
      {!isSelfChat && (
        <div className="flex h-5 shrink-0 items-center px-4">
          {peerTyping && <TypingIndicator name={title} />}
        </div>
      )}

      <DmComposer
        conversationId={conversation.id}
        onSend={handleSend}
        onTyping={notifyTyping}
        disabled={!connected}
        onSendNote={isTeacher ? handleSendNote : undefined}
        replyTo={replyTo}
        onCancelReply={cancelReply}
        selfId={selfId}
      />
    </section>
  )
}
