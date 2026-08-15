'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Loader2, Paperclip, SendHorizonal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useScrollbarAutohide } from '@/hooks/use-scrollbar-autohide'
import { SERVER_URL } from '@/hooks/mediasoup/types'
import { formatFileSize, isImageAttachment } from '@/lib/chat-format'
import { normalizeAttachment, type DmAttachment } from './types'

interface DmComposerProps {
  /** Нужен для загрузки: файл кладётся в папку конкретного диалога. */
  conversationId: string
  onSend: (text: string, attachment: DmAttachment | null) => void
  /** Вызывается при наборе текста; троттлинг событий — внутри useTyping. */
  onTyping: () => void
  disabled: boolean
}

const MAX_LENGTH = 4000
/** Предел роста поля ввода: дальше появляется собственный скролл. */
const MAX_HEIGHT = 140

export function DmComposer({
  conversationId,
  onSend,
  onTyping,
  disabled,
}: DmComposerProps) {
  const [text, setText] = useState('')
  // Загруженное вложение, ожидающее отправки со следующим сообщением. Файл уже
  // лежит на сервере: так отправка мгновенна, а ошибка загрузки видна заранее.
  const [pending, setPending] = useState<DmAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Подгонка высоты под содержимое.
  //
  // Здесь же решается, нужен ли textarea скролл. Полагаться на CSS нельзя: у
  // поля своя высота в одну строку, а по внутренним отступам и line-height
  // содержимое одной строки её чуть перерастает — браузер видел переполнение и
  // рисовал полосу прокрутки в пустом поле. Поэтому скролл включаем вручную и
  // только когда контент реально не влез в предел роста.
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Сначала снимаем прошлую высоту: scrollHeight у зафиксированного по высоте
    // элемента не умеет уменьшаться, и поле не сжималось бы при удалении строк.
    el.style.height = 'auto'
    const full = el.scrollHeight
    el.style.height = `${Math.min(full, MAX_HEIGHT)}px`
    el.style.overflowY = full > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  // При переключении диалога черновик и вложение сбрасываем: ссылка вложения
  // привязана к conversationId, в другом диалоге сервер её отвергнет.
  useEffect(() => {
    setText('')
    setPending(null)
    setUploadError(null)
  }, [conversationId])

  // Пересчёт после рендера, а не в обработчике ввода: и при наборе, и при
  // очистке после отправки в DOM на момент вызова ещё предыдущее значение.
  // Первый проход на монтировании тоже нужен — он задаёт высоту ровно в одну
  // строку вместо приблизительной из CSS.
  useEffect(() => {
    resize()
  }, [text, resize])

  const uploadFile = useCallback(
    async (file: File) => {
      setUploading(true)
      setUploadError(null)
      try {
        const body = new FormData()
        body.append('file', file)
        const res = await fetch(
          `/api/chat/upload?conversationId=${encodeURIComponent(conversationId)}`,
          { method: 'POST', body },
        )
        const payload = (await res.json().catch(() => null)) as
          | (Record<string, unknown> & { error?: string })
          | null
        if (!res.ok) {
          throw new Error(payload?.error ?? 'Не удалось загрузить файл')
        }
        const attachment = normalizeAttachment(payload)
        if (!attachment) throw new Error('Сервер вернул некорректный файл')
        setPending(attachment)
      } catch (e) {
        setUploadError((e as Error).message)
      } finally {
        setUploading(false)
      }
    },
    [conversationId],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Сброс значения, чтобы выбор того же файла снова вызвал change.
      e.target.value = ''
      if (file) void uploadFile(file)
    },
    [uploadFile],
  )

  const submit = useCallback(() => {
    const trimmed = text.trim()
    // Пустое сообщение с вложением — допустимо, без вложения — нет.
    if (disabled || uploading || (!trimmed && !pending)) return
    onSend(trimmed, pending)
    setText('')
    setPending(null)
    // Высоту после отправки сбрасывать здесь не нужно: её вернёт эффект по
    // изменению text — на момент этого вызова в DOM ещё старое значение.
  }, [text, pending, disabled, uploading, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter отправляет, Shift+Enter — перенос строки. Во время набора
      // иероглифов (CJK IME) Enter подтверждает композицию, а не отправляет.
      if (e.key !== 'Enter' || e.shiftKey) return
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      submit()
    },
    [submit],
  )

  // Drag & drop файла на композер — тот же путь, что и через скрепку.
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (disabled || uploading) return
      const file = e.dataTransfer.files?.[0]
      if (file) void uploadFile(file)
    },
    [disabled, uploading, uploadFile],
  )

  const canSend = (text.trim().length > 0 || !!pending) && !uploading && !disabled

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="shrink-0 border-t border-border/60 bg-card/70"
    >
      {/* Статус загрузки / готовое вложение */}
      {(pending || uploading || uploadError) && (
        <div className="px-3 pt-3">
          {uploading && (
            <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Загрузка файла…
            </div>
          )}

          {uploadError && !uploading && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span className="truncate">{uploadError}</span>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="shrink-0 opacity-70 hover:opacity-100"
                aria-label="Скрыть ошибку"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {pending && !uploading && (
            <div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2">
              {isImageAttachment(pending) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${SERVER_URL}${pending.url}` || '/placeholder.svg'}
                  alt={pending.name}
                  className="size-10 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                  <FileText className="size-4" />
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {pending.name}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {formatFileSize(pending.size)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label="Убрать вложение"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex items-end gap-2 px-3 py-3"
      >
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="size-10 shrink-0 rounded-full"
          aria-label="Прикрепить файл"
        >
          <Paperclip className="size-4" />
        </Button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (e.target.value.trim()) onTyping()
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          maxLength={MAX_LENGTH}
          placeholder={disabled ? 'Подключение к чату…' : 'Напишите сообщение…'}
          aria-label="Текст сообщения"
          className="max-h-[140px] min-h-10 flex-1 resize-none select-text rounded-2xl border border-transparent bg-foreground/5 px-4 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!canSend}
          className="size-10 shrink-0 rounded-full"
          aria-label="Отправить сообщение"
        >
          <SendHorizonal className="size-4" />
        </Button>
      </form>
    </div>
  )
}
