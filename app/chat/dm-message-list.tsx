'use client'

import { Check, CheckCheck, Clock, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AttachmentView } from '@/components/chat/attachment-view'
import { SERVER_URL } from '@/hooks/mediasoup/types'
import { formatTime } from '@/lib/chat-format'
import type { DmMessage } from './types'

interface DmMessageListProps {
  messages: DmMessage[]
  selfId: string
  /** До какого момента собеседник прочитал диалог (мс). */
  peerReadAt: number
  onRetry: (id: string) => void
}

function formatDayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Сегодня'
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString([], { day: 'numeric', month: 'long' })
}

export function DmMessageList({
  messages,
  selfId,
  peerReadAt,
  onRetry,
}: DmMessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-pretty text-sm text-muted-foreground">
          Сообщений пока нет. Напишите первым!
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {messages.map((m, i) => {
        const self = m.senderId === selfId
        const deleted = m.deletedAt !== null
        const prev = i > 0 ? messages[i - 1] : null
        const showDay =
          !prev ||
          new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()

        return (
          <li key={m.id} className="flex flex-col gap-3">
            {showDay && (
              <div className="flex items-center gap-2" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {formatDayLabel(m.createdAt)}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}

            <div className={cn('flex flex-col gap-0.5', self ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'flex max-w-[85%] flex-col gap-2 rounded-2xl px-3 py-2 text-sm leading-relaxed',
                  deleted
                    ? // Удалённое намеренно нейтральное: заглушка не должна
                      // выглядеть как обычная реплика в цвете отправителя.
                      'border border-dashed border-border bg-transparent text-muted-foreground'
                    : self
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-secondary text-secondary-foreground',
                  m.status === 'failed' && 'ring-1 ring-destructive',
                )}
              >
                {deleted ? (
                  <span className="italic">{DELETED_MESSAGE_TEXT}</span>
                ) : (
                  <>
                    {m.attachment && (
                      <AttachmentView
                        attachment={m.attachment}
                        // Файлы раздаёт mediasoup-сервер, а в БД хранится
                        // относительный путь — абсолютный собираем здесь.
                        baseUrl={SERVER_URL}
                        self={self}
                      />
                    )}
                    {/* Вложение без подписи — обычный случай, пустой абзац не рисуем. */}
                    {m.text && (
                      <span className="select-text whitespace-pre-wrap break-words">
                        {m.text}
                      </span>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-1.5 px-1">
                <span className="text-[10px] text-muted-foreground/70">
                  {formatTime(m.createdAt)}
                </span>
                {/* У удалённого правка уже не имеет смысла — не показываем. */}
                {!deleted && m.editedAt !== null && (
                  <span
                    className="text-[10px] text-muted-foreground/70"
                    title={`Изменено ${formatTime(m.editedAt)}`}
                  >
                    изменено
                  </span>
                )}
                {/* Ниже — только статусы доставки, и все они бессмысленны для
                    удалённого сообщения: галочки и «Повторить» на заглушке
                    выглядели бы так, будто её ещё можно отправить. */}
                {self && !deleted && m.status === 'sending' && (
                  <Clock className="size-3 text-muted-foreground/70" aria-label="Отправляется" />
                )}
                {self &&
                  !deleted &&
                  m.status !== 'sending' &&
                  m.status !== 'failed' &&
                  // Прочитано — не по каждому сообщению, а по маркеру времени
                  // собеседника: одна отметка закрывает всю ленту до неё.
                  (m.createdAt <= peerReadAt ? (
                    <CheckCheck className="size-3 text-primary" aria-label="Прочитано" />
                  ) : (
                    <Check className="size-3 text-muted-foreground/70" aria-label="Отправлено" />
                  ))}
                {self && !deleted && m.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => onRetry(m.id)}
                    className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
                  >
                    <RotateCcw className="size-3" />
                    Повторить
                  </button>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
