'use client'

import { useState } from 'react'
import { FileText, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatFileSize, isImageAttachment, type AttachmentLike } from '@/lib/chat-format'
import { ImageLightbox } from './image-lightbox'

// ---------------------------------------------------------------------------
// Вложение внутри пузыря сообщения: картинки — превью, всё остальное — карточка
// со скачиванием. Общий компонент для чата комнаты и личных сообщений: файлы в
// обоих случаях лежат на mediasoup-сервере и раздаются через /uploads, поэтому
// абсолютную ссылку собираем из baseUrl + относительного url вложения.
// ---------------------------------------------------------------------------
export function AttachmentView({
  attachment,
  baseUrl,
  self,
}: {
  attachment: AttachmentLike
  baseUrl: string
  self: boolean
}) {
  const href = `${baseUrl}${attachment.url}`

  // На диске файл лежит под UUID'ом, поэтому без подсказки браузер сохранил бы
  // «a1b2c3.pdf». Атрибут download задаёт имя только для same-origin ссылок, а
  // сервер вложений может быть на другом домене — поэтому исходное имя ещё и
  // передаём в ?name=, откуда сервер собирает Content-Disposition (RFC 5987).
  const downloadHref = `${href}${href.includes('?') ? '&' : '?'}name=${encodeURIComponent(attachment.name)}`

  if (isImageAttachment(attachment)) {
    return <ImageAttachment src={href} downloadHref={downloadHref} name={attachment.name} />
  }

  return (
    <a
      href={downloadHref}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.name}
      className={cn(
        'flex max-w-[260px] items-center gap-3 rounded-xl border border-border/60 px-3 py-2 transition-colors',
        self ? 'bg-primary-foreground/10 hover:bg-primary-foreground/20' : 'bg-background hover:bg-muted',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <FileText className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{attachment.name}</span>
        <span className="text-[11px] opacity-70">{formatFileSize(attachment.size)}</span>
      </span>
      <Download className="size-4 shrink-0 opacity-70" />
    </a>
  )
}

/**
 * Превью картинки, открывающее её в лайтбоксе поверх переписки.
 *
 * Именно кнопка, а не ссылка: раньше здесь была ссылка с target="_blank", и
 * клик уводил на отдельную страницу с файлом. Скачать картинку по-прежнему
 * можно — кнопка для этого есть в самом лайтбоксе.
 */
function ImageAttachment({
  src,
  downloadHref,
  name,
}: {
  src: string
  downloadHref: string
  name: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block cursor-zoom-in overflow-hidden rounded-xl transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={`Открыть изображение ${name}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src || '/placeholder.svg'}
          alt={name}
          className="max-h-60 w-full max-w-[260px] object-cover"
          loading="lazy"
        />
      </button>

      {open && (
        <ImageLightbox
          src={src}
          alt={name}
          downloadHref={downloadHref}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
