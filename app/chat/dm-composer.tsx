'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Loader2, Paperclip, SendHorizonal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SERVER_URL } from '@/hooks/mediasoup/types'
import { formatFileSize, isImageAttachment } from '@/lib/chat-format'
import { normalizeAttachment, type DmAttachment } from './types'
import { ComposerTextarea } from './composer-textarea'

interface DmComposerProps {
  /** Нужен для загрузки: файл кладётся в папку конкретного диалога. */
  conversationId: string
  /** Каждое вложение уходит отдельным сообщением; текст — только к последнему. */
  onSend: (text: string, attachments: DmAttachment[]) => void
  /** Вызывается при наборе текста; троттлинг событий — внутри useTyping. */
  onTyping: () => void
  disabled: boolean
}

/** Больше — неудобно листать превью и незачем: это личный чат, не файлообменник. */
const MAX_ATTACHMENTS = 10

export function DmComposer({
  conversationId,
  onSend,
  onTyping,
  disabled,
}: DmComposerProps) {
  const [text, setText] = useState('')
  // Загруженные вложения, ожидающие отправки. Каждое уходит своим сообщением
  // (см. ConversationView.handleSend), а текст из поля — только к последнему.
  // Файлы уже лежат на сервере: так отправка мгновенна, а ошибка загрузки
  // видна заранее.
  const [pendingList, setPendingList] = useState<DmAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // При переключении диалога черновик и вложение сбрасываем: ссылка вложения
  // привязана к conversationId, в другом диалоге сервер её отвергнет.
  useEffect(() => {
    setText('')
    setPendingList([])
    setUploadError(null)
  }, [conversationId])

  // Грузим по одному файлу за раз (не параллельно): так порядок вложений в
  // pendingList совпадает с порядком выбора, а прогресс легко показа��ь одним
  // общим индикатором вместо счётчика по каждому файлу.
  const uploadOne = useCallback(
    async (file: File): Promise<void> => {
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
        throw new Error(payload?.error ?? `Не удалось загрузить файл «${file.name}»`)
      }
      const attachment = normalizeAttachment(payload)
      if (!attachment) throw new Error('Сервер вернул некорректный файл')
      setPendingList((prev) => [...prev, attachment])
    },
    [conversationId],
  )

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setUploading(true)
      let lastError: string | null = null
      for (const file of files) {
        try {
          await uploadOne(file)
        } catch (e) {
          lastError = (e as Error).message
        }
      }
      setUploading(false)
      if (lastError) setUploadError(lastError)
    },
    [uploadOne],
  )

  // Общая точка входа для скрепки, вставки и drag&drop: обрезает список до
  // свободных мест в pendingList и предупреждает, если файлов прислали больше,
  // чем помещается.
  const addFiles = useCallback(
    (files: File[]) => {
      if (disabled || !files.length) return
      const room = MAX_ATTACHMENTS - pendingList.length
      if (room <= 0) {
        setUploadError(`Можно прикрепить не более ${MAX_ATTACHMENTS} файлов за раз`)
        return
      }
      const toUpload = files.slice(0, room)
      setUploadError(files.length > toUpload.length ? `Можно прикрепить не более ${MAX_ATTACHMENTS} файлов за раз` : null)
      void uploadFiles(toUpload)
    },
    [disabled, pendingList.length, uploadFiles],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      // Сброс значения, чтобы выбор тех же файлов снова вызвал change.
      e.target.value = ''
      addFiles(files)
    },
    [addFiles],
  )

  const removePending = useCallback((url: string) => {
    setPendingList((prev) => prev.filter((a) => a.url !== url))
  }, [])

  const submit = useCallback(() => {
    const trimmed = text.trim()
    // Пустое сообщение с вложением — допустимо, без вложения — нет.
    if (disabled || uploading || (!trimmed && pendingList.length === 0)) return
    onSend(trimmed, pendingList)
    setText('')
    setPendingList([])
    // Высоту после отправки сбрасывать здесь не нужно: её вернёт эффект по
    // изменению text — на момент этого вызова в DOM ещё старое значение.
  }, [text, pendingList, disabled, uploading, onSend])

  // Ctrl+V картинками из буфера — тот же путь, что и через скрепку.
  //
  // Скриншот в буфере приходит не в files, а элементами kind: 'file' в items,
  // поэтому перебираем все items и берём каждый файловый — так можно вставить
  // сразу несколько скопированных изображений. Файл из буфера почти всегда
  // безымянный ("image.png" браузер подставляет не всегда), так что имя задаём
  // сами, добавляя индекс — иначе несколько вставленных подряд картинок
  // получили бы одинаковое имя.
  //
  // preventDefault только когда файл действительно нашёлся: при обычной вставке
  // текста в items тоже лежит запись (kind: 'string'), и безусловный перехват
  // сломал бы вставку текста.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return
      const items = e.clipboardData?.items
      if (!items) return

      const files: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (!files.length) return
      e.preventDefault()
      const named = files.map((file, i) =>
        file.name && file.name !== 'image.png'
          ? file
          : new File(
              [file],
              `pasted-${Date.now()}-${i}.${file.type.split('/')[1] || 'png'}`,
              { type: file.type },
            ),
      )
      addFiles(named)
    },
    [disabled, addFiles],
  )

  // Drag & drop файлов на композер — тот же путь, что и через скрепку, но
  // сразу для всех перетащенных файлов (до MAX_ATTACHMENTS).
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (disabled) return
      addFiles(Array.from(e.dataTransfer.files ?? []))
    },
    [disabled, addFiles],
  )

  const canSend = (text.trim().length > 0 || pendingList.length > 0) && !uploading && !disabled

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="shrink-0 border-t border-border/60 bg-card/70"
    >
      {/* Статус загрузки / готовые вложения */}
      {(pendingList.length > 0 || uploading || uploadError) && (
        <div className="flex flex-col gap-2 px-3 pt-3">
          {uploading && (
            <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Загрузка файлов…
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

          {/* Каждое вложение уйдёт отдельным сообщением — превью показываем в
              ряд, а не карточкой на всю ширину, чтобы сразу было видно
              будущее число сообщений. */}
          {pendingList.length > 0 && (
            <div className="scroll-slim flex gap-2 overflow-x-auto pb-1">
              {pendingList.map((att) => (
                <div
                  key={att.url}
                  className="relative flex shrink-0 items-center gap-2 rounded-lg bg-muted px-2.5 py-2 pr-7"
                >
                  {isImageAttachment(att) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${SERVER_URL}${att.url}` || '/placeholder.svg'}
                      alt={att.name}
                      className="size-9 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                      <FileText className="size-4" />
                    </span>
                  )}
                  <span className="flex min-w-0 max-w-28 flex-col">
                    <span className="truncate text-xs font-medium text-foreground">
                      {att.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatFileSize(att.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removePending(att.url)}
                    className="absolute right-1 top-1 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Убрать файл ${att.name}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
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
          multiple
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
          disabled={disabled || uploading || pendingList.length >= MAX_ATTACHMENTS}
          // Кружок виден всегда, а не только под курсором: у ghost-варианта фон
          // появляется лишь на hover, и до наведения скрепка висела в пустоте
          // рядом с явно очерченными полем и кнопкой отправки. Фон берём тот же,
          // что у поля ввода, чтобы круг читался как часть строки, а не как
          // вторая акцентная кнопка возле «Отправить».
          className="size-10 shrink-0 rounded-full bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          aria-label="Прикрепить файл"
        >
          <Paperclip className="size-4" />
        </Button>
        {/* Само поле — в ComposerTextarea: там авторост, скролл и Enter. */}
        <ComposerTextarea
          value={text}
          onChange={(value) => {
            setText(value)
            if (value.trim()) onTyping()
          }}
          onSubmit={submit}
          onPaste={handlePaste}
          disabled={disabled}
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
