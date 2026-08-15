'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'

// ---------------------------------------------------------------------------
// Просмотр картинки из чата поверх страницы: затемнённый фон, изображение по
// центру во всю доступную высоту. Раньше превью было ссылкой с target="_blank",
// и клик уносил пользователя из переписки на голую страницу с файлом.
//
// Рендерим через портал в document.body: пузырь сообщения лежит внутри
// скроллируемой ленты с overflow-hidden и backdrop-blur, а такой предок
// создаёт содержащий блок для fixed — оверлей обрезался бы по границам ленты.
// ---------------------------------------------------------------------------
export function ImageLightbox({
  src,
  alt,
  downloadHref,
  onClose,
}: {
  src: string
  alt: string
  /** Ссылка «скачать» с ?name=, чтобы файл сохранился под исходным именем. */
  downloadHref: string
  onClose: () => void
}) {
  // Esc закрывает, а прокрутку страницы под оверлеем блокируем: иначе колесо
  // мыши крутило бы ленту сообщений за затемнением.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    // Клик по фону закрывает. Роль dialog + aria-modal, чтобы скринридер не
    // читал ленту под затемнением.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      // Затемнение чёрным, а не bg-background: тема тёмная, и полупрозрачный
      // фоновый цвет поверх почти чёрной страницы давал бы не «затемнено», а
      // просто ещё один тёмный экран — переписка за оверлеем должна угадываться.
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0 duration-150 md:p-10"
    >
      {/* Кнопки лежат поверх картинки, поэтому у них собственная тёмная
          подложка: на светлом снимке полупрозрачный фон растворился бы. */}
      <div className="absolute right-3 top-3 flex items-center gap-2">
        <a
          href={downloadHref}
          download={alt}
          onClick={(e) => e.stopPropagation()}
          className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/80"
          aria-label="Скачать изображение"
          title="Скачать"
        >
          <Download className="size-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/80"
          aria-label="Закрыть просмотр"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Клик по самой картинке не закрывает — иначе промах мимо кнопки при
          попытке разглядеть деталь выбрасывал бы из просмотра. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src || '/placeholder.svg'}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl animate-in zoom-in-95 duration-150"
      />
    </div>,
    document.body,
  )
}
