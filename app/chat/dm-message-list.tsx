'use client'

import { Check, CheckCheck, Clock, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AttachmentView } from '@/components/chat/attachment-view'
import { MessageText } from '@/components/chat/message-text'
import { SERVER_URL } from '@/hooks/mediasoup/types'
import { formatTime, isImageAttachment } from '@/lib/chat-format'
import { FAVORITES_EMPTY_TEXT, type DmMessage } from './types'

interface DmMessageListProps {
  messages: DmMessage[]
  selfId: string
  /**
   * До какого момента собеседник прочитал диалог (мс). В «Избранном» это
   * Infinity — галочки там всегда двойные, ждать прочтения не от кого.
   */
  peerReadAt: number
  /** Чат «Избранное»: заметки самому себе, без второго участника. */
  isSelfChat?: boolean
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
  isSelfChat = false,
  onRetry,
}: DmMessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-pretty text-sm text-muted-foreground">
          {/* «Напишите первым» подразумевает второго — в «Избранном» его нет, и
              фраза читалась бы как ожидание чужого ответа. */}
          {isSelfChat ? FAVORITES_EMPTY_TEXT : 'Сообщений пока нет. Напишите первым!'}
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {messages.map((m, i) => {
        const self = m.senderId === selfId
        // Картинка рисуется без рамки пузыря, карточка файла — с отступами.
        const photo = !!m.attachment && isImageAttachment(m.attachment)
        const prev = i > 0 ? messages[i - 1] : null
        const showDay =
          !prev ||
          new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()

        return (
          <li key={m.id} className="flex flex-col gap-3">
            {showDay && (
              // Плашка по центру, как в Telegram: линии по бокам на узорном
              // полотне ленты выглядели бы обрывками сетки.
              <div className="flex justify-center py-1" aria-hidden="true">
                <span className="rounded-full bg-foreground/5 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
                  {formatDayLabel(m.createdAt)}
                </span>
              </div>
            )}

            <div className={cn('flex flex-col gap-0.5', self ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'flex max-w-[85%] flex-col overflow-hidden rounded-2xl text-sm leading-relaxed',
                  self ? 'rounded-br-md bubble-self' : 'rounded-bl-md bubble-peer',
                  // Фотография занимает пузырь целиком: без отступов и зазора
                  // цветная рамка баббла вокруг неё не проглядывает, а
                  // overflow-hidden выше скругляет саму картинку по его форме.
                  // Остальным сообщениям отступы нужны — текст и карточку файла
                  // нельзя прижимать к краю.
                  photo ? 'gap-0' : 'gap-2 px-3 py-2',
                )}
              >
                {m.attachment && (
                  <AttachmentView
                    attachment={m.attachment}
                    // Файлы раздаёт mediasoup-сервер, а в БД хранится
                    // относительный путь — абсолютный собираем здесь.
                    baseUrl={SERVER_URL}
                    self={self}
                    // Фото с подписью снизу не скругляем: там начинается текст.
                    // Фото без подписи — самостоятельный пузырь, скругления с
                    // обеих сторон.
                    captioned={photo && !!m.text}
                  />
                )}
                {/* Вложение без подписи — обычный случай, пустой абзац не рисуем. */}
                {m.text &&
                  (photo ? (
                    // Пузырь отступов лишён — возвращаем их подписи под фото.
                    <MessageText text={m.text} className="block px-3 pb-2 pt-1.5" />
                  ) : (
                    <MessageText text={m.text} />
                  ))}
              </div>

              <div className="flex items-center gap-1.5 px-1">
                <span className="text-[10px] text-muted-foreground/70">
                  {formatTime(m.createdAt)}
                </span>
                {self && m.status === 'sending' && (
                  <Clock className="size-3 text-muted-foreground/70" aria-label="Отправляется" />
                )}
                {self &&
                  m.status !== 'sending' &&
                  m.status !== 'failed' &&
                  // Прочитано — не по каждому сообщению, а по маркеру времени
                  // собеседника: одна отметка закрывает всю ленту до неё.
                  (m.createdAt <= peerReadAt ? (
                    <CheckCheck
                      className="size-3 text-primary"
                      // Скринридеру «Прочитано» в «Избранном» обещало бы чужое
                      // прочтение; там двойная галочка значит только «записано».
                      aria-label={isSelfChat ? 'Сохранено' : 'Прочитано'}
                    />
                  ) : (
                    <Check className="size-3 text-muted-foreground/70" aria-label="Отправлено" />
                  ))}
                {self && m.status === 'failed' && (
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
