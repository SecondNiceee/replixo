'use client'

import { useCallback, useRef, useState } from 'react'
import { SendHorizonal } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DmComposerProps {
  onSend: (text: string) => void
  /** Вызывается при наборе текста; троттлинг событий — внутри useTyping. */
  onTyping: () => void
  disabled: boolean
}

const MAX_LENGTH = 4000

export function DmComposer({ onSend, onTyping, disabled }: DmComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    // Возвращаем высоту после отправки: textarea растёт по содержимому.
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
  }, [text, disabled, onSend])

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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="flex shrink-0 items-end gap-2 border-t border-border px-3 py-3"
    >
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
        className="max-h-[140px] min-h-10 flex-1 resize-none select-text rounded-2xl border border-input bg-background px-4 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
      />
      <Button
        type="submit"
        size="icon"
        disabled={disabled || text.trim().length === 0}
        className="size-10 shrink-0 rounded-full"
        aria-label="Отправить сообщение"
      >
        <SendHorizonal className="size-4" />
      </Button>
    </form>
  )
}
